import { googleProjectionSchema, type GoogleAgendaState } from '@/features/integrations/google-agenda';
import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../lib/auth/use-session';
import type { AttendeeResponse } from './use-events';

/**
 * Agenda data against GET /api/agenda (specs/014-family-collaboration/
 * contracts/api.md "Calendars"). The server expands occurrences across the
 * caller's calendars into a `from`/`to` instant window; each item is labelled
 * with its calendar and origin. Shapes mirror apps/api/src/web-schemas.ts.
 *
 * An all-day event carries `start_date`/`end_date` (calendar dates, no
 * instants) and survives any viewer timezone; a timed event carries epoch-ms
 * instants and null dates. A caller must never invent a time for an all-day
 * event, just as it must never invent a midnight for a date-only task due.
 *
 * `pending` is a client-side flag for an event whose provider write is still
 * settling (contracts/api.md "Pending is a real state"): the server only emits
 * native-origin, settled rows today, so it starts false, but the UI renders a
 * pending marker rather than pretending an in-flight write succeeded.
 */

type CalendarOrigin = 'native' | 'google' | 'icloud';

export type AgendaItem = {
  event_id: string;
  uid: string;
  title: string;
  location: string | null;
  body: string | null;
  all_day: boolean;
  start_date: string | null;
  end_date: string | null;
  start_at: number | null;
  end_at: number | null;
  zone: string;
  original_occurrence_start: number;
  cancelled: boolean;
  moved: boolean;
  calendar_id: string;
  /** The space the event's calendar belongs to. */
  space_id: string;
  origin: CalendarOrigin;
  pending: boolean;
  my_response?: AttendeeResponse | null;
  can_edit?: boolean;
  /** can_edit, or a group owner/admin who may delete but not edit (#873). */
  can_delete?: boolean;
};

export type AgendaRange = { from: number; to: number };

type UseAgendaResult = {
  items: AgendaItem[];
  google: GoogleAgendaState;
  loading: boolean;
  error: string | null;
  range: AgendaRange;
  setRange: (range: AgendaRange) => void;
};

const LIST_ERROR = 'The agenda could not be loaded.';

/** A window around today: 7 days back to 30 days ahead. */
function defaultRange(now = Date.now()): AgendaRange {
  const DAY = 24 * 60 * 60 * 1000;
  return { from: now - 7 * DAY, to: now + 30 * DAY };
}

function agendaBody(body: { items: AgendaItem[] }): { items: AgendaItem[]; google: GoogleAgendaState } {
  const projection = googleProjectionSchema.safeParse(body);
  return { google: projection.success ? projection.data : { remote_items: [], sources: [], remote_unavailable: true },
    items: body.items.map((item) => ({ ...item, pending: item.pending ?? false })) };
}

async function loadAgenda(range: AgendaRange, spaceId: string | null, signal: AbortSignal): Promise<ReturnType<typeof agendaBody>> {
  const space = spaceId === null ? '' : `&space_id=${encodeURIComponent(spaceId)}`;
  const query = `from=${Math.round(range.from)}&to=${Math.round(range.to)}${space}`;
  const response = await fetchWithAuth(`/api/agenda?${query}`, { signal });
  if (!response.ok) throw new Error('list_failed');
  return agendaBody((await response.json()) as { items: AgendaItem[] });
}

/** With `spaceId`, only that space's events (a space's Agenda tab): the
 *  server scopes the read, and a scoped agenda carries no Google rows. */
export function useAgenda(spaceId: string | null = null): UseAgendaResult {
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [google, setGoogle] = useState<GoogleAgendaState>({ remote_items: [], sources: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<AgendaRange>(() => defaultRange());

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void loadAgenda(range, spaceId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setGoogle(result.google);
      setItems(result.items);
      setError(null);
    }).catch(() => {
      if (!controller.signal.aborted) setError(LIST_ERROR);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [range, spaceId]);

  return { items, google, loading, error, range, setRange };
}