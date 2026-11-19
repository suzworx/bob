// store/reminders.ts tests (S14-REMINDERS-STORE). Real Postgres (createTestDb), same
// setup as store-tasks.test.ts. Exercises the three acceptance criteria
// through real RLS: per-recipient delivery and private snooze, cancelled /
// task-completed producing nothing on resume, and the unique
// (recipient, occurrence, schedule revision) key that makes a replay a no-op
// and a revision bump un-match the old queue -- plus the pure effect-key seam.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreNotFoundError, type Db } from '../../src/platform/db/db.ts';
import { expandOccurrences } from '../../src/calendar/recurrence.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { completeTask, createTask } from '../../src/tasks/store.ts';
import {
  acknowledgeOccurrence,
  cancelReminder,
  clearEndedSnooze,
  createReminder,
  dueOccurrences,
  getReminder,
  occurrenceEffectKey,
  recordOccurrence,
  setRecipients,
  snoozeOccurrence,
  updateReminder,
  type DueOccurrence,
  type OccurrenceKey,
  type StoredReminder,
} from '../../src/reminders/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb, withUserRaw } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

/** Creates a group space owned by `owner` with `members` added as 'member'. */
async function makeSpace(ownerId: string, name: string, members: string[] = []): Promise<{ id: string }> {
  const space = await createSpace(db, ownerId, { kind: 'group', name });
  for (const member of members) {
    await addMember(db, ownerId, space.id, member, 'member');
  }
  return space;
}

/** Creates a reminder with the given recipients and returns it. */
async function makeReminder(
  creatorId: string,
  spaceId: string,
  recipients: string[],
  input: Parameters<typeof createReminder>[3],
): Promise<StoredReminder> {
  const reminder = await createReminder(db, creatorId, spaceId, input);
  await setRecipients(db, creatorId, reminder.id, recipients);
  return reminder;
}

type OccurrenceRow = { id: string; userId: string; snoozedUntil: number | null };

/**
 * Reads one reminder's occurrence rows AS EACH RECIPIENT and merges them.
 *
 * This used to read directly, and said so: "the test Db bypasses RLS". That was
 * true on the old superuser test engine. On real Postgres the connection is
 * bob_server, and reminder_occurrences lets each person see only their OWN
 * rows -- so no single account can see every recipient's delivery, and an
 * admin read would bypass a table that has per-user policies. Reading as each
 * recipient is the honest equivalent, and a stronger check: it proves every
 * recipient can see their own occurrence, which is what the policy promises.
 */
async function occurrenceRows(reminderId: string, recipientIds: string[]): Promise<OccurrenceRow[]> {
  const all: OccurrenceRow[] = [];
  for (const userId of recipientIds) {
    const result = await withUserRaw(pg, userId, (tx) =>
      tx.query<{ id: string; userId: string; snoozedUntil: string | number | null }>(
        `SELECT id, user_id AS "userId",
                floor(extract(epoch from snoozed_until) * 1000)::bigint AS "snoozedUntil"
         FROM bob.reminder_occurrences
         WHERE reminder_id = $1`,
        [reminderId],
      ),
    );
    for (const row of result.rows) {
      // postgres.js returns a bigint as a string.
      all.push({ ...row, snoozedUntil: row.snoozedUntil === null ? null : Number(row.snoozedUntil) });
    }
  }
  return all.sort((x, y) => x.userId.localeCompare(y.userId));
}

/** The wall 'HH:mm' an instant occupies in America/Toronto (for DST asserts). */
function wallTime(at: number): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Toronto',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(at);
  const g: Record<string, string | undefined> = {};
  for (const p of parts) if (p.type !== 'literal') g[p.type] = p.value;
  return `${g.hour!}:${g.minute!}`;
}

describe('reminders store', () => {
  it('criterion 1a: a one-shot reminder for two recipients yields exactly one occurrence per recipient', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const c = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Remind', [b.userId, c.userId]);
    const due = Date.UTC(2026, 0, 5, 9, 0, 0);
    const reminder = await makeReminder(a.userId, space.id, [b.userId, c.userId], {
      title: 'standup',
      due: { kind: 'instant', at: due, zone: 'Asia/Kolkata' },
    });

    const dueList = await dueOccurrences(db, { now: Date.UTC(2026, 1, 1) });
    expect(dueList).toHaveLength(2);
    const users = dueList.map((d) => d.userId).sort();
    expect(users).toEqual([b.userId, c.userId].sort());
    // Same occurrence instant and revision for both recipients.
    expect(dueList[0]!.occurrenceAt).toBe(dueList[1]!.occurrenceAt);
    expect(dueList[0]!.scheduleRevision).toBe(1);
    expect(dueList.every((d) => d.reminderId === reminder.id)).toBe(true);

    // Recording both, a re-run yields nothing new (each recipient = one row).
    for (const d of dueList) await recordOccurrence(db, d);
    expect(await dueOccurrences(db, { now: Date.UTC(2026, 1, 1) })).toHaveLength(0);
    expect(await occurrenceRows(reminder.id, [b.userId, c.userId])).toHaveLength(2);
  });

  it('criterion 1b: snoozing one recipient leaves the other untouched', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const c = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Snooze', [b.userId, c.userId]);
    const due = Date.UTC(2026, 0, 5, 9, 0, 0);
    const reminder = await makeReminder(a.userId, space.id, [b.userId, c.userId], {
      title: 'review',
      due: { kind: 'instant', at: due, zone: 'Asia/Kolkata' },
    });

    const dueList = await dueOccurrences(db, { now: Date.UTC(2026, 1, 1) });
    for (const d of dueList) await recordOccurrence(db, d);
    const rows = await occurrenceRows(reminder.id, [b.userId, c.userId]);
    expect(rows).toHaveLength(2);

    const bRow = rows.find((r) => r.userId === b.userId)!;
    const cRow = rows.find((r) => r.userId === c.userId)!;
    const until = Date.UTC(2026, 1, 2, 10, 0, 0);
    await snoozeOccurrence(db, b.userId, bRow.id, until);

    const after = await occurrenceRows(reminder.id, [b.userId, c.userId]);
    expect(after.find((r) => r.userId === b.userId)!.snoozedUntil).toBe(until);
    expect(after.find((r) => r.userId === c.userId)!.snoozedUntil).toBeNull();
  });

  it('#507: an ended snooze is due again for its own recipient only, until cleared', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const c = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Snooze again', [b.userId, c.userId]);
    const due = Date.UTC(2026, 0, 6, 9, 0, 0);
    const reminder = await makeReminder(a.userId, space.id, [b.userId, c.userId], {
      title: 'call back',
      due: { kind: 'instant', at: due, zone: 'Asia/Kolkata' },
    });
    const mine = async (now: number): Promise<DueOccurrence[]> =>
      (await dueOccurrences(db, { now })).filter((d) => d.reminderId === reminder.id);

    for (const d of await mine(due + 1_000)) await recordOccurrence(db, d);
    const bRow = (await occurrenceRows(reminder.id, [b.userId])).find((r) => r.userId === b.userId)!;
    const until = due + 11 * 60_000;
    await snoozeOccurrence(db, b.userId, bRow.id, until);

    expect(await mine(until - 1)).toHaveLength(0);
    expect(await mine(until)).toEqual([{ reminderId: reminder.id, userId: b.userId, occurrenceAt: due,
      scheduleRevision: 1, catchUp: false, occurrenceId: bRow.id, snoozedUntil: until }]);

    // A re-snooze to a later time is not cleared by the earlier delivery.
    await snoozeOccurrence(db, b.userId, bRow.id, until + 60_000);
    expect(await clearEndedSnooze(db, b.userId, bRow.id, until)).toBe(false);
    expect(await mine(until + 60_000)).toHaveLength(1);
    expect(await clearEndedSnooze(db, b.userId, bRow.id, until + 60_000)).toBe(true);
    expect(await mine(until + 120_000)).toHaveLength(0);
    // An acknowledged occurrence is never re-delivered, even with a snooze set.
    await snoozeOccurrence(db, b.userId, bRow.id, until);
    await acknowledgeOccurrence(db, b.userId, bRow.id);
    expect(await mine(until + 120_000)).toHaveLength(0);
  });

  it('criterion 3 + revision: bumping schedule_revision un-matches the old queue', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Rev', [b.userId]);
    const due1 = Date.UTC(2026, 0, 5, 9, 0, 0);
    const due2 = Date.UTC(2026, 0, 9, 9, 0, 0);
    const reminder = await makeReminder(a.userId, space.id, [b.userId], {
      title: 'reschedule',
      due: { kind: 'instant', at: due1, zone: 'Asia/Kolkata' },
    });

    const first = (await dueOccurrences(db, { now: Date.UTC(2026, 1, 1) }))[0]!;
    expect(first.scheduleRevision).toBe(1);
    expect(await recordOccurrence(db, first)).toBe(true);

    // A PATCH that changes the due bumps the revision.
    const updated = await updateReminder(db, a.userId, reminder.id, {
      due: { kind: 'instant', at: due2, zone: 'Asia/Kolkata' },
    });
    expect(updated.scheduleRevision).toBe(2);

    // The old (recipient, occurrence, revision=1) replay is a no-op.
    expect(await recordOccurrence(db, first)).toBe(false);

    // The new revision yields fresh rows, distinct from the old.
    const second = (await dueOccurrences(db, { now: Date.UTC(2026, 1, 1) }))[0]!;
    expect(second.occurrenceAt).toBe(due2);
    expect(second.scheduleRevision).toBe(2);
    expect(await recordOccurrence(db, second)).toBe(true);
    expect(await occurrenceRows(reminder.id, [b.userId])).toHaveLength(2);
  });

  it('criterion 2a: a cancelled reminder produces no due occurrences', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Cancel', [b.userId]);
    const reminder = await makeReminder(a.userId, space.id, [b.userId], {
      title: 'doomed',
      due: { kind: 'instant', at: Date.UTC(2026, 0, 5, 9, 0, 0), zone: 'Asia/Kolkata' },
    });

    expect(await dueOccurrences(db, { now: Date.UTC(2026, 1, 1) })).toHaveLength(1);
    await cancelReminder(db, a.userId, reminder.id);
    expect(await dueOccurrences(db, { now: Date.UTC(2026, 1, 1) })).toHaveLength(0);
  });

  it('criterion 2b: a reminder whose linked task is completed produces no due occurrences', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'TaskDone', [b.userId]);
    const task = await createTask(db, a.userId, space.id, { title: 'pay the plumber' });
    await makeReminder(a.userId, space.id, [b.userId], {
      title: 'follow up',
      taskId: task.id,
      due: { kind: 'instant', at: Date.UTC(2026, 0, 5, 9, 0, 0), zone: 'Asia/Kolkata' },
    });

    expect(await dueOccurrences(db, { now: Date.UTC(2026, 1, 1) })).toHaveLength(1);
    await completeTask(db, a.userId, task.id);
    expect(await dueOccurrences(db, { now: Date.UTC(2026, 1, 1) })).toHaveLength(0);
  });

  it('criterion 3: recordOccurrence twice is one row', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Replay', [b.userId]);
    const due = Date.UTC(2026, 0, 5, 9, 0, 0);
    const reminder = await makeReminder(a.userId, space.id, [b.userId], {
      title: 'once only',
      due: { kind: 'instant', at: due, zone: 'Asia/Kolkata' },
    });

    const key = (await dueOccurrences(db, { now: Date.UTC(2026, 1, 1) }))[0]!;
    expect(await recordOccurrence(db, key)).toBe(true);
    expect(await recordOccurrence(db, key)).toBe(false);
    expect(await occurrenceRows(reminder.id, [b.userId])).toHaveLength(1);
  });

  it('occurrenceEffectKey is stable and distinct across all four inputs', async () => {
    const base: OccurrenceKey = {
      reminderId: randomUUID(),
      userId: randomUUID(),
      occurrenceAt: Date.UTC(2026, 0, 5, 9, 0, 0),
      scheduleRevision: 3,
    };
    // Stable: same inputs, same key.
    expect(occurrenceEffectKey(base)).toBe(occurrenceEffectKey({ ...base }));
    // Distinct when ANY single input changes.
    const variants: OccurrenceKey[] = [
      { ...base, reminderId: randomUUID() },
      { ...base, userId: randomUUID() },
      { ...base, occurrenceAt: Date.UTC(2026, 0, 6, 9, 0, 0) },
      { ...base, scheduleRevision: 4 },
    ];
    const keys = variants.map(occurrenceEffectKey);
    expect(new Set([occurrenceEffectKey(base), ...keys]).size).toBe(5);
    // The five parts are recoverable and ordered.
    const parts = occurrenceEffectKey(base).split(':');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('reminder');
    expect(parts[1]).toBe(base.reminderId);
    expect(parts[4]).toBe(String(base.scheduleRevision));
  });

  it('a recurring rule expands through a DST boundary; the wall time holds', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'DST', [b.userId]);
    // Anchored 2025-03-08 08:00 America/Toronto (EST). A daily rule must hold
    // 08:00 across the 2025-03-09 spring-forward gap.
    const anchor = Date.UTC(2025, 2, 8, 13, 0);
    await makeReminder(a.userId, space.id, [b.userId], {
      title: 'morning coffee',
      due: { kind: 'instant', at: anchor, zone: 'America/Toronto' },
      rrule: { freq: 'daily' },
    });

    // The DST property belongs to the recurrence engine, so assert it there:
    // 03-08, 03-09, 03-10 each at 08:00 local, and the gap day shifts the
    // instant's UTC offset from 13:00 to 12:00.
    const direct = expandOccurrences({
      rule: { freq: 'daily' },
      startWallTime: '2025-03-08T08:00',
      zone: 'America/Toronto',
      from: anchor,
      to: Date.UTC(2025, 2, 11),
    });
    expect(direct).toHaveLength(3);
    for (const o of direct) expect(wallTime(o.at)).toBe('08:00');
    expect(new Set(direct.map((o) => new Date(o.at).getUTCHours()))).toEqual(new Set([13, 12]));

    // dueOccurrences applies the fanout contract on top of that expansion.
    // Three overdue instants with nothing recorded is a backlog, and
    // spec.md:92 requires "at most one catch-up item per recipient, without a
    // repetition flood" -- so the recipient gets the most recent missed
    // instant, marked as a catch-up, not all three. The wall time still holds:
    // that is what this test is really about.
    const dueList = await dueOccurrences(db, { now: Date.UTC(2025, 2, 11) });
    expect(dueList).toHaveLength(1);
    expect(dueList[0]!.catchUp).toBe(true);
    expect(wallTime(dueList[0]!.occurrenceAt)).toBe('08:00');
    expect(dueList[0]!.occurrenceAt).toBe(direct[direct.length - 1]!.at);
  });

  it('a non-member gets StoreNotFoundError reading a hidden reminder', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const outsider = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Hidden', [b.userId]);
    const reminder = await makeReminder(a.userId, space.id, [b.userId], {
      title: 'private',
      due: { kind: 'instant', at: Date.UTC(2026, 0, 5, 9, 0, 0), zone: 'Asia/Kolkata' },
    });

    const hidden = await getReminder(db, outsider.userId, reminder.id).catch((error: unknown) => error);
    const missing = await getReminder(db, outsider.userId, randomUUID()).catch((error: unknown) => error);
    expect(hidden).toBeInstanceOf(StoreNotFoundError);
    expect(missing).toBeInstanceOf(StoreNotFoundError);
    expect((hidden as Error).message).toBe((missing as Error).message);
  });
});
/** jsonb_typeof(rrule) for one reminder, read on the engine behind `read`. */
async function rruleType(
  read: (sql: string, params: unknown[]) => Promise<Array<{ t: string | null }>>,
  id: string,
): Promise<string | null> {
  const rows = await read(`SELECT jsonb_typeof(rrule) AS t FROM bob.reminders WHERE id = $1`, [id]);
  return rows[0]?.t ?? null;
}

/** Creates a daily reminder, updates it to hourly, and returns both types. */
async function createAndUpdate(
  target: Db,
  userId: string,
  spaceId: string,
  read: (sql: string, params: unknown[]) => Promise<Array<{ t: string | null }>>,
): Promise<{ created: string | null; updated: string | null }> {
  const reminder = await createReminder(target, userId, spaceId, {
    title: 'water the plants',
    due: { kind: 'instant', at: Date.UTC(2026, 0, 5, 9, 0), zone: 'Asia/Kolkata' },
    rrule: { freq: 'daily' },
  });
  const created = await rruleType(read, reminder.id);
  await updateReminder(target, userId, reminder.id, { rrule: { freq: 'hourly', interval: 2 } });
  return { created, updated: await rruleType(read, reminder.id) };
}

describe('reminder rules are stored as jsonb objects (RRULE-JSONB)', () => {
  it('create and update store an object on Postgres, and an old-server string write still lands', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Rules');
    const read = (sql: string, params: unknown[]): Promise<Array<{ t: string | null }>> =>
      withUserRaw(pg, a.userId, async (tx) => (await tx.query<{ t: string | null }>(sql, params)).rows);
    expect(await createAndUpdate(db, a.userId, space.id, read)).toEqual({ created: 'object', updated: 'object' });

    // The server on main still writes a jsonb string; 20260927020000 dropped the
    // CHECK so it keeps working through the switchover and any rollback.
    const inserted = await withUserRaw(pg, a.userId, (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO bob.reminders (space_id, title, due_at, due_zone, rrule, created_by)
         VALUES ($1, 'old server', now(), 'UTC', to_jsonb('{"freq":"daily"}'::text), $2) RETURNING id`,
        [space.id, a.userId],
      ),
    );
    const id = inserted.rows[0]!.id;
    expect(await rruleType(read, id)).toBe('string');
    expect((await getReminder(db, a.userId, id)).rrule).toEqual({ freq: 'daily' });
  });
});
