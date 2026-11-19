/**
 * S14-T003 — pure recurrence engine. Table-driven coverage of the DST and
 * month-end rules from data-model.md "State and time rules", using real zones
 * with real transitions (America/Toronto gap 2025-03-09 02:00, overlap
 * 2025-11-02 01:00; Asia/Kolkata +05:30 no DST; Europe/London; Australia/Sydney
 * southern-hemisphere).
 */
import { describe, expect, it } from 'vitest';
import { expandOccurrences, previewOccurrences, ruleError, type ReminderRule } from '../../src/calendar/recurrence.ts';

const to = (y: number, mo: number, d: number): number => Date.UTC(y, mo - 1, d);
const toH = (y: number, mo: number, d: number, h: number, mi: number): number => Date.UTC(y, mo - 1, d, h, mi);

describe('recurrence DST handling (America/Toronto)', () => {
  it('1. daily 08:00 stays at 08:00 local across the March gap; UTC offset changes', () => {
    const r = expandOccurrences({
      rule: { freq: 'daily' },
      startWallTime: '2025-03-08T08:00',
      zone: 'America/Toronto',
      from: to(2025, 3, 8),
      to: to(2025, 3, 11),
    });
    expect(r.map((o) => o.wallTime)).toEqual([
      '2025-03-08T08:00',
      '2025-03-09T08:00',
      '2025-03-10T08:00',
    ]);
    expect(r.map((o) => o.at)).toEqual([
      toH(2025, 3, 8, 13, 0), // EST, offset -5
      toH(2025, 3, 9, 12, 0), // EDT, offset -4
      toH(2025, 3, 10, 12, 0), // EDT, offset -4
    ]);
    expect(r.every((o) => o.adjusted === undefined)).toBe(true);
  });

  it('2. daily 02:30 on spring-forward advances to the first valid local instant', () => {
    const r = expandOccurrences({
      rule: { freq: 'daily' },
      startWallTime: '2025-03-09T02:30',
      zone: 'America/Toronto',
      from: to(2025, 3, 9),
      to: to(2025, 3, 10),
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.at).toBe(toH(2025, 3, 9, 7, 0)); // 03:00 EDT
    expect(r[0]!.wallTime).toBe('2025-03-09T03:00');
    expect(r[0]!.adjusted).toBe('dst_gap_advanced');
  });

  it('3. daily 01:30 on fall-back fires exactly once, at the earlier instant', () => {
    const r = expandOccurrences({
      rule: { freq: 'daily' },
      startWallTime: '2025-11-02T01:30',
      zone: 'America/Toronto',
      from: to(2025, 11, 2),
      to: to(2025, 11, 3),
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.at).toBe(toH(2025, 11, 2, 5, 30)); // 01:30 EDT (earlier of the two)
    expect(r[0]!.wallTime).toBe('2025-11-02T01:30');
    expect(r[0]!.adjusted).toBe('dst_overlap_first');
  });
});

describe('month-end and leap-year skips', () => {
  it('4. monthly on the 31st skips months with no 31st', () => {
    const r = expandOccurrences({
      rule: { freq: 'monthly' },
      startWallTime: '2025-01-31T10:00',
      zone: 'America/Toronto',
      from: to(2025, 1, 1),
      to: to(2026, 1, 1),
    });
    const months = r.map((o) => new Date(o.at).getUTCMonth() + 1).sort((a, b) => a - b);
    expect(months).toEqual([1, 3, 5, 7, 8, 10, 12]);
  });

  it('5. yearly on Feb 29 appears only in leap years', () => {
    const r = expandOccurrences({
      rule: { freq: 'yearly' },
      startWallTime: '2024-02-29T10:00',
      zone: 'America/Toronto',
      from: to(2024, 1, 1),
      to: to(2030, 1, 1),
    });
    const years = r.map((o) => new Date(o.at).getUTCFullYear()).sort((a, b) => a - b);
    expect(years).toEqual([2024, 2028]);
  });
});

describe('weekly', () => {
  it('6. byWeekday [1,3,5] interval 2: correct weeks skipped, correct weekdays inside active weeks', () => {
    const r = expandOccurrences({
      rule: { freq: 'weekly', byWeekday: [1, 3, 5], interval: 2 },
      startWallTime: '2025-01-01T09:00', // Wednesday
      zone: 'America/Toronto',
      from: to(2025, 1, 1),
      to: to(2025, 2, 1),
    });
    expect(r.map((o) => o.wallTime.slice(0, 10))).toEqual([
      '2025-01-01', '2025-01-03', '2025-01-06', // week 0
      '2025-01-15', '2025-01-17', '2025-01-20', // week 2
      '2025-01-29', '2025-01-31', // week 4
    ]);
  });
});

describe('count and until', () => {
  it('7. count counts from the series start; the window filters, it does not re-count', () => {
    const r = expandOccurrences({
      rule: { freq: 'daily', count: 5 },
      startWallTime: '2025-01-01T09:00',
      zone: 'America/Toronto',
      from: to(2025, 1, 3),
      to: to(2025, 1, 31),
    });
    expect(r.map((o) => o.wallTime.slice(0, 10))).toEqual(['2025-01-03', '2025-01-04', '2025-01-05']);
  });

  it('8. until includes an occurrence on the until date itself', () => {
    const r = expandOccurrences({
      rule: { freq: 'daily', until: '2025-01-03' },
      startWallTime: '2025-01-01T09:00',
      zone: 'America/Toronto',
      from: to(2025, 1, 1),
      to: to(2025, 1, 31),
    });
    expect(r.map((o) => o.wallTime.slice(0, 10))).toEqual(['2025-01-01', '2025-01-02', '2025-01-03']);
  });
});

describe('windowing and offset correctness', () => {
  it('9. from/to is a window, not a reset: same instants computed both ways', () => {
    const windowed = expandOccurrences({
      rule: { freq: 'daily' },
      startWallTime: '2025-01-01T08:00',
      zone: 'America/Toronto',
      from: to(2025, 3, 1),
      to: to(2025, 4, 1),
    }).map((o) => o.at);
    const full = expandOccurrences({
      rule: { freq: 'daily' },
      startWallTime: '2025-01-01T08:00',
      zone: 'America/Toronto',
      from: to(2025, 1, 1),
      to: to(2026, 1, 1),
    })
      .filter((o) => o.at >= to(2025, 3, 1) && o.at < to(2025, 4, 1))
      .map((o) => o.at);
    expect(windowed).toEqual(full);
    expect(windowed).toHaveLength(31);
  });

  it('10. Asia/Kolkata half-hour offset (+05:30) produces correct instants', () => {
    const r = expandOccurrences({
      rule: { freq: 'daily' },
      startWallTime: '2025-01-01T10:00',
      zone: 'Asia/Kolkata',
      from: to(2025, 1, 1),
      to: to(2025, 1, 4),
    });
    expect(r.map((o) => o.at)).toEqual([
      toH(2025, 1, 1, 4, 30),
      toH(2025, 1, 2, 4, 30),
      toH(2025, 1, 3, 4, 30),
    ]);
    expect(r.every((o) => o.adjusted === undefined)).toBe(true);
  });

  it('11. limit caps results and never loops unboundedly on a pathological rule', () => {
    const bounded = expandOccurrences({
      rule: { freq: 'monthly', until: '2040-12-31' },
      startWallTime: '2025-01-31T10:00',
      zone: 'America/Toronto',
      from: to(2025, 1, 1),
      to: to(2036, 1, 1),
    });
    // 11 years (2025-2035), 7 months with 31 days per year.
    expect(bounded).toHaveLength(77);

    const capped = expandOccurrences({
      rule: { freq: 'daily' },
      startWallTime: '2025-01-01T09:00',
      zone: 'America/Toronto',
      from: to(2025, 1, 1),
      to: to(2031, 1, 1),
    });
    expect(capped).toHaveLength(500); // default limit
  });
});
describe('hourly rules (#456)', () => {
  const walls = (r: { wallTime: string }[]): string[] => r.map((o) => o.wallTime.slice(11));

  it('every hour inside an 08:00-22:00 window rings 15 times a day, never at night', () => {
    const r = expandOccurrences({
      rule: { freq: 'hourly', window: { start: '08:00', end: '22:00' } },
      startWallTime: '2026-09-25T08:00',
      zone: 'Asia/Kolkata',
      from: to(2026, 9, 24),
      to: to(2026, 9, 27),
    });
    expect(r).toHaveLength(30);
    expect(walls(r.slice(0, 15))).toEqual([
      '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00',
      '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00',
    ]);
    expect(r[15]!.wallTime).toBe('2026-09-26T08:00');
    expect(r[0]!.at).toBe(toH(2026, 9, 25, 2, 30)); // +05:30
  });

  it('every 3 hours counts from the window start; the anchor day starts at the anchor', () => {
    const r = expandOccurrences({
      rule: { freq: 'hourly', interval: 3, window: { start: '09:00', end: '21:00' } },
      startWallTime: '2026-09-25T13:00',
      zone: 'Europe/London',
      from: to(2026, 9, 25),
      to: to(2026, 9, 27),
    });
    expect(r.map((o) => o.wallTime)).toEqual([
      '2026-09-25T15:00', '2026-09-25T18:00', '2026-09-25T21:00',
      '2026-09-26T09:00', '2026-09-26T12:00', '2026-09-26T15:00', '2026-09-26T18:00', '2026-09-26T21:00',
    ]);
  });

  it('spring-forward: the missing 02:00 slot merges into 03:00, one ring (Toronto)', () => {
    const r = expandOccurrences({
      rule: { freq: 'hourly' },
      startWallTime: '2025-03-09T00:00',
      zone: 'America/Toronto',
      from: to(2025, 3, 9),
      to: toH(2025, 3, 9, 10, 0), // 06:00 EDT
    });
    expect(walls(r)).toEqual(['00:00', '01:00', '03:00', '04:00', '05:00']);
    expect(r[2]!.adjusted).toBe('dst_gap_advanced');
    expect(new Set(r.map((o) => o.at)).size).toBe(r.length);
  });

  it('fall-back: the repeated 01:00 rings once, at the first instant (Toronto)', () => {
    const r = expandOccurrences({
      rule: { freq: 'hourly' },
      startWallTime: '2025-11-02T00:00',
      zone: 'America/Toronto',
      from: to(2025, 11, 2),
      to: toH(2025, 11, 2, 9, 0), // 04:00 EST
    });
    expect(walls(r)).toEqual(['00:00', '01:00', '02:00', '03:00']);
    expect(r[1]).toMatchObject({ at: toH(2025, 11, 2, 5, 0), adjusted: 'dst_overlap_first' });
    expect(r[2]!.at).toBe(toH(2025, 11, 2, 7, 0)); // 02:00 EST
  });

  it('a from years after the anchor starts near from, not at the anchor', () => {
    const r = expandOccurrences({
      rule: { freq: 'hourly', window: { start: '08:00', end: '22:00' } },
      startWallTime: '2020-01-01T08:00',
      zone: 'UTC',
      from: toH(2026, 9, 25, 10, 30),
      to: toH(2026, 9, 25, 13, 0),
    });
    expect(walls(r)).toEqual(['11:00', '12:00']);
  });

  it('count and until bound an hourly rule', () => {
    const counted = expandOccurrences({
      rule: { freq: 'hourly', count: 4 },
      startWallTime: '2026-09-25T10:00',
      zone: 'UTC',
      from: to(2026, 9, 25),
      to: to(2026, 9, 30),
    });
    expect(walls(counted)).toEqual(['10:00', '11:00', '12:00', '13:00']);
    const until = expandOccurrences({
      rule: { freq: 'hourly', interval: 12, until: '2026-09-26' },
      startWallTime: '2026-09-25T00:00',
      zone: 'UTC',
      from: to(2026, 9, 25),
      to: to(2026, 9, 30),
    });
    expect(until.map((o) => o.wallTime)).toEqual([
      '2026-09-25T00:00', '2026-09-25T12:00', '2026-09-26T00:00', '2026-09-26T12:00',
    ]);
  });

  it('ruleError accepts sound hourly rules and refuses the rest', () => {
    expect(ruleError({ freq: 'hourly' })).toBeNull();
    expect(ruleError({ freq: 'hourly', interval: 12, window: { start: '08:00', end: '22:00' } })).toBeNull();
    expect(ruleError({ freq: 'daily' })).toBeNull();
    expect(ruleError({ freq: 'hourly', interval: 13 })).toMatch(/1 to 12/);
    expect(ruleError({ freq: 'hourly', interval: 0 })).toMatch(/1 to 12/);
    expect(ruleError({ freq: 'hourly', window: { start: '22:00', end: '08:00' } })).toMatch(/start before/);
    expect(ruleError({ freq: 'hourly', window: { start: '8am', end: '22:00' } })).toMatch(/HH:mm/);
    expect(ruleError({ freq: 'daily', window: { start: '08:00', end: '22:00' } } as unknown as ReminderRule)).toMatch(/only an hourly/);
  });
});

describe('previewOccurrences (#126)', () => {
  it('daily 08:00 Europe/London over the October change stays at 08:00 local', () => {
    const got = previewOccurrences({ rule: { freq: 'daily' }, dueAt: toH(2026, 10, 24, 7, 0), zone: 'Europe/London' });
    expect(got.map((o) => o.wallTime)).toEqual(['2026-10-24T08:00', '2026-10-25T08:00', '2026-10-26T08:00']);
    expect(got.map((o) => o.at)).toEqual([toH(2026, 10, 24, 7, 0), toH(2026, 10, 25, 8, 0), toH(2026, 10, 26, 8, 0)]);
  });

  it('monthly on the 31st from 2026-09-01 skips the short months', () => {
    const got = previewOccurrences({
      rule: { freq: 'monthly' }, dueAt: toH(2026, 8, 31, 7, 0), zone: 'Europe/London', from: to(2026, 9, 1),
    });
    expect(got.map((o) => o.wallTime)).toEqual(['2026-10-31T08:00', '2026-12-31T08:00', '2027-01-31T08:00']);
  });

  it('a one-off rings once; hourly honours its waking window', () => {
    expect(previewOccurrences({ rule: null, dueAt: toH(2026, 10, 24, 7, 0), zone: 'Europe/London' })).toHaveLength(1);
    const hourly = previewOccurrences({
      rule: { freq: 'hourly', interval: 4, window: { start: '08:00', end: '22:00' } },
      dueAt: toH(2026, 7, 1, 19, 30), zone: 'Europe/London',
    });
    expect(hourly.map((o) => o.wallTime)).toEqual(['2026-07-02T08:00', '2026-07-02T12:00', '2026-07-02T16:00']);
  });
});

describe('skipping ahead to the window (PREVIEW-BOUND)', () => {
  type Case = { name: string; rule: ReminderRule; start: string; zone: string; from: number; to: number };
  const cases: Case[] = [
    { name: 'daily/3 count across the Toronto gap', rule: { freq: 'daily', interval: 3, count: 50 }, start: '2025-01-01T02:30', zone: 'America/Toronto', from: to(2025, 3, 20), to: to(2025, 8, 1) },
    { name: 'daily until', rule: { freq: 'daily', until: '2025-04-10' }, start: '2025-01-01T08:00', zone: 'Europe/London', from: to(2025, 3, 29), to: to(2025, 6, 1) },
    { name: 'weekly [1,3,5]/2 count', rule: { freq: 'weekly', interval: 2, byWeekday: [1, 3, 5], count: 40 }, start: '2025-01-06T09:00', zone: 'Europe/London', from: to(2025, 6, 1), to: to(2026, 1, 1) },
    { name: 'weekly/3 no weekdays', rule: { freq: 'weekly', interval: 3 }, start: '2024-02-29T23:30', zone: 'Asia/Kolkata', from: to(2027, 1, 1), to: to(2029, 1, 1) },
    { name: 'monthly 31st count', rule: { freq: 'monthly', count: 20 }, start: '2025-01-31T08:00', zone: 'Australia/Sydney', from: to(2026, 3, 1), to: to(2028, 1, 1) },
    { name: 'monthly 31st /5', rule: { freq: 'monthly', interval: 5, count: 30 }, start: '2025-01-31T08:00', zone: 'UTC', from: to(2030, 3, 1), to: to(2040, 1, 1) },
    { name: 'yearly Feb 29 count', rule: { freq: 'yearly', count: 10 }, start: '2024-02-29T07:00', zone: 'UTC', from: to(2041, 1, 1), to: to(2070, 1, 1) },
    { name: 'yearly Feb 29 /3', rule: { freq: 'yearly', interval: 3, count: 8 }, start: '2024-02-29T07:00', zone: 'UTC', from: to(2100, 1, 1), to: to(2300, 1, 1) },
    { name: 'hourly count across the Toronto gap', rule: { freq: 'hourly', count: 400 }, start: '2025-03-01T00:00', zone: 'America/Toronto', from: to(2025, 3, 12), to: to(2025, 4, 1) },
    { name: 'hourly window 01:00-04:00 merging at the gap', rule: { freq: 'hourly', window: { start: '01:00', end: '04:00' }, count: 60 }, start: '2025-03-01T01:00', zone: 'America/Toronto', from: to(2025, 3, 15), to: to(2025, 4, 1) },
    { name: 'hourly /5 count over Sydney changes', rule: { freq: 'hourly', interval: 5, count: 500 }, start: '2025-03-20T10:00', zone: 'Australia/Sydney', from: to(2025, 6, 1), to: to(2025, 7, 1) },
    { name: 'hourly /6 count over the skipped Apia day', rule: { freq: 'hourly', interval: 6, count: 100 }, start: '2011-12-25T00:00', zone: 'Pacific/Apia', from: to(2012, 1, 3), to: to(2012, 2, 1) },
    { name: 'hourly count over a midnight gap (Havana)', rule: { freq: 'hourly', count: 500 }, start: '2025-03-01T00:00', zone: 'America/Havana', from: to(2025, 3, 12), to: to(2025, 4, 1) },
  ];
  for (const c of cases) {
    it(`${c.name}: the window equals the full expansion filtered to it`, () => {
      const base = { rule: c.rule, startWallTime: c.start, zone: c.zone };
      const full = expandOccurrences({ ...base, from: 0, to: c.to, limit: 1000 });
      expect(full.length).toBeLessThan(1000);
      const windowed = expandOccurrences({ ...base, from: c.from, to: c.to, limit: 1000 });
      expect(windowed).toEqual(full.filter((o) => o.at >= c.from));
    });
  }

  it('a far from on every frequency answers fast, with the same wall times', () => {
    const rules: ReminderRule[] = [
      { freq: 'daily' }, { freq: 'daily', count: 1_000_000_000 }, { freq: 'weekly', byWeekday: [0, 6] },
      { freq: 'monthly', count: 1_000_000_000 }, { freq: 'yearly' }, { freq: 'hourly', interval: 6 },
    ];
    for (const rule of rules) {
      const started = performance.now();
      const got = previewOccurrences({ rule, dueAt: toH(2026, 1, 31, 8, 0), zone: 'UTC', from: 8e15 });
      expect(performance.now() - started).toBeLessThan(200);
      expect(got).toHaveLength(3);
      expect(got.every((o) => o.at >= 8e15)).toBe(true);
    }
    const started = performance.now();
    const hourly = previewOccurrences({
      rule: { freq: 'hourly', count: 1_000_000_000 }, dueAt: toH(1970, 1, 1, 0, 0), zone: 'America/Toronto', from: toH(2070, 1, 1, 0, 0),
    });
    expect(performance.now() - started).toBeLessThan(200);
    expect(hourly.map((o) => o.wallTime)).toEqual(['2069-12-31T19:00', '2069-12-31T20:00', '2069-12-31T21:00']);
  });

  it('a count already spent before a far from rings nothing', () => {
    const got = previewOccurrences({ rule: { freq: 'daily', count: 5 }, dueAt: toH(2026, 1, 1, 8, 0), zone: 'UTC', from: 8e15 });
    expect(got).toEqual([]);
    expect(previewOccurrences({ rule: { freq: 'hourly', count: 5 }, dueAt: toH(2026, 1, 1, 8, 0), zone: 'UTC', from: 8e15 })).toEqual([]);
  });
});
