import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { SpacesProvider } from '@/features/spaces/use-spaces';
import { AllSpacesPage, byActivity, spaceRowDescription } from './all-spaces-page';

const shell = vi.hoisted(() => ({ isMobile: false }));

vi.mock('@astryxdesign/core/AppShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ ...actual.useAppShellMobile(), isMobile: shell.isMobile }) };
});

vi.mock('@/lib/auth/use-session', () => ({
  useSession: () => ({ session: { user: { id: 'u-self' } } }),
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

const base = { role: 'owner', membership_revision: 1, created_at: 0, updated_at: 0 };
const HOME = { ...base, id: 's1', kind: 'group', name: 'Home', unread_count: 2, thread_count: 3, last_activity_at: 3000 };
const JAM = { ...base, id: 's2', kind: 'group', name: 'Jam', unread_count: 0, thread_count: 0, last_activity_at: 9000 };
const PRIVATE = { ...base, id: 'p1', kind: 'private', name: 'Private', unread_count: 0, thread_count: 0, last_activity_at: 1000 };
const ARCHIVED = { ...base, id: 's9', kind: 'group', name: 'Old flat', archived_at: 5000 };
const member = (id: string): Record<string, unknown> => ({ user_id: id, role: 'member', joined_at: 0, display_name: id, handle: id, email: null });

type Handler = (init?: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(overrides: Record<string, Handler> = {}): ReturnType<typeof vi.fn> {
  const routes: Record<string, Handler> = {
    'GET /api/spaces': () => json({ spaces: [HOME, JAM, PRIVATE] }),
    'GET /api/spaces?archived=true': () => json({ spaces: [ARCHIVED] }),
    'GET /api/spaces/s1/members': () => json({ members: [member('Sam'), member('Riley')] }),
    'GET /api/spaces/s2/members': () => json({ members: [member('Sam')] }),
    'GET /api/spaces/p1/members': () => json({ members: [member('Sam')] }),
    ...overrides,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const route = routes[key];
    if (!route) throw new Error(`unrouted request: ${key}`);
    return route(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage(): void {
  render(
    <Theme theme={neutralTheme}>
      <SpacesProvider>
        <AllSpacesPage />
      </SpacesProvider>
    </Theme>,
  );
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

beforeEach(() => {
  window.history.replaceState(null, '', '/spaces');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The nearest element holding both nodes.
function sharedAncestor(a: HTMLElement, b: HTMLElement): HTMLElement {
  let node: HTMLElement | null = a;
  while (node && !node.contains(b)) node = node.parentElement;
  return node as HTMLElement;
}

describe('AllSpacesPage header', () => {
  it.each([
    [true, 'phone'],
    [false, 'desktop'],
  ])('puts New space on the filter row only on a phone (%s, %s)', async (isMobile) => {
    shell.isMobile = isMobile;
    stubFetch();
    renderPage();
    const add = await screen.findByRole('button', { name: 'New space' });
    const filter = screen.getByText('Active');
    const row = sharedAncestor(add, filter);
    // Phone: one row holding the title, the filter and the action. Desktop: the
    // title row and the filter row sit apart, so the shared parent holds just those two.
    expect(row.children.length).toBe(isMobile ? 3 : 2);
    shell.isMobile = false;
  });
});

describe('AllSpacesPage', () => {
  it('lists every space by last activity, with who it is for, who is in it and what is in it', async () => {
    stubFetch();
    renderPage();
    const list = await screen.findByRole('list', { name: 'Spaces' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByRole('button', { name: /^(Jam|Home|Private)/ }).textContent)).toEqual([
      expect.stringContaining('Jam'),
      expect.stringContaining('Home'),
      expect.stringContaining('Private'),
    ]);
    expect(within(list).getByText('Shared · 2 people · 3 threads')).toBeTruthy();
    expect(within(list).getByText('Just you')).toBeTruthy();
    expect(within(rows[1]).getByText('2')).toBeTruthy();
  });

  it('opens a space from its row', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /^Home/ }));
    expect(window.location.pathname).toBe('/spaces/s1/conversations');
  });

  it('filters to Archived, loading archived spaces only then, and restores with a Toast', async () => {
    const fetchMock = stubFetch({
      'PATCH /api/spaces/s9': () => json({ ...ARCHIVED, archived_at: null }),
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('list', { name: 'Spaces' });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('archived=true'))).toBe(false);
    await user.click(screen.getByRole('radio', { name: 'Archived' }));
    const list = await screen.findByRole('list', { name: 'Archived spaces' });
    expect(within(list).getByText('Old flat')).toBeTruthy();
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    await user.click(within(list).getByRole('button', { name: 'Actions for Old flat' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Archived spaces' })).toBeNull());
    expect((await screen.findAllByText('Restored Old flat')).length).toBeGreaterThan(0);
    expect(screen.getByText('No archived spaces')).toBeTruthy();
  });

  it('shows Retry when the spaces cannot be loaded', async () => {
    stubFetch({ 'GET /api/spaces': () => json({}, 500) });
    renderPage();
    expect(await screen.findByText("Couldn't load your spaces.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('opens New space from the header and from the empty state', async () => {
    stubFetch({ 'GET /api/spaces': () => json({ spaces: [] }) });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('No spaces yet')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'New space' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy();
  });

  it('creates a space from its name and opens it', async () => {
    let created = false;
    const fetchMock = stubFetch({
      'GET /api/spaces': () => json({ spaces: created ? [JAM] : [] }),
      'POST /api/spaces': () => {
        created = true;
        return json(JAM, 201);
      },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole('button', { name: 'New space' }))[0]);
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Jam');
    await user.click(screen.getByRole('button', { name: 'Create space' }));
    await waitFor(() => expect(window.location.pathname).toBe('/spaces/s2/conversations'));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ name: 'Jam' });
  });
});

describe('All spaces helpers', () => {
  it('orders by the newest activity, falling back to updated_at', () => {
    const rows = byActivity([
      { ...base, id: 'a', kind: 'group', name: 'A', updated_at: 50 },
      { ...base, id: 'b', kind: 'group', name: 'B', last_activity_at: 10 },
    ] as never[]);
    expect(rows.map((row: { id: string }) => row.id)).toEqual(['a', 'b']);
  });

  it('describes a one-person shared space without a thread count', () => {
    expect(spaceRowDescription({ ...base, id: 'x', kind: 'group', name: 'X', members: [member('Sam')] } as never)).toBe('Shared · 1 person');
  });
});

// Mockup 14: on a phone each space is one compact row of title, muted
// subtitle and trailing time, with no member avatars competing for the line.
describe('AllSpacesPage rows on a phone', () => {
  afterEach(() => {
    shell.isMobile = false;
  });

  it('drops the member avatars from the rows on a phone, and keeps them on desktop', async () => {
    shell.isMobile = true;
    stubFetch();
    renderPage();
    const phoneList = await screen.findByRole('list', { name: 'Spaces' });
    expect(within(phoneList).queryByRole('group', { name: 'Avatars' })).toBeNull();
    expect(within(phoneList).getByText('Shared · 2 people · 3 threads')).toBeTruthy();
    cleanup();
    shell.isMobile = false;
    renderPage();
    const desktopList = await screen.findByRole('list', { name: 'Spaces' });
    expect(within(desktopList).getAllByRole('group', { name: 'Avatars' }).length).toBeGreaterThan(0);
  });
});
