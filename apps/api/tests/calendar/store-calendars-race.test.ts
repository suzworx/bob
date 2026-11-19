// Race condition tests for concurrent calendar event edits (SCAN-D5-EVENT-RACE).
// Two concurrent edits at the same revision must have exactly one succeed and one fail.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreConflictError, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createCalendar, createEvent, updateEvent } from '../../src/calendar/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, withUserRaw, type TestDb } from '../support/test-db.ts';
import { waitForLockWaiter } from '../support/lock-barrier.ts';

let pg: TestDb;
let db: Db;

const WEEKLY_START = Date.parse('2026-10-05T09:00:00Z');
const WEEKLY_END = Date.parse('2026-10-05T10:00:00Z');

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

/** Setup: a group space with owner and member, plus a calendar and single event. */
async function setup() {
  const owner = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
  const calendar = await createCalendar(db, owner.userId, space.id, {
    name: 'Home',
    zone: 'Asia/Kolkata',
  });
  const event = await createEvent(db, owner.userId, calendar.id, {
    title: 'Original',
    allDay: false,
    startAt: WEEKLY_START,
    endAt: WEEKLY_END,
    zone: 'UTC',
  });
  return { owner, space, calendar, event };
}

describe('calendar event race conditions', () => {
  it('an edit racing a committed edit at the same revision is refused, not merged', async () => {
    const { owner, event } = await setup();
    const initialRevision = event.revision;

    // Simulate: one writer commits an edit. Start a second save at the same revision;
    // it should block on the lock and then fail with StoreConflictError.
    let updatePromise: Promise<unknown>;
    await withUserRaw(pg, owner.userId, async (tx) => {
      // First writer updates the row directly within the transaction.
      await tx.query(
        `UPDATE bob.calendar_events SET title = $1, revision = revision + 1 WHERE id = $2`,
        ['first', event.id],
      );
      // Start the second writer's updateEvent in parallel (don't await yet).
      updatePromise = updateEvent(db, owner.userId, event.id, 'series', {
        revision: initialRevision,
        patch: { title: 'second' },
      }).catch((e) => e);
      // Wait for the second transaction to block on the lock.
      await waitForLockWaiter(pg);
      // Implicit: transaction closes here, releasing the lock.
    });

    // Now the first transaction has committed, the second can proceed,
    // read revision 2, and fail with StoreConflictError.
    const conflict = await updatePromise!;
    expect(conflict).toBeInstanceOf(StoreConflictError);
    expect((conflict as StoreConflictError).message).toContain('event revision conflict');
  });

  it('two concurrent edits at one revision: exactly one wins', async () => {
    const { owner, event } = await setup();
    const initialRevision = event.revision;

    // Launch two updateEvent calls with the same revision but different titles.
    const result1 = updateEvent(db, owner.userId, event.id, 'series', {
      revision: initialRevision,
      patch: { title: 'title_a' },
    });

    const result2 = updateEvent(db, owner.userId, event.id, 'series', {
      revision: initialRevision,
      patch: { title: 'title_b' },
    });

    // Both promises should settle (one success, one failure).
    const outcomes = await Promise.allSettled([result1, result2]);

    // Exactly one should be fulfilled, one rejected.
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The rejected one should be a conflict error.
    const rejectedValue = rejected[0]?.reason;
    expect(rejectedValue).toBeInstanceOf(StoreConflictError);
    expect(rejectedValue.message).toContain('event revision conflict');

    // Verify the stored event has the winner's title and the incremented revision.
    const stored = await withUserRaw(pg, owner.userId, async (tx) => {
      const rows = await tx.query<{ title: unknown; revision: unknown }>(
        `SELECT title, revision FROM bob.calendar_events WHERE id = $1`,
        [event.id],
      );
      return rows.rows[0]!;
    });
    const winnerTitle = fulfilled[0]!.value.title;
    expect(stored.title).toBe(winnerTitle);
    expect(stored.revision).toBe(initialRevision + 1);
  });
});
