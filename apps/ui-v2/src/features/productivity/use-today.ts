import { useCallback, useEffect, useRef, useState } from 'react';
import { googleProjectionSchema, googleInclusiveEnd, type GoogleAgendaItem, type GoogleAgendaState } from '@/features/integrations/google-agenda';
import { browserTimeZone, fetchWithAuth, useSession } from '@/lib/auth/use-session';
import type { AgendaItem } from './use-agenda';
import type { AttendeeResponse } from './use-events';
import type { ReminderSummary as ReminderRecord } from './use-reminders';
import type { TaskSummary as TaskRecord } from './use-tasks';

/** The one time zone every calendar surface reads days and times in: the
 *  account's (seeded from the browser at first sign-in), else the browser's.
 *  Today, Calendar, the space Agenda and the event and reminder dialogs all
 *  call this, so an item never sits on different days on different pages. */
export function useAccountZone(): string {
  const { session } = useSession();
  const zone: unknown = session?.user.user_metadata?.time_zone;
  return typeof zone === 'string' && zone !== '' ? zone : browserTimeZone();
}

/** "2:00 PM": a clock time in `zone`, the one formatter for times on these pages. */
export function formatZoneTime(at: number, zone: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(at);
}

/** "Oct 24": a calendar date of an instant in `zone`. */
export function formatZoneDate(at: number, zone: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: zone }).format(at);
}

/** The first day of the week on every calendar grid (Calendar and space Agenda). */
export const WEEK_STARTS_ON = 'mon' as const;

/**
 * The Calendar view (story S30, issues #141 and #448): one chronological list of
 * what is due on a picked day, composed client-side from the endpoints that exist —
 * GET /api/spaces, GET /api/spaces/:id/tasks?status=open, then
 * GET /api/spaces/:id/calendars and GET /api/calendars/:id/events, plus
 * GET /api/spaces/:id/reminders (active reminders ringing that day). There is no
 * /api/today and this hook does not add one. When the picked day is today, open
 * tasks from earlier days (overdue) are kept too.
 *
 * The labelling is the point (FR-032): every item carries the space it came
 * from (`spaceId`, `spaceName`, `spaceKind`) so a private item is never shown
 * without its audience.
 *
 * Two honesty rules from the data model are preserved here rather than fixed in
 * the panel: a date-only task keeps `dateOnly: true` and a day-only sort key, so
 * no caller invents a midnight time; an all-day event keeps `allDay: true` and
 * its calendar date. A partial failure is not a total failure: a space whose
 * fetch fails is named in `unavailableSpaces` while the other spaces still
 * render — membership can be revoked under the client, and that is expected.
 */

type TodaySpaceKind = 'private' | 'pair' | 'group';

type TodayDue =
  | { kind: 'date'; date: string }
  | { kind: 'instant'; at: number; zone: string };

type SpaceLabel = { spaceId: string; spaceName: string; spaceKind: TodaySpaceKind };

export type TodayTaskItem = SpaceLabel & {
  kind: 'task';
  id: string;
  title: string;
  due: TodayDue;
  /** Local calendar day key (`YYYY-MM-DD`) used for grouping. */
  day: string;
  /** Epoch ms used for chronological ordering (start of day for date-only). */
  sortAt: number;
  /** True when the due has no time — the panel must never render a clock time. */
  dateOnly: boolean;
  revision: number;
  /** Who the task is for; null is anyone in the space. */
  assigneeUserId: string | null;
  /** The task as the API sent it, for the edit dialog. */
  task: TaskRecord;
};

type TodayEventItem = SpaceLabel & {
  kind: 'event';
  id: string;
  title: string;
  day: string;
  sortAt: number;
  allDay: boolean;
  startAt: number | null;
  startDate: string | null;
  myResponse?: AttendeeResponse | null;
  /** The occurrence as /api/agenda sent it, for the event dialog. */
  agenda: AgendaItem;
};

/** A read-only Google Calendar event: it belongs to the person, not a space. */
type TodayGoogleItem = {
  kind: 'google';
  id: string;
  title: string;
  day: string;
  sortAt: number;
  item: GoogleAgendaItem;
};

/** An active reminder ringing on the picked day; `at` is this day's instant.
 *  An hourly reminder is one row a day: `at` is its next ring (or its first,
 *  on another day) and `repeat` names the rule ("Every hour 8:00–22:00"). */
export type TodayReminderItem = SpaceLabel & {
  kind: 'reminder';
  id: string;
  title: string;
  day: string;
  sortAt: number;
  at: number;
  repeat: string | null;
  /** True for an hourly row whose `at` is still to come today. */
  isNext: boolean;
  /** The reminder itself (rule, zone), for its menu: no second fetch. */
  reminder: ReminderRecord;
};

export type TodayItem = TodayTaskItem | TodayEventItem | TodayReminderItem | TodayGoogleItem;

type UseTodayResult = {
  items: TodayItem[];
  loading: boolean;
  error: string | null;
  /** Names of spaces whose data could not be loaded; the rest still render. */
  unavailableSpaces: string[];
  /** The day `items` belong to; differs from the picked day until its first load settles. */
  loadedDay: string | null;
  /** True when /api/agenda (every event, native and Google) could not load. */
  eventsUnavailable: boolean;
  /** Google's freshness, for the incomplete-results notice; null before a load. */
  google: GoogleAgendaState | null;
  refresh: () => Promise<void>;
};

export type DayItemsOptions = {
  /** How many days from `day` to list (default 1): the Calendar lists the picked day and the week after it. */
  days?: number;
  /** When set, only tasks for this person (or for anyone) are kept: Today is my day, not the space's. */
  me?: string | null;
  /** Keep open tasks from before `day` when `day` is today (default true). The Calendar lists only its own days. */
  overdue?: boolean;
};

const LIST_ERROR = 'The calendar could not be loaded.';

/** The calendar day key (`YYYY-MM-DD`) of an instant: in `zone` when one is
 *  given (the account's, #870), else in the browser's. */
export function localDayKey(epochMs: number, zone?: string): string {
  if (zone !== undefined) return ymdKey(zoneParts(epochMs, zone));
  const d = new Date(epochMs);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** The calendar date after `date` (`YYYY-MM-DD`). */
function nextDate(date: string): string {
  const [y, mo, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, (d ?? 1) + 1));
  return ymdKey({ y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1, d: next.getUTCDate() });
}

/** Midnight of a calendar date in `zone`: the start of that day's window. */
export function zoneDayStart(date: string, zone: string): number {
  return dateStart(date, zone);
}

/** The instant of midnight for a calendar date (`YYYY-MM-DD`): in `zone` when
 *  one is given, else the browser's. */
function dateStart(date: string, zone?: string): number {
  if (zone === undefined) return new Date(`${date}T00:00:00`).getTime();
  const [y, mo, d] = date.split('-').map(Number);
  return wallToInstant({ y: y ?? 0, mo: mo ?? 1, d: d ?? 1 }, 0, 0, zone);
}

function isSpaceKind(value: string): value is TodaySpaceKind {
  return value === 'private' || value === 'pair' || value === 'group';
}

function label(space: SpaceSummary): SpaceLabel {
  return {
    spaceId: space.id,
    spaceName: space.name,
    spaceKind: isSpaceKind(space.kind) ? space.kind : 'group',
  };
}

type SpaceSummary = { id: string; kind: string; name: string };

type TaskSummary = TaskRecord;

type Occurrence = AgendaItem;

/** A completed or trashed task never appears; a task with no due is on no day. */
function toTaskItem(space: SpaceSummary, task: TaskSummary, zone?: string): TodayTaskItem | null {
  if (task.status !== 'open' || task.trashed_at !== null || task.due === null) return null;
  const due = task.due;
  const dateOnly = due.kind === 'date';
  return {
    kind: 'task',
    id: task.id,
    title: task.title,
    due,
    day: dateOnly ? due.date : localDayKey(due.at, zone),
    sortAt: dateOnly ? dateStart(due.date, zone) : due.at,
    dateOnly,
    revision: task.revision,
    assigneeUserId: task.assignee_user_id ?? null,
    task,
    ...label(space),
  };
}

function toEventItem(space: SpaceSummary, occurrence: Occurrence, zone?: string): TodayEventItem | null {
  if (occurrence.cancelled) return null;
  const id = `${occurrence.event_id}:${occurrence.original_occurrence_start}`;
  if (occurrence.all_day && occurrence.start_date !== null) {
    return {
      kind: 'event',
      id,
      title: occurrence.title,
      day: occurrence.start_date,
      sortAt: dateStart(occurrence.start_date, zone),
      allDay: true,
      startAt: null,
      startDate: occurrence.start_date,
      myResponse: occurrence.my_response ?? null,
      agenda: occurrence,
      ...label(space),
    };
  }
  if (occurrence.start_at !== null) {
    return {
      kind: 'event',
      id,
      title: occurrence.title,
      day: localDayKey(occurrence.start_at, zone),
      sortAt: occurrence.start_at,
      allDay: false,
      startAt: occurrence.start_at,
      startDate: occurrence.start_date,
      myResponse: occurrence.my_response ?? null,
      agenda: occurrence,
      ...label(space),
    };
  }
  if (occurrence.start_date !== null) {
    return {
      kind: 'event',
      id,
      title: occurrence.title,
      day: occurrence.start_date,
      sortAt: dateStart(occurrence.start_date, zone),
      allDay: false,
      startAt: null,
      startDate: occurrence.start_date,
      myResponse: occurrence.my_response ?? null,
      agenda: occurrence,
      ...label(space),
    };
  }
  return null;
}

/** The reminder's rule as GET /api/spaces/:id/reminders returns it. "Weekdays"
 *  is a weekly rule with byWeekday 1..5. `count` is not enforced here. */
type DatedRule = {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  byWeekday?: number[];
  until?: string;
  count?: number;
};

/** Every `interval` hours from window.start to window.end (HH:mm, zone wall
 *  time, both inclusive) each day; no window = the whole day. */
type HourlyRule = {
  freq: 'hourly';
  interval?: number;
  window?: { start: string; end: string };
  until?: string;
  count?: number;
};

type ReminderRule = DatedRule | HourlyRule;

type ReminderSummary = {
  id: string;
  title: string;
  due_at: number | null;
  due_zone: string | null;
  rrule: ReminderRule | null;
  status: 'active' | 'paused' | 'cancelled';
};

type Ymd = { y: number; mo: number; d: number };
type WallParts = Ymd & { h: number; mi: number };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The wall clock an instant occupies in an IANA zone. */
function zoneParts(at: number, zone: string): WallParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    calendar: 'gregory',
  });
  const g: Record<string, number> = {};
  for (const p of fmt.formatToParts(at)) if (p.type !== 'literal') g[p.type] = Number(p.value);
  return { y: g.year ?? 0, mo: g.month ?? 1, d: g.day ?? 1, h: g.hour ?? 0, mi: g.minute ?? 0 };
}

/** The instant a wall time names in a zone (two passes settle a DST shift). */
function wallToInstant(date: Ymd, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(date.y, date.mo - 1, date.d, h, mi);
  const offsetAt = (at: number): number => {
    const p = zoneParts(at, zone);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(at / 60000) * 60000;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

function dayNumber(date: Ymd): number {
  return Math.round(Date.UTC(date.y, date.mo - 1, date.d) / DAY_MS);
}

function ymdKey(date: Ymd): string {
  return `${date.y}-${String(date.mo).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
}

/** Whether a repeating rule, anchored at `anchor`, occurs on the zone date `date`. */
function ruleOccursOn(rule: DatedRule, anchor: Ymd, date: Ymd): boolean {
  const diff = dayNumber(date) - dayNumber(anchor);
  if (diff < 0) return false;
  if (rule.until !== undefined && ymdKey(date) > rule.until) return false;
  const interval = Math.max(1, Math.floor(rule.interval ?? 1));
  if (rule.freq === 'daily') return diff % interval === 0;
  if (rule.freq === 'weekly') {
    const anchorWeekday = new Date(Date.UTC(anchor.y, anchor.mo - 1, anchor.d)).getUTCDay();
    const weekday = new Date(Date.UTC(date.y, date.mo - 1, date.d)).getUTCDay();
    const days = rule.byWeekday && rule.byWeekday.length > 0 ? rule.byWeekday : [anchorWeekday];
    if (!days.includes(weekday)) return false;
    return Math.floor((diff + anchorWeekday) / 7) % interval === 0;
  }
  if (rule.freq === 'monthly') {
    return date.d === anchor.d && ((date.y - anchor.y) * 12 + date.mo - anchor.mo) % interval === 0;
  }
  return date.mo === anchor.mo && date.d === anchor.d && (date.y - anchor.y) % interval === 0;
}

function minutesOf(hhmm: string, fallback: number): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m) ? fallback : h * 60 + m;
}

/** The wall-clock minutes an hourly rule rings at on each day of its zone. */
function hourlySlots(rule: HourlyRule): number[] {
  const step = Math.min(12, Math.max(1, Math.floor(rule.interval ?? 1))) * 60;
  const start = rule.window === undefined ? 0 : minutesOf(rule.window.start, 0);
  const end = rule.window === undefined ? 24 * 60 - 1 : minutesOf(rule.window.end, 24 * 60 - 1);
  const slots: number[] = [];
  for (let t = start; t <= end; t += step) slots.push(t);
  return slots;
}

/** Every instant an active reminder rings on the day `day` (in `zone` when
 *  given, else the browser's), ascending.
 *  A repeating one is checked on the zone dates around `day`, since the
 *  reader's day and the reminder's zone day can differ. Hourly rules ring at
 *  each slot of the zone day from the anchor on; a DST-merged slot rings once. */
export function reminderInstantsOn(reminder: ReminderSummary, day: string, dayZone?: string): number[] {
  if (reminder.status !== 'active' || reminder.due_at === null) return [];
  if (reminder.rrule === null) return localDayKey(reminder.due_at, dayZone) === day ? [reminder.due_at] : [];
  const rule = reminder.rrule;
  const dueAt = reminder.due_at;
  const zone = reminder.due_zone ?? 'UTC';
  const anchor = zoneParts(dueAt, zone);
  const [y, mo, d] = day.split('-').map(Number);
  const found = new Set<number>();
  for (const offset of [-1, 0, 1]) {
    const shifted = new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, (d ?? 1) + offset));
    const date = { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
    if (rule.freq === 'hourly') {
      if (dayNumber(date) < dayNumber(anchor) || (rule.until !== undefined && ymdKey(date) > rule.until)) continue;
      for (const t of hourlySlots(rule)) {
        const at = wallToInstant(date, Math.floor(t / 60), t % 60, zone);
        if (at >= dueAt && localDayKey(at, dayZone) === day) found.add(at);
      }
    } else if (ruleOccursOn(rule, anchor, date)) {
      const at = wallToInstant(date, anchor.h, anchor.mi, zone);
      if (localDayKey(at, dayZone) === day) found.add(at);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** The first instant an active reminder rings on the local day `day`, or null. */
export function reminderInstantOn(reminder: ReminderSummary, day: string): number | null {
  return reminderInstantsOn(reminder, day)[0] ?? null;
}

/** "Every hour 8:00–22:00" / "Every 2 hours 8:00–22:00": an hourly rule in words. */
export function hourlyRepeatLabel(rule: { interval?: number; window?: { start: string; end: string } }): string {
  const every = Math.max(1, Math.floor(rule.interval ?? 1));
  const head = every === 1 ? 'Every hour' : `Every ${every} hours`;
  if (rule.window === undefined) return head;
  const trim = (hhmm: string): string => hhmm.replace(/^0(\d)/, '$1');
  return `${head} ${trim(rule.window.start)}–${trim(rule.window.end)}`;
}

/** One row per reminder per day. An hourly reminder rings many times a day,
 *  and fifteen identical rows said nothing the rule did not: it is one row,
 *  at its next ring today (or its first, on any other day). */
function toReminderItems(space: SpaceSummary, reminder: ReminderSummary, day: string, zone?: string, now = Date.now()): TodayReminderItem[] {
  const instants = reminderInstantsOn(reminder, day, zone);
  const base = { kind: 'reminder' as const, title: reminder.title, day, reminder: reminder as unknown as ReminderRecord, ...label(space) };
  if (reminder.rrule?.freq === 'hourly') {
    if (instants.length === 0) return [];
    const upcoming = instants.find((at) => at >= now);
    const at = upcoming ?? instants[instants.length - 1] ?? 0;
    return [{ ...base, id: `${reminder.id}:${day}`, sortAt: at, at, repeat: hourlyRepeatLabel(reminder.rrule), isNext: upcoming !== undefined }];
  }
  return instants.map((at) => ({ ...base, id: `${reminder.id}:${at}`, sortAt: at, at, repeat: null, isNext: false }));
}

/** A Google event's day and sort key in `zone`; an all-day one keeps its own date. */
function toGoogleItems(item: GoogleAgendaItem, days: readonly string[], zone?: string): TodayGoogleItem[] {
  if ('date' in item.start) {
    const first = item.start.date;
    const last = 'date' in item.end ? googleInclusiveEnd(item.end.date) : first;
    return days.filter((day) => day >= first && day <= last).map((day) => ({
      kind: 'google', id: `${item.source_key}:${day}`, title: item.title, day, sortAt: dateStart(day, zone), item,
    }));
  }
  const at = Date.parse(item.start.dateTime);
  const day = localDayKey(at, zone);
  return days.includes(day) ? [{ kind: 'google', id: item.source_key, title: item.title, day, sortAt: at, item }] : [];
}

/** One space's items plus whether every fetch for that space succeeded. */
type SpaceLoad = { space: SpaceSummary; items: TodayItem[]; ok: boolean };

/** `count` consecutive day keys from `day`. */
function dayRun(day: string, count: number): string[] {
  const days = [day];
  while (days.length < count) days.push(nextDate(days[days.length - 1] ?? day));
  return days;
}

type AgendaLoad = { items: AgendaItem[]; google: GoogleAgendaState } | null;

async function loadAgendaWindow(from: number, to: number): Promise<AgendaLoad> {
  try {
    const response = await fetchWithAuth(`/api/agenda?from=${from}&to=${to}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { items?: AgendaItem[] };
    const projection = googleProjectionSchema.safeParse(body);
    return {
      items: Array.isArray(body.items) ? body.items : [],
      google: projection.success ? projection.data : { remote_items: [], sources: [], remote_unavailable: true },
    };
  } catch {
    return null;
  }
}

/** What one load reads: its days, the zone they are read in, and whose tasks count. */
type LoadScope = { days: string[]; day: string; zone?: string; me: string | null; includeOverdue: boolean };

/** The days a load lists and their instant window: [first midnight, midnight
 *  after the last day), 23 or 25 hours a day across a DST change. */
function loadWindow(day: string, dayCount: number, zone: string | undefined, me: string | null, keepOverdue: boolean): { scope: LoadScope; from: number; to: number } {
  const days = dayRun(day, dayCount);
  const lastDay = days[days.length - 1] ?? day;
  const includeOverdue = keepOverdue && day === localDayKey(Date.now(), zone);
  return { scope: { days, day, zone, me, includeOverdue }, from: dateStart(day, zone), to: dateStart(nextDate(lastDay), zone) };
}

/** Whether a task belongs on the listed days for this reader. Someone else's
 *  task is theirs, not part of my day; overdue ones stay on today. */
function keepTask(item: TodayTaskItem, scope: LoadScope): boolean {
  if (scope.me !== null && item.assigneeUserId !== null && item.assigneeUserId !== scope.me) return false;
  return scope.days.includes(item.day) || (scope.includeOverdue && item.day < scope.day);
}

async function spaceTasks(space: SpaceSummary, scope: LoadScope): Promise<TodayItem[] | null> {
  const response = await fetchWithAuth(`/api/spaces/${space.id}/tasks?status=open`);
  if (!response.ok) return null;
  const body = (await response.json()) as { tasks: TaskSummary[] };
  return body.tasks
    .map((task) => toTaskItem(space, task, scope.zone))
    .filter((item): item is TodayTaskItem => item !== null && keepTask(item, scope));
}

async function spaceReminders(space: SpaceSummary, scope: LoadScope): Promise<TodayItem[] | null> {
  const response = await fetchWithAuth(`/api/spaces/${space.id}/reminders`);
  if (!response.ok) return null;
  const body = (await response.json()) as { reminders: ReminderSummary[] };
  return body.reminders.flatMap((reminder) => scope.days.flatMap((each) => toReminderItems(space, reminder, each, scope.zone)));
}

/** One space's tasks and reminders; `ok` is false when either read failed. */
async function loadSpace(space: SpaceSummary, scope: LoadScope): Promise<SpaceLoad> {
  try {
    const [tasks, reminders] = await Promise.all([spaceTasks(space, scope), spaceReminders(space, scope)]);
    return { space, items: [...(tasks ?? []), ...(reminders ?? [])], ok: tasks !== null && reminders !== null };
  } catch {
    return { space, items: [], ok: false };
  }
}

/** Native events (labelled with their space) and Google rows on the listed days. */
function agendaRows(agenda: AgendaLoad, spaces: SpaceSummary[], scope: LoadScope): TodayItem[] {
  if (agenda === null) return [];
  const bySpace = new Map(spaces.map((space) => [space.id, space]));
  const events: TodayItem[] = [];
  for (const occurrence of agenda.items) {
    const space = bySpace.get(occurrence.space_id);
    const item = space === undefined ? null : toEventItem(space, occurrence, scope.zone);
    if (item !== null && scope.days.includes(item.day)) events.push(item);
  }
  for (const remote of agenda.google.remote_items) events.push(...toGoogleItems(remote, scope.days, scope.zone));
  return events;
}

/**
 * Everything on `day` (and, with `days`, the days after it), composed from
 * GET /api/spaces, each space's open tasks and reminders, and ONE
 * GET /api/agenda for the window: native events across every space plus the
 * person's read-only Google events, which the old per-calendar reads never
 * saw. `refreshKey` is the account-events wake-up channel
 * (use-account-events.ts): the caller bumps it to refetch. `zone` is the zone
 * every day is read in: the account's (useAccountZone), on every page.
 */
export function useDayItems(day: string, refreshKey = 0, zone?: string, options: DayItemsOptions = {}): UseTodayResult {
  const dayCount = Math.max(1, options.days ?? 1);
  const me = options.me ?? null;
  const keepOverdue = options.overdue ?? true;
  const [items, setItems] = useState<TodayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailableSpaces, setUnavailableSpaces] = useState<string[]>([]);
  const [eventsUnavailable, setEventsUnavailable] = useState(false);
  const [google, setGoogle] = useState<GoogleAgendaState | null>(null);
  const [loadedDay, setLoadedDay] = useState<string | null>(null);
  const requestCounterRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestCounterRef.current;
    setLoading(true);
    try {
      const { scope, from, to } = loadWindow(day, dayCount, zone, me, keepOverdue);
      const agendaPromise = loadAgendaWindow(from, to);

      const response = await fetchWithAuth('/api/spaces');
      if (!response.ok) throw new Error('spaces_failed');
      if (requestId !== requestCounterRef.current) return;
      const body = (await response.json()) as { spaces: SpaceSummary[] };

      // Each space resolves independently: one failure never rejects the batch.
      const loaded = await Promise.all(body.spaces.map((space) => loadSpace(space, scope)));
      const agenda = await agendaPromise;
      if (requestId !== requestCounterRef.current) return;
      const events = agendaRows(agenda, body.spaces, scope);

      const merged = [...loaded.flatMap((result) => result.items), ...events].sort((a, b) => a.sortAt - b.sortAt);
      setItems(merged);
      setUnavailableSpaces(loaded.filter((result) => !result.ok).map((result) => result.space.name));
      setEventsUnavailable(agenda === null);
      setGoogle(agenda?.google ?? null);
      setError(null);
      setLoadedDay(day);
    } catch {
      if (requestId !== requestCounterRef.current) return;
      setItems([]);
      setUnavailableSpaces([]);
      setEventsUnavailable(false);
      setGoogle(null);
      setError(LIST_ERROR);
      setLoadedDay(day);
    } finally {
      if (requestId === requestCounterRef.current) setLoading(false);
    }
  }, [day, zone, dayCount, me, keepOverdue]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return { items, loading, error, unavailableSpaces, eventsUnavailable, google, loadedDay, refresh: load };
}
