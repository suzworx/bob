import { describe, expect, it, vi } from 'vitest';
import { createGoogleCalendarClient } from '../../src/integrations/google-calendar-client.ts';

describe('Google Calendar provider boundary', () => {
  const event = { summary: 'Lunch', start: { dateTime: '2026-10-18T12:00:00Z' }, end: { dateTime: '2026-10-18T13:00:00Z' } };
  it('preserves the actual HTTPS source link supplied by Google', async () => {
    const htmlLink = 'https://calendar.google.com/calendar/event?eid=provider-event';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...event, id: 'event', etag: 'v1', htmlLink }));
    expect(await createGoogleCalendarClient(fetcher).readEvent('secret', 'primary', 'event')).toMatchObject({ htmlLink });
  });
  it.each(['javascript:alert(1)', 'http://calendar.google.com/event', 'https://user:password@calendar.google.com/event'])('rejects unsafe provider event link %s', async htmlLink => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...event, id: 'event', etag: 'v1', htmlLink }));
    await expect(createGoogleCalendarClient(fetcher).readEvent('secret', 'primary', 'event')).rejects.toThrow('calendar_invalid_response');
  });
  it.each(['.', '..'])('rejects URL dot segment %s before sending credentials', async (id) => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createGoogleCalendarClient(fetcher);
    await expect(client.readEvent('secret', id, 'abc123')).rejects.toThrow('calendar_invalid_request');
    await expect(client.readEvent('secret', 'primary', id)).rejects.toThrow('calendar_invalid_request');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reads a stable event identity for reconciliation and reports bounded retry delay', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...event, id: 'abc123', etag: '"v1"' })).mockResolvedValueOnce(new Response('private', { status: 429, headers: { 'retry-after': '99999999' } }));
    const client = createGoogleCalendarClient(fetcher);
    expect((await client.readEvent('secret', 'primary', 'abc123')).id).toBe('abc123');
    await expect(client.listCalendars('secret')).rejects.toMatchObject({ message: 'calendar_rate_limited', retryAfterSeconds: 86400 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects unknown time zones before creating an event', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createGoogleCalendarClient(fetcher).createEvent('secret', 'primary', 'abc123', { ...event, start: { ...event.start, timeZone: 'Wrong/Zone' } })).rejects.toThrow('calendar_invalid_request');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects mismatched provider identities and malformed JSON without content leakage', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...event, id: 'other', etag: '"v1"' }));
    await expect(createGoogleCalendarClient(fetcher).updateEvent('secret', 'primary', 'abc123', { summary: 'Dinner' })).rejects.toThrow('calendar_invalid_response');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret not JSON'));
    await expect(createGoogleCalendarClient(malformed).listCalendars('secret')).rejects.toThrow(/^calendar_invalid_response$/);
  });
  it.each([
    { ...event, start: { date: '2026-10-18' } },
    { ...event, end: event.start },
    { ...event, recurrence: ['RRULE:FREQ=DAILY'] },
    { ...event, start: { dateTime: '2026-10-18T12:00:00' } },
  ])('refuses unsafe creation input %j', async (input) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createGoogleCalendarClient(fetcher).createEvent('secret', 'primary', 'abc123', input)).rejects.toThrow('calendar_invalid_request');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('updates a single all-day event without changing its exclusive end', async () => {
    const allDay = { id: 'abc123', etag: '"v1"', summary: 'Trip', start: { date: '2026-10-18' }, end: { date: '2026-10-20' } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(allDay)).mockResolvedValueOnce(Response.json({ ...allDay, summary: 'Holiday' }));
    const result = await createGoogleCalendarClient(fetcher).updateEvent('secret', 'primary', 'abc123', { summary: 'Holiday' });
    expect(result.end).toEqual({ date: '2026-10-20' });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ summary: 'Holiday' });
  });
  it('sanitizes transport failures, refuses redirects, and forwards cancellation', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret bearer'));
    await expect(createGoogleCalendarClient(fetcher).listCalendars('secret', {}, controller.signal)).rejects.toThrow(/^calendar_transport_failed$/);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    controller.abort();
    await expect(createGoogleCalendarClient(fetcher).listCalendars('secret', {}, controller.signal)).rejects.toThrow(/^calendar_aborted$/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses a provider page that exceeds the requested page size', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: Array.from({ length: 2 }, (_, i) => ({ id: String(i), summary: 'Calendar', accessRole: 'reader' })) }));
    await expect(createGoogleCalendarClient(fetcher).listCalendars('secret', { limit: 1 })).rejects.toThrow('calendar_invalid_response');
  });
  it('fresh-reads before a conditional patch and does not retry conflicts', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...event, id: 'abc123', etag: '"version2"' }))
      .mockResolvedValueOnce(new Response('private provider details', { status: 412 }));
    await expect(createGoogleCalendarClient(fetcher).updateEvent('secret', 'primary', 'abc123', { summary: 'Dinner' })).rejects.toThrow('calendar_precondition_failed');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('PATCH');
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('if-match')).toBe('"version2"');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ summary: 'Dinner' });
  });
  it.each([{ attendees: [{}] }, { attendeesOmitted: true }, { recurrence: ['RRULE:FREQ=DAILY'] }, { recurringEventId: 'parent' }, { eventType: 'outOfOffice' }])('refuses unsafe fresh event %j', async (unsafe) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...event, id: 'abc123', etag: '"v1"', ...unsafe }));
    await expect(createGoogleCalendarClient(fetcher).updateEvent('secret', 'primary', 'abc123', { summary: 'Dinner' })).rejects.toThrow('calendar_unsafe_event');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('creates with caller stable ID and rejects attendees before any request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...event, id: 'abc123', etag: '"v1"' }));
    const client = createGoogleCalendarClient(fetcher);
    await client.createEvent('secret', 'primary', 'abc123', event);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ ...event, id: 'abc123' });
    await expect(client.createEvent('secret', 'primary', 'abc124', { ...event, attendees: [] } as typeof event)).rejects.toThrow('calendar_invalid_request');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('lists a bounded page of calendars and preserves the opaque continuation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [{ id: 'primary', summary: 'Personal', accessRole: 'owner' }], nextPageToken: 'next' }));
    const client = createGoogleCalendarClient(fetcher);
    const result = await client.listCalendars('secret', { limit: 20 });
    expect(result.nextPageToken).toBe('next');
    expect(result.items[0]?.id).toBe('primary');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('maxResults=20');
  });
  it('lists expanded events in an explicit bounded time window without losing continuation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [{ id: 'event', etag: '"v1"', start: { date: '2026-10-18' }, end: { date: '2026-10-19' } }], nextPageToken: 'more' }));
    const result = await createGoogleCalendarClient(fetcher).listEvents('secret', 'a/b@example.test', { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-11-01T00:00:00Z', limit: 10, pageToken: 'first' });
    expect(result.items[0]?.start).toEqual({ date: '2026-10-18' });
    expect(result.nextPageToken).toBe('more');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toContain('a%2Fb%40example.test');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('pageToken')).toBe('first');
  });
  it('never exposes provider response bodies and bounds streamed response bytes', async () => {
    const denied = createGoogleCalendarClient(vi.fn<typeof fetch>().mockResolvedValue(new Response('token secret personal data', { status: 401 })));
    await expect(denied.listCalendars('secret')).rejects.toThrow(/^calendar_unauthorized$/);
    const huge = createGoogleCalendarClient(vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_048_577))));
    await expect(huge.listCalendars('secret')).rejects.toThrow(/^calendar_response_too_large$/);
  });
});
