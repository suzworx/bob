// store/timers.ts tests (issue #320). Same PG test support as
// store-active-space.test.ts: a per-file database connected as bob_server,
// with withUserRaw for the raw account-scoped RLS checks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreError, type Db } from '../../src/platform/db/db.ts';
import {
  cancelTimers, createAlarm, createTimer, dismissTimer, duePending, listPendingTimers,
  markTimerFired, nextPendingFireAt, normalizeTimerLabel,
} from '../../src/timers/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb, withUserRaw } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

const T0 = Date.parse('2030-01-01T12:00:00Z');
const MIN = 60_000;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

describe('timers store', () => {
  it('creates timers and lists them soonest first with time left', async () => {
    const a = await addAccount(pg);
    const pasta = await createTimer(db, a.userId, { durationMs: 10 * MIN, label: 'the pasta timer', now: T0 });
    const eggs = await createTimer(db, a.userId, { durationMs: 3 * MIN, label: 'Eggs', now: T0 });
    expect(pasta).toMatchObject({ kind: 'timer', label: 'pasta', firesAt: T0 + 10 * MIN, durationMs: 10 * MIN, status: 'pending' });
    const list = await listPendingTimers(db, a.userId, T0 + MIN);
    expect(list.map((t) => [t.id, t.remainingMs])).toEqual([[eggs.id, 2 * MIN], [pasta.id, 9 * MIN]]);
  });

  it('refuses out-of-range durations and past alarms', async () => {
    const a = await addAccount(pg);
    await expect(createTimer(db, a.userId, { durationMs: 500, now: T0 })).rejects.toBeInstanceOf(StoreError);
    await expect(createTimer(db, a.userId, { durationMs: 25 * 60 * MIN, now: T0 })).rejects.toBeInstanceOf(StoreError);
    await expect(createAlarm(db, a.userId, { time: '2029-01-01T07:00:00Z', timeZone: 'UTC', now: T0 }))
      .rejects.toThrow('that time has already passed');
    await expect(createAlarm(db, a.userId, { time: '07:00', timeZone: 'Mars/Base', now: T0 }))
      .rejects.toThrow('unknown time zone');
  });

  it('cancels by label, by id, the only one, and all', async () => {
    const a = await addAccount(pg);
    const pasta = await createTimer(db, a.userId, { durationMs: MIN, label: 'pasta', now: T0 });
    const tea = await createTimer(db, a.userId, { durationMs: 2 * MIN, label: 'tea', now: T0 });
    const byLabel = await cancelTimers(db, a.userId, { label: 'the Pasta timer' });
    expect(byLabel.cancelled.map((t) => t.id)).toEqual([pasta.id]);
    expect(byLabel.remaining).toBe(1);
    expect((await cancelTimers(db, a.userId, { label: 'nope' })).cancelled).toEqual([]);
    const only = await cancelTimers(db, a.userId, { label: 'the timer' });
    expect(only.cancelled.map((t) => t.id)).toEqual([tea.id]);
    const x = await createTimer(db, a.userId, { durationMs: MIN, now: T0 });
    await createTimer(db, a.userId, { durationMs: MIN, now: T0 });
    expect((await cancelTimers(db, a.userId, {})).cancelled).toEqual([]);
    expect((await cancelTimers(db, a.userId, { id: x.id })).cancelled.map((t) => t.id)).toEqual([x.id]);
    expect((await cancelTimers(db, a.userId, { id: 'not-a-uuid' })).cancelled).toEqual([]);
    const all = await cancelTimers(db, a.userId, { all: true });
    expect(all).toMatchObject({ remaining: 0 });
    expect(all.cancelled).toHaveLength(1);
    expect(await listPendingTimers(db, a.userId, T0)).toEqual([]);
  });

  it('marks fired once, then dismisses', async () => {
    const a = await addAccount(pg);
    const t = await createTimer(db, a.userId, { durationMs: MIN, now: T0 });
    const fired = await markTimerFired(db, a.userId, t.id, T0 + MIN);
    expect(fired).toMatchObject({ status: 'fired', firedAt: T0 + MIN });
    expect(await markTimerFired(db, a.userId, t.id, T0 + MIN)).toBeNull();
    expect(await dismissTimer(db, a.userId, t.id)).toMatchObject({ status: 'dismissed' });
    expect(await dismissTimer(db, a.userId, t.id)).toBeNull();
  });

  it('isolates accounts under RLS', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const t = await createTimer(db, a.userId, { durationMs: MIN, label: 'secret', now: T0 });
    expect(await listPendingTimers(db, b.userId, T0)).toEqual([]);
    expect((await cancelTimers(db, b.userId, { id: t.id })).cancelled).toEqual([]);
    expect((await cancelTimers(db, b.userId, { all: true })).cancelled).toEqual([]);
    expect(await markTimerFired(db, b.userId, t.id, T0)).toBeNull();
    const raw = await withUserRaw(pg, b.userId, (tx) => tx.query(`select id from bob.reminders where id = $1`, [t.id]));
    expect(raw.rows).toEqual([]);
    const aSpace = (await withUserRaw(pg, a.userId, (tx) => tx.query<{ id: string }>(
      `select id from bob.spaces where kind = 'private' and owner_user_id = $1`, [a.userId],
    ))).rows[0]!.id;
    const forged = await withUserRaw(pg, b.userId, (tx) => tx.query(
      `insert into bob.reminders (space_id, created_by, kind, due_at, due_zone, duration_ms, status)
       values ($1, $2, 'timer', now(), 'UTC', 1000, 'pending')`,
      [aSpace, a.userId],
    )).catch((error: unknown) => error);
    expect(forged).toBeInstanceOf(Error);
    expect(await listPendingTimers(db, a.userId, T0)).toHaveLength(1);
  });

  it('due query reads across accounts, oldest first, pending only, bounded', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const base = Date.parse('2031-06-01T00:00:00Z');
    await cancelTimers(db, a.userId, { all: true });
    const late = await createTimer(db, a.userId, { durationMs: 2 * MIN, now: base });
    const early = await createTimer(db, b.userId, { durationMs: MIN, now: base });
    const future = await createTimer(db, b.userId, { durationMs: 60 * MIN, now: base });
    const gone = await createTimer(db, a.userId, { durationMs: MIN, now: base });
    await cancelTimers(db, a.userId, { id: gone.id });
    const due = (await duePending(db, base + 5 * MIN)).filter((t) => [late.id, early.id, future.id, gone.id].includes(t.id));
    expect(due.map((t) => t.id)).toEqual([early.id, late.id]);
    expect(due[0]).toMatchObject({ userId: b.userId, kind: 'timer', status: 'pending' });
    expect(await duePending(db, base + 5 * MIN, 1)).toHaveLength(1);
    expect(await nextPendingFireAt(db)).toBeTypeOf('number');
    expect(normalizeTimerLabel('  the  ')).toBeNull();
  });
});
