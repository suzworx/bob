// The web server runs reminder delivery itself (prod runs only server.ts, so
// nothing else drains the outbox): the 'outbox' module is registered with the
// server's background work, and starting it ticks the reminder fanout at once
// (inbox notification + a device ring through the real announce seam) and
// drains the email.notification outbox row through the email handler. Its
// stop() ends both.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AppDeps } from '../src/app-deps.ts';
import { apiModules } from '../src/api-modules.ts';
import { outboxModule } from '../src/outbox-module.ts';
import { setJournalSink } from '../src/platform/logger.ts';
import type { Db } from '../src/platform/db/db.ts';
import { listNotifications } from '../src/notifications/store.ts';
import { createReminder, setRecipients } from '../src/reminders/store.ts';
import { createSpace } from '../src/spaces/store.ts';
import { enqueueOutbox } from '../src/platform/outbox/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from './support/test-db.ts';

let pg: TestDb;
let db: Db;
const lines: string[] = [];

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setJournalSink((line) => lines.push(line));
});

afterAll(async () => {
  setJournalSink(null);
  vi.unstubAllEnvs();
  await closeTestDb(pg).catch(() => undefined);
});

const events = (): Array<Record<string, unknown>> => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe('outbox module (reminders and email inside the web server)', () => {
  it('is registered with the server background work', () => {
    expect(apiModules).toContain(outboxModule);
    expect(apiModules.findIndex((module) => module.name === 'routines')).toBeLessThan(apiModules.indexOf(outboxModule));
  });

  it('hands routine run references to the queue through the existing drain', async () => {
    const runId = randomUUID();
    await enqueueOutbox(db, [{ spaceId: null, eventType: 'routine.dispatch', resourceType: 'routine_run',
      resourceId: runId, effectKey: `routine-test:${runId}`, payload: { resource_id: runId } }]);
    let received: () => void = () => undefined;
    const delivered = new Promise<void>((resolve) => { received = resolve; });
    const send = vi.fn(async () => { received(); });
    const deps = { getDb: async () => db, deviceSessions: { announce: vi.fn() },
      routineJobs: { start: vi.fn(), stop: vi.fn(), send } } as unknown as AppDeps;
    const stop = await outboxModule.start?.(deps);
    try {
      await delivered;
      expect(send).toHaveBeenCalledExactlyOnceWith(runId);
    } finally { await stop?.(); }
  });

  it('starting it delivers a due reminder to the inbox, rings the device and drains its email row', async () => {
    vi.stubEnv('BOB_NOTIFY_EMAIL_URL', '');
    const user = (await addAccount(pg)).userId;
    const space = await createSpace(db, user, { kind: 'group', name: 'Home' });
    const reminder = await createReminder(db, user, space.id, { title: 'water the plants',
      due: { kind: 'instant', at: Date.now() - 30_000, zone: 'UTC' } });
    await setRecipients(db, user, reminder.id, [user]);
    const rung: string[] = [];
    const deps = {
      getDb: async () => db,
      deviceSessions: { announce: (userId: string, announcement: { announce_id: string }) => {
        if (userId === user) rung.push(announcement.announce_id);
      } },
    } as unknown as AppDeps;

    const stop = await outboxModule.start!(deps);
    try {
      await vi.waitFor(() => {
        expect(rung).toHaveLength(1);
        expect(events().filter((e) => e.event === 'v2.email_notification_skipped'))
          .toContainEqual(expect.objectContaining({ reason: 'not_configured' }));
      }, { timeout: 15_000, interval: 100 });
    } finally {
      await stop();
    }
    const inbox = (await listNotifications(db, user, { limit: 10 })).filter((n) => n.resourceId === reminder.id);
    expect(inbox).toHaveLength(1);
    expect(events().map((e) => e.event)).toEqual(expect.arrayContaining(
      ['v2.outbox_worker_started', 'v2.reminder_fanout', 'v2.notifications_enqueued']));
  }, 30_000);
});
