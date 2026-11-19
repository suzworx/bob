import { z } from 'zod';

class CalendarError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) { super(message); }
}

const calendarSchema = z.object({
  id: z.string().min(1).max(1024), summary: z.string().max(4096),
  accessRole: z.enum(['freeBusyReader', 'reader', 'writerWithoutPrivateAccess', 'writer', 'owner']),
  timeZone: z.string().max(128).optional(), primary: z.boolean().optional(),
});
const pageOptions = z.object({ limit: z.number().int().min(1).max(100).default(50), pageToken: z.string().min(1).max(4096).optional() }).strict();
const calendarsSchema = z.object({ items: z.array(calendarSchema).max(100).default([]), nextPageToken: z.string().max(4096).optional() });
const identifier = z.string().min(1).max(1024).refine((value) => value !== '.' && value !== '..');
const dateTime = z.string().datetime({ offset: true });
function validTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions(); return true; }
  catch { return false; }
}
const timeZone = z.string().min(1).max(128).refine(validTimeZone);
const eventTime = z.union([
  z.object({ date: z.string().date() }).strict(),
  z.object({ dateTime, timeZone: timeZone.optional() }).strict(),
]);
const eventSchema = z.object({
  id: identifier, etag: z.string().min(1).max(256),
  htmlLink: z.url({ protocol: /^https$/ }).max(2048).refine(value => {
    const url = new URL(value);
    return !url.username && !url.password;
  }).optional(),
  summary: z.string().max(4096).optional(), description: z.string().max(65536).optional(),
  location: z.string().max(4096).optional(), start: eventTime.optional(), end: eventTime.optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  attendees: z.array(z.object({}).passthrough()).max(1000).optional(), attendeesOmitted: z.boolean().optional(),
  recurrence: z.array(z.string()).max(100).optional(), recurringEventId: identifier.optional(),
  originalStartTime: eventTime.optional(),
  eventType: z.string().max(128).optional(),
});
const eventsSchema = z.object({ items: z.array(eventSchema).max(100).default([]), nextPageToken: z.string().max(4096).optional() });
const eventListOptions = pageOptions.extend({ limit: z.number().int().min(1).max(50).default(20), timeMin: dateTime, timeMax: dateTime }).refine(
  (value) => Date.parse(value.timeMax) > Date.parse(value.timeMin) && Date.parse(value.timeMax) - Date.parse(value.timeMin) <= 366 * 86400_000,
);
const eventFields = z.object({
  summary: z.string().min(1).max(4096), description: z.string().max(65536).optional(),
  location: z.string().max(4096).optional(), start: eventTime, end: eventTime,
}).strict();
const createFields = eventFields.refine((value) => validTimes(value.start, value.end));
const updateFields = eventFields.partial().refine((value) => Object.keys(value).length > 0);
export const googleCalendarInputs = { identifier, page: pageOptions, events: eventListOptions, create: createFields, update: updateFields };
type CalendarEvent = z.infer<typeof eventSchema>;
interface GoogleCalendarClient {
  listCalendars(token: string, input?: z.input<typeof pageOptions>, signal?: AbortSignal): Promise<z.infer<typeof calendarsSchema>>;
  listEvents(token: string, calendarId: string, input: z.input<typeof eventListOptions>, signal?: AbortSignal): Promise<z.infer<typeof eventsSchema>>;
  readEvent(token: string, calendarId: string, eventId: string, signal?: AbortSignal): Promise<CalendarEvent>;
  createEvent(token: string, calendarId: string, eventId: string, input: z.input<typeof createFields>, signal?: AbortSignal): Promise<CalendarEvent>;
  updateEvent(token: string, calendarId: string, eventId: string, input: z.input<typeof updateFields>, signal?: AbortSignal): Promise<CalendarEvent>;
}

function matchingEvent(value: unknown, id: string): CalendarEvent {
  const event = parse(eventSchema, value, 'calendar_invalid_response');
  if (event.id !== id) throw new CalendarError('calendar_invalid_response');
  return event;
}

function assertEditable(event: z.infer<typeof eventSchema>): void {
  if (event.attendees?.length || event.attendeesOmitted || event.recurrence?.length || event.recurringEventId || event.originalStartTime || event.status === 'cancelled' || (event.eventType && event.eventType !== 'default')) {
    throw new CalendarError('calendar_unsafe_event');
  }
}

function validTimes(start: z.infer<typeof eventTime>, end: z.infer<typeof eventTime>): boolean {
  if ('date' in start && 'date' in end) return start.date < end.date;
  if ('dateTime' in start && 'dateTime' in end) return Date.parse(start.dateTime) < Date.parse(end.dateTime);
  return false;
}

function eventsUrl(calendarId: string, eventId?: string): URL {
  const calendar = encodeURIComponent(parse(identifier, calendarId));
  const event = eventId === undefined ? '' : `/${encodeURIComponent(parse(identifier, eventId))}`;
  return new URL(`https://www.googleapis.com/calendar/v3/calendars/${calendar}/events${event}`);
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code = 'calendar_invalid_request'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CalendarError(code);
  return result.data;
}

function statusCode(status: number): string {
  const codes: Record<number, string> = { 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 410: 'sync_expired', 412: 'precondition_failed', 429: 'rate_limited' };
  return `calendar_${codes[status] ?? 'provider_failed'}`;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    const retry = response.headers.get('retry-after');
    const seconds = retry && /^\d{1,8}$/.test(retry) ? Math.min(86400, Number(retry)) : undefined;
    throw new CalendarError(statusCode(response.status), response.status === 429 ? seconds : undefined);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CalendarError('calendar_invalid_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1_048_576) {
        await reader.cancel();
        throw new CalendarError('calendar_response_too_large');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new CalendarError('calendar_invalid_response'); }
}

export function createGoogleCalendarClient(fetcher: typeof fetch = fetch): GoogleCalendarClient {
  async function request(url: URL, options: RequestInit): Promise<unknown> {
    if (options.signal?.aborted) throw new CalendarError('calendar_aborted');
    try {
      const response = await fetcher(url, { ...options, redirect: 'error' });
      return await readJson(response);
    } catch (error) {
      if (options.signal?.aborted) throw new CalendarError('calendar_aborted');
      if (error instanceof CalendarError) throw error;
      throw new CalendarError('calendar_transport_failed');
    }
  }
  return {
    async readEvent(token, calendarId, eventId, signal): Promise<CalendarEvent> {
      return matchingEvent(await request(eventsUrl(calendarId, eventId), { headers: { authorization: `Bearer ${token}` }, signal }), eventId);
    },
    async updateEvent(token: string, calendarId: string, eventId: string, input: z.input<typeof updateFields>, signal?: AbortSignal): Promise<z.infer<typeof eventSchema>> {
      const fields = parse(updateFields, input);
      const url = eventsUrl(calendarId, eventId);
      const fresh = await request(url, { headers: { authorization: `Bearer ${token}` }, signal });
      const existing = matchingEvent(fresh, eventId);
      assertEditable(existing);
      const start = fields.start ?? existing.start;
      const end = fields.end ?? existing.end;
      if (!start || !end || !validTimes(start, end)) throw new CalendarError('calendar_invalid_request');
      url.searchParams.set('sendUpdates', 'none');
      const response = await request(url, {
        method: 'PATCH', signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'if-match': existing.etag },
        body: JSON.stringify(fields),
      });
      return matchingEvent(response, eventId);
    },
    async listCalendars(token: string, input: z.input<typeof pageOptions> = {}, signal?: AbortSignal): Promise<z.infer<typeof calendarsSchema>> {
      const options = parse(pageOptions, input);
      const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
      url.searchParams.set('maxResults', String(options.limit));
      if (options.pageToken) url.searchParams.set('pageToken', options.pageToken);
      const response = await request(url, { headers: { authorization: `Bearer ${token}` }, signal });
      const page = parse(calendarsSchema, response, 'calendar_invalid_response');
      if (page.items.length > options.limit) throw new CalendarError('calendar_invalid_response');
      return page;
    },
    async createEvent(token: string, calendarId: string, eventId: string, input: z.input<typeof createFields>, signal?: AbortSignal): Promise<z.infer<typeof eventSchema>> {
      const fields = parse(createFields, input);
      const id = parse(z.string().regex(/^[0-9a-v]{5,1024}$/), eventId);
      const url = eventsUrl(calendarId);
      url.searchParams.set('sendUpdates', 'none');
      const response = await request(url, {
        method: 'POST', signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...fields, id }),
      });
      return matchingEvent(response, id);
    },
    async listEvents(token: string, calendarId: string, input: z.input<typeof eventListOptions>, signal?: AbortSignal): Promise<z.infer<typeof eventsSchema>> {
      const options = parse(eventListOptions, input);
      const url = eventsUrl(calendarId);
      url.searchParams.set('maxResults', String(options.limit));
      url.searchParams.set('timeMin', options.timeMin);
      url.searchParams.set('timeMax', options.timeMax);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      if (options.pageToken) url.searchParams.set('pageToken', options.pageToken);
      const response = await request(url, { headers: { authorization: `Bearer ${token}` }, signal });
      const page = parse(eventsSchema, response, 'calendar_invalid_response');
      if (page.items.length > options.limit) throw new CalendarError('calendar_invalid_response');
      return page;
    },
  };
}

