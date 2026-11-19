/**
 * Calendar row shapes, validation and row mappers. An event is all-day (dates
 * only) or timed (epoch-ms instants only), never both and never neither.
 */
import { StoreError } from '../platform/db/db.ts';
import { wallTimeInZone, type RecurrenceRule } from './recurrence.ts';

/** A caller mistake; the route answers 400 invalid_request. */
export class CalendarInvalidError extends StoreError {
  constructor(message: string) { super(message); this.name = 'CalendarInvalidError'; }
}
/** A role refusal (organizer-only, own-RSVP-only); the route answers 403 forbidden. */
export class CalendarForbiddenError extends StoreError {
  constructor(message: string) { super(message); this.name = 'CalendarForbiddenError'; }
}

export type CalendarOrigin = 'native' | 'google' | 'icloud';
type EventStatus = 'confirmed' | 'cancelled';
export type AttendeeResponse = 'needs_action' | 'accepted' | 'declined' | 'tentative';
export type AttendeeRole = 'required' | 'optional';
export type RecurrenceScope = 'this' | 'this_and_following' | 'series';

export type StoredCalendar = {
  id: string;
  spaceId: string;
  name: string;
  zone: string;
  origin: CalendarOrigin;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

/** The series definition (rrule null for a single event). */
export type StoredEvent = {
  id: string;
  calendarId: string;
  spaceId: string;
  uid: string;
  sequence: number;
  organizerUserId: string;
  title: string;
  location: string | null;
  body: string | null;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  startAt: number | null;
  endAt: number | null;
  zone: string;
  rrule: RecurrenceRule | null;
  status: EventStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

/** One expanded occurrence. originalOccurrenceStart is the stable identity
 *  (epoch-ms); a moved occurrence keeps it and sets moved: true. */
export type StoredOccurrence = {
  eventId: string;
  uid: string;
  title: string;
  location: string | null;
  body: string | null;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  startAt: number | null;
  endAt: number | null;
  zone: string;
  originalOccurrenceStart: number;
  cancelled: boolean;
  moved: boolean;
};

export type StoredAttendee = {
  eventId: string;
  userId: string | null;
  email: string | null;
  response: AttendeeResponse;
  role: AttendeeRole;
};

/** One exception row keyed by its occurrence identity. */
export type EventException = {
  originalOccurrenceStart: number;
  cancelled: boolean;
  title: string | null;
  location: string | null;
  body: string | null;
  allDay: boolean | null;
  startDate: string | null;
  endDate: string | null;
  startAt: number | null;
  endAt: number | null;
  zone: string | null;
};

export type NewEventInput = {
  title: string;
  location?: string | null;
  body?: string | null;
  allDay: boolean;
  startDate?: string | null;
  endDate?: string | null;
  startAt?: number | null;
  endAt?: number | null;
  zone: string;
  rrule?: RecurrenceRule | null;
  organizerUserId?: string;
  attendees?: Array<{ userId: string; role: AttendeeRole }>;
};

/** undefined = unchanged, null = clear. */
export type EventPatch = {
  title?: string;
  location?: string | null;
  body?: string | null;
  allDay?: boolean;
  startDate?: string | null;
  endDate?: string | null;
  startAt?: number | null;
  endAt?: number | null;
  zone?: string;
  rrule?: RecurrenceRule | null;
};

export type ListEventsOptions = {
  from: number;
  to: number;
  limit?: number;
};

type Timing = { allDay: boolean; startDate: string | null; endDate: string | null; startAt: number | null; endAt: number | null };

const oneOf = <T extends string>(values: readonly T[]) => (value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const isCalendarOrigin = oneOf<CalendarOrigin>(['native', 'google', 'icloud']);
const isEventStatus = oneOf<EventStatus>(['confirmed', 'cancelled']);
export const isAttendeeResponse = oneOf<AttendeeResponse>(['needs_action', 'accepted', 'declined', 'tentative']);
export const isAttendeeRole = oneOf<AttendeeRole>(['required', 'optional']);
export const isRecurrenceScope = oneOf<RecurrenceScope>(['this', 'this_and_following', 'series']);

export function toCalendarOrigin(value: unknown): CalendarOrigin {
  return isCalendarOrigin(value) ? value : 'native';
}
export function toAttendeeResponse(value: unknown): AttendeeResponse {
  return isAttendeeResponse(value) ? value : 'needs_action';
}

function validateLength(value: string, max: number, message: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) throw new CalendarInvalidError(message);
  return trimmed;
}

export const validateName = (name: string): string => validateLength(name, 60, 'calendar name must be 1..60 characters');
export const validateZone = (zone: string): string => validateLength(zone, 64, 'zone must be 1..64 characters');
export const validateTitle = (title: string): string => validateLength(title, 200, 'title must be 1..200 characters');

export function normalizeStartEnd(
  input: { allDay: boolean; startDate?: string | null; endDate?: string | null; startAt?: number | null; endAt?: number | null },
): Timing {
  if (input.allDay) {
    if (!input.startDate || !input.endDate) {
      throw new CalendarInvalidError('all-day events need start_date and end_date');
    }
    if (!(input.endDate > input.startDate)) {
      throw new CalendarInvalidError('end_date must be after start_date');
    }
    return { allDay: true, startDate: input.startDate, endDate: input.endDate, startAt: null, endAt: null };
  }
  if (input.startAt === undefined || input.startAt === null || input.endAt === undefined || input.endAt === null) {
    throw new CalendarInvalidError('timed events need start_at and end_at');
  }
  if (!(input.endAt > input.startAt)) {
    throw new CalendarInvalidError('end_at must be after start_at');
  }
  return { allDay: false, startDate: null, endDate: null, startAt: input.startAt, endAt: input.endAt };
}

/** Merges a patch onto the current timing, then re-validates the invariant. */
export function resolveTiming(ev: StoredEvent, patch: EventPatch): Timing {
  return normalizeStartEnd({
    allDay: patch.allDay ?? ev.allDay,
    startDate: patch.startDate !== undefined ? patch.startDate : ev.startDate,
    endDate: patch.endDate !== undefined ? patch.endDate : ev.endDate,
    startAt: patch.startAt !== undefined ? patch.startAt : ev.startAt,
    endAt: patch.endAt !== undefined ? patch.endAt : ev.endAt,
  });
}

export const CALENDAR_COLUMNS = `id, space_id AS "spaceId", name, zone, origin,
  created_by AS "createdBy",
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt"`;

export const EVENT_COLUMNS = `id, calendar_id AS "calendarId", space_id AS "spaceId", uid, sequence,
  organizer_user_id AS "organizerUserId", title, location, body, all_day AS "allDay",
  start_date::text AS "startDate", end_date::text AS "endDate",
  floor(extract(epoch from start_at) * 1000)::bigint AS "startAt",
  floor(extract(epoch from end_at) * 1000)::bigint AS "endAt",
  zone, rrule, status, revision,
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt"`;

export type CalendarRow = Record<keyof StoredCalendar, unknown>;
export type EventRow = Record<keyof StoredEvent, unknown>;
export type AttendeeRow = Record<keyof StoredAttendee, unknown>;

export const strOrNull = (value: unknown): string | null => (value === null ? null : String(value));
export const numOrNull = (value: unknown): number | null => (value === null ? null : Number(value));

export function rowToCalendar(row: CalendarRow): StoredCalendar {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    name: String(row.name),
    zone: String(row.zone),
    origin: toCalendarOrigin(row.origin),
    createdBy: String(row.createdBy),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

/** rrule arrives parsed from the driver; the string branch keeps the mapping
 *  total if a driver ever returns text. */
function toRrule(value: unknown): RecurrenceRule | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value) as RecurrenceRule;
  return value as RecurrenceRule;
}

export function rowToEvent(row: EventRow): StoredEvent {
  return {
    id: String(row.id),
    calendarId: String(row.calendarId),
    spaceId: String(row.spaceId),
    uid: String(row.uid),
    sequence: Number(row.sequence),
    organizerUserId: String(row.organizerUserId),
    title: String(row.title),
    location: strOrNull(row.location),
    body: strOrNull(row.body),
    allDay: Boolean(row.allDay),
    startDate: strOrNull(row.startDate),
    endDate: strOrNull(row.endDate),
    startAt: numOrNull(row.startAt),
    endAt: numOrNull(row.endAt),
    zone: String(row.zone),
    rrule: toRrule(row.rrule),
    status: isEventStatus(row.status) ? row.status : 'confirmed',
    revision: Number(row.revision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export function rowToAttendee(row: AttendeeRow): StoredAttendee {
  return {
    eventId: String(row.eventId),
    userId: strOrNull(row.userId),
    email: strOrNull(row.email),
    response: toAttendeeResponse(row.response),
    role: isAttendeeRole(row.role) ? row.role : 'required',
  };
}

/** The local calendar date ('YYYY-MM-DD') of an instant in a zone. */
export function dateInZone(zone: string, at: number): string {
  return wallTimeInZone(zone, at).slice(0, 10);
}

/** epoch-ms of a date at UTC midnight (the all-day occurrence identity). */
export function dateUtcMs(dateStr: string): number {
  return Date.parse(`${dateStr}T00:00:00Z`);
}

export function addDaysToDate(dateStr: string, days: number): string {
  const t = new Date(dateUtcMs(dateStr));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** epoch-ms -> timestamptz parameter as ISO text. */
export function ts(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
