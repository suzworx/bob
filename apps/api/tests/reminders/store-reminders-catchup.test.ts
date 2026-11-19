// store/reminders.ts catch-up fixes (S14-REMINDERS-CATCHUP). Guards the two
// defects a review found in `dueOccurrences` and the "at most one catch-up per
// recipient" contract (spec.md:92). Runs against REAL Postgres on the local
// stack as bob_server via createTestDb + asDb -- a superuser connection would
// bypass RLS, proving nothing. Each test names the defect it
// guards; test 1 must fail against the pre-fix code.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Db } from '../../src/platform/db/db.ts';
import { createSpace, addMember } from '../../src/spaces/store.ts';
import {
  cancelReminder,
  createReminder,
  dueOccurrences,
  recordOccurrence,
  setRecipients,
  updateReminder,
  type StoredReminder,
} from '../../src/reminders/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

// The whole file shares ONE real-Postgres database (like the other store
// tests), and dueOccurrences scans every active reminder across every space.
// Each test cancels the reminders it created so they drop out of the fanout
// source and never leak into a later test's scan.
let created: Array<{ id: string; userId: string }> = [];

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

beforeEach(() => {
  created = [];
});

afterEach(async () => {
  for (const { id, userId } of created) {
    await cancelReminder(db, userId, id).catch(() => undefined);
  }
});

/** A group space owned by `owner` with `members` added as 'member'. */
async function makeSpace(ownerId: string, name: string, members: string[]): Promise<{ id: string }> {
  const space = await createSpace(db, ownerId, { kind: 'group', name });
  for (const member of members) {
    await addMember(db, ownerId, space.id, member, 'member');
  }
  return space;
}

/** Creates a reminder with recipients and returns it. */
async function makeReminder(
  creatorId: string,
  spaceId: string,
  recipients: string[],
  input: Parameters<typeof createReminder>[3],
): Promise<StoredReminder> {
  const reminder = await createReminder(db, creatorId, spaceId, input);
  await setRecipients(db, creatorId, reminder.id, recipients);
  created.push({ id: reminder.id, userId: creatorId });
  return reminder;
}

/** Anchors a daily 09:00 UTC reminder on Jan 5 2026 and gives it one recipient. */
function dailyAt(ownerId: string, spaceId: string, recipient: string): Promise<StoredReminder> {
  return makeReminder(ownerId, spaceId, [recipient], {
    title: 'daily',
    due: { kind: 'instant', at: Date.UTC(2026, 0, 5, 9, 0, 0), zone: 'UTC' },
    rrule: { freq: 'daily' },
  });
}

describe('reminders catch-up (S14)', () => {
  it('defect 1: a daily reminder whose first `limit` occurrences are all recorded STILL yields the next one', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Die', [b.userId]);
    const reminder = await dailyAt(a.userId, space.id, b.userId);

    const limit = 3;
    // Record the first three daily instants (Jan 5, 6, 7), one scan per day so
    // each is a single ordinary occurrence rather than a collapsed catch-up.
    for (const day of [6, 7, 8]) {
      const one = await dueOccurrences(db, { now: Date.UTC(2026, 0, day) });
      expect(one).toHaveLength(1);
      expect(one[0]!.occurrenceAt).toBe(Date.UTC(2026, 0, day - 1, 9, 0, 0));
      expect(await recordOccurrence(db, one[0]!)).toBe(true);
    }

    // Next scan: the current code re-expands the anchor with the same limit,
    // which regenerates exactly the three recorded instants and returns nothing
    // -- the reminder dies forever. The fix advances the lower bound past the
    // last recorded occurrence (Jan 7) and yields the next one (Jan 8).
    const next = await dueOccurrences(db, { now: Date.UTC(2026, 0, 9), limit });
    expect(next).toHaveLength(1);
    expect(next[0]!.reminderId).toBe(reminder.id);
    expect(next[0]!.occurrenceAt).toBe(Date.UTC(2026, 0, 8, 9, 0, 0));
    expect(next[0]!.catchUp).toBe(false);
  });

  it('defect 2: an outage across many due times yields exactly ONE occurrence per recipient, the most recent missed instant', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const c = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Outage', [b.userId, c.userId]);
    await makeReminder(a.userId, space.id, [b.userId, c.userId], {
      title: 'daily',
      due: { kind: 'instant', at: Date.UTC(2026, 0, 5, 9, 0, 0), zone: 'UTC' },
      rrule: { freq: 'daily' },
    });

    // Nothing recorded; service resumes 16 days later. The backlog spans
    // Jan 5-20; each recipient must get exactly one key at the MOST RECENT
    // missed instant (Jan 20), not a flood of 16 each.
    const dueList = await dueOccurrences(db, { now: Date.UTC(2026, 0, 21) });
    expect(dueList).toHaveLength(2);
    for (const d of dueList) {
      expect(d.occurrenceAt).toBe(Date.UTC(2026, 0, 20, 9, 0, 0));
      expect(d.catchUp).toBe(true);
    }
  });

  it('a collapsed backlog is a catch-up; an ordinary single due occurrence is not', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Flag', [b.userId]);

    // Ordinary: exactly one due instant -> not a catch-up.
    await dailyAt(a.userId, space.id, b.userId);
    const ordinary = await dueOccurrences(db, { now: Date.UTC(2026, 0, 6) });
    expect(ordinary).toHaveLength(1);
    expect(ordinary[0]!.catchUp).toBe(false);

    // Backlog: a second reminder, this one offline for several days -> collapse
    // is flagged as a catch-up.
    await makeReminder(a.userId, space.id, [b.userId], {
      title: 'late',
      due: { kind: 'instant', at: Date.UTC(2026, 1, 1, 9, 0, 0), zone: 'UTC' },
      rrule: { freq: 'daily' },
    });
    const collapsed = await dueOccurrences(db, { now: Date.UTC(2026, 1, 10) });
const flagged = collapsed.find((d) => d.occurrenceAt === Date.UTC(2026, 1, 9, 9, 0, 0))!;
    expect(flagged.catchUp).toBe(true);
  });

  it('after a catch-up, the next scan resumes normal scheduling and does not re-emit the backlog', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Resume', [b.userId]);
    await dailyAt(a.userId, space.id, b.userId);

    // Outage resumed Jan 21: the backlog collapses to the most recent missed
    // instant (Jan 20), which we record as the new high-water mark.
    const back = await dueOccurrences(db, { now: Date.UTC(2026, 0, 21) });
    expect(back).toHaveLength(1);
    expect(back[0]!.occurrenceAt).toBe(Date.UTC(2026, 0, 20, 9, 0, 0));
    expect(back[0]!.catchUp).toBe(true);
    expect(await recordOccurrence(db, back[0]!)).toBe(true);

    // Next scan: exactly one ordinary occurrence at Jan 21, and NOTHING from
    // the Jan 6-19 backlog -- it cannot re-appear because the lower bound
    // advanced past it once the catch-up was recorded.
    const next = await dueOccurrences(db, { now: Date.UTC(2026, 0, 22) });
    expect(next).toHaveLength(1);
    expect(next[0]!.occurrenceAt).toBe(Date.UTC(2026, 0, 21, 9, 0, 0));
    expect(next[0]!.catchUp).toBe(false);
  });

  it('bumping schedule_revision re-opens occurrences without inheriting the old revision high-water mark', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'RevBump', [b.userId]);
    const reminder = await dailyAt(a.userId, space.id, b.userId);

    // Record one revision-1 occurrence so its high-water mark (Jan 11) sits
    // ABOVE the soon-to-be new anchor.
    const rev1 = await dueOccurrences(db, { now: Date.UTC(2026, 0, 12) });
    expect(rev1[0]!.occurrenceAt).toBe(Date.UTC(2026, 0, 11, 9, 0, 0));
    expect(await recordOccurrence(db, rev1[0]!)).toBe(true);

    // A PATCH that moves the due to Jan 9 bumps the revision. Under revision 2
    // the latest recorded occurrence MUST be null (revision 1's Jan 11 must not
    // become the lower bound, or the new anchor would be skipped entirely).
    const updated = await updateReminder(db, a.userId, reminder.id, {
      due: { kind: 'instant', at: Date.UTC(2026, 0, 9, 9, 0, 0), zone: 'UTC' },
    });
    expect(updated.scheduleRevision).toBe(2);

    const reopen = await dueOccurrences(db, { now: Date.UTC(2026, 0, 10) });
    expect(reopen).toHaveLength(1);
    expect(reopen[0]!.scheduleRevision).toBe(2);
    expect(reopen[0]!.occurrenceAt).toBe(Date.UTC(2026, 0, 9, 9, 0, 0));
    expect(reopen[0]!.catchUp).toBe(false);
  });

  it('a one-shot (rrule null) reminder is unaffected', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'OneShot', [b.userId]);
    const reminder = await makeReminder(a.userId, space.id, [b.userId], {
      title: 'once',
      due: { kind: 'instant', at: Date.UTC(2026, 0, 5, 9, 0, 0), zone: 'UTC' },
    });

    const due = await dueOccurrences(db, { now: Date.UTC(2026, 0, 6) });
    expect(due).toHaveLength(1);
    expect(due[0]!.occurrenceAt).toBe(Date.UTC(2026, 0, 5, 9, 0, 0));
    expect(due[0]!.catchUp).toBe(false);
    expect(await recordOccurrence(db, due[0]!)).toBe(true);
    // Recorded one-shot produces nothing on a replay scan.
    expect(await dueOccurrences(db, { now: Date.UTC(2026, 0, 6) })).toHaveLength(0);
    expect(reminder.scheduleRevision).toBe(1);
  });

  it('the global limit caps the returned keys, and one old backlog cannot consume it all', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Cap', [b.userId]);

    // An old daily reminder down for 20 days (Jan 5-24).
    const old = await dailyAt(a.userId, space.id, b.userId);
    // Three other reminders that are also due this scan.
    const r2 = await makeReminder(a.userId, space.id, [b.userId], {
      title: 'r2',
      due: { kind: 'instant', at: Date.UTC(2026, 0, 20, 9, 0, 0), zone: 'UTC' },
    });
    const r3 = await makeReminder(a.userId, space.id, [b.userId], {
      title: 'r3',
      due: { kind: 'instant', at: Date.UTC(2026, 0, 21, 9, 0, 0), zone: 'UTC' },
    });
    await makeReminder(a.userId, space.id, [b.userId], {
      title: 'r4',
      due: { kind: 'instant', at: Date.UTC(2026, 0, 22, 9, 0, 0), zone: 'UTC' },
    });

    const limit = 3;
    const out = await dueOccurrences(db, { now: Date.UTC(2026, 0, 25), limit });
    // The cap still bounds the returned keys.
    expect(out.length).toBeLessThanOrEqual(limit);
    // The 20-instant backlog collapses to ONE key for the old reminder...
    expect(out.filter((d) => d.reminderId === old.id)).toHaveLength(1);
    // ...so it cannot eat the whole limit: at least one other reminder (r2) is
    // still delivered this scan. Pre-fix code would have the old reminder fill
    // all three limit slots and starve every other due reminder.
    expect(out.some((d) => d.reminderId === r2.id)).toBe(true);
    expect(out.some((d) => d.reminderId === r3.id)).toBe(true);
  });
});
describe('hourly reminders catch-up (#456)', () => {
  /** Every 2 hours from 08:00 to 22:00 Kolkata (+05:30), anchored on Jan 5 2026 at 08:00. */
  function hourlyAt(ownerId: string, spaceId: string, recipient: string): Promise<StoredReminder> {
    return makeReminder(ownerId, spaceId, [recipient], {
      title: 'water',
      due: { kind: 'instant', at: Date.UTC(2026, 0, 5, 2, 30), zone: 'Asia/Kolkata' },
      rrule: { freq: 'hourly', interval: 2, window: { start: '08:00', end: '22:00' } },
    });
  }

  it('rings each slot inside the window as its own ordinary occurrence, and nothing overnight', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Hourly', [b.userId]);
    await hourlyAt(a.userId, space.id, b.userId);

    const first = await dueOccurrences(db, { now: Date.UTC(2026, 0, 5, 2, 31) });
    expect(first).toHaveLength(1);
    expect(first[0]!).toMatchObject({ occurrenceAt: Date.UTC(2026, 0, 5, 2, 30), catchUp: false });
    expect(await recordOccurrence(db, first[0]!)).toBe(true);

    // 10:00 local is the next slot; 09:00 is not one (every 2 hours).
    expect(await dueOccurrences(db, { now: Date.UTC(2026, 0, 5, 4, 0) })).toHaveLength(0);
    const second = await dueOccurrences(db, { now: Date.UTC(2026, 0, 5, 4, 31) });
    expect(second[0]!).toMatchObject({ occurrenceAt: Date.UTC(2026, 0, 5, 4, 30), catchUp: false });
    expect(await recordOccurrence(db, second[0]!)).toBe(true);
  });

  it('a months-long backlog collapses to ONE catch-up at the newest slot, then resumes', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'HourlyOutage', [b.userId]);
    await hourlyAt(a.userId, space.id, b.userId);

    // Three months later at 23:00 local (17:30 UTC): the newest slot is 22:00 local.
    const back = await dueOccurrences(db, { now: Date.UTC(2026, 3, 5, 17, 30) });
    expect(back).toHaveLength(1);
    expect(back[0]!).toMatchObject({ occurrenceAt: Date.UTC(2026, 3, 5, 16, 30), catchUp: true });
    expect(await recordOccurrence(db, back[0]!)).toBe(true);

    // Overnight nothing rings; the next ring is 08:00 local the next day.
    expect(await dueOccurrences(db, { now: Date.UTC(2026, 3, 6, 2, 0) })).toHaveLength(0);
    const morning = await dueOccurrences(db, { now: Date.UTC(2026, 3, 6, 2, 31) });
    expect(morning).toHaveLength(1);
    expect(morning[0]!).toMatchObject({ occurrenceAt: Date.UTC(2026, 3, 6, 2, 30), catchUp: false });
  });

  it('refuses an hourly rule the engine cannot honour', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'HourlyBad', []);
    const due = { kind: 'instant' as const, at: Date.UTC(2026, 0, 5, 9, 0), zone: 'UTC' };
    await expect(createReminder(db, a.userId, space.id, { title: 'x', due, rrule: { freq: 'hourly', interval: 24 } }))
      .rejects.toThrow(/1 to 12/);
    await expect(createReminder(db, a.userId, space.id, {
      title: 'x', due, rrule: { freq: 'hourly', window: { start: '22:00', end: '06:00' } },
    })).rejects.toThrow(/start before/);
    const ok = await makeReminder(a.userId, space.id, [a.userId], { title: 'x', due, rrule: { freq: 'daily' } });
    await expect(updateReminder(db, a.userId, ok.id, { rrule: { freq: 'hourly', interval: 13 } }))
      .rejects.toThrow(/1 to 12/);
  });
});
