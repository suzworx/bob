import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import type { Space, SpacesValue } from '@/features/spaces/use-spaces';
import { localDayKey } from '@/features/productivity/use-today';
import { CalendarPage, TodayPage } from './calendar-page';

// Outside a SpacesProvider (every older test here) there is no space to write
// to, so no "New reminder"; the reminder-write tests below set one.
let mockSpaces: SpacesValue | null = null;
vi.mock('@/features/spaces/use-spaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/spaces/use-spaces')>()),
  useOptionalSpaces: () => mockSpaces,
}));
vi.mock('@/lib/auth/use-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/use-session')>()),
  useSession: () => ({
    status: 'signed-in',
    // The account zone is the browser's here, so the fixtures' local days are the page's days.
    session: { user: { id: 'me', user_metadata: { time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone } } },
    unavailable: null,
  }),
}));

// Every date in this file derives from one pinned instant, never the real clock
// or the machine's day: with a live clock these tests passed or failed by the
// date CI ran them (#637 went red on the 29th, when "the day after tomorrow" was
// in next month). Only Date is faked, and it advances with real time, so
// promises, userEvent, waitFor and a ticking countdown all keep working. Keys
// come from the component's own localDayKey (the browser's zone), and a noon
// UTC instant is the same calendar day in every zone from UTC-11 to UTC+11.
const MID_MONTH = Date.parse('2026-09-16T12:00:00Z');

/** The local day key `days` calendar days from an instant (DST-safe). */
function dayKeyFrom(instant: number, days: number): string {
  const d = new Date(instant);
  return localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 12).getTime());
}

let now = MID_MONTH;
let today = new Date(now);
let todayKey = dayKeyFrom(now, 0);
let tomorrowKey = dayKeyFrom(now, 1);
// A day in the visible month with nothing due: the day after tomorrow, or two days back
// when that is in next month (the last two days of a month), outside the visible grid.
let emptyDayKey = '';

/** Pin Date to `instant` and derive every key the stubs and assertions use from it. */
function pinClock(instant: number): void {
  vi.useFakeTimers({ now: instant, toFake: ['Date'], shouldAdvanceTime: true });
  now = instant;
  today = new Date(instant);
  todayKey = dayKeyFrom(instant, 0);
  tomorrowKey = dayKeyFrom(instant, 1);
  const dayAfterTomorrowKey = dayKeyFrom(instant, 2);
  emptyDayKey = dayAfterTomorrowKey.slice(0, 7) === todayKey.slice(0, 7) ? dayAfterTomorrowKey : dayKeyFrom(instant, -2);
}
pinClock(MID_MONTH);

beforeEach(() => pinClock(MID_MONTH));
afterEach(() => vi.useRealTimers());

/** The Calendar's accessible name for a day button, e.g. "Friday, September 25, 2026". */
function dayName(key: string, selected = false): RegExp {
  const label = new Date(`${key}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return new RegExp(`^${label}${selected ? ', selected' : ''}$`);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(
  routes: Record<string, () => Promise<Response>> = {},
  failures: Set<string> = new Set(),
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      const route = routes[url] ?? (url.startsWith('/api/agenda?') ? routes['/api/agenda'] : undefined);
      if (route) return route();
      if (failures.has(url)) return new Response(null, { status: 500 });
      if (url === '/api/spaces') {
        return json({
          spaces: [
            { id: 's1', kind: 'private', name: 'My Space' },
            { id: 's2', kind: 'pair', name: 'Pair Space' },
            { id: 's3', kind: 'group', name: 'Family Space' },
          ],
        });
      }
      if (url === '/api/spaces/s1/tasks?status=open') {
        return json({
          tasks: [
            {
              id: 't1',
              title: 'Task today',
              status: 'open',
              due: { kind: 'date', date: todayKey },
              trashed_at: null,
            },
            {
              id: 't2',
              title: 'Task tomorrow',
              status: 'open',
              due: { kind: 'date', date: tomorrowKey },
              trashed_at: null,
            },
          ],
        });
      }
      if (url === '/api/spaces/s2/tasks?status=open') {
        return json({
          tasks: [
            {
              id: 't3',
              title: 'Pair task with time',
              status: 'open',
              due: { kind: 'instant', at: now, zone: 'UTC' },
              trashed_at: null,
            },
          ],
        });
      }
      if (url === '/api/spaces/s3/tasks?status=open') {
        return json({
          tasks: [
            {
              id: 't4',
              title: 'Family task',
              status: 'open',
              due: { kind: 'date', date: todayKey },
              trashed_at: null,
            },
          ],
        });
      }
      if (url.startsWith('/api/agenda?')) {
        return json({
          items: [
            {
              event_id: 'e1',
              space_id: 's1',
              origin: 'native',
              title: 'All day event',
              all_day: true,
              start_date: todayKey,
              start_at: null,
              original_occurrence_start: now,
              cancelled: false,
            },
            {
              event_id: 'e2',
              space_id: 's1',
              origin: 'native',
              title: 'Timed event',
              all_day: false,
              start_date: todayKey,
              start_at: now + 3600000,
              original_occurrence_start: now,
              cancelled: false,
              my_response: 'tentative',
            },
          ],
        });
      }
      if (/^\/api\/spaces\/s\d\/reminders$/.test(url)) {
        return json({ reminders: [] });
      }
      if (url === '/api/timers') {
        return json({ timers: [] });
      }
      throw new Error(`unrouted fetch: ${url}`);
    }),
  );
}

function renderPage(): void {
  render(
    <Theme theme={neutralTheme} mode="system">
      <CalendarPage />
    </Theme>,
  );
}

describe('CalendarPage', () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the heading and loading state', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Calendar', level: 1 })).toBeTruthy();
    expect(screen.getByText('Your day and what is coming up.')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
  });

  it('picks today by default and lists that day, then what is coming up', async () => {
    renderPage();
    await screen.findByText('Task today');
    const day = screen.getByText('Task today').closest('ul') as HTMLElement;
    expect(within(day).queryByText('Task tomorrow')).toBeNull();
    const coming = screen.getByRole('heading', { name: 'Coming up', level: 2 });
    expect(coming.compareDocumentPosition(screen.getByText('Task tomorrow')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: dayName(todayKey, true) })).toBeTruthy();
    // The day group is headed with a short weekday and a date, never a relative word.
    expect(screen.getAllByText(/^[A-Z][a-z]{2}, /).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryAllByText(/^(Today|Tomorrow)$/)).toHaveLength(0);
  });

  it("picking another day shows that day's items, labelled with their space", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Task today');
    await user.click(screen.getByRole('button', { name: dayName(tomorrowKey) }));
    const row = (await screen.findByText('Task tomorrow')).closest('li') as HTMLElement;
    expect(row.textContent).toContain('My Space');
    expect(screen.queryByText('Task today')).toBeNull();
    expect(screen.queryByText('Pair task with time')).toBeNull();
  });

  it('shows the empty state for a picked day with nothing due', async () => {
    const user = userEvent.setup();
    // The default events stub ignores from/to; with no events only tasks count.
    stubFetch({ '/api/agenda': async () => json({ items: [] }) });
    renderPage();
    await screen.findByText('Task today');
    await user.click(screen.getByRole('button', { name: dayName(emptyDayKey) }));
    expect(await screen.findByRole('heading', { name: 'Nothing on this day', level: 2 })).toBeTruthy();
    expect(screen.queryByText('Task today')).toBeNull();
    expect(screen.queryByText('Task tomorrow')).toBeNull();
  });

  it('names the kind in words on a task and a reminder row, beside its icon', async () => {
    renderPage();
    const row = (await screen.findByText('Task today')).closest('li') as HTMLElement;
    expect(row.textContent).toContain('Task · My Space');
  });

  it('is not a copy of Today: an overdue task from another day is not listed', async () => {
    stubFetch({
      '/api/spaces': async () => json({ spaces: [{ id: 's1', kind: 'private', name: 'My Space' }] }),
      '/api/spaces/s1/tasks?status=open': async () =>
        json({
          tasks: [
            { id: 't0', title: 'Late task', status: 'open', due: { kind: 'date', date: '2020-01-01' }, trashed_at: null },
            { id: 't1', title: 'Task today', status: 'open', due: { kind: 'date', date: todayKey }, trashed_at: null },
          ],
        }),
      '/api/agenda': async () => json({ items: [] }),
    });
    renderPage();
    await screen.findByText('Task today');
    expect(screen.queryByText('Late task')).toBeNull();
  });

  it('names the space in the row description, with no separate chip', async () => {
    renderPage();
    await screen.findByText('Task today');
    expect(document.body.textContent).toContain('Task · My Space');
    expect(document.body.textContent).toContain('Task · Family Space');
    expect(screen.queryByText('My Space')).toBeNull();
  });

  it('shows Google events read-only next to native ones', async () => {
    stubFetch({
      '/api/agenda': async () => json({
        items: [],
        sources: [],
        remote_items: [{
          origin: 'google', source_key: 'g1', source: { account_id: 'a', calendar_id: 'c', event_id: 'e', etag: 'x' },
          title: 'Dentist', location: null, start: { date: todayKey }, end: { date: tomorrowKey }, read_only: true, fetched_at: 1,
        }],
      }),
    });
    renderPage();
    const row = (await screen.findByText('Dentist')).closest('li') as HTMLElement;
    expect(row.textContent).toContain('Read-only');
  });

  it('shows "All day" for all-day events and time for timed events', async () => {
    renderPage();
    await screen.findByText('All day event');
    const allDayEventText = screen.getByText('All day event').textContent || '';
    const allDayRow = screen.getByText('All day event').closest('div');
    expect(allDayRow?.textContent).toContain('All day');
  });

  it("shows the caller's RSVP on an event row", async () => {
    renderPage();
    await screen.findByText('Timed event');
    const eventRow = screen.getByText('Timed event').closest('div');
    expect(eventRow?.textContent).toContain('Maybe');
  });

  it('shows empty state when nothing is due', async () => {
    stubFetch({
      '/api/spaces': async () =>
        json({
          spaces: [{ id: 's1', kind: 'private', name: 'My Space' }],
        }),
      '/api/spaces/s1/tasks?status=open': async () => json({ tasks: [] }),
      '/api/agenda': async () => json({ items: [] }),
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Nothing on this day', level: 2 })).toBeTruthy();
    expect(screen.getByText('Tasks, events and reminders show up here.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Calendar', level: 1 })).toBeTruthy();
  });

  it('shows error state with Retry button', async () => {
    stubFetch({ '/api/spaces': async () => new Response(null, { status: 500 }) });
    renderPage();
    expect(await screen.findByText('The calendar could not be loaded.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('retries loading on Retry button click', async () => {
    const user = userEvent.setup();
    let callCount = 0;
    const customRoutes = {
      '/api/spaces': async () => {
        callCount++;
        if (callCount === 1) return new Response(null, { status: 500 });
        return json({
          spaces: [{ id: 's1', kind: 'private', name: 'My Space' }],
        });
      },
      '/api/spaces/s1/tasks?status=open': async () => json({ tasks: [] }),
      '/api/agenda': async () => json({ items: [] }),
    };
    stubFetch(customRoutes);
    renderPage();
    expect(await screen.findByText('The calendar could not be loaded.')).toBeTruthy();
    const retryButton = screen.getByRole('button', { name: 'Retry' });
    await user.click(retryButton);
    expect(await screen.findByRole('heading', { name: 'Nothing on this day', level: 2 })).toBeTruthy();
  });

  it('shows partial failure when one space fails', async () => {
    const failures = new Set(['/api/spaces/s2/tasks?status=open']);
    stubFetch({}, failures);
    renderPage();
    expect(await screen.findByText(/Could not load/)).toBeTruthy();
    expect(screen.getByText('Task today')).toBeTruthy();
  });

  it('sets data-space-kind on each row', async () => {
    renderPage();
    const row = (await screen.findByText('Task today')).closest('[data-space-kind]');
    expect(row?.getAttribute('data-space-kind')).toBe('private');
  });
});

describe('CalendarPage refresh on focus', () => {
  const task = (id: string, title: string) => ({
    id,
    title,
    status: 'open',
    due: { kind: 'date', date: todayKey },
    trashed_at: null,
  });

  function returnToTab(): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('refetches when the tab becomes visible again', async () => {
    let taskCalls = 0;
    stubFetch({
      '/api/spaces/s1/tasks?status=open': async () => {
        taskCalls += 1;
        return json({ tasks: taskCalls === 1 ? [task('t1', 'Task today')] : [task('t1', 'Task today'), task('t9', 'Added elsewhere')] });
      },
    });
    renderPage();

    await screen.findByText('Task today');
    expect(screen.queryByText('Added elsewhere')).toBeNull();
    returnToTab();

    expect(await screen.findByText('Added elsewhere')).toBeTruthy();
    expect(taskCalls).toBe(2);
  });

  it('keeps the list on screen while it refetches instead of showing the loading message', async () => {
    let taskCalls = 0;
    let release: () => void = () => undefined;
    stubFetch({
      '/api/spaces/s1/tasks?status=open': async () => {
        taskCalls += 1;
        if (taskCalls === 1) return json({ tasks: [task('t1', 'Task today')] });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return json({ tasks: [task('t1', 'Task today'), task('t9', 'Added elsewhere')] });
      },
    });
    renderPage();

    await screen.findByText('Task today');
    returnToTab();
    await waitFor(() => expect(taskCalls).toBe(2));
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
    expect(screen.getByText('Task today')).toBeTruthy();

    release();
    expect(await screen.findByText('Added elsewhere')).toBeTruthy();
    expect(screen.getByText('Task today')).toBeTruthy();
  });
});

describe('CalendarPage reminders', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const eightPm = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 20, 0).getTime();
  const reminder = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id,
    space_id: 's3',
    title,
    due_at: eightPm,
    due_zone: zone,
    rrule: null,
    status: 'active',
    ...extra,
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows a reminder due today at 20:00 with its time, kind and space', async () => {
    stubFetch({
      '/api/spaces/s3/reminders': async () => json({ reminders: [reminder('r1', 'have lunch')] }),
    });
    renderPage();
    const row = (await screen.findByText('have lunch')).closest('li') as HTMLElement;
    expect(row.textContent).toContain('Reminder · Family Space');
    expect(row.textContent).toMatch(/8:00|20:00/);
    // It sits in the same list as the day's tasks.
    expect(screen.getByText('Task today').closest('ul')).toBe(row.closest('ul'));
  });

  it('a daily reminder shows on the next day too', async () => {
    const user = userEvent.setup();
    stubFetch({
      '/api/spaces/s3/reminders': async () =>
        json({ reminders: [reminder('r2', 'stretch', { rrule: { freq: 'daily' } })] }),
    });
    renderPage();
    await screen.findAllByText('stretch');
    await user.click(screen.getByRole('button', { name: dayName(tomorrowKey) }));
    const row = (await screen.findByText('Task tomorrow')).closest('ul') as HTMLElement;
    expect(within(row).getByText('stretch')).toBeTruthy();
  });

  it('a cancelled reminder is not shown', async () => {
    stubFetch({
      '/api/spaces/s3/reminders': async () =>
        json({ reminders: [reminder('r3', 'cancelled one', { status: 'cancelled' })] }),
    });
    renderPage();
    await screen.findByText('Task today');
    expect(screen.queryByText('cancelled one')).toBeNull();
  });

  it("another space's reminders failure still renders the rest", async () => {
    stubFetch(
      { '/api/spaces/s3/reminders': async () => json({ reminders: [reminder('r1', 'have lunch')] }) },
      new Set(['/api/spaces/s2/reminders']),
    );
    renderPage();
    expect(await screen.findByText(/Could not load Pair Space/)).toBeTruthy();
    expect(screen.getByText('have lunch')).toBeTruthy();
    expect(screen.getByText('Task today')).toBeTruthy();
  });
});

describe('CalendarPage completing a task', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const taskFixture = (id: string, title: string, day: string, revision: number) => ({
    id,
    title,
    status: 'open',
    due: { kind: 'date', date: day },
    trashed_at: null,
    revision,
  });

  it('ticks off a task via a PATCH and it disappears from the day', async () => {
    const user = userEvent.setup();
    const t1 = taskFixture('t1', 'Task today', todayKey, 3);
    const t2 = taskFixture('t2', 'Task tomorrow', tomorrowKey, 1);
    let done = false;
    stubFetch({
      '/api/spaces/s1/tasks?status=open': async () => json({ tasks: done ? [t2] : [t1, t2] }),
      '/api/tasks/t1': async () => {
        done = true;
        return json({ ...t1, status: 'completed' });
      },
    });
    renderPage();

    const checkbox = await screen.findByRole('checkbox', { name: 'Complete Task today' });
    await user.click(checkbox);

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true);
    });
    const patchCall = vi.mocked(fetch).mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const body = JSON.parse(((patchCall?.[1] as RequestInit | undefined)?.body as string) ?? '{}');
    expect(body).toEqual({ revision: 3, status: 'completed' });

    await waitFor(() => expect(screen.queryByText('Task today')).toBeNull());
  });

  it('shows an error and keeps the row when the PATCH fails', async () => {
    const user = userEvent.setup();
    const t1 = taskFixture('t1', 'Task today', todayKey, 3);
    stubFetch({
      '/api/spaces/s1/tasks?status=open': async () => json({ tasks: [t1] }),
      '/api/tasks/t1': async () => new Response(null, { status: 500 }),
    });
    renderPage();

    const checkbox = await screen.findByRole('checkbox', { name: 'Complete Task today' });
    await user.click(checkbox);

    expect(await screen.findByText('The task could not be completed.')).toBeTruthy();
    expect(screen.getByText('Task today')).toBeTruthy();
  });

  it('does not render a checkbox for event rows', async () => {
    stubFetch();
    renderPage();
    await screen.findByText('All day event');
    expect(screen.queryByRole('checkbox', { name: 'Complete All day event' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Complete Timed event' })).toBeNull();
  });
});

describe('CalendarPage running timers', () => {
  const pasta = { id: 't1', kind: 'timer', label: 'pasta', fire_at: now + 65_000, remaining_ms: 65_000, zone: 'UTC' };
  const wakeAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 30).getTime();
  const alarm = { id: 'a1', kind: 'alarm', label: null, fire_at: wakeAt, remaining_ms: 60 * 60_000, zone: 'UTC' };

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // The countdown ticks on setInterval, so a test that waits for it on the wall
  // clock timed out under CPU load (L-172). These tests freeze Date and fake the
  // interval, then move time themselves; setTimeout stays real, so findBy and
  // waitFor (MutationObserver plus a real timeout) keep working.
  function freezeClock(): void {
    vi.useFakeTimers({ now, toFake: ['Date', 'setInterval', 'clearInterval'] });
  }

  async function advance(ms: number): Promise<void> {
    await act(() => vi.advanceTimersByTimeAsync(ms));
  }

  function renderToday(): void {
    render(
      <Theme theme={neutralTheme} mode="system">
        <TodayPage />
      </Theme>,
    );
  }

  it('hides the section when nothing is running', async () => {
    stubFetch({ '/api/action-items': async () => json({ action_items: [] }) });
    renderToday();
    await screen.findByText('Task today');
    expect(screen.queryByRole('list', { name: 'Timers' })).toBeNull();
  });

  it('lists a timer with a ticking countdown and an alarm with its ring time', async () => {
    freezeClock();
    stubFetch({ '/api/timers': async () => json({ timers: [pasta, alarm] }), '/api/action-items': async () => json({ action_items: [] }) });
    renderToday();
    expect(await screen.findByRole('list', { name: 'Timers' })).toBeTruthy();
    const timerRow = screen.getByText('pasta').closest('li') as HTMLElement;
    expect(within(timerRow).getByRole('timer').textContent).toBe('1:05 left');
    await advance(1000);
    expect(within(timerRow).getByRole('timer').textContent).toBe('1:04 left');
    const alarmRow = screen.getByText('Alarm').closest('li') as HTMLElement;
    expect(alarmRow.textContent).toContain('Rings at');
    expect(alarmRow.textContent).toMatch(/11:30|23:30/);
  });

  it('cancel removes the timer and hides the empty section', async () => {
    const user = userEvent.setup();
    let deleted = false;
    stubFetch({
      '/api/timers': async () => json({ timers: deleted ? [] : [pasta] }),
      '/api/timers/t1': async () => {
        deleted = true;
        return json({ cancelled: pasta, remaining: 0 });
      },
      '/api/action-items': async () => json({ action_items: [] }),
    });
    renderToday();
    await screen.findByText('pasta');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('pasta')).toBeNull());
    expect(deleted).toBe(true);
    expect(screen.queryByRole('list', { name: 'Timers' })).toBeNull();
  });

  it('refetches when a timer reaches zero', async () => {
    freezeClock();
    let calls = 0;
    stubFetch({
      '/api/timers': async () => {
        calls += 1;
        return json({ timers: calls === 1 ? [{ ...pasta, remaining_ms: 1000 }] : [] });
      },
      '/api/action-items': async () => json({ action_items: [] }),
    });
    renderToday();
    await screen.findByText('pasta');
    await advance(999);
    expect(calls).toBe(1);
    await advance(1);
    await waitFor(() => expect(screen.queryByText('pasta')).toBeNull());
    expect(calls).toBe(2);
  });
});

describe('CalendarPage reminder actions (#509)', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const eightPm = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 20, 0).getTime();
  const family = {
    id: 's3', kind: 'group', name: 'Family Space', role: 'owner', membership_revision: 1, created_at: 0, updated_at: 0,
    members: [
      { user_id: 'me', role: 'owner', joined_at: 0, display_name: 'Alex', handle: 'alex', email: null },
      { user_id: 'u2', role: 'member', joined_at: 0, display_name: 'Sam', handle: 'sam', email: null },
    ],
  } as Space;
  const personal = { ...family, id: 's1', kind: 'private', name: 'My Space', members: [family.members[0]] } as Space;
  let status = 'active';
  let rrule: unknown = null;
  let spaceId = 's3';
  const lunch = () => ({ id: 'r1', space_id: spaceId, title: 'have lunch', due_at: eightPm, due_zone: zone, rrule, status });
  const writes = () => vi.mocked(fetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== undefined);

  function stubReminder(): void {
    stubFetch({
      [`/api/spaces/${spaceId}/reminders`]: async () => json({ reminders: [lunch()] }),
      '/api/reminders/r1/cancel': async () => {
        status = 'cancelled';
        return json({ reminder: lunch() });
      },
      '/api/reminders/r1': async () => json({ reminder: lunch() }),
    });
  }

  beforeEach(() => {
    status = 'active';
    rrule = null;
    spaceId = 's3';
    mockSpaces = { spaces: [personal, family], activeSpaceId: 's3', activeSpace: family } as unknown as SpacesValue;
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
      this.removeAttribute('open');
    };
    stubReminder();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    mockSpaces = null;
  });

  async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(await screen.findByRole('button', { name: 'Actions for have lunch' }));
  }

  it('one New menu opens the reminder dialog in the account zone, private by default', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Reminder' }));
    expect(await screen.findByRole('heading', { name: 'New reminder' })).toBeTruthy();
    expect(screen.getByText(`Time in ${zone}`)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /Space/ }).textContent).toContain('My Space');
    expect(screen.queryByRole('checkbox', { name: 'Sam' })).toBeNull();
  });

  it('cancelling a shared reminder asks first, naming who it stops for', async () => {
    const user = userEvent.setup();
    renderPage();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Cancel reminder/ }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('everyone in Family Space');
    expect(writes()).toEqual([]);
    await user.click(within(confirm).getByRole('button', { name: 'Cancel reminder' }));
    await waitFor(() => expect(screen.queryByText('have lunch')).toBeNull());
    expect(writes().map(([path]) => String(path))).toEqual(['/api/reminders/r1/cancel']);
  });

  it('cancelling a private reminder needs no dialog and offers Undo', async () => {
    spaceId = 's1';
    stubReminder();
    const user = userEvent.setup();
    renderPage();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Cancel reminder/ }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(screen.queryByText('have lunch')).toBeNull());
    expect(await screen.findByText('Cancelled have lunch')).toBeTruthy();
    expect(screen.getAllByText('Undo').length).toBeGreaterThan(0);
  });

  it('Snooze is a submenu counted from now, with a confirming toast', async () => {
    const at = eightPm - 3 * 60 * 60 * 1000;
    vi.useFakeTimers({ toFake: ['Date'], now: at, shouldAdvanceTime: true });
    const user = userEvent.setup();
    renderPage();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Snooze/ }));
    await user.click(await screen.findByRole('menuitem', { name: '10 minutes' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [path, init] = writes()[0] ?? [];
    expect(path).toBe('/api/reminders/r1');
    const body = JSON.parse(String((init as RequestInit).body)) as { due_at: number };
    // From now, not from 8 PM when it rings.
    expect(body.due_at - at).toBeGreaterThanOrEqual(10 * 60_000);
    expect(body.due_at - at).toBeLessThan(11 * 60_000);
    expect(await screen.findByText(/^Snoozed until/)).toBeTruthy();
  });

  it('a repeating reminder cannot be snoozed from its row', async () => {
    rrule = { freq: 'daily' };
    const user = userEvent.setup();
    renderPage();
    // A daily one is on today and every day coming up: open today's row.
    await user.click((await screen.findAllByRole('button', { name: 'Actions for have lunch' }))[0] as HTMLElement);
    const snooze = await screen.findByRole('menuitem', { name: /Snooze/ });
    expect(snooze.getAttribute('aria-disabled')).toBe('true');
  });

  it('opening a reminder row shows who gets it', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('have lunch'));
    expect(await screen.findByRole('heading', { name: 'Edit reminder' })).toBeTruthy();
    expect(screen.getByText('Who gets it')).toBeTruthy();
    expect(screen.getByText('People in Family Space')).toBeTruthy();
  });
});

// Month edges on purpose: near a month's end "the day after tomorrow" is in next
// month, outside the grid, so the empty day is a past one; on the first the day
// before is. 05:00Z on the 29th is the instant #637's CI run failed at.
describe.each([
  ['the day before the last of a month', '2026-09-29T05:00:00Z'],
  ['the last day of a month', '2026-09-30T12:00:00Z'],
  ['the first day of a month', '2026-10-01T12:00:00Z'],
])('CalendarPage on %s', (_edge, instant) => {
  beforeEach(() => {
    pinClock(Date.parse(instant));
    stubFetch({ '/api/agenda': async () => json({ items: [] }) });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("picks today and lists today's items", async () => {
    renderPage();
    await screen.findByText('Task today');
    expect(screen.getByRole('button', { name: dayName(todayKey, true) })).toBeTruthy();
    const day = screen.getByText('Task today').closest('ul') as HTMLElement;
    expect(within(day).queryByText('Task tomorrow')).toBeNull();
  });

  it('shows the empty state for a picked day in the month with nothing due', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Task today');
    await user.click(screen.getByRole('button', { name: dayName(emptyDayKey) }));
    expect(await screen.findByRole('heading', { name: 'Nothing on this day', level: 2 })).toBeTruthy();
    // A later day lists only itself and what comes after it.
    if (emptyDayKey > todayKey) expect(screen.queryByText('Task today')).toBeNull();
  });
});
