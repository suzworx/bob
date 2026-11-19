/**
 * Expands an event master into occurrences in a window: the recurrence engine
 * does the expansion, exception rows are applied on top. All-day events expand
 * from a T00:00 wall time and each instant is read back to its calendar date,
 * which is what makes an all-day date survive any viewer time zone.
 */
import { type Db } from '../platform/db/db.ts';
import { expandOccurrences, wallTimeInZone, type Occurrence } from './recurrence.ts';
import {
  addDaysToDate,
  dateInZone,
  dateUtcMs,
  numOrNull,
  strOrNull,
  type AttendeeResponse,
  type EventException,
  type ListEventsOptions,
  type StoredEvent,
  type StoredOccurrence,
} from './rows.ts';

/** Keyed by original_occurrence_start as epoch-ms. */
async function loadExceptions(tx: Db, eventId: string): Promise<Map<number, EventException>> {
  const rows = await tx.query<Record<keyof EventException, unknown>>(
    `SELECT
       floor(extract(epoch from original_occurrence_start) * 1000)::bigint AS "originalOccurrenceStart",
       cancelled, title, location, body, all_day AS "allDay",
       start_date::text AS "startDate", end_date::text AS "endDate",
       floor(extract(epoch from start_at) * 1000)::bigint AS "startAt",
       floor(extract(epoch from end_at) * 1000)::bigint AS "endAt", zone
     FROM bob.event_exceptions WHERE event_id = $1`,
    [eventId],
  );
  const map = new Map<number, EventException>();
  for (const row of rows) {
    map.set(Number(row.originalOccurrenceStart), {
      originalOccurrenceStart: Number(row.originalOccurrenceStart),
      cancelled: Boolean(row.cancelled),
      title: strOrNull(row.title),
      location: strOrNull(row.location),
      body: strOrNull(row.body),
      allDay: row.allDay === null ? null : Boolean(row.allDay),
      startDate: strOrNull(row.startDate),
      endDate: strOrNull(row.endDate),
      startAt: numOrNull(row.startAt),
      endAt: numOrNull(row.endAt),
      zone: strOrNull(row.zone),
    });
  }
  return map;
}

/** Window checks use the effective (possibly moved) instants. */
function expandTimed(
  ev: StoredEvent,
  exceptions: Map<number, EventException>,
  from: number,
  to: number,
  limit: number,
): StoredOccurrence[] {
  const duration = ev.endAt! - ev.startAt!;
  const startWall = wallTimeInZone(ev.zone, ev.startAt!);
  const base: Occurrence[] = ev.rrule
    ? expandOccurrences({ rule: ev.rrule, startWallTime: startWall, zone: ev.zone, from, to, limit })
    : [{ at: ev.startAt!, wallTime: startWall }];
  const out: StoredOccurrence[] = [];
  for (const occ of base) {
    const exc = exceptions.get(occ.at);
    if (exc?.cancelled) continue;
    let startAt = occ.at;
    let endAt = occ.at + duration;
    let title = ev.title;
    let location = ev.location;
    let body = ev.body;
    let zone = ev.zone;
    let moved = false;
    if (exc) {
      if (exc.startAt !== null) {
        startAt = exc.startAt;
        endAt = exc.endAt ?? exc.startAt + duration;
        moved = true;
      }
      if (exc.title !== null) title = exc.title;
      if (exc.location !== null) location = exc.location;
      if (exc.body !== null) body = exc.body;
      if (exc.zone !== null) zone = exc.zone;
    }
    if (endAt <= from || startAt >= to) continue;
    out.push({
      eventId: ev.id,
      uid: ev.uid,
      title,
      location,
      body,
      allDay: false,
      startDate: null,
      endDate: null,
      startAt,
      endAt,
      zone,
      originalOccurrenceStart: occ.at,
      cancelled: false,
      moved,
    });
  }
  return out;
}

/** The identity is UTC midnight of the occurrence date, so the same date
 *  string is reported in any zone. */
function expandAllDay(
  ev: StoredEvent,
  exceptions: Map<number, EventException>,
  from: number,
  to: number,
  limit: number,
): StoredOccurrence[] {
  const daySpan = Math.round((dateUtcMs(ev.endDate!) - dateUtcMs(ev.startDate!)) / 86_400_000);
  const base: Array<{ date: string; id: number }> = ev.rrule
    ? expandOccurrences({
        rule: ev.rrule,
        startWallTime: `${ev.startDate}T00:00`,
        zone: ev.zone,
        from,
        to,
        limit,
      }).map((occ) => {
        const date = dateInZone(ev.zone, occ.at);
        return { date, id: dateUtcMs(date) };
      })
    : [{ date: ev.startDate!, id: dateUtcMs(ev.startDate!) }];
  const out: StoredOccurrence[] = [];
  for (const occ of base) {
    const exc = exceptions.get(occ.id);
    if (exc?.cancelled) continue;
    let date = occ.date;
    let endDate = addDaysToDate(date, daySpan);
    let title = ev.title;
    let location = ev.location;
    let body = ev.body;
    let zone = ev.zone;
    let moved = false;
    if (exc) {
      if (exc.startDate !== null) {
        date = exc.startDate;
        endDate = exc.endDate ?? addDaysToDate(date, daySpan);
        moved = true;
      }
      if (exc.title !== null) title = exc.title;
      if (exc.location !== null) location = exc.location;
      if (exc.body !== null) body = exc.body;
      if (exc.zone !== null) zone = exc.zone;
    }
    const startMs = dateUtcMs(date);
    const endMs = dateUtcMs(endDate);
    if (endMs <= from || startMs >= to) continue;
    out.push({
      eventId: ev.id,
      uid: ev.uid,
      title,
      location,
      body,
      allDay: true,
      startDate: date,
      endDate,
      startAt: null,
      endAt: null,
      zone,
      originalOccurrenceStart: occ.id,
      cancelled: false,
      moved,
    });
  }
  return out;
}

export async function expandEventOccurrences(
  tx: Db,
  ev: StoredEvent,
  options: ListEventsOptions,
): Promise<StoredOccurrence[]> {
  if (ev.status === 'cancelled') return [];
  const limit = options.limit === undefined ? 500 : Math.max(1, Math.min(options.limit, 1000));
  const exceptions = await loadExceptions(tx, ev.id);
  if (!ev.allDay) {
    return expandTimed(ev, exceptions, options.from, options.to, limit);
  }
  return expandAllDay(ev, exceptions, options.from, options.to, limit);
}

/** An occurrence with the caller's own RSVP, or null when the caller is not
 *  an attendee. */
export type UserOccurrence = StoredOccurrence & { myResponse: AttendeeResponse | null };

export const MY_RESPONSE = `(SELECT a.response FROM bob.event_attendees a
  WHERE a.event_id = calendar_events.id AND a.user_id = $2) AS "myResponse"`;
