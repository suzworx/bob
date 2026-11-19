import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addGoogleAccount } from '../../src/integrations/google-store.ts';
import { dispatchRoutines } from '../../src/routines/dispatch.ts';
import { createRoutine } from '../../src/routines/store.ts';
import { createRoutineRunner } from '../../src/workflows/workflow-routine-run.ts';
import { getRoutineRun, listRoutineRuns } from '../../src/routines/run-store.ts';
import { getNote } from '../../src/notes/store.ts';
import { emailEffectKey, listNotifications } from '../../src/notifications/store.ts';
import { claimOutboxBatch } from '../../src/platform/outbox/store.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';
import { setToolPreference } from '../../src/tools/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import type { DeliveryOutcome } from '../../src/notifications/notify.ts';

let pg: TestDb;
let db: Db;
const now = Date.parse('2026-10-22T00:00:00Z');
const digest = {
  summary: 'One delivery update.',
  messageCount: 1,
  partial: false,
  sources: [{ threadId: 'thread1', messageId: 'message1', label: 'Delivery' }],
};

beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

async function fixture(emailResult: boolean): Promise<{ owner: string; routineId: string }> {
  const { userId: owner } = await addAccount(pg);
  await ensurePrivateSpace(db, owner);
  const account = await addGoogleAccount(db, owner, {
    installationId: randomUUID(), accountId: randomUUID(), email: 'routine@example.test',
  });
  await withUser(db, owner, tx => tx.query(
    "update bob.google_accounts set authorization_capabilities=array['gmail.read'] where id=$1",
    [account.id],
  ));
  for (const toolId of ['google_gmail_search', 'google_gmail_read_thread'] as const) {
    await setToolPreference(db, owner, { scope: 'integration', scopeId: account.id, toolId, enabled: true });
  }
  const routine = await createRoutine(db, owner, {
    kind: 'daily_gmail_digest',
    googleAccountId: account.id,
    localTime: '08:00',
    timeZone: 'UTC',
    scheduledReadConsent: true,
    emailResult,
  }, now);
  const saved = (await withUser(db, owner, tx => tx.query<{ email_result: boolean }>(
    'select email_result from bob.routines where id=$1',
    [routine.id],
  )))[0];
  expect(saved?.email_result).toBe(emailResult);
  return { owner, routineId: routine.id };
}

async function schedule(owner: string, routineId: string): Promise<{ id: string }> {
  const due = now + 8 * 60 * 60 * 1000;
  await dispatchRoutines(db, due);
  const run = (await listRoutineRuns(db, owner, routineId))[0];
  if (!run) throw new Error('routine_fixture_missing');
  return { id: run.id };
}

const runner = (notifyBobMessage: (db: Db, owner: string, noteId: string, effectKey: string) => Promise<DeliveryOutcome>,
  digestCalls: { count: number }) => createRoutineRunner({
  db,
  now: () => now + 8 * 60 * 60 * 1000,
  verifyConsent: async () => undefined,
  notifyBobMessage,
  digest: async () => { digestCalls.count += 1; return digest; },
});

it('does not notify when email delivery is left at its default-off setting', async () => {
  const f = await fixture(false);
  const run = await schedule(f.owner, f.routineId);
  const notify = vi.fn(async (): Promise<DeliveryOutcome> => ({ status: 'delivered', enqueued: 1, muted: 0 }));
  const digestCalls = { count: 0 };
  await runner(notify, digestCalls)(run.id, new AbortController().signal);
  expect(digestCalls.count).toBe(1);
  expect(notify).not.toHaveBeenCalled();
  expect((await getRoutineRun(db, f.owner, f.routineId, run.id))?.emailOutcome).toBeNull();
});

it('retries failed email delivery from the saved result with the same stable private note', async () => {
  const f = await fixture(true);
  const run = await schedule(f.owner, f.routineId);
  await expect(withUser(db, f.owner, tx => tx.query(
    'select * from bob_private.get_routine_email_delivery_context($1)',
    [run.id],
  ))).rejects.toMatchObject({ code: '42501' });
  const digestCalls = { count: 0 };
  const notify = vi.fn()
    .mockResolvedValueOnce({ status: 'failed', reason: 'enqueue_failed' } satisfies DeliveryOutcome)
    .mockResolvedValue({ status: 'delivered', enqueued: 1, muted: 0 } satisfies DeliveryOutcome);
  const execute = runner(notify, digestCalls);

  await expect(execute(run.id, new AbortController().signal)).rejects.toThrow('routine_retry');
  const savedAfterFailure = await getRoutineRun(db, f.owner, f.routineId, run.id);
  expect(digestCalls.count).toBe(1);
  expect(savedAfterFailure).toMatchObject({ status: 'completed', emailOutcome: null, result: { summary: digest.summary } });
  expect(notify).toHaveBeenCalledTimes(1);

  const noteCounts = await withUser(db, f.owner, tx => tx.query<{ notes: number; revisions: number }>(
    `select
       (select count(*)::int from bob.notes where id=$1) as notes,
       (select count(*)::int from bob.note_revisions where note_id=$1) as revisions`,
    [run.id],
  ));
  expect(noteCounts[0]).toEqual({ notes: 1, revisions: 1 });
  expect(notify).toHaveBeenNthCalledWith(1, db, f.owner, run.id, `bob_message:note:${run.id}`);

  await execute(run.id, new AbortController().signal);
  await execute(run.id, new AbortController().signal);
  expect(digestCalls.count).toBe(1);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(notify).toHaveBeenNthCalledWith(2, db, f.owner, run.id, `bob_message:note:${run.id}`);
  expect((await getRoutineRun(db, f.owner, f.routineId, run.id))?.emailOutcome).toBe('queued');
  const finalCounts = await withUser(db, f.owner, tx => tx.query<{ notes: number; revisions: number }>(
    `select
       (select count(*)::int from bob.notes where id=$1) as notes,
       (select count(*)::int from bob.note_revisions where note_id=$1) as revisions`,
    [run.id],
  ));
  expect(finalCounts[0]).toEqual({ notes: 1, revisions: 1 });
});

it('persists muted preferences as muted and does not retry or claim a queued email', async () => {
  const f = await fixture(true);
  const run = await schedule(f.owner, f.routineId);
  const digestCalls = { count: 0 };
  const notify = vi.fn(async (): Promise<DeliveryOutcome> => ({ status: 'muted', enqueued: 0, muted: 1 }));
  const execute = runner(notify, digestCalls);

  await execute(run.id, new AbortController().signal);
  await execute(run.id, new AbortController().signal);
  expect(notify).toHaveBeenCalledTimes(1);
  const saved = await getRoutineRun(db, f.owner, f.routineId, run.id);
  expect(saved?.emailOutcome).toBe('muted');
  expect(saved?.status).toBe('completed');
  expect(digestCalls.count).toBe(1);
});

it('queues a scheduled result through the production Bob-message notifier', async () => {
  const f = await fixture(true);
  const run = await schedule(f.owner, f.routineId);
  const privateSpace = await ensurePrivateSpace(db, f.owner);
  expect(privateSpace).toMatchObject({ kind: 'private', ownerUserId: f.owner });
  const execute = createRoutineRunner({
    db,
    now: () => now + 8 * 60 * 60 * 1000,
    verifyConsent: async () => undefined,
    digest: async () => digest,
  });

  await execute(run.id, new AbortController().signal);

  expect(await getRoutineRun(db, f.owner, f.routineId, run.id))
    .toMatchObject({ status: 'completed', emailOutcome: 'queued' });
  expect(await getNote(db, f.owner, run.id)).toMatchObject({
    id: run.id,
    spaceId: privateSpace.id,
    createdBy: f.owner,
    aiAssisted: true,
  });

  const notifications = await listNotifications(db, f.owner, { limit: 10 });
  expect(notifications).toMatchObject([{
    type: 'bob_message',
    resourceType: 'note',
    resourceId: run.id,
    effectKey: `bob_message:note:${run.id}`,
  }]);
  expect(notifications).toHaveLength(1);

  // Claiming only reads/leases the durable outbox row; no email provider runs here.
  const outbox = await claimOutboxBatch(db, {
    owner: `routine-email-delivery-${randomUUID()}`,
    limit: 1000,
    leaseMs: 60_000,
    now: Date.now() + 60_000,
  });
  const emailRows = outbox.filter((row) =>
    row.effectKey === emailEffectKey(f.owner, `bob_message:note:${run.id}`));
  expect(emailRows).toHaveLength(1);
  expect(emailRows[0]).toMatchObject({
    eventType: 'email.notification',
    resourceType: 'notification',
    resourceId: run.id,
  });
});
