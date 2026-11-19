import { describe, expect, it } from 'vitest';
import { nextRoutineRun } from '../../src/routines/schedule.ts';

describe('daily routine schedule', () => {
  it.each([
    ['UTC', '08:00', '2026-10-22T08:00:00Z', '2026-10-23T08:00:00.000Z'],
    ['America/New_York', '01:30', '2026-11-01T00:00:00Z', '2026-11-01T05:30:00.000Z'],
    ['America/New_York', '01:30', '2026-11-01T05:30:00Z', '2026-11-02T06:30:00.000Z'],
    ['Europe/Berlin', '02:30', '2026-10-25T00:00:00Z', '2026-10-25T00:30:00.000Z'],
    ['Europe/Berlin', '02:30', '2026-10-25T00:45:00Z', '2026-10-26T01:30:00.000Z'],
    ['America/New_York', '02:30', '2026-03-08T00:00:00Z', '2026-03-08T07:00:00.000Z'],
    ['Australia/Lord_Howe', '01:45', '2026-04-04T12:00:00Z', '2026-04-04T14:45:00.000Z'],
    ['Australia/Lord_Howe', '02:15', '2026-10-03T12:00:00Z', '2026-10-03T15:30:00.000Z'],
    ['Pacific/Apia', '08:00', '2011-12-29T21:00:00Z', '2011-12-30T18:00:00.000Z'],
  ])('%s %s after %s resolves to %s', (timeZone, localTime, now, expected) => {
    expect(new Date(nextRoutineRun({ timeZone, localTime }, Date.parse(now))).toISOString()).toBe(expected);
  });

  it('rejects invalid zones, times and clocks', () => {
    expect(() => nextRoutineRun({ timeZone: 'Wrong/Zone', localTime: '08:00' }, 0)).toThrow();
    expect(() => nextRoutineRun({ timeZone: 'UTC', localTime: '24:00' }, 0)).toThrow();
    expect(() => nextRoutineRun({ timeZone: 'UTC', localTime: '08:00' }, NaN)).toThrow();
  });
});
