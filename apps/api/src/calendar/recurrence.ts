/**
 * Pure recurrence engine for repeating events and reminders. Expands a bounded
 * recurrence rule into concrete instants in a named IANA zone, with the DST and
 * month-end rules decided explicitly. No date library: wall-time conversion
 * uses the platform Intl.DateTimeFormat.
 */
type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly';

/** A daily window of wall times in the rule's zone, 'HH:mm', both inclusive. */
type HourWindow = { start: string; end: string };

/** Largest `interval` an hourly rule accepts: past 12 hours it is a daily rule. */
export const HOURLY_MAX_INTERVAL = 12;

/**
 * The window an hourly reminder rings in when the person named none: 8 a.m.
 * to 10 p.m. local. A reminder that rings every hour through the night wakes
 * the person and trains them to mute it, so waking hours are the default and
 * a night-time window must be asked for explicitly.
 */
export const DEFAULT_HOURLY_WINDOW: HourWindow = { start: '08:00', end: '22:00' };

/** The rule events and reminders share. Events never repeat hourly. */
export type RecurrenceRule = {
  freq: Freq;
  /** Every N periods. Integer >= 1. Default 1. */
  interval?: number;
  /** weekly only: 0=Sunday .. 6=Saturday. Empty means "same weekday as start". */
  byWeekday?: number[];
  /** Inclusive end, as a wall-clock date in the rule's zone. */
  until?: string; // 'YYYY-MM-DD'
  /** Or a count of occurrences. `until` and `count` are mutually exclusive. */
  count?: number;
};

/** Reminders only: every `interval` hours (1..12) inside a daily window. */
type HourlyRule = {
  freq: 'hourly';
  interval?: number;
  /**
   * Each day it rings at `start`, then every `interval` hours while the wall
   * time is at or before `end`. Absent = 00:00 to 23:59. Slots are wall
   * times, so a DST change never shifts them off the clock.
   */
  window?: HourWindow;
  until?: string; // 'YYYY-MM-DD'
  count?: number;
};

/** What a reminder may repeat by. */
export type ReminderRule = RecurrenceRule | HourlyRule;

export type Occurrence = {
  /** The instant, as epoch-ms UTC. */
  at: number;
  /** The actual local wall time the instant occupies, 'YYYY-MM-DDTHH:mm'. */
  wallTime: string;
  /** Set when a DST rule moved this occurrence off its nominal wall time. */
  adjusted?: 'dst_gap_advanced' | 'dst_overlap_first';
};

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

interface YMD {
  y: number;
  mo: number;
  d: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** The local calendar parts of an instant in a zone (Gregorian, 0-23 hour). */
function partsInZone(zone: string, at: number): Wall {
  let fmt = fmtCache.get(zone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      calendar: 'gregory',
    });
    fmtCache.set(zone, fmt);
  }
  const parts = fmt.formatToParts(at);
  const g: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') g[p.type] = p.value;
  return { y: Number(g.year), mo: Number(g.month), d: Number(g.day), h: Number(g.hour), mi: Number(g.minute) };
}

/**
 * The instant (epoch-ms) whose local wall time is `w`, or null when `w` does
 * not exist (spring-forward gap). Convergence: guess naive-UTC, read the actual
 * offset, correct, re-check; 4 iterations settle every real zone.
 */
function resolveExisting(zone: string, w: Wall): number | null {
  const target = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  let at = target;
  for (let i = 0; i < 4; i++) {
    const p = partsInZone(zone, at);
    at = target - (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - at);
  }
  const p = partsInZone(zone, at);
  return p.y === w.y && p.mo === w.mo && p.d === w.d && p.h === w.h && p.mi === w.mi ? at : null;
}

/**
 * Resolves a wall time to an instant, applying the DST rules:
 * a gap advances minute-by-minute (bounded, 180 min) to the next valid instant
 * (dst_gap_advanced); an overlap fires once at the earlier of the two
 * one-hour-apart instants (dst_overlap_first).
 */
function resolveWall(zone: string, w: Wall): { at: number; adjusted?: Occurrence['adjusted'] } {
  const at = resolveExisting(zone, w);
  if (at !== null) {
    const later = partsInZone(zone, at + 3_600_000);
    if (later.y === w.y && later.mo === w.mo && later.d === w.d && later.h === w.h && later.mi === w.mi) {
      return { at, adjusted: 'dst_overlap_first' };
    }
    return { at };
  }
  for (let m = 1; m <= 180; m++) {
    const t = w.h * 60 + w.mi + m;
    const resolved = resolveExisting(zone, { y: w.y, mo: w.mo, d: w.d, h: Math.floor(t / 60), mi: t % 60 });
    if (resolved !== null) return { at: resolved, adjusted: 'dst_gap_advanced' };
  }
  return { at: Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) };
}

function parseWallTime(s: string): Wall {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid startWallTime: ${s}`);
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]) };
}

function parseDate(s: string): YMD {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid date: ${s}`);
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

function wallString(w: Wall): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.y}-${p(w.mo)}-${p(w.d)}T${p(w.h)}:${p(w.mi)}`;
}

/** The local wall time of an instant in a zone, 'YYYY-MM-DDTHH:mm'. */
export function wallTimeInZone(zone: string, at: number): string {
  return wallString(partsInZone(zone, at));
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function addDays(y: number, mo: number, d: number, n: number): YMD {
  const t = new Date(Date.UTC(y, mo - 1, d) + n * 86_400_000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** 'HH:mm' -> minutes after midnight, or null when it is not a wall time. */
function minutesOf(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Why a rule cannot be stored, or null when it is sound. Only the hourly
 * shape is checked here: interval 1..12 and a window whose start precedes its
 * end; a window on any other freq is refused rather than silently ignored.
 */
export function ruleError(rule: ReminderRule): string | null {
  if (rule.freq !== 'hourly') return 'window' in rule ? 'only an hourly rule has a window' : null;
  const interval = rule.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > HOURLY_MAX_INTERVAL) {
    return `an hourly rule repeats every 1 to ${HOURLY_MAX_INTERVAL} hours`;
  }
  if (rule.window === undefined) return null;
  const start = minutesOf(rule.window.start);
  const end = minutesOf(rule.window.end);
  if (start === null || end === null) return 'an hourly window is two HH:mm times';
  return start < end ? null : 'an hourly window must start before it ends';
}

/**
 * The first instant at or after `at` that a rule anchored at `at` rings, or
 * null when it never rings within a week (e.g. `until` already passed). An
 * hourly anchor asked for at 23:10 with an 08:00-22:00 window rings first at
 * 08:00 the next morning, so a reminder is stored with that instant.
 */
export function firstOccurrence(rule: ReminderRule, at: number, zone: string): number | null {
  const [first] = expandOccurrences({
    rule, startWallTime: wallTimeInZone(zone, at), zone, from: at, to: at + 7 * 86_400_000, limit: 1,
  });
  return first === undefined ? null : first.at;
}

/** How far ahead a preview looks: long enough for a yearly rule on Feb 29. */
const PREVIEW_HORIZON_MS = 10 * 366 * 86_400_000;

/**
 * The next `count` rings of a reminder due at `dueAt` in `zone`, at or
 * after `from` (default: the due itself). A one-off reminder rings once. The
 * wall time is anchored in the reminder's own zone, so a daily 08:00 London
 * reminder stays at 08:00 London across the October change.
 */
export function previewOccurrences(input: {
  rule: ReminderRule | null;
  dueAt: number;
  zone: string;
  from?: number;
  count?: number;
}): Occurrence[] {
  const { rule, dueAt, zone } = input;
  const from = input.from ?? dueAt;
  const count = Math.max(1, Math.min(input.count ?? 3, 10));
  if (rule === null) {
    return dueAt >= from ? [{ at: dueAt, wallTime: wallTimeInZone(zone, dueAt) }] : [];
  }
  return expandOccurrences({
    rule, startWallTime: wallTimeInZone(zone, dueAt), zone, from, to: from + PREVIEW_HORIZON_MS, limit: count,
  });
}

function dateGt(a: YMD, b: YMD): boolean {
  if (a.y !== b.y) return a.y > b.y;
  if (a.mo !== b.mo) return a.mo > b.mo;
  return a.d > b.d;
}

/** Whole calendar days from `a` to `b` (negative when `b` is earlier). */
function daysBetween(a: YMD, b: YMD): number {
  return Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 86_400_000);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * How many k in [0, n) satisfy `valid`, where `valid` repeats every `period`
 * steps (the Gregorian calendar repeats every 400 years), in O(period).
 */
function countPeriodic(n: number, period: number, valid: (k: number) => boolean): number {
  const upTo = (end: number): number => {
    let c = 0;
    for (let k = 0; k < end; k++) if (valid(k)) c += 1;
    return c;
  };
  return n <= period ? upTo(n) : Math.floor(n / period) * upTo(period) + upTo(n % period);
}

/**
 * How many distinct rings an hourly rule makes on the `n` days from its anchor
 * day, without walking them all: a plain day rings once per window slot. A
 * spring-forward gap merges the slots inside it with the one at its end into a
 * single ring, which is subtracted arithmetically; the anchor day and the days
 * around an unusual gap (over three hours, or across midnight) are walked slot
 * by slot. Offset changes are found by sampling the offset weekly and
 * bisecting to the minute, so two changes within one week would be missed.
 */
function hourlyRingsBefore(input: {
  zone: string;
  startDay: YMD;
  startMinute: number;
  n: number;
  windowStart: number;
  windowEnd: number;
  step: number;
}): number {
  const { zone, startDay, startMinute, n, windowStart, windowEnd, step } = input;
  const base = Date.UTC(startDay.y, startDay.mo - 1, startDay.d);
  const offsetAt = (at: number): number => {
    const p = partsInZone(zone, at);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - at;
  };
  const slotsIn = (lo: number, hi: number): number => {
    const first = Math.ceil((Math.max(lo, windowStart) - windowStart) / step);
    const last = Math.floor((Math.min(hi, windowEnd) - windowStart) / step);
    return Math.max(0, last - first + 1);
  };
  const walk = new Set<number>([0]);
  const merged = new Map<number, number>();
  let prev = base;
  let prevOffset = offsetAt(prev);
  for (let i = 7; i < n + 7; i += 7) {
    const cur = base + Math.min(i, n) * 86_400_000;
    const curOffset = offsetAt(cur);
    if (curOffset !== prevOffset) {
      // Bisect to the first minute on the new offset.
      let lo = prev;
      let hi = cur;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
        if (offsetAt(mid) === prevOffset) lo = mid;
        else hi = mid;
      }
      const after = partsInZone(zone, hi);
      const before = partsInZone(zone, hi - 60_000);
      const day = daysBetween(startDay, after);
      const gap = offsetAt(hi) - prevOffset;
      if (gap > 0 && gap <= 180 * 60_000 && daysBetween(before, after) === 0) {
        // Every slot in [gap start, gap end] rings once, at the gap end.
        const end = after.h * 60 + after.mi;
        merged.set(day, (merged.get(day) ?? 0) + Math.max(0, slotsIn(end - gap / 60_000, end) - 1));
      } else if (gap > 0) {
        // A day-long skip resolves naively, onto either neighbour: walk two each side.
        for (let d = day - 2; d <= day + 2; d++) walk.add(d);
      }
    }
    prev = cur;
    prevOffset = curOffset;
  }
  const walked = [...walk].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  let rings = (n - walked.length) * slotsIn(windowStart, windowEnd);
  for (const [day, lost] of merged) if (day >= 0 && day < n && !walk.has(day)) rings -= lost;
  let lastAt = -Infinity;
  let lastDay = -2;
  for (const i of walked) {
    if (i !== lastDay + 1) lastAt = -Infinity;
    lastDay = i;
    const day = addDays(startDay.y, startDay.mo, startDay.d, i);
    for (let t = windowStart; t <= windowEnd; t += step) {
      if (i === 0 && t < startMinute) continue;
      const { at } = resolveWall(zone, { ...day, h: Math.floor(t / 60), mi: t % 60 });
      if (at <= lastAt) continue;
      lastAt = at;
      rings += 1;
    }
  }
  return rings;
}

export function expandOccurrences(input: {
  rule: ReminderRule;
  startWallTime: string;
  zone: string;
  from: number;
  to: number;
  limit?: number;
}): Occurrence[] {
  const { rule, zone, from, to } = input;
  const limit = input.limit === undefined ? 500 : Math.max(0, Math.min(input.limit, 1000));
  const interval = Math.max(1, Math.floor(rule.interval ?? 1));
  const start = parseWallTime(input.startWallTime);
  const until = rule.until !== undefined ? parseDate(rule.until) : null;
  const toDate = partsInZone(zone, to);

  const results: Occurrence[] = [];
  let ordinal = 0;

  const pastEnd = (cand: YMD): boolean => dateGt(cand, toDate) || (until !== null && dateGt(cand, until));

  let lastAt = -Infinity;

  /** Emits one candidate occurrence; returns true when generation must stop. */
  const emit = (cand: YMD, h = start.h, mi = start.mi): boolean => {
    const resolved = resolveWall(zone, { y: cand.y, mo: cand.mo, d: cand.d, h, mi });
    // A gap-advanced hourly slot can land on the next slot's instant: one ring.
    if (resolved.at <= lastAt) return false;
    lastAt = resolved.at;
    ordinal += 1;
    if (rule.count !== undefined && ordinal > rule.count) return true;
    if (resolved.at < from || resolved.at >= to) return false;
    const wall = partsInZone(zone, resolved.at);
    results.push({ at: resolved.at, wallTime: wallString(wall), adjusted: resolved.adjusted });
    return results.length >= limit;
  };

  // Nothing on or before `skipTo` can ring at or after `from` (a gap advance
  // moves a wall time by at most three hours), so each frequency starts from
  // there, with `ordinal` set to the occurrences it skipped, instead of
  // stepping one period at a time from a possibly ancient anchor.
  const startDay: YMD = { y: start.y, mo: start.mo, d: start.d };
  const fromWall = partsInZone(zone, from);
  const skipTo = addDays(fromWall.y, fromWall.mo, fromWall.d, -2);

  if (rule.freq === 'hourly') {
    const step = Math.min(interval, HOURLY_MAX_INTERVAL) * 60;
    const windowStart = rule.window === undefined ? 0 : (minutesOf(rule.window.start) ?? 0);
    const windowEnd = rule.window === undefined ? 23 * 60 + 59 : (minutesOf(rule.window.end) ?? 23 * 60 + 59);
    const startMinute = start.h * 60 + start.mi;
    // Without a count nothing before `from` matters: begin the day before it
    // (zone days and UTC days differ) instead of walking from a years-old anchor.
    const fromDay = addDays(fromWall.y, fromWall.mo, fromWall.d, -1);
    let day = rule.count === undefined && dateGt(fromDay, startDay) ? fromDay : startDay;
    const skipDays = daysBetween(startDay, skipTo);
    if (rule.count !== undefined && skipDays > 1) {
      // Every whole day rings at least once, so the series ended before skipTo.
      if (skipDays - 1 >= rule.count) return results;
      ordinal = hourlyRingsBefore({ zone, startDay, startMinute, n: skipDays, windowStart, windowEnd, step });
      day = skipTo;
    }
    while (!pastEnd(day)) {
      const first = day.y === start.y && day.mo === start.mo && day.d === start.d;
      for (let t = windowStart; t <= windowEnd; t += step) {
        if (first && t < startMinute) continue;
        if (emit(day, Math.floor(t / 60), t % 60)) return results;
      }
      day = addDays(day.y, day.mo, day.d, 1);
    }
  } else if (rule.freq === 'daily') {
    const k0 = Math.max(0, Math.floor(daysBetween(startDay, skipTo) / interval));
    ordinal = k0;
    let cand: YMD = addDays(start.y, start.mo, start.d, k0 * interval);
    while (!pastEnd(cand)) {
      if (emit(cand)) break;
      cand = addDays(cand.y, cand.mo, cand.d, interval);
    }
  } else if (rule.freq === 'weekly') {
    const weekdays = rule.byWeekday !== undefined && rule.byWeekday.length > 0 ? rule.byWeekday : [weekdayOf(start.y, start.mo, start.d)];
    const set = new Set(weekdays);
    // Every active week holds each weekday once, so it rings set-size times.
    const perWeek = [...set].filter((w) => Number.isInteger(w) && w >= 0 && w <= 6).length;
    const w0 = Math.max(0, Math.floor(daysBetween(startDay, skipTo) / 7 / interval)) * interval;
    ordinal = (w0 / interval) * perWeek;
    for (let week = w0; !pastEnd(addDays(start.y, start.mo, start.d, week * 7)); week++) {
      if (week % interval !== 0) continue;
      for (let off = 0; off < 7; off++) {
        const cand = addDays(start.y, start.mo, start.d, week * 7 + off);
        if (pastEnd(cand)) return results;
        if (set.has(weekdayOf(cand.y, cand.mo, cand.d)) && emit(cand)) return results;
      }
    }
  } else if (rule.freq === 'monthly') {
    const monthOf = (k: number): YMD => {
      const total = start.mo - 1 + k * interval;
      return { y: start.y + Math.floor(total / 12), mo: (total % 12) + 1, d: start.d };
    };
    // Months k < k0 all end before skipTo's month; the 400-year calendar cycle
    // is 4800 months, so the short-month skips repeat every 4800/gcd steps.
    const monthsDiff = (skipTo.y - start.y) * 12 + skipTo.mo - start.mo;
    const k0 = Math.max(0, Math.floor((monthsDiff - 1) / interval));
    ordinal = countPeriodic(k0, 4800 / gcd(interval, 4800), (k) => {
      const m = monthOf(k);
      return start.d <= daysInMonth(m.y, m.mo);
    });
    for (let k = k0; ; k++) {
      const cand = monthOf(k);
      if (pastEnd(cand)) break;
      if (start.d <= daysInMonth(cand.y, cand.mo) && emit(cand)) break;
    }
  } else {
    const k0 = Math.max(0, Math.floor((skipTo.y - start.y - 1) / interval));
    ordinal = countPeriodic(k0, 400 / gcd(interval, 400), (k) => start.d <= daysInMonth(start.y + k * interval, start.mo));
    for (let k = k0; ; k++) {
      const cand: YMD = { y: start.y + k * interval, mo: start.mo, d: start.d };
      if (pastEnd(cand)) break;
      if (start.d <= daysInMonth(cand.y, cand.mo) && emit(cand)) break;
    }
  }
  return results;
}