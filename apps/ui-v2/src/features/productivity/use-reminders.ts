/**
 * Reminder writes and the next-rings preview for the Calendar page (#509, #126),
 * over apps/api/src/reminders/http.ts. A reminder's time is a wall time in its
 * own zone: the dialog edits 'YYYY-MM-DDTHH:mm' in that zone and this module
 * turns it into the UTC instant the API stores, so a London reminder set from
 * a New York browser still rings at London's 08:00. The preview is computed by
 * the server's own recurrence engine, never re-derived here.
 */
import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../lib/auth/use-session';

export type ReminderRule =
  | { freq: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval?: number; byWeekday?: number[] }
  | { freq: 'hourly'; interval?: number; window?: { start: string; end: string } };

export type ReminderSummary = {
  id: string;
  space_id: string;
  title: string;
  due_at: number | null;
  due_zone: string | null;
  rrule: ReminderRule | null;
  status: 'active' | 'paused' | 'cancelled';
  /** Who it rings for, when the server sends it (not yet on the list read). */
  recipient_user_ids?: string[];
};

type PreviewOccurrence = { at: number; wall_time: string };

type ReminderWrite = { title: string; dueAt: number; zone: string; rrule: ReminderRule | null };

type Result = { ok: true } | { ok: false; reason: 'invalid' | 'failed' };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** The wall clock ('YYYY-MM-DDTHH:mm') an instant occupies in an IANA zone. */
export function instantToWall(at: number, zone: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', calendar: 'gregory',
  });
  const g: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) if (p.type !== 'literal') g[p.type] = p.value;
  return `${g.year}-${g.month}-${g.day}T${g.hour}:${g.minute}`;
}

function wallAsUtc(wall: string): number {
  return Date.parse(`${wall}:00Z`);
}

/** The instant whose wall time in `zone` is `wall`; a few passes settle a DST
 *  offset. A wall time inside a spring-forward gap lands just after it. */
export function wallToInstant(wall: string, zone: string): number {
  const target = wallAsUtc(wall);
  let at = target;
  for (let i = 0; i < 3; i++) at = target - (wallAsUtc(instantToWall(at, zone)) - Math.floor(at / 60_000) * 60_000);
  return at;
}

async function send(path: string, method: string, body?: unknown): Promise<Result> {
  try {
    const response = await fetchWithAuth(path, {
      method,
      ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
    });
    if (response.ok) return { ok: true };
    return { ok: false, reason: response.status === 400 ? 'invalid' : 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export function createReminder(spaceId: string, input: ReminderWrite, recipients: string[]): Promise<Result> {
  return send(`/api/spaces/${spaceId}/reminders`, 'POST', {
    title: input.title, due_at: input.dueAt, due_zone: input.zone, rrule: input.rrule, recipient_user_ids: recipients,
  });
}

export function updateReminder(id: string, input: ReminderWrite): Promise<Result> {
  return send(`/api/reminders/${id}`, 'PATCH', {
    title: input.title, due_at: input.dueAt, due_zone: input.zone, rrule: input.rrule,
  });
}

/** Moves a one-off reminder later. A repeating one keeps its schedule: moving
 *  its anchor would move every later ring too. */
export function snoozeReminder(reminder: ReminderSummary, until: number): Promise<Result> {
  return send(`/api/reminders/${reminder.id}`, 'PATCH', { due_at: until, due_zone: reminder.due_zone ?? 'UTC' });
}

export type SnoozeChoice = { label: string; until: number };

/** The Snooze submenu: always counted from now, never from the ring time, and
 *  "Tomorrow" is tomorrow at 9:00 AM in the reminder's zone, not now + 24 h. */
export function snoozeChoices(now: number, zone: string): SnoozeChoice[] {
  const today = instantToWall(now, zone).slice(0, 10);
  const [y, m, d] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
  return [
    { label: '10 minutes', until: now + 10 * 60_000 },
    { label: '1 hour', until: now + 60 * 60_000 },
    { label: 'Tomorrow 9:00 AM', until: wallToInstant(`${tomorrow}T09:00`, zone) },
  ];
}

export function cancelReminder(id: string): Promise<Result> {
  return send(`/api/reminders/${id}/cancel`, 'POST');
}

function isPreview(body: unknown): body is { occurrences: PreviewOccurrence[] } {
  const list = (body as { occurrences?: unknown } | null)?.occurrences;
  return Array.isArray(list) && list.every((o: { at?: unknown; wall_time?: unknown }) =>
    typeof o.at === 'number' && typeof o.wall_time === 'string');
}

function isReminderList(body: unknown): body is { reminders: ReminderSummary[] } {
  const list = (body as { reminders?: unknown } | null)?.reminders;
  return Array.isArray(list) && list.every((r: { id?: unknown; title?: unknown }) =>
    typeof r.id === 'string' && typeof r.title === 'string');
}

/** The reminder id inside a calendar row id (`<reminderId>:<instant>`). */
export function reminderIdOf(rowId: string): string {
  return rowId.split(':')[0] ?? rowId;
}

/**
 * The full reminders (rule, zone) behind the calendar's reminder rows, by id,
 * for the spaces in `spaceIds`: a row only carries its title and instant, and
 * editing or snoozing needs the rest. A space that fails is simply missing.
 */
export function useSpaceReminders(spaceIds: readonly string[], refreshKey = 0): ReadonlyMap<string, ReminderSummary> {
  const [byId, setById] = useState<ReadonlyMap<string, ReminderSummary>>(new Map());
  const key = [...new Set(spaceIds)].sort().join(',');
  useEffect(() => {
    let live = true;
    const ids = key === '' ? [] : key.split(',');
    void (async () => {
      const lists = await Promise.all(ids.map(async (spaceId): Promise<ReminderSummary[]> => {
        try {
          const response = await fetchWithAuth(`/api/spaces/${spaceId}/reminders`);
          const body: unknown = response.ok ? await response.json() : null;
          return isReminderList(body) ? body.reminders : [];
        } catch {
          return [];
        }
      }));
      if (live) setById(new Map(lists.flat().map((reminder) => [reminder.id, reminder])));
    })();
    return () => {
      live = false;
    };
  }, [key, refreshKey]);
  return byId;
}

export const PREVIEW_DEBOUNCE_MS = 250;

type PreviewState = { status: 'idle' | 'loading' | 'ready' | 'error'; occurrences: PreviewOccurrence[] };

/** The next three rings (#126) of the reminder being edited; idle without a time. */
export function useReminderPreview(dueAt: number | null, zone: string, rrule: ReminderRule | null): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: 'idle', occurrences: [] });
  const ruleKey = rrule === null ? '' : JSON.stringify(rrule);
  useEffect(() => {
    if (dueAt === null || !Number.isFinite(dueAt)) {
      setState({ status: 'idle', occurrences: [] });
      return undefined;
    }
    let live = true;
    setState((prev) => ({ status: 'loading', occurrences: prev.occurrences }));
    const handle = setTimeout(() => {
      const query = `due=${dueAt}&zone=${encodeURIComponent(zone)}${ruleKey ? `&rrule=${encodeURIComponent(ruleKey)}` : ''}`;
      void (async () => {
        try {
          const response = await fetchWithAuth(`/api/reminders/preview?${query}`);
          const body: unknown = response.ok ? await response.json() : null;
          if (live) setState(isPreview(body) ? { status: 'ready', occurrences: body.occurrences } : { status: 'error', occurrences: [] });
        } catch {
          if (live) setState({ status: 'error', occurrences: [] });
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(handle);
    };
  }, [dueAt, zone, ruleKey]);
  return state;
}
