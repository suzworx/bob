// core/timer-scheduler.ts tests (issue #320): a fake clock and a fake setTimer
// over the real store. Each test gets its own database (the due query reads
// across accounts), and the armed callback is fired by hand.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import { startTimerScheduler, type SetTimerFn } from '../../src/timers/scheduler.ts';
import { type Db } from '../../src/platform/db/db.ts';
import { cancelTimers, createTimer, type Timer } from '../../src/timers/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const T0 = Date.parse('2030-01-01T12:00:00Z');
const MIN = 60_000;

let pg: TestDb;
let db: Db;
let clock = T0;
let armed: { fn: () => void; ms: number; live: boolean }[] = [];
const setTimer: SetTimerFn = (fn, ms) => {
  const entry = { fn, ms, live: true };
  armed.push(entry);
  return () => { entry.live = false; };
};
const live = (): { fn: () => void; ms: number }[] => armed.filter((a) => a.live);

function start(fired: Timer[]) {
  return startTimerScheduler({ db, now: () => clock, setTimer, onFire: (t) => { fired.push(t); }, afterFire: () => undefined });
}

/** Advances the clock to the armed deadline and runs the armed callback. */
async function elapse(s: { reschedule: () => Promise<void> }): Promise<void> {
  const [next] = live();
  if (!next) throw new Error('nothing armed');
  clock += next.ms;
  armed.forEach((a) => { if (a.fn === next.fn) a.live = false; });
  next.fn();
  await s.reschedule();
}

beforeEach(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  clock = T0;
  armed = [];
});

afterEach(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

describe('timer scheduler', () => {
  it('keeps one timeout for the next timer and fires in order', async () => {
    const a = await addAccount(pg);
    const three = await createTimer(db, a.userId, { durationMs: 3 * MIN, label: 'three', now: T0 });
    const one = await createTimer(db, a.userId, { durationMs: MIN, label: 'one', now: T0 });
    const two = await createTimer(db, a.userId, { durationMs: 2 * MIN, label: 'two', now: T0 });
    const fired: Timer[] = [];
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    const s = start(fired);
    await s.reschedule();
    expect(live().map((x) => x.ms)).toEqual([MIN]);
    await elapse(s);
    await elapse(s);
    await elapse(s);
    setJournalSink(null);
    expect(fired.map((t) => t.id)).toEqual([one.id, two.id, three.id]);
    expect(fired.every((t) => t.status === 'fired')).toBe(true);
    expect(live()).toEqual([]);
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.event === 'v2.timer_fired');
    expect(events).toHaveLength(3);
    for (const e of events) expect(Object.keys(e).sort()).toEqual(['conversation_id', 'conversation_source', 'event', 'kind', 'level', 'message', 'module', 'source', 'ts']);
    s.stop();
  });

  it('re-arms on reschedule after a create or cancel', async () => {
    const a = await addAccount(pg);
    await createTimer(db, a.userId, { durationMs: 10 * MIN, now: T0 });
    const s = start([]);
    await s.reschedule();
    expect(live().map((x) => x.ms)).toEqual([10 * MIN]);
    const soon = await createTimer(db, a.userId, { durationMs: MIN, now: T0 });
    await s.reschedule();
    expect(live().map((x) => x.ms)).toEqual([MIN]);
    await cancelTimers(db, a.userId, { id: soon.id });
    await s.reschedule();
    expect(live().map((x) => x.ms)).toEqual([10 * MIN]);
    await cancelTimers(db, a.userId, { all: true });
    await s.reschedule();
    expect(live()).toEqual([]);
    s.stop();
  });

  it('fires overdue timers at once on start (a restart) and skips cancelled ones', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const overdueA = await createTimer(db, a.userId, { durationMs: MIN, now: T0 });
    const overdueB = await createTimer(db, b.userId, { durationMs: 2 * MIN, now: T0 });
    const gone = await createTimer(db, b.userId, { durationMs: MIN, now: T0 });
    await cancelTimers(db, b.userId, { id: gone.id });
    await createTimer(db, a.userId, { durationMs: 2 * 60 * MIN, now: T0 });
    clock = T0 + 30 * MIN;
    const fired: Timer[] = [];
    const s = start(fired);
    await s.reschedule();
    expect(fired.map((t) => t.id)).toEqual([overdueA.id, overdueB.id]);
    expect(live().map((x) => x.ms)).toEqual([90 * MIN]);
    s.stop();
    expect(live()).toEqual([]);
  });

  it('fires each timer exactly once with two schedulers racing', async () => {
    const a = await addAccount(pg);
    const ids = new Set<string>();
    for (let i = 1; i <= 5; i += 1) ids.add((await createTimer(db, a.userId, { durationMs: i * 1000, now: T0 })).id);
    clock = T0 + MIN;
    const fired: Timer[] = [];
    const first = start(fired);
    const second = start(fired);
    await Promise.all([first.reschedule(), second.reschedule(), first.reschedule(), second.reschedule()]);
    expect(fired).toHaveLength(5);
    expect(new Set(fired.map((t) => t.id))).toEqual(ids);
    first.stop();
    second.stop();
  });

  it('a throwing onFire does not stall the queue; stop halts firing', async () => {
    const a = await addAccount(pg);
    await createTimer(db, a.userId, { durationMs: 1000, now: T0 });
    await createTimer(db, a.userId, { durationMs: 2000, now: T0 });
    clock = T0 + MIN;
    let calls = 0;
    const s = startTimerScheduler({ db, now: () => clock, setTimer, onFire: () => { calls += 1; throw new Error('x'); }, afterFire: () => undefined });
    await s.reschedule();
    expect(calls).toBe(2);
    s.stop();
    await createTimer(db, a.userId, { durationMs: 1000, now: T0 });
    await s.reschedule();
    expect(calls).toBe(2);
  });
});
