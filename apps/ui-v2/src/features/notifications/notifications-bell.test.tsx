import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { NotificationsBell } from './notifications-bell';

vi.mock('@/lib/auth/use-session', () => ({
  useSession: () => ({ session: { user: { id: 'u-self', user_metadata: { time_zone: 'America/Los_Angeles' } } } }),
  browserTimeZone: () => 'UTC',
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

vi.mock('../../lib/use-refresh-on-focus', () => ({ useRefreshOnFocus: () => 0 }));

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const THREAD_ID = '22222222-2222-4222-8222-222222222222';

const MENTION = {
  id: 'n1',
  space_id: SPACE_ID,
  type: 'mention',
  resource_type: 'thread',
  resource_id: THREAD_ID,
  revision: 1,
  cursor: 3,
  read_at: null,
  created_at: 1_700_000_000_000,
  about: { actor_name: 'Asha', title: 'Groceries', space_name: 'Test Fam', at: null, date: null, action: null },
};

const GONE = {
  ...MENTION,
  id: 'n2',
  cursor: 2,
  read_at: 1_700_000_000_000,
  type: 'assignment',
  resource_type: 'task',
  about: null,
};

const BOB_MESSAGE = {
  ...MENTION,
  id: 'n-bob',
  type: 'bob_message',
  resource_type: 'note',
  resource_id: 'note_42',
  about: { actor_name: null, title: 'Weekend plan', space_name: 'Test Fam', at: null, date: null, action: null },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Handler = (init?: RequestInit, url?: string) => Response | Promise<Response>;

function stubFetch(overrides: Record<string, Handler> = {}): ReturnType<typeof vi.fn> {
  const routes: Record<string, Handler> = {
    'GET /api/notifications': () => json({ notifications: [], next_cursor: null, unread_count: 0 }),
    'PUT /api/notifications/read': () => json({ moved: 0 }),
    ...overrides,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    const route = routes[key];
    if (!route) throw new Error(`unrouted request: ${key}`);
    return route(init, url);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, method: string, path: string): unknown[][] {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input).split('?')[0] === path && ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  );
}

function renderBell(): void {
  render(
    <Theme theme={neutralTheme} mode="system">
      <NotificationsBell />
    </Theme>,
  );
}

async function openBell(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /^Notifications/ }));
}

describe('NotificationsBell', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is an icon button whose name and badge carry the unread count', async () => {
    stubFetch({ 'GET /api/notifications': () => json({ notifications: [], next_cursor: null, unread_count: 3 }) });
    renderBell();
    expect(await screen.findByRole('button', { name: 'Notifications, 3 unread' })).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('opens a popover, not a modal dialog, with rows that say who, what and where', async () => {
    stubFetch({
      'GET /api/notifications': () => json({ notifications: [MENTION, GONE], next_cursor: null, unread_count: 1 }),
    });
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    expect(await screen.findByText('Asha mentioned you in Groceries')).toBeTruthy();
    expect(screen.getByText('Test Fam')).toBeTruthy();
    expect(screen.getAllByLabelText('Unread')).toHaveLength(1);
    expect(document.querySelector('dialog[open]')).toBeNull();
  });

  it('shows Bob note copy with its own type icon and opens the exact note', async () => {
    stubFetch({
      'GET /api/notifications': () => json({ notifications: [BOB_MESSAGE, MENTION], next_cursor: null, unread_count: 2 }),
    });
    const user = userEvent.setup();
    renderBell();
    await openBell(user);

    const bobLabel = await screen.findByText('Bob left you a note: Weekend plan');
    expect(screen.getByText('Note · Test Fam')).toBeTruthy();
    const bobIcon = bobLabel.closest('li')?.querySelector('svg')?.getAttribute('class');
    const mentionIcon = screen.getByText('Asha mentioned you in Groceries')
      .closest('li')?.querySelector('svg')?.getAttribute('class');
    expect(bobIcon).toBeTruthy();
    expect(bobIcon).not.toBe(mentionIcon);

    await user.click(screen.getByRole('button', { name: /Bob left you a note: Weekend plan/ }));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/spaces\/[^/]+\/notes$/));
    expect(new URLSearchParams(window.location.search).get('note')).toBe('note_42');
  });

  it('opens the exact thread, marking it read; a row with no target is plain text', async () => {
    const fetchMock = stubFetch({
      'GET /api/notifications': () => json({ notifications: [MENTION, GONE], next_cursor: null, unread_count: 1 }),
    });
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('Asha mentioned you in Groceries');

    // The gone row renders as text: no button carries its label.
    expect(screen.queryByRole('button', { name: /A task was assigned to you/ })).toBeNull();
    expect(screen.getByText('A task was assigned to you')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Asha mentioned you in Groceries/ }));
    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/notifications/read')).toHaveLength(1));
    const [, init] = callsTo(fetchMock, 'PUT', '/api/notifications/read')[0] as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ ids: ['n1'] });
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/spaces\/[^/]+\/conversations\/[^/]+$/));
  });

  it('shows Skeleton rows while loading', async () => {
    let release: (r: Response) => void = () => undefined;
    let calls = 0;
    stubFetch({
      'GET /api/notifications': () => {
        calls += 1;
        if (calls === 1) return json({ notifications: [], next_cursor: null, unread_count: 0 });
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      },
    });
    const user = userEvent.setup();
    renderBell();
    await waitFor(() => expect(calls).toBe(1));
    await openBell(user);
    expect(await screen.findByRole('status', { name: 'Loading notifications' })).toBeTruthy();
    release(json({ notifications: [], next_cursor: null, unread_count: 0 }));
    expect(await screen.findByText("You're all caught up")).toBeTruthy();
  });

  it('a failed load shows an inline error, and Retry refetches', async () => {
    let failing = true;
    stubFetch({
      'GET /api/notifications': (_init, url) =>
        failing && !String(url).includes('unread=true')
          ? new Response(null, { status: 500 })
          : json({ notifications: [], next_cursor: null, unread_count: 0 }),
    });
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    expect(await screen.findByText("Couldn't load notifications.")).toBeTruthy();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText("You're all caught up")).toBeTruthy();
  });

  it('Mark all read marks up to the newest cursor, covering rows not yet loaded', async () => {
    let markedAll = false;
    const fetchMock = stubFetch({
      'GET /api/notifications': () =>
        json(
          markedAll
            ? { notifications: [{ ...MENTION, read_at: 1 }], next_cursor: null, unread_count: 0 }
            : { notifications: [MENTION, GONE], next_cursor: 2, unread_count: 4 },
        ),
      'PUT /api/notifications/read': () => {
        markedAll = true;
        return json({ moved: 4 });
      },
    });
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('Asha mentioned you in Groceries');
    await user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/notifications/read')).toHaveLength(1));
    const [, init] = callsTo(fetchMock, 'PUT', '/api/notifications/read')[0] as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ up_to_cursor: 3 });
    await waitFor(() => expect(screen.queryByLabelText('Unread')).toBeNull());
  });

  it('has no settings view: "Notification settings" goes to /settings#notifications', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await user.click(await screen.findByRole('button', { name: 'Notification settings' }));
    await waitFor(() => expect(`${window.location.pathname}${window.location.hash}`).toBe('/settings#notifications'));
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
