// core/erasure.ts + store/erasure.ts tests (S14-ERASURE, issue #143;
// S14-PG-ERASURE). Real Postgres (createTestDb + asDb(pg), same
// setup as store-tasks.test.ts): every connection is bob_server
// (nobypassrls), so a bare db.query() against the FORCE-RLS bob.* tables
// (spaces/tasks/notes/threads/...) sees zero rows -- exactly the defect this
// story fixes for eraseAccount itself. Verification reads below therefore go
// through withUser() as an account that still has visibility (the erased
// account's own row via its owner/self clause, or another still-active member
// such as b), never as a bare bob_server connection.
//
// Proves: refusal when the account still solely owns a group (and that the
// refusal changes nothing), success when another active owner exists or
// ownership was transferred, anonymized authorship surviving shared work,
// private-vs-shared space deletion, cleared assignments, outbox invalidation
// scoped to the actor, full idempotency, and that an ordinary signed-in user
// cannot call bob_private.erase_account directly (only bob_server may).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { ERASED_USER_ID, EraseRefusedError, eraseAccount } from '../../src/account/erasure-service.ts';
import { addMember, createSpace, ensurePrivateSpace, transferOwnership } from '../../src/spaces/store.ts';
import { addSubscriber, completeTask, createTask } from '../../src/tasks/store.ts';
import { createNote, updateNote } from '../../src/notes/store.ts';
import { claimOutboxBatch, enqueueOutbox, pendingOutboxCount } from '../../src/platform/outbox/store.ts';
import { createReminder, dueOccurrences, recordOccurrence } from '../../src/reminders/store.ts';
import { createTimer, markTimerFired } from '../../src/timers/store.ts';
import { setActiveSpace } from '../../src/spaces/active.ts';
import { patchDeviceSettings } from '../../src/devices/settings-store.ts';
import { emailEffectKey, enqueueNotifications, markEmailEffectSent } from '../../src/notifications/store.ts';
import { listPushDevices, markPushSent, registerPushDevice } from '../../src/notifications/push-store.ts';
import * as pairing from '../../src/devices/pairing-service.ts';
import { asDb, addAccount, addSession, closeTestDb, createTestDb, withUserRaw, type TestDb } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';

let pg: TestDb;

/** Counts rows matching `query` (one uuid parameter, `$1` = `id`) as the
 *  database owner. Erasure revokes the account's RLS visibility, so only an
 *  owner read can prove a row is really gone rather than merely hidden.
 *  Read-only: every row it counts was created through the app's own store
 *  functions. */
async function ownerCount(query: string, id: string): Promise<number> {
  const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
  return withAdmin(url, async (sql) => {
    const rows = await sql.unsafe<{ total: number }[]>(`SELECT COUNT(*)::int AS total FROM (${query}) q`, [id]);
    return Number(rows[0]!.total);
  });
}

/** A paired device for `userId` with stored settings (a web patch creates them). */
async function pairedDeviceWithSettings(userId: string): Promise<string> {
  const issued = await pairing.issueCode(db, {
    model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.7',
  });
  const deviceId = await pairing.approve(db, userId, issued.pairingId, 'Kitchen');
  await patchDeviceSettings(db, userId, deviceId, { volume: 3 });
  return deviceId;
}
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

/** Creates a group space owned by `owner` with `members` added as 'member'. */
async function makeGroup(ownerId: string, name: string, members: string[] = []): Promise<{ id: string }> {
  const space = await createSpace(db, ownerId, { kind: 'group', name });
  for (const member of members) {
    await addMember(db, ownerId, space.id, member, 'member');
  }
  return space;
}

/** Counts group spaces the account still solely owns (same query as the
 *  definer's guard). Read as `userId` itself: the owner clause on
 *  bob.spaces and the own-row clause on bob.space_memberships both key
 *  off auth.uid() = userId, so this is visible regardless of the account's
 *  current membership state. */
async function ownedGroupCount(userId: string): Promise<number> {
  const rows = await withUser(db, userId, (tx) =>
    tx.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM bob.spaces s
        WHERE s.kind = 'group' AND s.owner_user_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM bob.space_memberships m
             WHERE m.space_id = s.id AND m.user_id <> $1
               AND m.role = 'owner' AND m.revoked_at IS NULL
          )`,
      [userId],
    ),
  );
  return Number(rows[0]!.total);
}

/** Number of active memberships the account holds, read as itself (the
 *  space_memberships_select policy's own-row clause). */
async function activeMemberships(userId: string): Promise<number> {
  const rows = await withUser(db, userId, (tx) =>
    tx.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM bob.space_memberships
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    ),
  );
  return Number(rows[0]!.total);
}

describe('erasure', () => {
  it('1: an owner of a group is REFUSED with the named error and a count, and nothing changes', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await makeGroup(a.userId, 'Family', [b.userId]);
    await createTask(db, a.userId, group.id, { title: 'kept' });

    const error = await eraseAccount({ db, userId: a.userId, now: Date.now() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EraseRefusedError);
    expect((error as EraseRefusedError).count).toBe(1);
    expect((error as Error).message).not.toContain('Family'); // never the group name

    // Nothing changed: still sole owner, membership still active.
    expect(await ownedGroupCount(a.userId)).toBe(1);
    expect(await activeMemberships(a.userId)).toBe(1);
  });

  it('2: an account that co-owns a group with another active owner is NOT refused', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'CoOwned' });
    await addMember(db, a.userId, group.id, b.userId, 'owner'); // b is a co-owner, not just a member

    expect(await ownedGroupCount(a.userId)).toBe(0); // another active owner exists

    const result = await eraseAccount({ db, userId: a.userId, now: Date.now() });
    expect(result.membershipsRevoked).toBeGreaterThan(0);
    expect(await activeMemberships(a.userId)).toBe(0);
  });

  it('3: after transferring ownership, the same account erases successfully and returns the five counts', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await makeGroup(a.userId, 'Transfer', [b.userId]);
    await transferOwnership(db, a.userId, group.id, b.userId);

    const result = await eraseAccount({ db, userId: a.userId, now: Date.now() });
    expect(Object.keys(result).sort()).toEqual(
      ['anonymized', 'assignmentsCleared', 'jobsInvalidated', 'membershipsRevoked', 'privateSpacesDeleted'].sort(),
    );
    expect(result.membershipsRevoked).toBeGreaterThan(0);
    expect(await ownedGroupCount(a.userId)).toBe(0);
    expect(await activeMemberships(a.userId)).toBe(0);
  });

  it('4: a task the erased user completed still exists with anonymized authorship; a note another member edited is untouched', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await makeGroup(b.userId, 'Shared', [a.userId]);

    // Task created by b, completed by a — the completed-by attribution anonymizes.
    const task = await createTask(db, b.userId, group.id, { title: 'family chores' });
    await completeTask(db, a.userId, task.id);
    // Note created and edited by b only — a never touched it, so it is untouched.
    const note = await createNote(db, b.userId, group.id, { title: 'plan', body: 'v1' });
    await updateNote(db, b.userId, note.id, { revision: 1, body: 'v2' });

    await eraseAccount({ db, userId: a.userId, now: Date.now() });

    // b is still an active member; read as b (a lost visibility on revoke).
    const taskRow = await withUser(db, b.userId, (tx) =>
      tx.query<{ createdBy: string; completedBy: string | null }>(
        `SELECT created_by AS "createdBy", completed_by AS "completedBy" FROM bob.tasks WHERE id = $1`,
        [task.id],
      ),
    );
    expect(taskRow).toHaveLength(1); // still exists
    expect(taskRow[0]!.createdBy).toBe(b.userId); // creator untouched
    expect(taskRow[0]!.completedBy).toBe(ERASED_USER_ID); // completed-by anonymized

    const noteRow = await withUser(db, b.userId, (tx) =>
      tx.query<{ createdBy: string; updatedBy: string }>(
        `SELECT created_by AS "createdBy", updated_by AS "updatedBy" FROM bob.notes WHERE id = $1`,
        [note.id],
      ),
    );
    expect(noteRow).toHaveLength(1);
    expect(noteRow[0]!.createdBy).toBe(b.userId);
    expect(noteRow[0]!.updatedBy).toBe(b.userId); // b's edit untouched
  });

  it('5: the private space and its resources are gone; a shared space they belonged to is not', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const privateSpace = await ensurePrivateSpace(db, a.userId);
    const shared = await makeGroup(b.userId, 'KeepShared', [a.userId]);
    const task = await createTask(db, a.userId, privateSpace.id, { title: 'mine only' });

    await eraseAccount({ db, userId: a.userId, now: Date.now() });

    // Private space and its resource are gone. Read as a: the spaces_select
    // owner clause would still show it if it existed, so 0 rows proves deletion.
    const privateRows = await withUser(db, a.userId, (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM bob.spaces WHERE id = $1`, [privateSpace.id]),
    );
    expect(privateRows).toHaveLength(0);
    const taskRows = await withUser(db, a.userId, (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM bob.tasks WHERE id = $1`, [task.id]),
    );
    expect(taskRows).toHaveLength(0);

    // Shared space still exists and still lists the task b kept. a lost
    // visibility (membership revoked), so read as b, still an active member.
    const sharedRows = await withUser(db, b.userId, (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM bob.spaces WHERE id = $1`, [shared.id]),
    );
    expect(sharedRows).toHaveLength(1);
  });

  it('6: assignments held by the erased user are cleared and no longer reference them', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await makeGroup(b.userId, 'Assign', [a.userId]);
    const task = await createTask(db, b.userId, group.id, { title: 'assigned to a' });
    await withUser(db, b.userId, (tx) =>
      tx.query<{ id: string }>(
        `UPDATE bob.tasks SET assignee_user_id = $1, revision = revision + 1 WHERE id = $2 RETURNING id`,
        [a.userId, task.id],
      ),
    );
    await addSubscriber(db, b.userId, task.id, a.userId);

    await eraseAccount({ db, userId: a.userId, now: Date.now() });

    const taskRow = await withUser(db, b.userId, (tx) =>
      tx.query<{ assigneeUserId: string | null }>(
        `SELECT assignee_user_id AS "assigneeUserId" FROM bob.tasks WHERE id = $1`,
        [task.id],
      ),
    );
    expect(taskRow[0]!.assigneeUserId).toBeNull();
    const subs = await withUser(db, b.userId, (tx) =>
      tx.query<{ id: string }>(
        `SELECT id FROM bob.task_subscribers WHERE task_id = $1 AND user_id = $2`,
        [task.id, a.userId],
      ),
    );
    expect(subs).toHaveLength(0);
  });

  it('7: undelivered outbox rows for the actor are invalidated; other actors rows are not', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    // space_id is nullable on bob.outbox; these rows need no real space, so
    // no raw INSERT INTO bob.spaces is needed (a bare bob_server INSERT
    // there would fail the spaces_insert RLS check anyway).
    await enqueueOutbox(db, [
      {
        eventType: 'task.completed',
        resourceType: 'task',
        resourceId: randomUUID(),
        effectKey: `erasure-a-${randomUUID()}`,
        payload: { actor_user_id: a.userId, event_type: 'task.completed' },
      },
      {
        eventType: 'task.completed',
        resourceType: 'task',
        resourceId: randomUUID(),
        effectKey: `erasure-b-${randomUUID()}`,
        payload: { actor_user_id: b.userId, event_type: 'task.completed' },
      },
    ]);
    expect(await pendingOutboxCount(db)).toBe(2);

    await eraseAccount({ db, userId: a.userId, now: Date.now() });

    // a's row is delivered (invalidated => not pending); b's row is still
    // undelivered. The outbox is server-only (no policies at all, not even
    // for authenticated), so it is inspected through claimOutboxBatch (the
    // sanctioned bob_private.outbox_* path), not a bare/withUser SELECT.
    expect(await pendingOutboxCount(db)).toBe(1);
    // now is padded well past outbox_claim_batch's available_at <= p_now
    // check: the local stack's container clock runs measurably ahead of the
    // test host's (observed ~8s), so a host Date.now() right at the boundary
    // can miss a row that is due by the container's own clock.
    const remaining = await claimOutboxBatch(db, {
      owner: 'erasure-test-verify',
      limit: 10,
      leaseMs: 60_000,
      now: Date.now() + 60_000,
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.payload['actor_user_id']).toBe(b.userId);
  });

  it('8: running eraseAccount twice changes nothing the second time and returns the same shape', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await makeGroup(b.userId, 'Idem', [a.userId]);
    const task = await createTask(db, b.userId, group.id, { title: 'idem task' });
    await completeTask(db, a.userId, task.id);

    const now = Date.now();
    const first = await eraseAccount({ db, userId: a.userId, now });
    const second = await eraseAccount({ db, userId: a.userId, now });

    // Same shape; the second run touches nothing (all counts zero).
    expect(Object.keys(second)).toEqual(Object.keys(first));
    expect(second.anonymized).toBe(0);
    expect(second.assignmentsCleared).toBe(0);
    expect(second.privateSpacesDeleted).toBe(0);
    expect(second.membershipsRevoked).toBe(0);
    expect(second.jobsInvalidated).toBe(0);
  });

  it('10 (#513): timers, device settings, active space and reminder recipients go; a group reminder survives anonymized and fires for the rest', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await makeGroup(b.userId, 'Gaps', [a.userId]);
    const privateSpace = await ensurePrivateSpace(db, a.userId);
    const due = { kind: 'instant' as const, at: Date.now() - 60_000, zone: 'UTC' };
    const shared = await createReminder(db, a.userId, group.id, { title: 'bins out', due, recipients: [a.userId, b.userId] });
    const other = await createReminder(db, b.userId, group.id, { title: 'fed cat', due, recipients: [a.userId] });
    await recordOccurrence(db, { reminderId: other.id, userId: a.userId, occurrenceAt: due.at, scheduleRevision: 1 });
    const mine = await createReminder(db, a.userId, privateSpace.id, { title: 'mine', due });
    await createTimer(db, a.userId, { durationMs: 60_000 });
    await withUser(db, a.userId, (tx) => setActiveSpace(tx, a.userId, group.id, 'web'));
    await pairedDeviceWithSettings(a.userId);

    const perTable: Record<string, string> = {
      timers: `SELECT 1 FROM bob.reminders WHERE created_by = $1 AND kind = 'timer'`,
      device_settings: `SELECT 1 FROM bob.devices WHERE user_id = $1 AND settings_updated_at IS NOT NULL AND volume = 3`,
      user_state: `SELECT 1 FROM bob.user_state WHERE user_id = $1 AND active_space_id IS NOT NULL`,
      reminder_recipients: `SELECT 1 FROM bob.reminder_recipients WHERE user_id = $1`,
      reminder_occurrences: `SELECT 1 FROM bob.reminder_occurrences WHERE user_id = $1`,
      reminders: `SELECT 1 FROM bob.reminders WHERE created_by = $1 AND kind = 'reminder'`,
    };
    for (const query of Object.values(perTable)) expect(await ownerCount(query, a.userId)).toBeGreaterThan(0);

    const first = await eraseAccount({ db, userId: a.userId, now: Date.now() });
    expect(first.anonymized).toBeGreaterThan(0);
    expect(first.assignmentsCleared).toBeGreaterThan(0);

    for (const [table, query] of Object.entries(perTable)) {
      expect(await ownerCount(query, a.userId), table).toBe(0);
    }
    // The device row stays, with its settings back at the defaults (#757).
    expect(await ownerCount(`SELECT 1 FROM bob.devices WHERE user_id = $1 AND volume = 6 AND settings_updated_at IS NULL`, a.userId)).toBe(1);
    // user_state carries the pointers and game settings; no row may remain.
    expect(await ownerCount(`SELECT 1 FROM bob.user_state WHERE user_id = $1`, a.userId), 'user_state').toBe(0);
    // The group reminder a created stays, authored by the sentinel, still aimed at b.
    expect(await ownerCount(`SELECT 1 FROM bob.reminders WHERE id = $1 AND created_by = '${ERASED_USER_ID}'`, shared.id)).toBe(1);
    expect(await ownerCount(`SELECT 1 FROM bob.reminder_recipients WHERE reminder_id = $1`, shared.id)).toBe(1);
    // The private-space reminder is gone with the private space.
    expect(await ownerCount(`SELECT 1 FROM bob.reminders WHERE id = $1`, mine.id)).toBe(0);
    // It fires for b and never for a.
    const firing = (await dueOccurrences(db, { now: Date.now() + 60_000 })).filter((o) => o.reminderId === shared.id);
    expect(firing.map((o) => o.userId)).toEqual([b.userId]);

    const second = await eraseAccount({ db, userId: a.userId, now: Date.now() });
    expect(second).toEqual({
      anonymized: 0, assignmentsCleared: 0, privateSpacesDeleted: 0, membershipsRevoked: 0, jobsInvalidated: 0,
    });
  });

  it('11 (#513): a co-owned group is handed to the remaining owner', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Handover' });
    await addMember(db, a.userId, group.id, b.userId, 'owner');

    await eraseAccount({ db, userId: a.userId, now: Date.now() });

    expect(await ownerCount(`SELECT 1 FROM bob.spaces WHERE owner_user_id = $1`, a.userId)).toBe(0);
    const rows = await withUser(db, b.userId, (tx) =>
      tx.query<{ ownerUserId: string }>(`SELECT owner_user_id AS "ownerUserId" FROM bob.spaces WHERE id = $1`, [group.id]),
    );
    expect(rows[0]!.ownerUserId).toBe(b.userId);
  });

  it('12 (#545): erasure deletes the account\'s email effects and keeps everyone else\'s', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    for (const { userId } of [a, b]) {
      const effectKey = `assignment:task:${randomUUID()}:1`;
      await enqueueNotifications(db, [{ recipientUserId: userId, type: 'assignment', resourceType: 'task',
        resourceId: randomUUID(), effectKey }]);
      expect(await markEmailEffectSent(db, emailEffectKey(userId, effectKey), userId)).toBe(true);
    }

    await eraseAccount({ db, userId: a.userId, now: Date.now() });

    expect(await ownerCount(`SELECT 1 FROM bob.outbox WHERE recipient_user_id = $1`, a.userId)).toBe(0);
    expect(await ownerCount(`SELECT 1 FROM bob.outbox WHERE recipient_user_id = $1`, b.userId)).toBe(2); // email + push
  });

  it('13: erasure purges push endpoints, receipts and pending work only for its account and fences stale registration', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    for (const { userId, sessionId } of [a, b]) {
      await registerPushDevice(db, userId, sessionId, {
        installation_id: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2),
        environment: 'sandbox', topic: 'xyz.heybob.ios', app_version: '1', local_timer_ids: [],
      });
      const effectKey = `assignment:task:${randomUUID()}:1`;
      await enqueueNotifications(db, [{ recipientUserId: userId, type: 'assignment', resourceType: 'task',
        resourceId: randomUUID(), effectKey }]);
      await markEmailEffectSent(db, emailEffectKey(userId, effectKey), userId);
      const timer = await createTimer(db, userId, { durationMs: 1000, now: Date.now() - 2000 });
      await markTimerFired(db, userId, timer.id);
    }
    const rows = await claimOutboxBatch(db, { owner: randomUUID(), limit: 100, leaseMs: 60_000,
      now: Date.now() + 1000, include: ['push.notification'] });
    for (const { userId } of [a, b]) {
      const [device] = await listPushDevices(db, userId);
      const row = rows.find((entry) => entry.payload.recipient_user_id === userId);
      if (!device || !row) throw new Error('missing push erasure fixture');
      await markPushSent(db, device, row.id);
      expect(await ownerCount('SELECT 1 FROM bob.push_receipts WHERE user_id = $1', userId)).toBe(1);
    }

    await eraseAccount({ db, userId: a.userId, now: Date.now() });
    for (const table of ['push_devices', 'push_receipts']) {
      expect(await ownerCount(`SELECT 1 FROM bob.${table} WHERE user_id = $1`, a.userId)).toBe(0);
      expect(await ownerCount(`SELECT 1 FROM bob.${table} WHERE user_id = $1`, b.userId)).toBe(1);
    }
    expect(await ownerCount('SELECT 1 FROM bob.outbox WHERE recipient_user_id = $1', a.userId)).toBe(0);
    expect(await ownerCount('SELECT 1 FROM bob.outbox WHERE recipient_user_id = $1', b.userId)).toBe(3);
    const registration = { installation_id: randomUUID(), token: 'ab'.repeat(32),
      environment: 'sandbox' as const, topic: 'xyz.heybob.ios', app_version: '1', local_timer_ids: [] };
    expect(await registerPushDevice(db, a.userId, a.sessionId, registration)).toBe(false);
    // Account deletion retains global sessions for retry; only a fresh sign-in
    // can intentionally establish a new push installation after the purge.
    const freshSession = await addSession(pg, a.userId);
    expect(await registerPushDevice(db, a.userId, freshSession, registration)).toBe(true);
  });

  it('14: a registration queued behind erasure rechecks the committed session fence', async () => {
    const a = await addAccount(pg);
    let queued: Promise<boolean> | undefined;
    await db.tx(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [a.userId]);
      queued = registerPushDevice(db, a.userId, a.sessionId, {
        installation_id: randomUUID(), token: 'de'.repeat(32), environment: 'sandbox',
        topic: 'xyz.heybob.ios', app_version: '1', local_timer_ids: [],
      });
      await eraseAccount({ db: tx, userId: a.userId, now: Date.now() });
    });
    expect(await queued).toBe(false);
    expect(await ownerCount('SELECT 1 FROM bob.push_devices WHERE user_id = $1', a.userId)).toBe(0);
  });

  it('9: an ordinary signed-in user cannot call bob_private.erase_account directly', async () => {
    const a = await addAccount(pg);
    await expect(
      withUserRaw(pg, a.userId, (tx) =>
        tx.query(`select * from bob_private.erase_account($1::uuid, now())`, [a.userId]),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withUserRaw(pg, a.userId, (tx) => tx.query('select bob_private.purge_account_push($1::uuid)', [a.userId])),
    ).rejects.toThrow(/permission denied/i);
  });
});
