// Timer tools (issue #320): apps/ai createTimerTools over the api binding
// (core/timer-tools.ts bindTimerTools) and the real store, with a fake clock.
// Covers inputs, spoken outputs and alarms in the account time zone, DST days
// included.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from 'ai';
import { createTimerTools, parseTimerDuration, speakDuration } from '@bob/ai';
import { bindTimerTools } from '../../src/timers/tools.ts';
import { type Db } from '../../src/platform/db/db.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

type Out = { ok: true; message: string; id?: string } | { ok: false; reason: string };

async function account(timeZone: string, start: number) {
  const { userId } = await addAccount(pg);
  const clock = { now: start, changes: 0, changedFor: new Set<string>() };
  const tools = createTimerTools(bindTimerTools(db, userId, {
    timeZone, now: () => clock.now, onChange: (changed) => { clock.changes += 1; clock.changedFor.add(changed); },
  }));
  const call = async (name: string, input: unknown = {}): Promise<Out> => {
    const execute = (tools[name] as Tool).execute as (input: unknown, options: unknown) => Promise<Out>;
    return execute(input, { toolCallId: 't', messages: [] });
  };
  return { clock, call, userId };
}

describe('timer tool inputs', () => {
  it('reads seconds and ISO-8601 durations', () => {
    expect(parseTimerDuration(600)).toBe(600_000);
    expect(parseTimerDuration('90')).toBe(90_000);
    expect(parseTimerDuration('PT10M')).toBe(600_000);
    expect(parseTimerDuration('PT1H30M15S')).toBe(5_415_000);
    expect(parseTimerDuration('P1D')).toBe(86_400_000);
    for (const bad of ['P', 'PT', 'ten minutes', '-5', 0]) expect(parseTimerDuration(bad)).toBeNull();
    expect(speakDuration(252_000)).toBe('4 minutes 12 seconds');
    expect(speakDuration(3_900_000)).toBe('1 hour 5 minutes');
    expect(speakDuration(1_000)).toBe('1 second');
  });
});

describe('timer tools', () => {
  it('sets, lists and cancels timers in spoken sentences', async () => {
    const T0 = Date.parse('2030-01-01T12:00:00Z');
    const { clock, call, userId } = await account('UTC', T0);
    expect(await call('set_timer', { duration: 'PT10M', label: 'pasta' }))
      .toMatchObject({ ok: true, message: 'Pasta timer set for 10 minutes.' });
    expect(await call('set_timer', { duration: 300 })).toMatchObject({ ok: true, message: 'Timer set for 5 minutes.' });
    expect(await call('set_timer', { duration: 'soon' })).toEqual({ ok: false, reason: 'unreadable duration' });
    expect(await call('set_timer', { duration: 3 * 86_400 }))
      .toEqual({ ok: false, reason: 'timer duration must be between 1 second and 24 hours' });
    clock.now = T0 + 348_000;
    expect(await call('list_timers')).toEqual({
      ok: true, message: 'Timer: 0 seconds left. Pasta timer: 4 minutes 12 seconds left.',
    });
    expect(await call('cancel_timer')).toEqual({ ok: true, message: 'Which one? You have 2 running.' });
    expect(await call('cancel_timer', { label: 'the pasta timer' })).toEqual({ ok: true, message: 'Pasta timer cancelled.' });
    expect(await call('cancel_timer', { label: 'pizza' })).toEqual({ ok: true, message: "I couldn't find that timer." });
    await call('set_timer', { duration: 60, label: 'tea' });
    expect(await call('cancel_timer', { all: true })).toEqual({ ok: true, message: 'Cancelled 2 timers and alarms.' });
    expect(await call('list_timers')).toEqual({ ok: true, message: 'No timers or alarms are set.' });
    expect(await call('cancel_timer')).toEqual({ ok: true, message: 'No timers are running.' });
    expect(clock.changes).toBe(5);
    expect([...clock.changedFor]).toEqual([userId]);
  });

  it('sets alarms on the account wall clock: next occurrence, pm, local ISO', async () => {
    const now = Date.parse('2026-09-23T15:00:00Z'); // 11:00 in New York
    const { call } = await account('America/New_York', now);
    const tomorrow = await call('set_alarm', { time: '07:00', label: 'wake up' });
    expect(tomorrow).toMatchObject({ ok: true, message: 'Wake up alarm set for 7:00 AM.' });
    const evening = await call('set_alarm', { time: '7:30 pm' });
    expect(evening).toMatchObject({ ok: true, message: 'Alarm set for 7:30 PM.' });
    expect(await call('list_timers')).toEqual({ ok: true, message: 'Alarm at 7:30 PM. Wake up alarm at 7:00 AM.' });
    expect(await call('set_alarm', { time: '2026-09-22T07:00' }))
      .toEqual({ ok: false, reason: 'that time has already passed' });
    expect(await call('set_alarm', { time: '25:00' })).toEqual({ ok: false, reason: 'invalid alarm time' });
    const india = await account('Asia/Kolkata', now);
    expect(await india.call('set_alarm', { time: '2026-09-24T07:00' }))
      .toMatchObject({ ok: true, message: 'Alarm set for 7:00 AM.' });
  });

  it('resolves 07:00 correctly on both DST change days', async () => {
    const bindTimerToolsAt = async (now: number) => {
      const { userId } = await addAccount(pg);
      return bindTimerTools(db, userId, { timeZone: 'America/New_York', now: () => now });
    };
    const spring = await bindTimerToolsAt(Date.parse('2026-03-08T06:00:00Z')); // 01:00 EST, clocks jump at 02:00
    expect((await spring.setAlarm({ time: '07:00' })).firesAtIso).toBe('2026-03-08T11:00:00.000Z');
    const fall = await bindTimerToolsAt(Date.parse('2026-11-01T05:30:00Z')); // 01:30 EDT, clocks fall back at 02:00
    expect((await fall.setAlarm({ time: '07:00' })).firesAtIso).toBe('2026-11-01T12:00:00.000Z');
    const gap = await bindTimerToolsAt(Date.parse('2026-03-08T06:00:00Z'));
    expect((await gap.setAlarm({ time: '02:30' })).firesAtIso).toBe('2026-03-08T07:30:00.000Z');
  });
});
