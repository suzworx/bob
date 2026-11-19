/**
 * Native calendars and events store. Every function runs under withUser() so
 * RLS decides access from ACTIVE membership; a space (and everything in it) a
 * caller cannot see is indistinguishable from one that does not exist
 * (StoreNotFoundError, no separate code).
 *
 * Two invariants are enforced in code, not only in SQL: an edit always carries
 * an explicit recurrence scope (never defaulted), and only an attendee may set
 * their own response (an admin/organizer who is not an attendee cannot).
 */
import { randomUUID } from 'node:crypto';
import { StoreConflictError, StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { requireSpaceMember } from '../spaces/store.ts';
import { MY_RESPONSE, expandEventOccurrences, type UserOccurrence } from './expand.ts';
import { type RecurrenceRule } from './recurrence.ts';
import {
  CALENDAR_COLUMNS,
  CalendarForbiddenError,
  CalendarInvalidError,
  EVENT_COLUMNS,
  addDaysToDate,
  dateInZone,
  dateUtcMs,
  isAttendeeResponse,
  isAttendeeRole,
  isRecurrenceScope,
  normalizeStartEnd,
  numOrNull,
  resolveTiming,
  rowToAttendee,
  rowToCalendar,
  rowToEvent,
  strOrNull,
  toAttendeeResponse,
  toCalendarOrigin,
  ts,
  validateName,
  validateTitle,
  validateZone,
  type AttendeeResponse,
  type AttendeeRole,
  type AttendeeRow,
  type CalendarOrigin,
  type CalendarRow,
  type EventPatch,
  type EventRow,
  type ListEventsOptions,
  type NewEventInput,
  type RecurrenceScope,
  type StoredAttendee,
  type StoredCalendar,
  type StoredEvent,
} from './rows.ts';
export { CalendarForbiddenError, CalendarInvalidError } from './rows.ts';
export type { AttendeeResponse, AttendeeRole, EventPatch, NewEventInput, StoredAttendee, StoredCalendar, StoredEvent } from './rows.ts';
export type { UserOccurrence } from './expand.ts';

export async function listCalendars(db: Db, userId: string, spaceId: string): Promise<StoredCalendar[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<CalendarRow>(
      `SELECT ${CALENDAR_COLUMNS} FROM bob.calendars
       WHERE space_id = $1 ORDER BY created_at ASC`,
      [spaceId],
    );
    return rows.map(rowToCalendar);
  });
}

export async function createCalendar(
  db: Db,
  userId: string,
  spaceId: string,
  input: { name: string; zone: string },
): Promise<StoredCalendar> {
  const name = validateName(input.name);
  const zone = validateZone(input.zone);
  return withUser(db, userId, async (tx) => {
    await requireSpaceMember(tx, spaceId, userId);
    const rows = await tx.query<CalendarRow>(
      `INSERT INTO bob.calendars (space_id, name, zone, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING ${CALENDAR_COLUMNS}`,
      [spaceId, name, zone, userId],
    );
    if (!rows[0]) throw new StoreNotFoundError('calendar not found');
    return rowToCalendar(rows[0]);
  });
}

/** RLS hides other spaces' events, so a hidden id is a plain not-found. */
async function requireEvent(tx: Db, eventId: string, options?: { forUpdate?: boolean }): Promise<StoredEvent> {
  const lock = options?.forUpdate ? ' FOR UPDATE' : '';
  const rows = await tx.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM bob.calendar_events WHERE id = $1${lock}`,
    [eventId],
  );
  if (!rows[0]) throw new StoreNotFoundError('event not found');
  return rowToEvent(rows[0]);
}

async function requireCalendarSpace(tx: Db, calendarId: string): Promise<string> {
  const rows = await tx.query<{ spaceId: unknown }>(
    `SELECT space_id AS "spaceId" FROM bob.calendars WHERE id = $1`,
    [calendarId],
  );
  if (!rows[0]) throw new StoreNotFoundError('calendar not found');
  return String(rows[0].spaceId);
}

/** The organizer may change their event; once the organizer is no longer an
 *  active member of the event's space, that space's active owner may. Group
 *  moderation does not confer organizer authority. */
async function assertCanManageEvent(
  tx: Db,
  ev: { spaceId: string; organizerUserId: string },
  userId: string,
  message: string,
): Promise<void> {
  if (ev.organizerUserId === userId) return;
  const rows = await tx.query<{ userId: unknown; role: unknown }>(
    `SELECT user_id AS "userId", role FROM bob.space_memberships
     WHERE space_id = $1 AND revoked_at IS NULL AND user_id IN ($2, $3)`,
    [ev.spaceId, ev.organizerUserId, userId],
  );
  const organizerActive = rows.some((row) => String(row.userId) === ev.organizerUserId);
  if (organizerActive) throw new CalendarForbiddenError(message);
  const callerRole = rows.find((row) => String(row.userId) === userId)?.role;
  if (callerRole === undefined || String(callerRole) !== 'owner') {
    throw new CalendarForbiddenError(message);
  }
}

/** A group space's owner or admin moderates its events. Pair peers are both
 *  seeded 'owner', so the space kind is part of the rule. */
export function isEventModerator(spaceKind: string, role: string | undefined): boolean {
  return spaceKind === 'group' && (role === 'owner' || role === 'admin');
}

/** Cancelling: whoever may manage the event or, beyond that, a moderator of
 *  its group space -- on a NATIVE calendar only. Editing stays organizer-only. */
async function assertCanCancelEvent(tx: Db, ev: StoredEvent, userId: string): Promise<void> {
  if (ev.organizerUserId !== userId) {
    const rows = await tx.query<{ kind: unknown; role: unknown }>(
      `SELECT s.kind, m.role FROM bob.calendars c
       JOIN bob.spaces s ON s.id = c.space_id
       JOIN bob.space_memberships m ON m.space_id = c.space_id AND m.user_id = $2 AND m.revoked_at IS NULL
       WHERE c.id = $1 AND c.origin = 'native'`,
      [ev.calendarId, userId],
    );
    const row = rows[0];
    if (row && isEventModerator(String(row.kind), String(row.role))) return;
  }
  await assertCanManageEvent(tx, ev, userId, 'only the organizer can change this event');
}

const ATTENDEE_COLUMNS = `event_id AS "eventId", user_id AS "userId", email, response, role`;

/** Being invited grants no membership: the invitee must already be an active
 *  member, and only event_attendees is written. */
async function insertAttendee(
  tx: Db,
  event: { id: string; spaceId: string },
  attendeeUserId: string,
  role: AttendeeRole,
): Promise<StoredAttendee> {
  const members = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM bob.space_memberships
     WHERE space_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [event.spaceId, attendeeUserId],
  );
  if (members.length === 0) {
    throw new CalendarInvalidError('attendee must be an active member of the space');
  }
  const rows = await tx.query<AttendeeRow>(
    `INSERT INTO bob.event_attendees (event_id, user_id, space_id, response, role)
     VALUES ($1, $2, $3, 'needs_action', $4)
     ON CONFLICT (event_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()
     RETURNING ${ATTENDEE_COLUMNS}`,
    [event.id, attendeeUserId, event.spaceId, role],
  );
  const [row] = rows;
  if (row === undefined) throw new StoreError('attendee upsert returned no row');
  return rowToAttendee(row);
}

export async function getEvent(db: Db, userId: string, eventId: string): Promise<StoredEvent> {
  return withUser(db, userId, (tx) => requireEvent(tx, eventId));
}

export async function createEvent(
  db: Db,
  userId: string,
  calendarId: string,
  input: NewEventInput,
): Promise<StoredEvent> {
  const title = validateTitle(input.title);
  const zone = validateZone(input.zone);
  const timing = normalizeStartEnd(input);
  const uid = randomUUID();
  const organizerUserId = input.organizerUserId ?? userId;
  return withUser(db, userId, async (tx) => {
    const spaceId = await requireCalendarSpace(tx, calendarId);
    const rows = await tx.query<EventRow>(
      `INSERT INTO bob.calendar_events
         (calendar_id, space_id, uid, sequence, organizer_user_id, title, location, body,
          all_day, start_date, end_date, start_at, end_at, zone, rrule, status, revision)
       VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'confirmed', 1)
       RETURNING ${EVENT_COLUMNS}`,
      [
        calendarId,
        spaceId,
        uid,
        organizerUserId,
        title,
        input.location ?? null,
        input.body ?? null,
        timing.allDay,
        timing.startDate,
        timing.endDate,
        ts(timing.startAt),
        ts(timing.endAt),
        zone,
        input.rrule ?? null,
      ],
    );
    if (!rows[0]) throw new StoreNotFoundError('calendar not found');
    const event = rowToEvent(rows[0]);
    for (const attendee of input.attendees ?? []) {
      await insertAttendee(tx, event, attendee.userId, attendee.role);
    }
    return event;
  });
}

type EventRowWithResponse = EventRow & { myResponse: unknown };

function myResponseOf(row: EventRowWithResponse): AttendeeResponse | null {
  return row.myResponse === null || row.myResponse === undefined ? null : toAttendeeResponse(row.myResponse);
}

function byStart(a: UserOccurrence, b: UserOccurrence): number {
  return (a.startAt ?? a.originalOccurrenceStart) - (b.startAt ?? b.originalOccurrenceStart);
}

/** RLS hides the calendar's space for a non-member, so both an unknown and a
 *  hidden calendar answer not-found. */
export async function listEvents(
  db: Db,
  userId: string,
  calendarId: string,
  options: ListEventsOptions,
): Promise<UserOccurrence[]> {
  return withUser(db, userId, async (tx) => {
    await requireCalendarSpace(tx, calendarId);
    const rows = await tx.query<EventRowWithResponse>(
      `SELECT ${EVENT_COLUMNS}, ${MY_RESPONSE} FROM bob.calendar_events WHERE calendar_id = $1`,
      [calendarId, userId],
    );
    const out: UserOccurrence[] = [];
    for (const row of rows) {
      const myResponse = myResponseOf(row);
      for (const occ of await expandEventOccurrences(tx, rowToEvent(row), options)) {
        out.push({ ...occ, myResponse });
      }
    }
    return out.sort(byStart);
  });
}

/** canEdit follows the organizer rules; canDelete adds group moderation. */
export type AgendaOccurrence = UserOccurrence & {
  calendarId: string;
  spaceId: string;
  origin: CalendarOrigin;
  canEdit: boolean;
  canDelete: boolean;
};

/** The agenda window, optionally narrowed to one space's calendars. */
export type AgendaOptions = ListEventsOptions & { spaceId?: string };

type AgendaCalendarRow = { id: unknown; spaceId: unknown; origin: unknown; spaceKind: unknown };

/** The calendars the caller can see (RLS decides), optionally one space's only. */
function agendaCalendars(tx: Db, spaceId: string | undefined): Promise<AgendaCalendarRow[]> {
  const spaceFilter = spaceId === undefined ? '' : ' AND c.space_id = $1';
  return tx.query<AgendaCalendarRow>(
    `SELECT c.id, c.space_id AS "spaceId", c.origin, s.kind AS "spaceKind"
     FROM bob.calendars c JOIN bob.spaces s ON s.id = c.space_id
     WHERE s.archived_at IS NULL${spaceFilter}`,
    spaceId === undefined ? [] : [spaceId],
  );
}

/** One calendar's occurrences in the window, each with the caller's edit and delete rights. */
async function calendarAgenda(
  tx: Db,
  userId: string,
  cal: AgendaCalendarRow,
  options: ListEventsOptions,
): Promise<AgendaOccurrence[]> {
  const spaceId = String(cal.spaceId);
  const origin = toCalendarOrigin(cal.origin);
  // One membership read per calendar, reused for every event on it: the
  // assertCanManageEvent rule computed without throwing, so a non-editor
  // still sees the occurrence.
  const membershipRows = await tx.query<{ userId: unknown; role: unknown }>(
    `SELECT user_id AS "userId", role FROM bob.space_memberships
     WHERE space_id = $1 AND revoked_at IS NULL`,
    [spaceId],
  );
  const activeRoles = new Map(membershipRows.map((row) => [String(row.userId), String(row.role)] as const));
  const moderator = isEventModerator(String(cal.spaceKind), activeRoles.get(userId));
  const rows = await tx.query<EventRowWithResponse>(
    `SELECT ${EVENT_COLUMNS}, ${MY_RESPONSE} FROM bob.calendar_events WHERE calendar_id = $1`,
    [cal.id, userId],
  );
  const out: AgendaOccurrence[] = [];
  for (const row of rows) {
    const myResponse = myResponseOf(row);
    const organizerUserId = String(row.organizerUserId);
    const canEdit =
      origin === 'native' &&
      (organizerUserId === userId ||
        (!activeRoles.has(organizerUserId) && activeRoles.get(userId) === 'owner'));
    const canDelete = canEdit || (origin === 'native' && moderator);
    for (const occ of await expandEventOccurrences(tx, rowToEvent(row), options)) {
      out.push({ ...occ, myResponse, calendarId: String(cal.id), spaceId, origin, canEdit, canDelete });
    }
  }
  return out;
}

/** Every calendar the caller can see (RLS decides), with the caller's own RSVP.
 *  With `spaceId`, only that space's calendars (a space's Agenda tab). */
export async function listAgenda(
  db: Db,
  userId: string,
  options: AgendaOptions,
): Promise<AgendaOccurrence[]> {
  return withUser(db, userId, async (tx) => {
    const { spaceId, ...window } = options;
    const out: AgendaOccurrence[] = [];
    for (const cal of await agendaCalendars(tx, spaceId)) out.push(...(await calendarAgenda(tx, userId, cal, window)));
    return out.sort(byStart);
  });
}

/** Bumps the master's sequence (attendee-visible change) and revision. */
async function bumpChange(tx: Db, eventId: string): Promise<void> {
  await tx.query(
    `UPDATE bob.calendar_events
     SET sequence = sequence + 1, revision = revision + 1, updated_at = now()
     WHERE id = $1`,
    [eventId],
  );
}

/** uid is never touched; sequence and revision each advance by one. */
async function updateEventMaster(tx: Db, ev: StoredEvent, patch: EventPatch): Promise<StoredEvent> {
  const title = patch.title !== undefined ? validateTitle(patch.title) : ev.title;
  const zone = patch.zone !== undefined ? validateZone(patch.zone) : ev.zone;
  const timing = resolveTiming(ev, patch);
  const set: string[] = ['sequence = sequence + 1', 'revision = revision + 1', 'updated_at = now()'];
  const params: unknown[] = [ev.id];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  set.push(`title = ${push(title)}`);
  if (patch.location !== undefined) set.push(`location = ${push(patch.location ?? null)}`);
  if (patch.body !== undefined) set.push(`body = ${push(patch.body ?? null)}`);
  set.push(`all_day = ${push(timing.allDay)}`);
  set.push(`start_date = ${push(timing.startDate)}`, `end_date = ${push(timing.endDate)}`);
  set.push(`start_at = ${push(ts(timing.startAt))}`, `end_at = ${push(ts(timing.endAt))}`);
  set.push(`zone = ${push(zone)}`);
  if (patch.rrule !== undefined) set.push(`rrule = ${push(patch.rrule ?? null)}`);
  const rows = await tx.query<EventRow>(
    `UPDATE bob.calendar_events SET ${set.join(', ')} WHERE id = $1 RETURNING ${EVENT_COLUMNS}`,
    params,
  );
  if (!rows[0]) throw new StoreNotFoundError('event not found');
  return rowToEvent(rows[0]);
}

/** Ends the series the day before the target occurrence (this_and_following). */
async function truncateSeriesBefore(tx: Db, ev: StoredEvent, occurrenceStart: number): Promise<void> {
  if (!ev.rrule) return;
  // A local day is not always 24h (DST) and an all-day identity is a UTC date,
  // so step back one calendar date rather than subtracting 86_400_000ms.
  const targetDate = ev.allDay
    ? new Date(occurrenceStart).toISOString().slice(0, 10)
    : dateInZone(ev.zone, occurrenceStart);
  const rrule: RecurrenceRule = { ...ev.rrule, until: addDaysToDate(targetDate, -1) };
  await tx.query(
    `UPDATE bob.calendar_events SET rrule = $2, updated_at = now() WHERE id = $1`,
    [ev.id, JSON.stringify(rrule)],
  );
}

/** The timing an exception overrides. Timed: identity is the start instant.
 *  All-day: identity is UTC midnight of the date, so the date is recovered
 *  without zone math. */
function occurrenceBase(ev: StoredEvent, occurrenceStart: number): ReturnType<typeof normalizeStartEnd> {
  if (!ev.allDay) {
    const duration = ev.endAt! - ev.startAt!;
    return { allDay: false, startDate: null, endDate: null, startAt: occurrenceStart, endAt: occurrenceStart + duration };
  }
  const startDate = new Date(occurrenceStart).toISOString().slice(0, 10);
  const daySpan = Math.round((dateUtcMs(ev.endDate!) - dateUtcMs(ev.startDate!)) / 86_400_000);
  return { allDay: true, startDate, endDate: addDaysToDate(startDate, daySpan), startAt: null, endAt: null };
}

/** Upserts one occurrence's exception, merging the patch onto any existing
 *  exception and then the occurrence base. cancelled=true is the
 *  per-occurrence cancel. */
async function upsertException(
  tx: Db,
  ev: StoredEvent,
  occurrenceStart: number,
  patch: EventPatch,
  cancelled: boolean,
): Promise<void> {
  const existing = await tx.query<Record<'allDay' | 'startDate' | 'endDate' | 'startAt' | 'endAt' | 'title' | 'location' | 'body' | 'zone', unknown>>(
    `SELECT all_day AS "allDay", start_date::text AS "startDate", end_date::text AS "endDate",
       floor(extract(epoch from start_at) * 1000)::bigint AS "startAt",
       floor(extract(epoch from end_at) * 1000)::bigint AS "endAt",
       title, location, body, zone
     FROM bob.event_exceptions
     WHERE event_id = $1 AND original_occurrence_start = to_timestamp($2 / 1000.0)`,
    [ev.id, occurrenceStart],
  );
  const cur = existing[0];
  const str = (value: unknown): string | null => (cur === undefined ? null : strOrNull(value));
  const num = (value: unknown): number | null => (cur === undefined ? null : numOrNull(value));
  const curAllDay = cur === undefined || cur.allDay === null ? null : Boolean(cur.allDay);
  const base = occurrenceBase(ev, occurrenceStart);
  const timing = normalizeStartEnd({
    allDay: patch.allDay ?? (curAllDay ?? base.allDay),
    startDate: patch.startDate !== undefined ? patch.startDate : (str(cur?.startDate) ?? base.startDate),
    endDate: patch.endDate !== undefined ? patch.endDate : (str(cur?.endDate) ?? base.endDate),
    startAt: patch.startAt !== undefined ? patch.startAt : (num(cur?.startAt) ?? base.startAt),
    endAt: patch.endAt !== undefined ? patch.endAt : (num(cur?.endAt) ?? base.endAt),
  });
  const title = patch.title !== undefined ? validateTitle(patch.title) : (str(cur?.title) ?? ev.title);
  const location = patch.location !== undefined ? patch.location : (str(cur?.location) ?? ev.location);
  const body = patch.body !== undefined ? patch.body : (str(cur?.body) ?? ev.body);
  const zone = patch.zone !== undefined ? validateZone(patch.zone) : (str(cur?.zone) ?? ev.zone);
  await tx.query(
    `INSERT INTO bob.event_exceptions
       (event_id, space_id, original_occurrence_start, cancelled, title, location, body,
        all_day, start_date, end_date, start_at, end_at, zone, revision)
     VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1)
     ON CONFLICT (event_id, original_occurrence_start) DO UPDATE SET
       cancelled = EXCLUDED.cancelled, title = EXCLUDED.title, location = EXCLUDED.location,
       body = EXCLUDED.body, all_day = EXCLUDED.all_day, start_date = EXCLUDED.start_date,
       end_date = EXCLUDED.end_date, start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at,
       zone = EXCLUDED.zone, revision = bob.event_exceptions.revision + 1, updated_at = now()`,
    [
      ev.id,
      ev.spaceId,
      occurrenceStart,
      cancelled,
      title,
      location,
      body,
      timing.allDay,
      timing.startDate,
      timing.endDate,
      ts(timing.startAt),
      ts(timing.endAt),
      zone,
    ],
  );
}

/** The scope is explicit (NO default). 'series' edits the master; 'this' edits
 *  one occurrence via an exception; 'this_and_following' is refused until a
 *  series-split design exists. Organizer only. Returns the updated master. */
export async function updateEvent(
  db: Db,
  userId: string,
  eventId: string,
  scope: RecurrenceScope,
  options: { revision: number; occurrenceStart?: number; patch: EventPatch },
): Promise<StoredEvent> {
  if (!isRecurrenceScope(scope)) throw new StoreError('updateEvent: invalid scope');
  if (scope === 'this_and_following') {
    throw new CalendarInvalidError(
      'this_and_following edits are not supported; edit this occurrence or the series',
    );
  }
  return withUser(db, userId, async (tx) => {
    const ev = await requireEvent(tx, eventId);
    await assertCanManageEvent(tx, ev, userId, 'only the organizer can change this event');
    // Re-read under a row lock so concurrent edits at the same revision conflict.
    const lockedEv = await requireEvent(tx, eventId, { forUpdate: true });
    if (lockedEv.revision !== options.revision) throw new StoreConflictError('event revision conflict');
    if (scope === 'series') return updateEventMaster(tx, lockedEv, options.patch);
    if (options.occurrenceStart === undefined) {
      throw new StoreError('updateEvent: occurrence_start is required for scope this/this_and_following');
    }
    if (lockedEv.rrule === null) return updateEventMaster(tx, lockedEv, options.patch);
    await upsertException(tx, lockedEv, options.occurrenceStart, options.patch, false);
    await bumpChange(tx, lockedEv.id);
    return requireEvent(tx, eventId);
  });
}

/** 'series' (or a single event) sets status='cancelled' WITHOUT deleting rows,
 *  so attendees still see it was cancelled; 'this' writes a cancelled
 *  exception; 'this_and_following' also truncates the series first. */
export async function cancelEvent(
  db: Db,
  userId: string,
  eventId: string,
  scope: RecurrenceScope,
  options: { occurrenceStart?: number },
): Promise<StoredEvent> {
  if (!isRecurrenceScope(scope)) throw new StoreError('cancelEvent: invalid scope');
  return withUser(db, userId, async (tx) => {
    const ev = await requireEvent(tx, eventId);
    await assertCanCancelEvent(tx, ev, userId);
    if (scope === 'series' || ev.rrule === null) {
      const rows = await tx.query<EventRow>(
        `UPDATE bob.calendar_events
         SET status = 'cancelled', sequence = sequence + 1, revision = revision + 1, updated_at = now()
         WHERE id = $1 RETURNING ${EVENT_COLUMNS}`,
        [eventId],
      );
      const [row] = rows;
      if (row === undefined) throw new StoreError('event cancel returned no row');
      return rowToEvent(row);
    }
    if (options.occurrenceStart === undefined) {
      throw new StoreError('cancelEvent: occurrence_start is required for scope this/this_and_following');
    }
    if (scope === 'this_and_following') await truncateSeriesBefore(tx, ev, options.occurrenceStart);
    await upsertException(tx, ev, options.occurrenceStart, {}, true);
    await bumpChange(tx, ev.id);
    return requireEvent(tx, eventId);
  });
}

export async function listAttendees(db: Db, userId: string, eventId: string): Promise<StoredAttendee[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<AttendeeRow>(
      `SELECT ${ATTENDEE_COLUMNS} FROM bob.event_attendees
       WHERE event_id = $1 ORDER BY created_at ASC`,
      [eventId],
    );
    return rows.map(rowToAttendee);
  });
}

/** The WHERE is pinned to the caller's own row and the RLS update policy is
 *  user_id = auth.uid(), so an organizer or admin who is NOT an attendee is
 *  refused -- being a role is not being an attendee. */
export async function setAttendeeResponse(
  db: Db,
  userId: string,
  eventId: string,
  response: AttendeeResponse,
): Promise<StoredAttendee> {
  if (!isAttendeeResponse(response)) throw new StoreError('setAttendeeResponse: invalid response');
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<AttendeeRow>(
      `UPDATE bob.event_attendees SET response = $3, updated_at = now()
       WHERE event_id = $1 AND user_id = $2
       RETURNING ${ATTENDEE_COLUMNS}`,
      [eventId, userId, response],
    );
    if (!rows[0]) throw new CalendarForbiddenError('only an attendee may set their own response');
    return rowToAttendee(rows[0]);
  });
}

export async function addAttendee(
  db: Db,
  userId: string,
  eventId: string,
  input: { userId: string; role?: AttendeeRole },
): Promise<StoredAttendee> {
  const role = input.role ?? 'required';
  if (!isAttendeeRole(role)) throw new StoreError('addAttendee: invalid role');
  return withUser(db, userId, async (tx) => {
    const ev = await requireEvent(tx, eventId);
    await assertCanManageEvent(tx, ev, userId, 'only the organizer can add attendees');
    return insertAttendee(tx, ev, input.userId, role);
  });
}

/** An unknown target answers StoreNotFoundError exactly like an event outside
 *  the caller's audience. */
export async function removeAttendee(
  db: Db,
  userId: string,
  eventId: string,
  targetUserId: string,
): Promise<void> {
  return withUser(db, userId, async (tx) => {
    const ev = await requireEvent(tx, eventId);
    await assertCanManageEvent(tx, ev, userId, 'only the organizer can remove attendees');
    const rows = await tx.query<{ id: string }>(
      `DELETE FROM bob.event_attendees WHERE event_id = $1 AND user_id = $2 RETURNING id`,
      [eventId, targetUserId],
    );
    if (rows.length === 0) throw new StoreNotFoundError('attendee not found');
  });
}
