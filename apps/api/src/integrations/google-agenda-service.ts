import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { getGoogleAccount } from './google-store.ts';
import { GoogleCredentialError } from './google-credentials.ts';
import type { createGoogleCalendarService } from './google-calendar-service.ts';
import { GoogleAgendaResponseSchema, GoogleAgendaWindowSchema, GoogleCalendarSelectionInputSchema,
  GoogleCalendarListResponseSchema, type GoogleAgendaProjection, type GoogleCalendarSelection } from './google-agenda-schemas.ts';
import { listGoogleCalendarSelections, replaceGoogleCalendarSelections, recordGoogleCalendarFetch } from './google-calendar-selection-store.ts';

type Calendar = Pick<ReturnType<typeof createGoogleCalendarService>, 'listCalendars' | 'listEvents'>;
type CalendarEntry = Awaited<ReturnType<Calendar['listCalendars']>>['items'][number];
type ProviderEvent = Awaited<ReturnType<Calendar['listEvents']>>['items'][number];
interface Dependencies { db: Db; calendar: Calendar }
interface Service {
  listCalendars(userId: string, accountId: string, input?: { pageToken?: string }, signal?: AbortSignal): Promise<z.infer<typeof GoogleCalendarListResponseSchema>>;
  selectCalendars(userId: string, accountId: string, input: z.input<typeof GoogleCalendarSelectionInputSchema>, signal?: AbortSignal): Promise<{ selections: GoogleCalendarSelection[] }>;
  project(userId: string, input: z.input<typeof GoogleAgendaWindowSchema>, signal?: AbortSignal): Promise<GoogleAgendaProjection>;
}
export type GoogleAgendaProjector = Service['project'];
function deadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function available(calendar: CalendarEntry): boolean { return calendar.accessRole !== 'freeBusyReader'; }
function failureState(error: unknown): 'unavailable' | 'reconnect_required' | 'permission_required' {
  if (error instanceof GoogleCredentialError) return error.code;
  if (error instanceof Error && error.message === 'calendar_unauthorized') return 'reconnect_required';
  if (error instanceof Error && error.message === 'calendar_forbidden') return 'permission_required';
  return 'unavailable';
}
function projectEvent(event: ProviderEvent, selection: GoogleCalendarSelection, stamp: number): GoogleAgendaProjection['remote_items'][number] | null {
  if (event.status === 'cancelled') return null;
  if (!event.start || !event.end) throw new StoreError('google_agenda_invalid_event');
  const valid = 'date' in event.start && 'date' in event.end ? event.start.date < event.end.date
    : 'dateTime' in event.start && 'dateTime' in event.end && Date.parse(event.start.dateTime) < Date.parse(event.end.dateTime);
  if (!valid) throw new StoreError('google_agenda_invalid_event');
  const identity = [selection.account_id, selection.calendar_id, event.id];
  return { origin: 'google', source_key: `google:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
    source: { account_id: selection.account_id, calendar_id: selection.calendar_id, event_id: event.id, etag: event.etag },
    title: (event.summary ?? '(Untitled event)').slice(0, 200), location: event.location?.slice(0, 500) ?? null,
    start: event.start, end: event.end, ...(event.originalStartTime ? { original_start: event.originalStartTime } : {}), read_only: true, fetched_at: stamp };
}

export function createGoogleAgendaService(deps: Dependencies): Service {
  async function account(userId: string, accountId: string): Promise<void> {
    if (!await getGoogleAccount(deps.db, userId, accountId)) throw new StoreNotFoundError('google_account_not_found');
  }
  async function selectedEntries(userId: string, accountId: string, ids: string[], signal: AbortSignal): Promise<CalendarEntry[]> {
    const found: CalendarEntry[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const response = await deps.calendar.listCalendars(userId, accountId, { limit: 100, pageToken }, signal);
      found.push(...response.items.filter((item) => ids.includes(item.id) && available(item)));
      if (new Set(found.map((item) => item.id)).size === ids.length) return found;
      if (!response.nextPageToken) break;
      pageToken = response.nextPageToken;
    }
    throw new StoreError('google_calendar_selection_unavailable');
  }
  async function projectSource(userId: string, selection: GoogleCalendarSelection, range: { from: number; to: number }, signal: AbortSignal): Promise<GoogleAgendaProjection> {
    const base = { account_id: selection.account_id, calendar_id: selection.calendar_id, last_success_at: selection.last_success_at };
    try {
      signal.throwIfAborted();
      const result = await deps.calendar.listEvents(userId, selection.account_id, selection.calendar_id,
        { timeMin: new Date(range.from).toISOString(), timeMax: new Date(range.to).toISOString(), limit: 50 }, signal);
      signal.throwIfAborted();
      const stamp = Date.now();
      const remote_items = result.items.map((event) => projectEvent(event, selection, stamp)).filter((item) => item !== null);
      if (!await recordGoogleCalendarFetch(deps.db, userId, selection, stamp)) return { remote_items: [], sources: [] };
      return { remote_items, sources: [{ ...base, state: result.nextPageToken ? 'partial' : 'fresh', fetched_at: stamp, last_success_at: stamp,
        ...(result.nextPageToken ? { next_page_token: result.nextPageToken } : {}) }] };
    } catch (error) {
      return { remote_items: [], sources: [{ ...base, state: failureState(error) }] };
    }
  }
  return {
    async listCalendars(userId, accountId, input = {}, signal) {
      await account(userId, accountId);
      const response = await deps.calendar.listCalendars(userId, accountId, { limit: 100, ...input }, deadline(signal));
      const selected = await listGoogleCalendarSelections(deps.db, userId);
      return GoogleCalendarListResponseSchema.parse({ selected_calendar_ids: selected.filter((entry) => entry.account_id === accountId).map((entry) => entry.calendar_id), calendars: response.items.map((item) => ({ id: item.id, title: item.summary.slice(0, 200),
        time_zone: item.timeZone ?? null, selected: selected.some((entry) => entry.account_id === accountId && entry.calendar_id === item.id),
        selectable: available(item), read_only: true })), ...(response.nextPageToken ? { next_page_token: response.nextPageToken } : {}) });
    },
    async selectCalendars(userId, accountId, input, signal) {
      const parsed = GoogleCalendarSelectionInputSchema.safeParse(input);
      if (!parsed.success) throw new StoreError('google_selection_invalid');
      await account(userId, accountId);
      const bounded = deadline(signal);
      bounded.throwIfAborted();
      const entries = parsed.data.calendarIds.length ? await selectedEntries(userId, accountId, parsed.data.calendarIds, bounded) : [];
      bounded.throwIfAborted();
      const selections = entries.map((entry) => ({ account_id: accountId, calendar_id: entry.id, title: entry.summary.slice(0, 200), time_zone: entry.timeZone ?? null, last_success_at: null }));
      return { selections: await replaceGoogleCalendarSelections(deps.db, userId, accountId, selections) };
    },
    async project(userId, input, signal) {
      const parsed = GoogleAgendaWindowSchema.safeParse(input);
      if (!parsed.success) throw new StoreError('google_agenda_invalid_window');
      const selections = await listGoogleCalendarSelections(deps.db, userId);
      const bounded = deadline(signal);
      const result: GoogleAgendaProjection = { remote_items: [], sources: [] };
      for (let index = 0; index < selections.length; index += 2) {
        const pages = await Promise.all(selections.slice(index, index + 2).map((selection) => projectSource(userId, selection, parsed.data, bounded)));
        for (const page of pages) { result.remote_items.push(...page.remote_items); result.sources.push(...page.sources); }
      }
      return GoogleAgendaResponseSchema.parse(result);
    },
  };
}
