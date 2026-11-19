/**
 * Local-time helpers for the thread invocation's capabilities. A model's due or
 * event time becomes a stored instant in the account zone with
 * BOB_LOCAL_TIME_DUES on, or keeps the legacy pass-through with it off;
 * read-backs render the same zone. Pure: no store or agent access, so
 * tasks/agent-callbacks.ts and voice/turn/tools.ts import these directly.
 * The invocation workflow is workflows/workflow-thread-invocation.ts.
 */
import { resolveAlarmTime } from '../timers/store.ts';
import { LOCAL_WALL_TIME_SHAPE, type CreateEventInput } from '@bob/ai';
import type { NewEventInput } from '../calendar/store.ts';

/** What a binder converts timed tool input with: the account zone and the
 *  BOB_LOCAL_TIME_DUES flag. Flag off keeps the legacy pass-through of the
 *  model's ISO instant and zone. */
export interface LocalTimeScope {
  timeZone: string;
  localTimeDues: boolean;
}

const LOCAL_WALL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/** A local wall-clock time in `timeZone` as an instant; a DST gap moves forward.
 *  A `now` of -Infinity means no due counts as past. An offset or Z is refused
 *  with the expected shape so the model can retry. */
function localWallToInstant(at: string, timeZone: string): number {
  const text = at.trim();
  if (!LOCAL_WALL_RE.test(text)) {
    throw new Error(
      `expected local wall-clock time ${LOCAL_WALL_TIME_SHAPE} in the user's timezone, with no Z or offset; got "${at}"`,
    );
  }
  return resolveAlarmTime(text, timeZone, Number.NEGATIVE_INFINITY);
}

/** The stored instant due for a model `at`: local wall time in the account zone
 *  with the flag on; the model's own at and zone with it off. */
export function dueInstant(
  due: { at: string; zone?: string },
  scope: LocalTimeScope,
): { kind: 'instant'; at: number; zone: string } {
  if (scope.localTimeDues) {
    return { kind: 'instant', at: localWallToInstant(due.at, scope.timeZone), zone: scope.timeZone };
  }
  return { kind: 'instant', at: Date.parse(due.at), zone: due.zone ?? scope.timeZone };
}

/** The zone and times of a create_event input, as the event store takes them. */
export function eventTiming(input: CreateEventInput, scope: LocalTimeScope): Omit<NewEventInput, 'title'> {
  const allDay = input.allDay === true;
  const zone = scope.localTimeDues || !('zone' in input) ? scope.timeZone : input.zone;
  if (allDay) return { zone, allDay, startDate: input.startIso.slice(0, 10), endDate: input.endIso.slice(0, 10) };
  const instant = scope.localTimeDues ? (at: string) => localWallToInstant(at, scope.timeZone) : Date.parse;
  return { zone, allDay, startAt: instant(input.startIso), endAt: instant(input.endIso) };
}

/** "2026-09-24T09:00 America/Los_Angeles": an instant as local wall time plus zone. */
function wallTimeIn(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')} ${timeZone}`;
}

/** list_tasks read-back of a due: local wall time plus zone with the flag on,
 *  the legacy bare UTC ISO string with it off. */
export function taskDueText(
  task: { dueDate: string | null; dueAt: number | null; dueZone: string | null },
  scope: LocalTimeScope,
): string | null {
  if (task.dueDate !== null) return task.dueDate;
  if (task.dueAt === null || task.dueZone === null) return null;
  return scope.localTimeDues ? wallTimeIn(task.dueAt, scope.timeZone) : new Date(task.dueAt).toISOString();
}

/** list_agenda read-back of one end of an occurrence: local wall time plus zone
 *  (all-day: the bare date) with the flag on, the legacy UTC ISO with it off. */
export function agendaTimeText(at: number | null, date: string | null, scope: LocalTimeScope): string {
  if (at !== null) return scope.localTimeDues ? wallTimeIn(at, scope.timeZone) : new Date(at).toISOString();
  return scope.localTimeDues ? `${date}` : `${date}T00:00:00Z`;
}

/** The zone a freshly created default calendar gets. */
export function defaultCalendarZone(scope: LocalTimeScope): string {
  return scope.localTimeDues ? scope.timeZone : 'UTC';
}
