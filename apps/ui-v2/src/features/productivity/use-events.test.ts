import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAttendee,
  browserZone,
  cancelEvent,
  createEvent,
  ensureDefaultCalendar,
  listAttendees,
  removeAttendee,
  setRsvp,
  updateEvent,
  type Attendee,
  type EventSummary,
} from './use-events';

vi.mock('../../lib/auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

const SPACE_ID = 'space-1';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const EVENT: EventSummary = {
  id: 'event-1',
  calendar_id: 'cal_1',
  space_id: SPACE_ID,
  uid: 'uid-1',
  sequence: 0,
  organizer_user_id: 'u1',
  title: 'Dinner',
  location: null,
  body: null,
  all_day: false,
  start_date: null,
  end_date: null,
  start_at: 1000,
  end_at: 2000,
  zone: 'UTC',
  rrule: null,
  status: 'confirmed',
  revision: 1,
  created_at: 1,
  updated_at: 1,
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function call(index: number): { method: string; url: string; body: Record<string, unknown> } {
  const [input, init] = fetchMock.mock.calls[index]!;
  return {
    method: init?.method ?? 'GET',
    url: String(input),
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
  };
}

describe('ensureDefaultCalendar', () => {
  it('returns the first calendar id and makes no POST', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { calendars: [{ id: 'cal_existing' }, { id: 'cal_other' }] }));
    const result = await ensureDefaultCalendar(SPACE_ID, 'group');
    expect(result).toEqual({ ok: true, value: 'cal_existing' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('POSTs Family for group with no calendars and returns the new id', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { calendars: [] }));
    fetchMock.mockResolvedValueOnce(json(201, { id: 'cal_new' }));
    const result = await ensureDefaultCalendar(SPACE_ID, 'group');
    expect(result).toEqual({ ok: true, value: 'cal_new' });
    const posted = call(1);
    expect(posted.method).toBe('POST');
    expect(posted.body.name).toBe('Family');
    expect(typeof posted.body.zone).toBe('string');
  });

  it('POSTs Private for kind private with no calendars', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { calendars: [] }));
    fetchMock.mockResolvedValueOnce(json(201, { id: 'cal_new' }));
    await ensureDefaultCalendar(SPACE_ID, 'private');
    expect(call(1).body.name).toBe('Private');
  });
});

describe('createEvent', () => {
  it('POSTs a timed body with exactly the expected keys', async () => {
    fetchMock.mockResolvedValueOnce(json(201, EVENT));
    const result = await createEvent('cal_1', {
      title: 'Dinner',
      zone: 'UTC',
      timing: { allDay: false, startAt: 1000, endAt: 2000 },
    });
    expect(result).toEqual({ ok: true, value: EVENT });
    const posted = call(0);
    expect(posted.method).toBe('POST');
    expect(posted.url).toBe('/api/calendars/cal_1/events');
    expect(posted.body).toEqual({ title: 'Dinner', all_day: false, start_at: 1000, end_at: 2000, zone: 'UTC' });
  });

  it('POSTs an all-day body with start_date/end_date and no start_at/end_at', async () => {
    fetchMock.mockResolvedValueOnce(json(201, EVENT));
    await createEvent('cal_1', {
      title: 'Trip',
      zone: 'UTC',
      timing: { allDay: true, startDate: '2026-01-01', endDate: '2026-01-02' },
    });
    const posted = call(0);
    expect(posted.body).toEqual({
      title: 'Trip',
      all_day: true,
      start_date: '2026-01-01',
      end_date: '2026-01-02',
      zone: 'UTC',
    });
    expect(posted.body.start_at).toBeUndefined();
    expect(posted.body.end_at).toBeUndefined();
  });
});

describe('updateEvent', () => {
  it('scope series sends no occurrence_start; patch has only passed keys', async () => {
    fetchMock.mockResolvedValueOnce(json(200, EVENT));
    await updateEvent({ id: 'event-1', revision: 1 }, 'series', null, { title: 'New title' });
    const patched = call(0);
    expect(patched.method).toBe('PATCH');
    expect(patched.body).toEqual({ revision: 1, scope: 'series', patch: { title: 'New title' } });
  });

  it('scope this sends occurrence_start', async () => {
    fetchMock.mockResolvedValueOnce(json(200, EVENT));
    await updateEvent({ id: 'event-1', revision: 1 }, 'this', 5000, { location: 'Home' });
    const patched = call(0);
    expect(patched.body).toEqual({
      revision: 1,
      scope: 'this',
      occurrence_start: 5000,
      patch: { location: 'Home' },
    });
  });

  it.each([
    [409, 'conflict'],
    [400, 'invalid'],
    [403, 'forbidden'],
    [404, 'not_found'],
  ] as const)('maps status %i to %s', async (status, reason) => {
    fetchMock.mockResolvedValueOnce(json(status, { error: { code: 'x' } }));
    const result = await updateEvent({ id: 'event-1', revision: 1 }, 'series', null, { title: 'X' });
    expect(result).toEqual({ ok: false, reason });
  });

  it('maps a rejected fetch to failed', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const result = await updateEvent({ id: 'event-1', revision: 1 }, 'series', null, { title: 'X' });
    expect(result).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('cancelEvent', () => {
  it('sends scope this with occurrence_start as the DELETE body', async () => {
    fetchMock.mockResolvedValueOnce(json(200, EVENT));
    await cancelEvent('event-1', 'this', 5000);
    const deleted = call(0);
    expect(deleted.method).toBe('DELETE');
    expect(deleted.body).toEqual({ scope: 'this', occurrence_start: 5000 });
  });

  it('sends scope series with no occurrence_start as the DELETE body', async () => {
    fetchMock.mockResolvedValueOnce(json(200, EVENT));
    await cancelEvent('event-1', 'series', null);
    const deleted = call(0);
    expect(deleted.body).toEqual({ scope: 'series' });
  });
});

const ATTENDEE: Attendee = {
  event_id: 'event-1',
  user_id: 'u2',
  email: null,
  response: 'needs_action',
  role: 'required',
};

describe('listAttendees', () => {
  it('GETs the attendees list and returns it', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { attendees: [ATTENDEE] }));
    const result = await listAttendees('event-1');
    expect(result).toEqual({ ok: true, value: [ATTENDEE] });
    const got = call(0);
    expect(got.method).toBe('GET');
    expect(got.url).toBe('/api/events/event-1/attendees');
  });

  it('maps a 403 to forbidden', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: { code: 'x' } }));
    const result = await listAttendees('event-1');
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });
});

describe('addAttendee', () => {
  it('POSTs user_id and role required, returning the created attendee', async () => {
    fetchMock.mockResolvedValueOnce(json(201, ATTENDEE));
    const result = await addAttendee('event-1', 'u2');
    expect(result).toEqual({ ok: true, value: ATTENDEE });
    const posted = call(0);
    expect(posted.method).toBe('POST');
    expect(posted.url).toBe('/api/events/event-1/attendees');
    expect(posted.body).toEqual({ user_id: 'u2', role: 'required' });
  });

  it('maps a 403 to forbidden', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: { code: 'x' } }));
    const result = await addAttendee('event-1', 'u2');
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });
});

describe('removeAttendee', () => {
  it('DELETEs with the user id encoded as a query param and maps 204 to a null value', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await removeAttendee('event-1', 'u2');
    expect(result).toEqual({ ok: true, value: null });
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe('/api/events/event-1/attendees?user_id=u2');
    expect(init?.method).toBe('DELETE');
  });

  it('maps a 403 to forbidden', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    const result = await removeAttendee('event-1', 'u2');
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });
});

describe('setRsvp', () => {
  it('PUTs the response, returning the updated attendee', async () => {
    const accepted: Attendee = { ...ATTENDEE, response: 'accepted' };
    fetchMock.mockResolvedValueOnce(json(200, accepted));
    const result = await setRsvp('event-1', 'accepted');
    expect(result).toEqual({ ok: true, value: accepted });
    const put = call(0);
    expect(put.method).toBe('PUT');
    expect(put.url).toBe('/api/events/event-1/rsvp');
    expect(put.body).toEqual({ response: 'accepted' });
  });

  it('maps a 403 to forbidden', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: { code: 'x' } }));
    const result = await setRsvp('event-1', 'accepted');
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });
});

describe('browserZone', () => {
  it('returns a non-empty string clamped to 64 chars', () => {
    const zone = browserZone();
    expect(typeof zone).toBe('string');
    expect(zone.length).toBeGreaterThan(0);
    expect(zone.length).toBeLessThanOrEqual(64);
  });
});
