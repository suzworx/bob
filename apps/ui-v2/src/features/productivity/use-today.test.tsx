process.env.TZ = 'America/New_York';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hourlyRepeatLabel, localDayKey, reminderInstantOn, reminderInstantsOn, useDayItems } from './use-today';

vi.mock('../../lib/auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useDayItems: Google events and my tasks only', () => {
  it('lists Google read-only events next to native ones, and drops tasks assigned to someone else', async () => {
    const day = '2026-10-21';
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/spaces') return json(200, { spaces: [{ id: 'spc_f', kind: 'group', name: 'Family' }] });
      if (url === '/api/spaces/spc_f/tasks?status=open') {
        const task = (id: string, title: string, assignee: string | null) => ({
          id, title, status: 'open', due: { kind: 'date', date: day }, trashed_at: null, revision: 1, assignee_user_id: assignee,
        });
        return json(200, { tasks: [task('t1', 'Mine', 'me'), task('t2', 'Anyone', null), task('t3', 'Sams', 'u-sam')] });
      }
      if (url === '/api/spaces/spc_f/reminders') return json(200, { reminders: [] });
      if (url.startsWith('/api/agenda?')) {
        return json(200, {
          items: [],
          remote_items: [{
            origin: 'google', source_key: 'g1', source: { account_id: 'a', calendar_id: 'c', event_id: 'e', etag: 'x' },
            title: 'Dentist', location: null, start: { dateTime: '2026-10-21T15:30:00Z' }, end: { dateTime: '2026-10-21T16:00:00Z' },
            read_only: true, fetched_at: 1,
          }],
          sources: [],
        });
      }
      return json(404, {});
    });
    const { result } = renderHook(() => useDayItems(day, 0, 'UTC', { me: 'me' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const titles = result.current.items.map((item) => `${item.kind}:${item.title}`);
    expect(titles).toContain('google:Dentist');
    expect(titles).toContain('task:Mine');
    expect(titles).toContain('task:Anyone');
    expect(titles).not.toContain('task:Sams');
  });
});

describe('useDayItems', () => {
  it('a slow older load never overwrites a newer one', async () => {
    const releaseFirst = { fn: (() => {}) as (() => void) };
    let callCount = 0;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/spaces') {
        callCount += 1;
        if (callCount === 1) {
          // First call: delay until manually released
          await new Promise<void>((resolve) => {
            releaseFirst.fn = resolve;
          });
          return json(200, { spaces: [{ id: 'spc_1', kind: 'private', name: 'First' }] });
        }
        // Second call: return immediately
        return json(200, { spaces: [{ id: 'spc_2', kind: 'private', name: 'Second' }] });
      }
      if (url === '/api/spaces/spc_2/tasks?status=open') return json(200, { tasks: [] });
      if (url === '/api/spaces/spc_2/calendars') return json(200, { calendars: [] });
      if (url === '/api/spaces/spc_1/tasks?status=open') return json(200, { tasks: [] });
      if (url === '/api/spaces/spc_1/calendars') return json(200, { calendars: [] });
      return json(404, {});
    });

    const { result } = renderHook(() => useDayItems(localDayKey(Date.now())));

    // Wait for initial load to be pending
    await waitFor(() => expect(callCount).toBe(1), { timeout: 1000 });

    // Trigger refresh
    await act(async () => {
      result.current.refresh();
    });

    // Wait for second load to complete
    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 3000 });

    // Release first load
    releaseFirst.fn();

    // Ensure items don't change
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current.unavailableSpaces).not.toContain('First');
  });

  it('the window is the picked local day, 25 hours across the DST change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 1, 12, 0));

    const capturedQueries: string[] = [];

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/spaces') {
        return json(200, { spaces: [{ id: 'spc_a', kind: 'private', name: 'Space A' }] });
      }
      if (url === '/api/spaces/spc_a/tasks?status=open') {
        return json(200, { tasks: [] });
      }
      if (url.startsWith('/api/agenda?')) {
        const match = url.match(/\?(.+)$/);
        if (match) capturedQueries.push(match[1]);
        return json(200, { items: [] });
      }
      return json(404, {});
    });

    const { result } = renderHook(() => useDayItems(localDayKey(Date.now())));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(capturedQueries.length).toBeGreaterThan(0);
    const query = capturedQueries[0];
    const fromMatch = query.match(/from=(\d+)/);
    const toMatch = query.match(/to=(\d+)/);
    expect(fromMatch).toBeTruthy();
    expect(toMatch).toBeTruthy();

    if (fromMatch && toMatch) {
      const fromValue = parseInt(fromMatch[1], 10);
      const toValue = parseInt(toMatch[1], 10);
      const endDate = new Date(toValue);

      // Verify it's midnight
      expect(endDate.getHours()).toBe(0);
      expect(endDate.getMinutes()).toBe(0);

      // Local midnight Nov 1 to local midnight Nov 2
      expect(fromValue).toBe(new Date(2026, 10, 1).getTime());
      expect(endDate.getTime()).toBe(new Date(2026, 10, 2).getTime());

      // DST ends on Nov 1, so that day is 25 hours long
      expect(toValue - fromValue).toBe(25 * 3600 * 1000);
    }

    vi.useRealTimers();
  });

  it('merges tasks and events sorted chronologically from multiple spaces', async () => {
    const now = Date.now();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const midnightMs = midnight.getTime();
    const hour = 60 * 60 * 1000;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/spaces') {
        return json(200, {
          spaces: [
            { id: 'spc_a', kind: 'private', name: 'Space A' },
            { id: 'spc_b', kind: 'group', name: 'Space B' },
          ],
        });
      }
      if (url === '/api/spaces/spc_a/tasks?status=open') {
        return json(200, {
          tasks: [
            {
              id: 'task_1',
              title: 'Morning task',
              status: 'open',
              due: { kind: 'instant', at: midnightMs + 9 * hour, zone: 'UTC' },
              trashed_at: null,
              revision: 1,
            },
          ],
        });
      }
      // Every event, in every space, comes from one /api/agenda read.
      if (url.startsWith('/api/agenda?')) {
        return json(200, {
          items: [
            {
              event_id: 'evt_1',
              space_id: 'spc_a',
              title: 'Early event',
              all_day: false,
              start_date: null,
              start_at: midnightMs + 7 * hour,
              original_occurrence_start: midnightMs + 7 * hour,
              cancelled: false,
            },
          ],
        });
      }
      if (url === '/api/spaces/spc_b/tasks?status=open') {
        return json(200, {
          tasks: [
            {
              id: 'task_2',
              title: 'Mid-morning task',
              status: 'open',
              due: { kind: 'instant', at: midnightMs + 8 * hour, zone: 'UTC' },
              trashed_at: null,
              revision: 1,
            },
          ],
        });
      }
      if (url === '/api/spaces/spc_b/calendars') {
        return json(200, { calendars: [] });
      }
      return json(404, {});
    });

    const { result } = renderHook(() => useDayItems(localDayKey(Date.now())));

    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 3000 });

    // Verify items sorted by time: 07:00 event, 08:00 task, 09:00 task
    expect(result.current.items).toHaveLength(3);
    expect(result.current.items[0].title).toBe('Early event');
    expect(result.current.items[1].title).toBe('Mid-morning task');
    expect(result.current.items[2].title).toBe('Morning task');
  });


  function dayKey(offset: number): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return localDayKey(d.getTime());
  }

  function stubTasks(tasks: Array<{ id: string; title: string; date: string }>): void {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/spaces') {
        return json(200, { spaces: [{ id: 'spc_1', kind: 'private', name: 'Space 1' }] });
      }
      if (url === '/api/spaces/spc_1/tasks?status=open') {
        return json(200, {
          tasks: tasks.map((task) => ({
            id: task.id,
            title: task.title,
            status: 'open',
            due: { kind: 'date', date: task.date },
            trashed_at: null,
            revision: 1,
          })),
        });
      }
      if (url === '/api/spaces/spc_1/calendars') return json(200, { calendars: [] });
      return json(404, {});
    });
  }

  it('today keeps overdue tasks and drops tomorrow', async () => {
    stubTasks([
      { id: 't_past', title: 'Overdue task', date: dayKey(-2) },
      { id: 't_today', title: 'Today task', date: dayKey(0) },
      { id: 't_next', title: 'Tomorrow task', date: dayKey(1) },
    ]);

    const { result } = renderHook(() => useDayItems(dayKey(0)));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items.map((item) => item.title)).toEqual(['Overdue task', 'Today task']);
    // A date-only due keeps its date and never gains a time.
    expect(result.current.items[1]).toMatchObject({ dateOnly: true, day: dayKey(0) });
  });

  it('another day shows only its own tasks, never the overdue ones', async () => {
    stubTasks([
      { id: 't_past', title: 'Overdue task', date: dayKey(-2) },
      { id: 't_today', title: 'Today task', date: dayKey(0) },
      { id: 't_next', title: 'Tomorrow task', date: dayKey(1) },
    ]);

    const { result } = renderHook(() => useDayItems(dayKey(1)));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items.map((item) => item.title)).toEqual(['Tomorrow task']);
  });

  it('refetches when the picked day changes', async () => {
    stubTasks([
      { id: 't_today', title: 'Today task', date: dayKey(0) },
      { id: 't_later', title: 'Later task', date: dayKey(3) },
    ]);

    const { result, rerender } = renderHook(({ day }) => useDayItems(day), {
      initialProps: { day: dayKey(0) },
    });
    await waitFor(() => expect(result.current.items.map((item) => item.title)).toEqual(['Today task']));

    rerender({ day: dayKey(3) });
    await waitFor(() => expect(result.current.items.map((item) => item.title)).toEqual(['Later task']));
  });
});

describe('reminderInstantOn', () => {
  // Fri 2026-09-25 20:00 in Los Angeles = Sat 2026-09-26 03:00 UTC = 23:00 New York.
  const at = Date.UTC(2026, 8, 26, 3, 0);
  const base = { id: 'r1', title: 'have lunch', due_at: at, due_zone: 'America/Los_Angeles', status: 'active' as const };

  it('a one-shot rings on the reader\'s local day of its instant', () => {
    const reminder = { ...base, rrule: null };
    expect(reminderInstantOn(reminder, '2026-09-25')).toBe(at);
    expect(reminderInstantOn(reminder, '2026-09-26')).toBeNull();
  });

  it('a cancelled or paused reminder never rings', () => {
    expect(reminderInstantOn({ ...base, rrule: null, status: 'cancelled' }, '2026-09-25')).toBeNull();
    expect(reminderInstantOn({ ...base, rrule: { freq: 'daily' }, status: 'paused' }, '2026-09-26')).toBeNull();
  });

  it('daily keeps the zone wall time, across the DST change', () => {
    const reminder = { ...base, rrule: { freq: 'daily' as const } };
    expect(reminderInstantOn(reminder, '2026-09-24')).toBeNull();
    expect(reminderInstantOn(reminder, '2026-09-26')).toBe(at + 24 * 3600 * 1000);
    // Both zones leave DST on Nov 1: 20:00 PST = 04:00 UTC = 23:00 EST.
    expect(reminderInstantOn(reminder, '2026-11-02')).toBe(Date.UTC(2026, 10, 3, 4, 0));
  });

  it('weekdays skips the weekend, and until ends the rule', () => {
    const reminder = { ...base, rrule: { freq: 'weekly' as const, byWeekday: [1, 2, 3, 4, 5], until: '2026-10-02' } };
    expect(reminderInstantOn(reminder, '2026-09-26')).toBeNull();
    expect(reminderInstantOn(reminder, '2026-09-28')).toBe(Date.UTC(2026, 8, 29, 3, 0));
    expect(reminderInstantOn(reminder, '2026-10-05')).toBeNull();
  });

  it('weekly, monthly and yearly land on their own days only', () => {
    const weekly = { ...base, rrule: { freq: 'weekly' as const, interval: 2 } };
    expect(reminderInstantOn(weekly, '2026-10-02')).toBeNull();
    expect(reminderInstantOn(weekly, '2026-10-09')).toBe(Date.UTC(2026, 9, 10, 3, 0));
    const monthly = { ...base, rrule: { freq: 'monthly' as const } };
    expect(reminderInstantOn(monthly, '2026-10-25')).toBe(Date.UTC(2026, 9, 26, 3, 0));
    expect(reminderInstantOn(monthly, '2026-10-24')).toBeNull();
    const yearly = { ...base, rrule: { freq: 'yearly' as const } };
    expect(reminderInstantOn(yearly, '2027-09-25')).toBe(Date.UTC(2027, 8, 26, 3, 0));
    expect(reminderInstantOn(yearly, '2026-10-25')).toBeNull();
  });
});

describe('hourly reminders on the calendar (#456)', () => {
  // Fri 2026-09-25 08:00 in New York (EDT) = 12:00 UTC.
  const base = { id: 'r9', title: 'have water', due_at: Date.UTC(2026, 8, 25, 12, 0), due_zone: 'America/New_York', status: 'active' as const };
  const hours = (ats: number[], zone = 'America/New_York'): string[] =>
    ats.map((at) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(at));

  it('rings at every slot of the window, and the anchor day starts at the anchor', () => {
    const rrule = { freq: 'hourly' as const, interval: 2, window: { start: '08:00', end: '22:00' } };
    expect(hours(reminderInstantsOn({ ...base, rrule }, '2026-09-26'))).toEqual([
      '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00',
    ]);
    const late = { ...base, due_at: Date.UTC(2026, 8, 25, 17, 0), rrule }; // 13:00 EDT, off-slot
    expect(hours(reminderInstantsOn(late, '2026-09-25'))).toEqual(['14:00', '16:00', '18:00', '20:00', '22:00']);
    expect(reminderInstantsOn(late, '2026-09-24')).toEqual([]);
    expect(reminderInstantOn(late, '2026-09-25')).toBe(Date.UTC(2026, 8, 25, 18, 0));
  });

  it('a reminder zone day that straddles the reader\'s day contributes from both', () => {
    const rrule = { freq: 'hourly' as const, window: { start: '08:00', end: '22:00' } };
    const kolkata = { ...base, due_at: Date.UTC(2026, 8, 25, 2, 30), due_zone: 'Asia/Kolkata', rrule };
    // New York Sep 26 = 09:30 IST Sep 26 to 09:30 IST Sep 27.
    const ats = reminderInstantsOn(kolkata, '2026-09-26');
    expect(hours(ats, 'Asia/Kolkata')).toEqual([
      '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00',
      '08:00', '09:00',
    ]);
  });

  it('across DST each wall slot rings once: 23 rings in spring, 24 in autumn', () => {
    const rrule = { freq: 'hourly' as const };
    const spring = reminderInstantsOn({ ...base, due_at: Date.UTC(2026, 0, 1, 5, 0), rrule }, '2026-03-08');
    expect(new Set(spring).size).toBe(spring.length);
    expect(spring).toHaveLength(23);
    const autumn = reminderInstantsOn({ ...base, due_at: Date.UTC(2026, 0, 1, 5, 0), rrule }, '2026-11-01');
    expect(autumn).toHaveLength(24);
    expect(autumn.every((at) => localDayKey(at) === '2026-11-01')).toBe(true);
  });

  it('the day view shows an hourly reminder as one row, at its next ring, naming the rule', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/spaces') return json(200, { spaces: [{ id: 'spc_1', kind: 'private', name: 'Home' }] });
      if (url === '/api/spaces/spc_1/tasks?status=open') return json(200, { tasks: [] });
      if (url === '/api/spaces/spc_1/calendars') return json(200, { calendars: [] });
      if (url === '/api/spaces/spc_1/reminders') {
        return json(200, { reminders: [{ ...base, space_id: 'spc_1', rrule: { freq: 'hourly', interval: 4, window: { start: '08:00', end: '20:00' } } }] });
      }
      return json(404, {});
    });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 8, 26, 12) });
    const { result } = renderHook(() => useDayItems('2026-09-27'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const rows = result.current.items.filter((item) => item.kind === 'reminder');
    expect(rows.map((row) => row.title)).toEqual(['have water']);
    const [row] = rows;
    if (row?.kind !== 'reminder') throw new Error('no reminder row');
    expect(row.repeat).toBe('Every 4 hours 8:00–20:00');
    // A day after now (pinned before it): no ring has passed, so the first is the next.
    expect(hours([row.at])).toEqual(['08:00']);
    expect(hourlyRepeatLabel({ interval: 1, window: { start: '08:00', end: '22:00' } })).toBe('Every hour 8:00–22:00');
  });
});
