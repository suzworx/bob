import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelReminder,
  createReminder,
  instantToWall,
  PREVIEW_DEBOUNCE_MS,
  reminderIdOf,
  snoozeReminder,
  useReminderPreview,
  useSpaceReminders,
  wallToInstant,
  type ReminderSummary,
  snoozeChoices,
} from './use-reminders';

vi.mock('../../lib/auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const reminder: ReminderSummary = {
  id: 'r1', space_id: 's1', title: 'Bins', due_at: Date.UTC(2026, 9, 24, 7), due_zone: 'Europe/London', rrule: null, status: 'active',
};

describe('zone wall time', () => {
  it('holds 08:00 London on both sides of the October change', () => {
    expect(wallToInstant('2026-10-24T08:00', 'Europe/London')).toBe(Date.UTC(2026, 9, 24, 7));
    expect(wallToInstant('2026-10-26T08:00', 'Europe/London')).toBe(Date.UTC(2026, 9, 26, 8));
    expect(instantToWall(Date.UTC(2026, 9, 26, 8), 'Europe/London')).toBe('2026-10-26T08:00');
    expect(wallToInstant('2026-10-24T08:00', 'America/New_York')).toBe(Date.UTC(2026, 9, 24, 12));
  });

  it('reads the reminder id out of a calendar row id', () => {
    expect(reminderIdOf('r1:1790000000000')).toBe('r1');
  });
});

describe('snoozeChoices', () => {
  it('counts from now, and Tomorrow is 9:00 AM the next day in the zone, not 24 hours on', () => {
    const now = Date.UTC(2026, 9, 21, 20); // 21:00 London (BST)
    const [ten, hour, tomorrow] = snoozeChoices(now, 'Europe/London');
    expect(ten).toEqual({ label: '10 minutes', until: now + 10 * 60_000 });
    expect(hour).toEqual({ label: '1 hour', until: now + 60 * 60_000 });
    expect(tomorrow).toEqual({ label: 'Tomorrow 9:00 AM', until: Date.UTC(2026, 9, 22, 8) });
  });
});

describe('reminder writes', () => {
  it('creates with the zone and recipients; cancels and snoozes by id', async () => {
    fetchMock.mockResolvedValue(json(201, { reminder }));
    const rule = { freq: 'daily' as const };
    expect(await createReminder('s1', { title: 'Bins', dueAt: 5, zone: 'Europe/London', rrule: rule }, ['u1', 'u2'])).toEqual({ ok: true });
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe('/api/spaces/s1/reminders');
    expect(JSON.parse(String(init?.body))).toEqual({
      title: 'Bins', due_at: 5, due_zone: 'Europe/London', rrule: rule, recipient_user_ids: ['u1', 'u2'],
    });
    await cancelReminder('r1');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/reminders/r1/cancel');
    await snoozeReminder(reminder, 99);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ due_at: 99, due_zone: 'Europe/London' });
    fetchMock.mockResolvedValue(json(400, { error: { code: 'invalid_recipient' } }));
    expect(await cancelReminder('r1')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('useReminderPreview', () => {
  it('asks the server once the edits settle and returns its rings', async () => {
    const occurrences = [{ at: 1, wall_time: '2026-10-24T08:00' }];
    fetchMock.mockResolvedValue(json(200, { occurrences }));
    const { result } = renderHook(() => useReminderPreview(Date.UTC(2026, 9, 24, 7), 'Europe/London', { freq: 'daily' }));
    expect(result.current.status).toBe('loading');
    expect(fetchMock).not.toHaveBeenCalled();
    await flush(PREVIEW_DEBOUNCE_MS);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `/api/reminders/preview?due=${Date.UTC(2026, 9, 24, 7)}&zone=Europe%2FLondon&rrule=${encodeURIComponent('{"freq":"daily"}')}`,
    );
    expect(result.current).toEqual({ status: 'ready', occurrences });
  });

  it('stays idle without a time and reports a failed preview', async () => {
    const idle = renderHook(() => useReminderPreview(null, 'UTC', null));
    expect(idle.result.current.status).toBe('idle');
    fetchMock.mockResolvedValue(json(400, { error: { code: 'invalid_request' } }));
    const failed = renderHook(() => useReminderPreview(5, 'UTC', null));
    await flush(PREVIEW_DEBOUNCE_MS);
    expect(failed.result.current.status).toBe('error');
  });
});

describe('useSpaceReminders', () => {
  it('maps each space reminder by id and skips a failing space', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/api/spaces/s1/reminders' ? json(200, { reminders: [reminder] }) : json(500, {}));
    const { result } = renderHook(() => useSpaceReminders(['s1', 's2', 's1']));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.get('r1')?.title).toBe('Bins');
  });
});
