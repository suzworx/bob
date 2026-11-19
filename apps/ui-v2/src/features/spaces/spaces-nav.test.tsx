import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SideNav } from '@astryxdesign/core/SideNav';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { SpacesProvider } from '@/features/spaces/use-spaces';
import type { AppRoute } from '../../app/routes';
import { SpacesNav } from './spaces-nav';

// The page reads the caller's id from the session; fetchWithAuth is the plain
// global fetch so the tests stub the network in one place, as spaces-page.test.tsx does.
vi.mock('@/lib/auth/use-session', () => ({
  useSession: () => ({ session: { user: { id: 'u-self' } } }),
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

// Phone is read through useAppShellMobile only; jsdom has no breakpoint, so a flag stands it in.
const phone = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ ...actual.useAppShellMobile(), isMobile: phone.isMobile }) };
});

const SPACE_A = { id: 'a', kind: 'group', name: 'Home', role: 'owner', membership_revision: 1, created_at: 0, updated_at: 0, unread_count: 3, last_activity_at: 500 };
const SPACE_B = { id: 'b', kind: 'pair', name: 'Us two', role: 'owner', membership_revision: 1, created_at: 0, updated_at: 0, unread_count: 0, last_activity_at: 900 };
const PRIVATE = { id: 'p', kind: 'private', name: 'Private', role: 'owner', membership_revision: 1, created_at: 0, updated_at: 0, unread_count: 0, last_activity_at: 9999 };
const MANY = Array.from({ length: 6 }, (_, index) => ({
  id: `m${index}`, kind: 'group', name: `Space ${index}`, role: 'member', membership_revision: 1,
  created_at: 0, updated_at: 0, unread_count: 0, last_activity_at: index * 10,
}));
const THREAD_READ = {
  id: 't1', space_id: 'a', title: 'Groceries', created_by: 'u1', archived_at: null,
  last_sequence: 1, unread_count: 0, created_at: 0, updated_at: 0,
};
const THREAD_UNREAD = {
  id: 't2', space_id: 'a', title: 'Trip', created_by: 'u1', archived_at: null,
  last_sequence: 2, unread_count: 3, created_at: 0, updated_at: 0,
};

type Handler = () => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MEMBER = (id: string): { user_id: string; role: string; joined_at: number; display_name: null; handle: string; email: null } => ({
  user_id: id, role: 'member', joined_at: 0, display_name: null, handle: id, email: null,
});

function stubFetch(overrides: Record<string, Handler> = {}): ReturnType<typeof vi.fn> {
  const routes: Record<string, Handler> = {
    'GET /api/spaces': () => json({ spaces: [SPACE_A, SPACE_B, PRIVATE] }),
    'GET /api/spaces/p/members': () => json({ members: [MEMBER('u1')] }),
    'GET /api/spaces/a/members': () => json({ members: [MEMBER('u1'), MEMBER('u2')] }),
    'GET /api/spaces/b/members': () => json({ members: [MEMBER('u1')] }),
    'GET /api/spaces/a/threads': () => json({ threads: [THREAD_READ, THREAD_UNREAD] }),
    ...overrides,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`;
    const route = routes[key];
    if (!route) throw new Error(`unrouted request: ${key}`);
    return route();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ROUTE_A: AppRoute = { kind: 'spaces', spaceId: 'a', section: 'threads', threadId: null };

// A space row is collapsible, so Astryx also renders a hidden label span (for
// the disclosure group's aria-labelledby) with the same text as the row's own
// visible label. Scope to the button's own span to find the clickable one.
function findSpaceRow(name: string): Promise<HTMLElement> {
  return screen.findByRole('link', { name: new RegExp(`^${name}`) });
}

function renderNav(
  route: AppRoute,
  onOpen: (path: string) => void = vi.fn(),
  onCreateSpace: () => void = vi.fn(),
): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <Theme theme={neutralTheme}>
      <QueryClientProvider client={client}>
        <SpacesProvider>
          <SideNav>
            <SpacesNav route={route} onOpen={onOpen} onCreateSpace={onCreateSpace} />
          </SideNav>
        </SpacesProvider>
      </QueryClientProvider>
    </Theme>,
  );
}

// jsdom has no modal <dialog>; the Astryx dialog calls showModal() on open.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  phone.isMobile = false;
  cleanup();
  vi.unstubAllGlobals();
});

describe('SpacesNav', () => {
  // P0: the unread total comes from the spaces list, so a space shows it
  // without any thread list being fetched (rows no longer expand).
  it('shows each space\'s server unread total and fetches no thread list', async () => {
    const fetchMock = stubFetch();
    renderNav(ROUTE_A);
    const home = await findSpaceRow('Home');
    expect(within(home).getByText('3')).toBeTruthy();
    const pair = await findSpaceRow('Us two');
    expect(within(pair).queryByText('0')).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => /\/threads/.test(String(input)))).toBe(false);
    expect(screen.queryByText('Groceries')).toBeNull();
  });

  it('leaves Private out: personal chats already live under Chats', async () => {
    stubFetch();
    renderNav(ROUTE_A);
    await findSpaceRow('Home');
    expect(screen.queryByRole('link', { name: /^Private/ })).toBeNull();
  });

  it('shows the four most recent spaces, newest first, then All spaces', async () => {
    stubFetch({
      'GET /api/spaces': () => json({ spaces: MANY }),
      ...Object.fromEntries(MANY.map((space) => [`GET /api/spaces/${space.id}/members`, () => json({ members: [] })])),
    });
    renderNav({ kind: 'chat', conversationId: null } as AppRoute);
    await findSpaceRow('Space 5');
    const names = screen.getAllByRole('link').map((link) => link.textContent);
    expect(names).toEqual(['Space 5', 'Space 4', 'Space 3', 'Space 2', 'All spaces']);
  });

  it('opens a space\'s thread list, and All spaces, through onOpen', async () => {
    stubFetch();
    const onOpen = vi.fn();
    const user = userEvent.setup();
    renderNav(ROUTE_A, onOpen);
    await user.click(await findSpaceRow('Us two'));
    expect(onOpen).toHaveBeenLastCalledWith('/spaces/b/conversations');
    await user.click(screen.getByRole('link', { name: 'All spaces' }));
    expect(onOpen).toHaveBeenLastCalledWith('/spaces');
  });

  it('keeps modified clicks native', async () => {
    stubFetch();
    const onOpen = vi.fn();
    renderNav(ROUTE_A, onOpen);
    const row = await findSpaceRow('Us two');
    fireEvent.click(row, { metaKey: true });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('marks the open space selected', async () => {
    stubFetch();
    renderNav(ROUTE_A);
    const home = await findSpaceRow('Home');
    expect(home.getAttribute('aria-current')).toBe('page');
  });

  it('on a phone shows the three most recent spaces and All spaces, with no New space row', async () => {
    phone.isMobile = true;
    stubFetch({
      'GET /api/spaces': () => json({ spaces: MANY }),
      ...Object.fromEntries(MANY.map((space) => [`GET /api/spaces/${space.id}/members`, () => json({ members: [] })])),
    });
    renderNav({ kind: 'chat', conversationId: null } as AppRoute);
    await findSpaceRow('Space 5');
    const names = screen.getAllByRole('link').map((link) => link.textContent);
    expect(names).toEqual(['Space 5', 'Space 4', 'Space 3', 'All spaces']);
    expect(screen.queryByRole('button', { name: 'New space' })).toBeNull();
  });

  it('calls onCreateSpace from New space', async () => {
    stubFetch();
    const onCreateSpace = vi.fn();
    const user = userEvent.setup();
    renderNav(ROUTE_A, vi.fn(), onCreateSpace);
    await user.click(await screen.findByRole('button', { name: 'New space' }));
    expect(onCreateSpace).toHaveBeenCalledTimes(1);
  });
});
