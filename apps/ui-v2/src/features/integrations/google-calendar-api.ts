import { fetchWithAuth } from '@/lib/auth/use-session';
import { z } from 'zod';

// Browser boundary mirror of GoogleCalendarListResponseSchema in web-schemas.
const pageSchema = z.object({ calendars: z.array(z.object({ id: z.string(), title: z.string(), time_zone: z.string().nullable(), selected: z.boolean(), selectable: z.boolean(), read_only: z.literal(true) })).max(100), selected_calendar_ids: z.array(z.string()).max(5), next_page_token: z.string().optional() });
/** The limit spans every connected Google account, so it can trip on save. */
const CALENDAR_LIMIT_MESSAGE = 'You can show up to 5 calendars across your Google accounts.';
/** The calendars call answered 403: the account must be connected again. */
export const CALENDAR_RECONNECT_MESSAGE = 'Reconnect this Google account and allow calendar access.';
export type GoogleCalendarPage = z.infer<typeof pageSchema>;

export async function listGoogleCalendars(accountId: string, signal: AbortSignal, pageToken?: string): Promise<GoogleCalendarPage> {
  const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
  const response = await fetchWithAuth(`/api/google-accounts/${encodeURIComponent(accountId)}/calendars${query}`, { signal });
  if (!response.ok) throw new Error(response.status === 403 ? CALENDAR_RECONNECT_MESSAGE : 'Google calendars are unavailable. Try again later.');
  const page = pageSchema.safeParse(await response.json());
  if (!page.success) throw new Error('Google calendars are unavailable. Try again later.');
  return page.data;
}

export async function saveGoogleCalendars(accountId: string, calendarIds: string[], signal: AbortSignal): Promise<void> {
  const response = await fetchWithAuth(`/api/google-accounts/${encodeURIComponent(accountId)}/calendars/selection`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calendarIds }), signal,
  });
  if (response.ok) return;
  const code = await response.json().then((body: unknown) => z.object({ error: z.object({ code: z.string() }) }).safeParse(body).data?.error.code, () => undefined);
  throw new Error(code === 'google_selection_limit' ? CALENDAR_LIMIT_MESSAGE : "Couldn't save your calendars. Try again.");
}
