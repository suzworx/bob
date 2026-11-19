// Reminder fanout tests (API-TIME): a due occurrence becomes exactly one
// 'reminder' notification for its recipient, a second tick adds nothing, and a
// recipient who muted reminders gets nothing while the occurrence is still
// recorded (so it is never retried). #507: a failed enqueue is NOT recorded and
// is delivered exactly once by the next tick (journaled with a reason), and a
// snooze re-delivers one new item to its own recipient once it ends.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createReminderFanout } from '../../src/workflows/workflow-reminder-fire.ts';
import { type Db } from '../../src/platform/db/db.ts';
import { listNotifications, upsertPreference } from '../../src/notifications/store.ts';
import { createReminder, occurrenceEffectKey, setRecipients, snoozeOccurrence } from '../../src/reminders/store.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb,
  withUserRaw } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
// Injected enqueue failures: the next enqueue for a reminder id in `failOnce`
// rejects before writing (other tests' reminders share the tick).
const control = vi.hoisted(() => ({ failOnce: new Set<string>() }));
vi.mock('../../src/notifications/store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/notifications/store.ts')>();
  return {
    ...actual,
    enqueueNotifications: async (...args: Parameters<typeof actual.enqueueNotifications>):
      Promise<void> => {
      const hit = args[1].find((row) => control.failOnce.has(row.resourceId));
      if (hit !== undefined) {
        control.failOnce.delete(hit.resourceId);
        throw new Error('enqueue down');
      }
      return actual.enqueueNotifications(...args);
    },
  };
});

afterEach(() => {
  control.failOnce.clear();
  vi.restoreAllMocks();
});

let pg: TestDb;
let db: Db;
let owner: TestAccount;
let spaceId: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  owner = await addAccount(pg);
  spaceId = (await createSpace(db, owner.userId, { kind: 'group', name: 'Family' })).id;
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

async function freshMember(): Promise<TestAccount> {
  const account = await addAccount(pg);
  await addMember(db, owner.userId, spaceId, account.userId, 'member');
  return account;
}

async function dueReminder(recipients: string[], due: number): Promise<string> {
  const reminder = await createReminder(db, owner.userId, spaceId, {
    title: 'water the plants',
    due: { kind: 'instant', at: due, zone: 'Asia/Kolkata' },
  });
  await setRecipients(db, owner.userId, reminder.id, recipients);
  return reminder.id;
}

async function remindersFor(userId: string, reminderId: string) {
  const all = await listNotifications(db, userId, { limit: 100 });
  return all.filter((n) => n.resourceId === reminderId);
}

describe('reminder fanout', () => {
  it('a due occurrence enqueues one notification, and a second tick adds none', async () => {
    const recipient = await freshMember();
    const due = Date.now() - 60_000;
    const reminderId = await dueReminder([recipient.userId], due);
    const fanout = createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => due + 1_000 });

    expect(await fanout.tick()).toBeGreaterThanOrEqual(1);
    let rows = await remindersFor(recipient.userId, reminderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'reminder',
      resourceType: 'reminder',
      spaceId,
      revision: 1,
      effectKey: occurrenceEffectKey({
        reminderId, userId: recipient.userId, occurrenceAt: due, scheduleRevision: 1,
      }),
    });

    expect(await fanout.tick()).toBe(0);
    rows = await remindersFor(recipient.userId, reminderId);
    expect(rows).toHaveLength(1);
  });

  it('a muted recipient gets nothing and the occurrence is not retried', async () => {
    const recipient = await freshMember();
    await upsertPreference(db, recipient.userId, { type: 'reminder', muted: true });
    const due = Date.now() - 30_000;
    const reminderId = await dueReminder([recipient.userId], due);
    const fanout = createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => due + 1_000 });

    expect(await fanout.tick()).toBe(0);
    expect(await remindersFor(recipient.userId, reminderId)).toHaveLength(0);

    await upsertPreference(db, recipient.userId, { type: 'reminder', muted: false });
    await fanout.tick();
    expect(await remindersFor(recipient.userId, reminderId)).toHaveLength(0);
  });

  it('an hourly reminder notifies once per slot inside its window, and a backlog once (#456)', async () => {
    const recipient = await freshMember();
    const reminder = await createReminder(db, owner.userId, spaceId, {
      title: 'have water',
      due: { kind: 'instant', at: Date.parse('2026-01-05T08:00:00+05:30'), zone: 'Asia/Kolkata' },
      rrule: { freq: 'hourly', window: { start: '08:00', end: '22:00' } },
    });
    await setRecipients(db, owner.userId, reminder.id, [recipient.userId]);
    const at = (local: string): (() => number) => () => Date.parse(`2026-01-05T${local}+05:30`);

    // 08:00, 09:00 and 10:00 were missed: one catch-up, not three.
    await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: at('10:00:30') }).tick();
    expect(await remindersFor(recipient.userId, reminder.id)).toHaveLength(1);
    // 11:00 is its own ring; a second tick in the same minute adds nothing.
    await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: at('11:00:30') }).tick();
    await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: at('11:00:40') }).tick();
    expect(await remindersFor(recipient.userId, reminder.id)).toHaveLength(2);
    // After the 22:00 ring, nothing until 08:00 the next morning.
    await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: at('22:00:30') }).tick();
    await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => Date.parse('2026-01-06T07:59:00+05:30') }).tick();
    expect(await remindersFor(recipient.userId, reminder.id)).toHaveLength(3);
  });

  it('#507 c1: a failed enqueue is not recorded; the next tick delivers it exactly once', async () => {
    const recipient = await freshMember();
    const due = Date.now() - 45_000;
    const reminderId = await dueReminder([recipient.userId], due);
    const fanout = createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => due + 1_000 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    control.failOnce.add(reminderId);
    await fanout.tick();
    expect(await remindersFor(recipient.userId, reminderId)).toHaveLength(0);
    const failures = log.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((entry) => entry.event === 'v2.reminder_delivery_failed');
    expect(failures).toEqual([{ ts: expect.any(String), level: 'error', message: 'v2.reminder_delivery_failed', source: 'api', module: 'reminders', conversation_id: 'none', conversation_source: 'none',
      event: 'v2.reminder_delivery_failed',
      reason: 'enqueue_failed', reminder_id: reminderId, user_id: recipient.userId }]);

    await fanout.tick();
    expect(await remindersFor(recipient.userId, reminderId)).toHaveLength(1);
    await fanout.tick();
    expect(await remindersFor(recipient.userId, reminderId)).toHaveLength(1);
  });

  it('#507 c4: replaying a tick around an injected failure never duplicates a row', async () => {
    const [a, b] = [await freshMember(), await freshMember()];
    const due = Date.now() - 40_000;
    const reminderId = await dueReminder([a.userId, b.userId], due);
    const fanout = createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => due + 1_000 });

    // The first recipient's enqueue fails, the second's succeeds; then replay twice.
    control.failOnce.add(reminderId);
    await fanout.tick();
    await fanout.tick();
    await fanout.tick();
    for (const user of [a, b]) {
      const rows = await remindersFor(user.userId, reminderId);
      expect(rows).toHaveLength(1);
      expect(new Set(rows.map((row) => row.effectKey)).size).toBe(rows.length);
    }
  });

  it('#507 c3: a 10-minute snooze re-delivers once to its recipient only', async () => {
    const [snoozer, other] = [await freshMember(), await freshMember()];
    const due = Date.now() - 35_000;
    const reminderId = await dueReminder([snoozer.userId, other.userId], due);
    const at = due + 1_000;
    await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => at }).tick();

    const occurrence = await withUserRaw(pg, snoozer.userId, (tx) => tx.query<{ id: string }>(
      'SELECT id FROM bob.reminder_occurrences WHERE reminder_id = $1', [reminderId]));
    const until = at + 10 * 60_000;
    await snoozeOccurrence(db, snoozer.userId, occurrence.rows[0]!.id, until);

    await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => until - 1_000 }).tick();
    expect(await remindersFor(snoozer.userId, reminderId)).toHaveLength(1);

    await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => until }).tick();
    await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => until + 5_000 }).tick();
    const rows = await remindersFor(snoozer.userId, reminderId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.effectKey)).toContain(`${occurrenceEffectKey({ reminderId,
      userId: snoozer.userId, occurrenceAt: due, scheduleRevision: 1 })}:snooze:${until}`);
    expect(await remindersFor(other.userId, reminderId)).toHaveLength(1);
  });

  it('two servers ticking at once notify and ring one occurrence once (deploy overlap)', async () => {
    const recipient = await freshMember();
    const due = Date.now() - 50_000;
    const reminderId = await dueReminder([recipient.userId], due);
    const rung: string[] = [];
    const server = (): ReturnType<typeof createReminderFanout> => createReminderFanout({ db, now: () => due + 1_000,
      announce: (_userId, announcement) => { rung.push(announcement.announce_id); } });

    await Promise.all([server().tick(), server().tick()]);
    expect(await remindersFor(recipient.userId, reminderId)).toHaveLength(1);
    expect(rung.filter((id) => id.includes(reminderId))).toHaveLength(1);
  });

  it('an occurrence due more than 24 h ago is recorded, journaled as stale, and never notified', async () => {
    const recipient = await freshMember();
    const due = Date.now() - 3 * 24 * 60 * 60_000;
    const reminderId = await dueReminder([recipient.userId], due);
    const rung: string[] = [];
    const now = Date.now();
    const fanout = createReminderFanout({ db, now: () => now,
      announce: (_userId, announcement) => { rung.push(announcement.announce_id); } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await fanout.tick();
    expect(await remindersFor(recipient.userId, reminderId)).toHaveLength(0);
    expect(rung.filter((id) => id.includes(reminderId))).toHaveLength(0);
    const summaries = log.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((entry) => entry.event === 'v2.reminder_fanout');
    // Other tests' reminders share the tick, so only this one's stale count is pinned from below.
    expect(summaries.at(-1)?.stale).toBeGreaterThanOrEqual(1);
    // Recorded as handled: the next tick does not pick it up again.
    const recorded = await withUserRaw(pg, recipient.userId, (tx) => tx.query<{ id: string }>(
      'SELECT id FROM bob.reminder_occurrences WHERE reminder_id = $1', [reminderId]));
    expect(recorded.rows).toHaveLength(1);
    await fanout.tick();
    expect(await remindersFor(recipient.userId, reminderId)).toHaveLength(0);
  });

  it('tick never throws when the store fails', async () => {
    const broken: Db = {
      query: () => Promise.reject(new Error('down')),
      tx: () => Promise.reject(new Error('down')),
    };
    await expect(createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db: broken }).tick()).resolves.toBe(0);
  });
});
