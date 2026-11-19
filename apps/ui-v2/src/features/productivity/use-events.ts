import { fetchWithAuth } from '../../lib/auth/use-session';

/**
 * Plain async functions for writing calendar events (specs/014-family-
 * collaboration, apps/api/src/calendar/http.ts + web-schemas.ts). The UI calls
 * these imperatively from an event-editor dialog, so there is no React state
 * or hook here -- just fetchWithAuth calls mirroring the wire contract.
 *
 * Timing is HONEST: an all-day event carries calendar dates, a timed event
 * carries epoch-ms instants, and a caller never invents one from the other.
 * endDate is EXCLUSIVE (the day after the last day), as on the server.
 */

export type RecurrenceScope = 'this' | 'this_and_following' | 'series';

type RecurrenceRule = {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  byWeekday?: number[];
  until?: string;
  count?: number;
};

export type EventSummary = {
  id: string;
  calendar_id: string;
  space_id: string;
  uid: string;
  sequence: number;
  organizer_user_id: string;
  title: string;
  location: string | null;
  body: string | null;
  all_day: boolean;
  start_date: string | null;
  end_date: string | null;
  start_at: number | null;
  end_at: number | null;
  zone: string;
  rrule: RecurrenceRule | null;
  status: 'confirmed' | 'cancelled';
  revision: number;
  created_at: number;
  updated_at: number;
};

/** Wire timing. endDate is EXCLUSIVE (the day after the last day), as on the server. */
export type EventTiming =
  | { allDay: true; startDate: string; endDate: string }
  | { allDay: false; startAt: number; endAt: number };

type NewEventInput = {
  title: string;
  location?: string | null;
  body?: string | null;
  zone: string;
  timing: EventTiming;
};

export type EventPatchInput = {
  title?: string;
  location?: string | null;
  body?: string | null;
  timing?: EventTiming;
};

type EventFailure = 'invalid' | 'forbidden' | 'not_found' | 'conflict' | 'failed';

type EventResult<T> = { ok: true; value: T } | { ok: false; reason: EventFailure };

/** Intl.DateTimeFormat resolvedOptions().timeZone, else 'UTC'; clamped to the
 *  server's zone length bound (web-schemas.ts CalendarSummarySchema.zone). */
export function browserZone(): string {
  let zone = 'UTC';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    zone = 'UTC';
  }
  return zone.slice(0, 64);
}

function statusToFailure(status: number): EventFailure {
  if (status === 400) return 'invalid';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  return 'failed';
}

async function toResult<T>(response: Response): Promise<EventResult<T>> {
  if (response.ok) {
    const value = (await response.json()) as T;
    return { ok: true, value };
  }
  return { ok: false, reason: statusToFailure(response.status) };
}

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<EventResult<T>> {
  try {
    const response = await fetchWithAuth(input, init);
    return await toResult<T>(response);
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

function timingToWire(
  timing: EventTiming,
): { all_day: true; start_date: string; end_date: string } | { all_day: false; start_at: number; end_at: number } {
  return timing.allDay
    ? { all_day: true, start_date: timing.startDate, end_date: timing.endDate }
    : { all_day: false, start_at: timing.startAt, end_at: timing.endAt };
}

/** The space's first calendar (server orders by created_at), else a freshly
 *  created default -- mirrors core/invocations.ts resolveCalendar and
 *  turn.ts resolvePrivateCalendar. */
export async function ensureDefaultCalendar(
  spaceId: string,
  kind: 'private' | 'pair' | 'group',
): Promise<EventResult<string>> {
  const listed = await request<{ calendars: Array<{ id: string }> }>(`/api/spaces/${spaceId}/calendars`);
  if (!listed.ok) return listed;
  const existing = listed.value.calendars[0];
  if (existing) return { ok: true, value: existing.id };
  const created = await request<{ id: string }>(`/api/spaces/${spaceId}/calendars`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: kind === 'private' ? 'Private' : 'Family', zone: browserZone() }),
  });
  if (!created.ok) return created;
  return { ok: true, value: created.value.id };
}

export async function getEvent(eventId: string): Promise<EventResult<EventSummary>> {
  return request<EventSummary>(`/api/events/${eventId}`);
}

export async function createEvent(
  calendarId: string,
  input: NewEventInput,
): Promise<EventResult<EventSummary>> {
  return request<EventSummary>(`/api/calendars/${calendarId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: input.title,
      ...timingToWire(input.timing),
      zone: input.zone,
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    }),
  });
}

export async function updateEvent(
  event: { id: string; revision: number },
  scope: RecurrenceScope,
  occurrenceStart: number | null,
  patch: EventPatchInput,
): Promise<EventResult<EventSummary>> {
  const wirePatch: Record<string, unknown> = {};
  if (patch.title !== undefined) wirePatch.title = patch.title;
  if (patch.location !== undefined) wirePatch.location = patch.location;
  if (patch.body !== undefined) wirePatch.body = patch.body;
  if (patch.timing !== undefined) Object.assign(wirePatch, timingToWire(patch.timing));
  return request<EventSummary>(`/api/events/${event.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      revision: event.revision,
      scope,
      ...(scope !== 'series' ? { occurrence_start: occurrenceStart } : {}),
      patch: wirePatch,
    }),
  });
}

export async function cancelEvent(
  eventId: string,
  scope: RecurrenceScope,
  occurrenceStart: number | null,
): Promise<EventResult<EventSummary>> {
  return request<EventSummary>(`/api/events/${eventId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope,
      ...(scope !== 'series' ? { occurrence_start: occurrenceStart } : {}),
    }),
  });
}

export type AttendeeResponse = 'needs_action' | 'accepted' | 'declined' | 'tentative';

export type Attendee = {
  event_id: string;
  user_id: string | null;
  email: string | null;
  response: AttendeeResponse;
  role: 'required' | 'optional';
};

export async function listAttendees(eventId: string): Promise<EventResult<Attendee[]>> {
  const result = await request<{ attendees: Attendee[] }>(`/api/events/${eventId}/attendees`);
  if (!result.ok) return result;
  return { ok: true, value: result.value.attendees };
}

export async function addAttendee(eventId: string, userId: string): Promise<EventResult<Attendee>> {
  return request<Attendee>(`/api/events/${eventId}/attendees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, role: 'required' }),
  });
}

/** A 204 has no body, so this skips toResult()'s response.json() rather than
 *  risk it throwing on an empty payload. */
export async function removeAttendee(eventId: string, userId: string): Promise<EventResult<null>> {
  try {
    const response = await fetchWithAuth(
      `/api/events/${eventId}/attendees?user_id=${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
    if (response.ok) return { ok: true, value: null };
    return { ok: false, reason: statusToFailure(response.status) };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export async function setRsvp(eventId: string, response: AttendeeResponse): Promise<EventResult<Attendee>> {
  return request<Attendee>(`/api/events/${eventId}/rsvp`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response }),
  });
}
