import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { localDayKey } from '@/features/productivity/use-today';
import { TodayPage } from './calendar-page';

// #870: the Today page is the Calendar fixed to today, in the account's time
// zone, with the open action items under it.
let accountZone: string | undefined;
vi.mock('@/lib/auth/use-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/use-session')>()),
  useSession: () => ({
    status: 'signed-in',
    session: { user: { id: 'me', user_metadata: accountZone === undefined ? {} : { time_zone: accountZone } } },
    unavailable: null,
  }),
}));

vi.mock('@/features/spaces/use-spaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/spaces/use-spaces')>()),
  useOptionalSpaces: () => ({
    spaces: [{ id: 's1', kind: 'private', name: 'My Space', role: 'owner', members: [{ user_id: 'me', role: 'owner', joined_at: 0, display_name: 'Me', handle: 'me', email: null }] }],
    activeSpace: null,
    activeSpaceId: null,
  }),
}));

// One pinned instant; noon UTC is the same calendar day from UTC-11 to UTC+11.
const NOON = Date.parse('2026-09-16T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

type ActionItemRow = { id: string; content: string; status: 'open' | 'done' | 'dropped'; due_at: number | null };

let tasks: Array<{ id: string; title: string; date: string; assignee?: string }> = [];
let actionItems: ActionItemRow[] = [];
let eventsQuery = '';
let patched: Array<{ url: string; body: unknown }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function wireActionItem(item: ActionItemRow): Record<string, unknown> {
  return { ...item, memory_id: `m-${item.id}`, confidence: 1, created_at: 0, updated_at: 0 };
}

function patchActionItem(url: string, init: RequestInit): Response {
  const body = JSON.parse(String(init.body)) as { status: ActionItemRow['status'] };
  patched.push({ url, body });
  const id = decodeURIComponent(url.slice('/api/action-items/'.length));
  actionItems = actionItems.map((item) => (item.id === id ? { ...item, status: body.status } : item));
  return json(wireActionItem(actionItems.find((item) => item.id === id) as ActionItemRow));
}

let remoteItems: unknown[] = [];
let reminders: unknown[] = [];
let promoted: Array<{ url: string; body: unknown }> = [];

// Exact-path GET routes; the agenda, PATCH and promote routes match by prefix below.
const ROUTES: Record<string, () => Response> = {
  '/api/spaces': () => json({ spaces: [{ id: 's1', kind: 'private', name: 'My Space' }] }),
  '/api/spaces/s1/tasks?status=open': () =>
    json({
      tasks: tasks.map((task) => ({
        id: task.id, title: task.title, status: 'open', due: { kind: 'date', date: task.date }, trashed_at: null, revision: 1,
        assignee_user_id: task.assignee ?? null,
      })),
    }),
  '/api/spaces/s1/reminders': () => json({ reminders }),
  '/api/timers': () => json({ timers: [] }),
  '/api/action-items': () => json({ action_items: actionItems.map(wireActionItem) }),
};

function route(url: string, init?: RequestInit): Response {
  const exact = ROUTES[url];
  if (exact) return exact();
  if (url.startsWith('/api/agenda?')) {
    eventsQuery = url.slice(url.indexOf('?') + 1);
    return json({ items: [], remote_items: remoteItems, sources: [] });
  }
  if (url.startsWith('/api/action-items/') && init?.method === 'PATCH') return patchActionItem(url, init);
  if (url.startsWith('/api/memories/') && init?.method === 'POST') {
    promoted.push({ url, body: JSON.parse(String(init.body)) });
    return json({ id: 'task-new' }, 201);
  }
  throw new Error(`unrouted fetch: ${url}`);
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      route(typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url, init),
    ),
  );
}

function renderPage(): void {
  render(
    <Theme theme={neutralTheme} mode="system">
      <TodayPage />
    </Theme>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOON, toFake: ['Date'], shouldAdvanceTime: true });
  accountZone = undefined;
  tasks = [];
  actionItems = [];
  eventsQuery = '';
  patched = [];
  remoteItems = [];
  reminders = [];
  promoted = [];
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TodayPage', () => {
  it("shows today's tasks and overdue ones, never tomorrow's, and no date picker", async () => {
    const today = localDayKey(NOON);
    tasks = [
      { id: 't1', title: 'Due today', date: today },
      { id: 't2', title: 'Was due yesterday', date: localDayKey(NOON - DAY_MS) },
      { id: 't3', title: 'Due tomorrow', date: localDayKey(NOON + DAY_MS) },
    ];
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
    expect(await screen.findByText('Due today')).toBeTruthy();
    const overdueRow = screen.getByText('Was due yesterday').closest('li');
    expect(overdueRow).not.toBeNull();
    expect(within(overdueRow as HTMLElement).getByText('Overdue')).toBeTruthy();
    expect(screen.queryByText('Due tomorrow')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('one empty state for the whole page, and no link away to Memory', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Nothing due today' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'No open action items' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage action items' })).toBeNull();
  });

  it('groups Overdue, Today and Suggested by Bob, with only my tasks and Google events', async () => {
    const today = localDayKey(NOON);
    tasks = [
      { id: 't1', title: 'Mine today', date: today, assignee: 'me' },
      { id: 't2', title: 'Sam\'s today', date: today, assignee: 'u-sam' },
      { id: 't3', title: 'Late one', date: localDayKey(NOON - DAY_MS) },
    ];
    remoteItems = [{
      origin: 'google', source_key: 'g1', source: { account_id: 'a', calendar_id: 'c', event_id: 'e', etag: 'x' },
      title: 'Dentist', location: null, start: { dateTime: new Date(NOON + 60 * 60 * 1000).toISOString() },
      end: { dateTime: new Date(NOON + 2 * 60 * 60 * 1000).toISOString() }, read_only: true, fetched_at: 1,
    }];
    actionItems = [{ id: 'a1', content: 'Call the plumber', status: 'open', due_at: null }];
    renderPage();

    const overdue = await screen.findByRole('list', { name: /^Overdue/ });
    expect(within(overdue).getByText('Late one')).toBeTruthy();
    const todayList = screen.getByRole('list', { name: /^Today/ });
    expect(within(todayList).getByText('Mine today')).toBeTruthy();
    expect(within(todayList).getByText('Dentist')).toBeTruthy();
    expect(screen.queryByText("Sam's today")).toBeNull();
    const suggested = await screen.findByRole('list', { name: /^Suggested by/ });
    expect(within(suggested).getByText('Call the plumber')).toBeTruthy();
    // Order on the page: Overdue, Today, Suggested.
    expect(overdue.compareDocumentPosition(todayList) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(todayList.compareDocumentPosition(suggested) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Add turns a suggestion into a task in my private space and says where it went', async () => {
    actionItems = [{ id: 'a1', content: 'Call the plumber', status: 'open', due_at: null }];
    const user = userEvent.setup();
    renderPage();
    const suggested = await screen.findByRole('list', { name: /^Suggested by/ });
    await user.click(within(suggested).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Added to My Space')).toBeTruthy();
    expect(promoted[0]?.body).toMatchObject({ space_id: 's1' });
    await waitFor(() => expect(screen.queryByText('Call the plumber')).toBeNull());
  });

  it('Dismiss shows an Undo toast that brings the suggestion back', async () => {
    actionItems = [{ id: 'a1', content: 'Call the plumber', status: 'open', due_at: null }];
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Call the plumber');
    await user.click(screen.getByRole('button', { name: 'Actions for Call the plumber' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: /^Suggested by/ })).toBeNull());
    // The toast viewport is a live region, not in the role tree here; find Undo by its text.
    const undo = (await screen.findByText('Undo')).closest('button');
    if (undo === null) throw new Error('no Undo button');
    await user.click(undo);
    expect(await screen.findByText('Call the plumber')).toBeTruthy();
    expect(patched.map((entry) => entry.body)).toEqual([{ status: 'dropped' }, { status: 'open' }]);
  });

  it('a notification link (?reminder=) highlights that reminder\'s row', async () => {
    reminders = [{ id: 'r7', space_id: 's1', title: 'Pay rent', due_at: NOON + 60 * 60 * 1000, due_zone: 'UTC', rrule: null, status: 'active' }];
    window.history.replaceState(null, '', '/today?reminder=r7');
    renderPage();
    const row = (await screen.findByText('Pay rent')).closest('[data-reminder-id]') as HTMLElement;
    expect(row.getAttribute('data-reminder-id')).toBe('r7');
    expect(row.getAttribute('aria-current')).toBe('true');
    window.history.replaceState(null, '', '/');
  });

  it('one New menu offers Task, Reminder and Event', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Nothing due today' });
    await user.click(screen.getByRole('button', { name: 'New' }));
    for (const name of ['Task', 'Reminder', 'Event']) expect(await screen.findByRole('menuitem', { name })).toBeTruthy();
  });

  it("reads today in the account's time zone, not the browser's", async () => {
    // Noon UTC on the 16th is already 02:00 on the 17th in Kiritimati (UTC+14),
    // and still the 16th in every browser zone from UTC-11 to UTC+11.
    accountZone = 'Pacific/Kiritimati';
    tasks = [
      { id: 't1', title: 'Due on the 17th', date: '2026-09-17' },
      { id: 't2', title: 'Due on the 16th', date: '2026-09-16' },
      { id: 't3', title: 'Due on the 18th', date: '2026-09-18' },
    ];
    renderPage();

    const today = (await screen.findByText('Due on the 17th')).closest('li') as HTMLElement;
    expect(within(today).queryByText('Overdue')).toBeNull();
    const yesterday = screen.getByText('Due on the 16th').closest('li') as HTMLElement;
    expect(within(yesterday).getByText('Overdue')).toBeTruthy();
    expect(screen.queryByText('Due on the 18th')).toBeNull();
    // The agenda window is the account zone's whole day: midnight to midnight in Kiritimati.
    await waitFor(() => expect(eventsQuery).not.toBe(''));
    expect(eventsQuery).toBe(`from=${Date.parse('2026-09-16T10:00:00Z')}&to=${Date.parse('2026-09-17T10:00:00Z')}`);
  });
});
