import { act, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { SpacesProvider } from '@/features/spaces/use-spaces';
import { navigateTo } from '../../app/routes';
import { COMPOSER_PLACEHOLDER } from '@/features/chat/composer';
import { clearDraft } from '@/features/chat/drafts';
import { SpacesPage } from './spaces-page';

// Phone is Astryx's mobile breakpoint; jsdom has no layout, so the test sets it.
const shell = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (original) => {
  const actual = await original<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ ...actual.useAppShellMobile(), isMobile: shell.isMobile }) };
});
// jsdom loads no StyleX, so stand in a marker for VisuallyHidden.
vi.mock('@astryxdesign/core/VisuallyHidden', () => ({
  VisuallyHidden: ({ children }: { children: ReactNode }) => <div data-testid="visually-hidden">{children}</div>,
}));

// Captures every LayoutContent's props so a test can read the section
// content's own padding/isScrollable (#899): jsdom computes no layout, so a
// second scroll container nested inside this one is only visible through the
// props, not pixels.
const layoutContentProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@astryxdesign/core/Layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/Layout')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    LayoutContent: (props: Parameters<typeof actual.LayoutContent>[0]) => {
      layoutContentProps.push(props as Record<string, unknown>);
      return createElement(actual.LayoutContent, props);
    },
  };
});

// Records the props the Tasks and Notes tabs receive, so a test can see the
// ?task= / ?note= target reach them (the panels themselves are tasks-notes').
const panelProps = vi.hoisted(() => ({ tasks: [] as Array<Record<string, unknown>>, notes: [] as Array<Record<string, unknown>> }));
vi.mock('../productivity/tasks-panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../productivity/tasks-panel')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    TasksPanel: (props: Parameters<typeof actual.TasksPanel>[0]) => {
      panelProps.tasks.push(props as Record<string, unknown>);
      return createElement(actual.TasksPanel, props);
    },
  };
});
vi.mock('../productivity/notes-panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../productivity/notes-panel')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    NotesPanel: (props: Parameters<typeof actual.NotesPanel>[0]) => {
      panelProps.notes.push(props as Record<string, unknown>);
      return createElement(actual.NotesPanel, props);
    },
  };
});

// The page and its panels read the caller's id from the session; fetchWithAuth
// is the plain global fetch so the tests stub the network in one place.
vi.mock('@/lib/auth/use-session', () => ({
  useSession: () => ({ session: { user: { id: 'u-self' } } }),
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

const SPACE = {
  id: 's1',
  kind: 'group',
  name: 'Home',
  role: 'owner',
  membership_revision: 1,
  created_at: 0,
  updated_at: 0,
};

// Riley's id is UUID-shaped on purpose: it is what the owner's "why names
// are not rendered :(" bug report showed truncated to "cbf063e2…". Messages
// now resolve author names through memberDisplayName, so this id should
// never reach the screen.
const RILEY_ID = 'cbf063e2-51e6-4c9a-9c31-1a2b3c4d5e6f';

const MEMBERS = [
  { user_id: 'u-self', role: 'owner', joined_at: 1, display_name: 'Sam', handle: 'sam', email: null },
  { user_id: RILEY_ID, role: 'member', joined_at: 2, display_name: 'Riley', handle: 'riley', email: null },
];

const THREAD = {
  id: 't1',
  space_id: 's1',
  title: 'Groceries',
  created_by: 'u-self',
  archived_at: null,
  last_sequence: 2,
  unread_count: 2,
  created_at: 0,
  updated_at: 0,
};

function threadMessage(id: string, author: string | null, body: string): Record<string, unknown> {
  return {
    id,
    thread_id: 't1',
    space_id: 's1',
    author_user_id: author,
    body,
    reply_to_message_id: null,
    sequence: 1,
    client_message_id: `c-${id}`,
    revision: 1,
    tombstoned_at: null,
    tombstoned_by: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

const MESSAGES = [
  threadMessage('m1', null, 'Milk is on the list, @sam'),
  threadMessage('m2', RILEY_ID, 'Thanks!'),
];

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Routes are keyed "METHOD /path" (no query string). Everything the page mounts
// has a default, so a test overrides only what it exercises; an unrouted call
// fails loudly.
function stubFetch(overrides: Record<string, Handler> = {}): ReturnType<typeof vi.fn> {
  const routes: Record<string, Handler> = {
    'GET /api/spaces': () => json({ spaces: [SPACE] }),
    'GET /api/spaces/s1/members': () => json({ members: MEMBERS }),
    'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
    'GET /api/spaces/s1/threads': () => json({ threads: [THREAD] }),
    'GET /api/spaces/s1/tasks': () => json({ tasks: [] }),
    'GET /api/spaces/s1/notes': () => json({ notes: [] }),
    'GET /api/agenda': () => json({ items: [] }),
    'GET /api/threads/t1/messages': () => json({ messages: MESSAGES, next_cursor: null }),
    'PUT /api/threads/t1/read': () => json({}),
    'GET /api/active': () => json({ active: null }),
    'GET /api/devices': () => json({ devices: [] }),
    ...overrides,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`;
    const route = routes[key];
    if (!route) throw new Error(`unrouted request: ${key}`);
    return route(init);
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

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <Theme theme={neutralTheme}>
      <QueryClientProvider client={client}>
        <SpacesProvider>
          <SpacesPage />
        </SpacesProvider>
      </QueryClientProvider>
    </Theme>,
  );
}

// Sets the starting URL (the page reads it on mount) and renders. The URL is
// the source of truth for the active space and section now, not localStorage.
function renderAt(path: string): void {
  window.history.replaceState(null, '', path);
  renderPage();
}

// Post-render navigation, mirroring a click in the rail or the header's tabs.
function goTo(path: string): void {
  act(() => navigateTo(path));
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/spaces');
});

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
  cleanup();
  vi.unstubAllGlobals();
  // Drafts are kept per thread (module memory), so one test's text must not reach the next.
  clearDraft('t1');
});

describe('SpacesPage spaces', () => {
  it('shows loading rows while spaces load, then the space', async () => {
    stubFetch();
    renderAt('/spaces/s1');
    expect(screen.getByRole('status', { name: 'Loading spaces' })).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
  });

  it('shows an error with Retry when the spaces cannot be loaded', async () => {
    let fail = true;
    stubFetch({ 'GET /api/spaces': () => (fail ? json({}, 500) : json({ spaces: [SPACE] })) });
    const user = userEvent.setup();
    renderAt('/spaces/s1');
    expect(await screen.findByText("Couldn't load your spaces.")).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
  });
});

describe('SpacesPage routing', () => {
  // P1: no auto-jump into the latest thread; the Threads tab is a list.
  it('opens "/spaces/s1" on its thread list without redirecting into a thread', async () => {
    stubFetch();
    const replaceState = vi.spyOn(window.history, 'replaceState');
    renderAt('/spaces/s1');
    const list = await screen.findByRole('list', { name: 'Threads' });
    expect(within(list).getByText('Groceries')).toBeTruthy();
    expect(window.location.pathname).toBe('/spaces/s1');
    expect(replaceState).toHaveBeenCalledTimes(1); // renderAt's own
    expect(screen.getByRole('button', { name: 'Threads' }).getAttribute('aria-current')).toBe('true');
    replaceState.mockRestore();
  });

  it('invites the first thread instead when the space has none yet', async () => {
    stubFetch({ 'GET /api/spaces/s1/threads': () => json({ threads: [] }) });
    renderAt('/spaces/s1');
    expect(await screen.findByText("Start this space's first thread")).toBeTruthy();
    expect(window.location.pathname).toBe('/spaces/s1');
    expect(screen.getByRole('button', { name: 'Threads' }).getAttribute('aria-current')).toBe('true');
  });

  it('shows the create-thread form at "/spaces/s1/threads/new" even when the space has threads', async () => {
    stubFetch();
    renderAt('/spaces/s1/threads/new');
    expect(await screen.findByRole('textbox', { name: 'New thread title' })).toBeTruthy();
    // The landing redirect leaves it alone.
    expect(window.location.pathname).toBe('/spaces/s1/threads/new');
  });

  it('opens a thread named by the URL, e.g. "/spaces/s1/threads/t1"', async () => {
    stubFetch();
    renderAt('/spaces/s1/threads/t1');
    expect(await screen.findByRole('button', { name: 'Thread actions for Groceries' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Thread messages' })).toBeTruthy();
  });

  it('renders only the tasks panel at "/spaces/s1/tasks"', async () => {
    stubFetch();
    renderAt('/spaces/s1/tasks');
    expect(await screen.findByRole('region', { name: 'Tasks' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Notes' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Agenda' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Members' })).toBeNull();
  });

  it('renders only the notes panel at "/spaces/s1/notes"', async () => {
    stubFetch();
    renderAt('/spaces/s1/notes');
    expect(await screen.findByRole('region', { name: 'Notes' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Tasks' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Members' })).toBeNull();
  });

  it('renders only the members panel at "/spaces/s1/members"', async () => {
    stubFetch();
    renderAt('/spaces/s1/members');
    expect(await screen.findByRole('region', { name: 'Members' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Tasks' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Notes' })).toBeNull();
  });

  it('switches sections when the header tabs are clicked', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderAt('/spaces/s1');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    await user.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(await screen.findByRole('region', { name: 'Tasks' })).toBeTruthy();
    expect(window.location.pathname).toBe('/spaces/s1/tasks');
  });

  it("shows that a space isn't available for an unknown space id", async () => {
    stubFetch();
    const pushState = vi.spyOn(window.history, 'pushState');
    const user = userEvent.setup();
    renderAt('/spaces/nope');
    expect(await screen.findByText("That space isn't available.")).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'All spaces' }));
    expect(pushState).toHaveBeenCalledWith(null, '', '/spaces');
    pushState.mockRestore();
  });

  it('switches the active space when the URL changes to a different space', async () => {
    const other = { ...SPACE, id: 's2', kind: 'pair', name: 'Us two' };
    const fetchMock = stubFetch({
      'GET /api/spaces': () => json({ spaces: [SPACE, other] }),
      'GET /api/spaces/s2/members': () => json({ members: [MEMBERS[0]] }),
      'GET /api/spaces/s2/invitations': () => json({ invitations: [] }),
      'GET /api/spaces/s2/threads': () => json({ threads: [] }),
      'GET /api/spaces/s2/tasks': () => json({ tasks: [] }),
      'GET /api/spaces/s2/notes': () => json({ notes: [] }),
    });
    renderAt('/spaces/s1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    goTo('/spaces/s2');
    expect(await screen.findByRole('heading', { level: 1, name: 'Us two' })).toBeTruthy();
    expect(await screen.findByText("Start this space's first thread")).toBeTruthy();
    expect(callsTo(fetchMock, 'GET', '/api/spaces/s2/threads')).toHaveLength(1);
  });
});

// Private is just you: its conversations are your personal chats (the rail's
// Chats), so it has no Threads or Members tab and never asks for threads.
describe('SpacesPage phone thread header', () => {
  beforeEach(() => {
    shell.isMobile = true;
  });
  afterEach(() => {
    shell.isMobile = false;
  });

  it('collapses the space header and tabs, leaving the thread header as the only visible header', async () => {
    stubFetch();
    renderAt('/spaces/s1/threads/t1');
    await screen.findByRole('region', { name: 'Thread messages' });
    // The page keeps one h1 for assistive tech, visually hidden on a phone.
    const title = screen.getByRole('heading', { level: 1, name: 'Home' });
    expect(title.closest('[data-testid="visually-hidden"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Tasks' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tools' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to threads' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Thread actions for Groceries' })).toBeTruthy();
  });

  it('keeps Tools in the one thread menu; the device has its own row (#1349)', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderAt('/spaces/s1/threads/t1');
    await user.click(await screen.findByRole('button', { name: 'Thread actions for Groceries' }));
    expect(await screen.findByRole('menuitem', { name: 'Tools' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Use on device' })).toBeNull();
  });
});

describe('SpacesPage private space', () => {
  const PRIVATE = { ...SPACE, id: 'p1', kind: 'private', name: 'Private' };

  it('opens on Tasks, shows neither Threads nor Members, and fetches no threads', async () => {
    const fetchMock = stubFetch({
      'GET /api/spaces': () => json({ spaces: [PRIVATE, SPACE] }),
      'GET /api/spaces/p1/members': () => json({ members: [MEMBERS[0]] }),
      'GET /api/spaces/p1/tasks': () => json({ tasks: [] }),
    });
    renderAt('/spaces/p1/threads');
    expect(await screen.findByRole('region', { name: 'Tasks' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Threads' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Members' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Private' })).toBeTruthy();
    expect(callsTo(fetchMock, 'GET', '/api/spaces/p1/threads')).toHaveLength(0);
  });
});

describe('SpacesPage threads', () => {
  it('creates a thread from the empty-state form and opens it', async () => {
    const fetchMock = stubFetch({
      'GET /api/spaces/s1/threads': () => json({ threads: [] }),
      'POST /api/spaces/s1/threads': () => json({ ...THREAD, id: 't2', title: 'Trip', unread_count: 0 }, 201),
    });
    const user = userEvent.setup();
    renderAt('/spaces/s1');
    const input = await screen.findByRole('textbox', { name: 'New thread title' });
    await user.type(input, 'Trip');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const [, init] = callsTo(fetchMock, 'POST', '/api/spaces/s1/threads')[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Trip' });
    // The new thread opens.
    expect(await screen.findByRole('button', { name: 'Thread actions for Trip' })).toBeTruthy();
    expect(window.location.pathname).toBe('/spaces/s1/conversations/t2');
  });

  it('creates a thread when Enter is pressed in the title input', async () => {
    const fetchMock = stubFetch({
      'GET /api/spaces/s1/threads': () => json({ threads: [] }),
      'POST /api/spaces/s1/threads': () => json({ ...THREAD, id: 't2', title: 'Packing', unread_count: 0 }, 201),
    });
    const user = userEvent.setup();
    renderAt('/spaces/s1');
    const input = await screen.findByRole('textbox', { name: 'New thread title' });
    await user.type(input, 'Packing');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/spaces/s1/threads')).toHaveLength(1));
  });

  it('reports a failed thread create', async () => {
    stubFetch({
      'GET /api/spaces/s1/threads': () => json({ threads: [] }),
      'POST /api/spaces/s1/threads': () => json({}, 500),
    });
    const user = userEvent.setup();
    renderAt('/spaces/s1');
    const input = await screen.findByRole('textbox', { name: 'New thread title' });
    await user.type(input, 'Trip');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    // Astryx also echoes an alert into its shared live region, so match the form's own.
    const alerts = await screen.findAllByText('That could not be created.');
    expect(alerts.some((alert) => alert.closest('[role="alert"]') !== null)).toBe(true);
  });
});

describe('SpacesPage thread messages', () => {
  // Was "renders Bob, a shortened author id and highlighted mentions...":
  // the shortened-id fallback was the bug the owner reported ("why names are
  // not rendered :(" against a thread showing "cbf063e2…"). Messages now
  // resolve authors through memberDisplayName, so this proves the member's
  // NAME shows and the raw id never reaches the screen — not the old
  // shortening behaviour.
  it('renders Bob and each member by name, highlights mentions, and marks the thread read', async () => {
    const fetchMock = stubFetch();
    renderAt('/spaces/s1/threads/t1');
    const region = await screen.findByRole('region', { name: 'Thread messages' });
    // Each message's Avatar (tooltip) and ChatMessageBubble both render the
    // author's name, so this asserts presence rather than a single match.
    expect((await within(region).findAllByText('Bob')).length).toBeGreaterThan(0);
    expect(within(region).getAllByText('Riley').length).toBeGreaterThan(0);
    expect(region.textContent).not.toContain('cbf063e2');
    expect(within(region).getByText('Thanks!')).toBeTruthy();
    expect(region.textContent).toContain('Milk is on the list,');
    // A mention is lifted out of the text into its own highlighted element.
    expect(within(region).getAllByText('@sam').length).toBeGreaterThan(0);
    // Each message carries its own Astryx Timestamp. Its exact wording is the
    // design system's ("now", "12 seconds ago" ...) and depends on how long
    // the render took, so the assertion counts the timestamps instead.
    expect(region.querySelectorAll('.astryx-timestamp')).toHaveLength(2);
    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/threads/t1/read')).toHaveLength(1));
  });

  // #899: iPhone Safari showed the composer floating mid-screen above the
  // keyboard, blurred by ChatLayout's dock. Root cause was a scrollable,
  // padded LayoutContent wrapping ChatLayout's own scroller/dock, so the
  // keyboard-driven scroll moved the outer box while the dock stayed pinned
  // inside the inner one. The fix is the same one main chat already uses
  // (chat-surface.tsx): the section's LayoutContent is full bleed and not a
  // scroll container of its own, so ChatLayout is the thread's only scroller.
  it('renders the open thread full bleed and non-scrolling, so ChatLayout is the only scroller', async () => {
    stubFetch();
    renderAt('/spaces/s1/threads/t1');
    await screen.findByRole('region', { name: 'Thread messages' });
    const sectionContent = layoutContentProps.at(-1);
    expect(sectionContent?.padding).toBe(0);
    expect(sectionContent?.isScrollable).toBe(false);
  });

  it('shows a neutral error when the messages cannot be loaded', async () => {
    stubFetch({ 'GET /api/threads/t1/messages': () => json({}, 500) });
    renderAt('/spaces/s1/threads/t1');
    expect(await screen.findByText('Messages could not be loaded.')).toBeTruthy();
  });
});

// The thread list lives in the rail now, not this page, so a composer test
// opens the thread directly by URL rather than clicking it in a list.
async function openGroceries(): Promise<HTMLElement> {
  renderAt('/spaces/s1/threads/t1');
  // With @ triggers configured Astryx exposes the editor as a combobox.
  return screen.findByRole('combobox', { name: 'Message' });
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = callsTo(fetchMock, 'POST', '/api/threads/t1/messages')[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('SpacesPage thread composer', () => {
  // P0: the thread composer is main chat's: default placeholder, no audience line.
  it('names the message box with the default placeholder and no audience line', async () => {
    stubFetch();
    await openGroceries();
    expect(screen.getByText(COMPOSER_PLACEHOLDER)).toBeTruthy();
    expect(screen.queryByText(/Posting to/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Voice mode' })).toBeTruthy();
  });

  it('posts the draft, shows it in the thread and clears the box', async () => {
    const fetchMock = stubFetch({
      'POST /api/threads/t1/messages': (init) =>
        json(threadMessage('m3', 'u-self', (JSON.parse(init?.body as string) as { body: string }).body), 201),
    });
    const user = userEvent.setup();
    const box = await openGroceries();
    await user.click(box);
    await user.keyboard('Buy oat milk{Enter}');
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/threads/t1/messages')).toHaveLength(1));
    expect(postedBody(fetchMock).body).toBe('Buy oat milk');
    expect(String(postedBody(fetchMock).client_message_id)).toMatch(/^web-/);
    expect(await screen.findByText('Buy oat milk')).toBeTruthy();
    await waitFor(() => expect(box.textContent).toBe(''));
  });

  it('keeps the draft and says so when the post fails', async () => {
    const fetchMock = stubFetch({ 'POST /api/threads/t1/messages': () => json({}, 500) });
    const user = userEvent.setup();
    const box = await openGroceries();
    await user.click(box);
    await user.keyboard('Buy oat milk{Enter}');
    expect(await screen.findByText('Your message could not be posted.')).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', '/api/threads/t1/messages')).toHaveLength(1);
    expect(box.textContent).toContain('Buy oat milk');
  });

  it('offers the members and an Bob entry after @', async () => {
    stubFetch();
    const user = userEvent.setup();
    const box = await openGroceries();
    await user.click(box);
    await user.keyboard('@');
    expect(await screen.findByRole('option', { name: /Bob/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Riley/ })).toBeTruthy();
  });

  it('inserts @bob when the Bob entry is picked', async () => {
    const fetchMock = stubFetch({
      'POST /api/threads/t1/messages': () => json(threadMessage('m3', 'u-self', '@bob hi'), 201),
    });
    const user = userEvent.setup();
    const box = await openGroceries();
    await user.click(box);
    await user.keyboard('@');
    await user.click(await screen.findByRole('option', { name: /Bob/ }));
    await user.keyboard('hi{Enter}');
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/threads/t1/messages')).toHaveLength(1));
    expect(String(postedBody(fetchMock).body)).toMatch(/^@bob\s+hi$/);
  });
});

describe('SpacesPage members', () => {
  it('puts "Invite people" inside the members panel, once', async () => {
    stubFetch();
    renderAt('/spaces/s1/members');
    const panel = await screen.findByRole('region', { name: 'Members' });
    expect(await within(panel).findByRole('button', { name: 'Invite people' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Invite people' })).toHaveLength(1);
  });
});

describe('SpacesPage leave and archive', () => {
  const MEMBER_SPACE = { ...SPACE, role: 'member' };

  // P0: leaving is confirmed by name, then lands on All spaces.
  it('asks before leaving, naming the space, then leaves and goes to /spaces', async () => {
    let left = false;
    const fetchMock = stubFetch({
      'GET /api/spaces': () => json({ spaces: left ? [] : [MEMBER_SPACE] }),
      'DELETE /api/spaces/s1/members/u-self': () => {
        left = true;
        return new Response(null, { status: 204 });
      },
    });
    const user = userEvent.setup();
    renderAt('/spaces/s1/tasks');
    await user.click(await screen.findByRole('button', { name: 'Space actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Leave space' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave Home?' });
    expect(callsTo(fetchMock, 'DELETE', '/api/spaces/s1/members/u-self')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Leave space' }));
    await waitFor(() => expect(callsTo(fetchMock, 'DELETE', '/api/spaces/s1/members/u-self')).toHaveLength(1));
    await waitFor(() => expect(window.location.pathname).toBe('/spaces'));
  });

  it('cancelling the leave dialog sends nothing', async () => {
    const fetchMock = stubFetch({ 'GET /api/spaces': () => json({ spaces: [MEMBER_SPACE] }) });
    const user = userEvent.setup();
    renderAt('/spaces/s1/tasks');
    await user.click(await screen.findByRole('button', { name: 'Space actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Leave space' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave Home?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  // P1: archive is reversible: no type-to-confirm, archive at once with Undo.
  it('archives at once without a dialog, goes to /spaces and offers Undo', async () => {
    let archived = false;
    const fetchMock = stubFetch({
      'GET /api/spaces': () => json({ spaces: archived ? [] : [SPACE] }),
      'DELETE /api/spaces/s1': () => {
        archived = true;
        return json({ ...SPACE, archived_at: Date.now() });
      },
      'PATCH /api/spaces/s1': () => {
        archived = false;
        return json(SPACE);
      },
    });
    const user = userEvent.setup();
    renderAt('/spaces/s1/tasks');
    await user.click(await screen.findByRole('button', { name: 'Space actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    await waitFor(() => expect(callsTo(fetchMock, 'DELETE', '/api/spaces/s1')).toHaveLength(1));
    await waitFor(() => expect(window.location.pathname).toBe('/spaces'));
    expect((await screen.findAllByText('Archived Home')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Undo', hidden: true }));
    await waitFor(() => expect(callsTo(fetchMock, 'PATCH', '/api/spaces/s1')).toHaveLength(1));
    const [, init] = callsTo(fetchMock, 'PATCH', '/api/spaces/s1')[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ archived: false });
  });

  it('archives once for a double click on Archive', async () => {
    let archived = false;
    const fetchMock = stubFetch({
      'GET /api/spaces': () => json({ spaces: archived ? [] : [SPACE] }),
      'DELETE /api/spaces/s1': () => {
        archived = true;
        return json({ ...SPACE, archived_at: Date.now() });
      },
    });
    const user = userEvent.setup();
    renderAt('/spaces/s1/tasks');
    await user.click(await screen.findByRole('button', { name: 'Space actions' }));
    await user.dblClick(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(window.location.pathname).toBe('/spaces'));
    expect(callsTo(fetchMock, 'DELETE', '/api/spaces/s1')).toHaveLength(1);
  });

  it('passes ?task= to the Tasks tab as the task to focus', async () => {
    stubFetch();
    renderAt('/spaces/s1/tasks?task=task_9');
    expect(await screen.findByRole('region', { name: 'Tasks' })).toBeTruthy();
    expect(panelProps.tasks.at(-1)?.focusTaskId).toBe('task_9');
  });

  it('passes ?note= to the Notes tab as the note to focus, and null without it', async () => {
    stubFetch();
    renderAt('/spaces/s1/notes?note=note_7');
    expect(await screen.findByRole('region', { name: 'Notes' })).toBeTruthy();
    expect(panelProps.notes.at(-1)?.focusNoteId).toBe('note_7');
    cleanup();
    renderAt('/spaces/s1/notes');
    expect(await screen.findByRole('region', { name: 'Notes' })).toBeTruthy();
    expect(panelProps.notes.at(-1)?.focusNoteId).toBeNull();
  });
});

// A create that stays pending until the test releases it, so a second submit
// arrives while the first is still in flight.
function pendingResponse(): { handler: Handler; release: (response: Response) => void } {
  let release: (response: Response) => void = () => undefined;
  const handler: Handler = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  return { handler, release: (response) => release(response) };
}

function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true';
}

describe('SpacesPage double submits', () => {
  it('creates one thread for two rapid Enter presses', async () => {
    const pending = pendingResponse();
    const fetchMock = stubFetch({
      'GET /api/spaces/s1/threads': () => json({ threads: [] }),
      'POST /api/spaces/s1/threads': pending.handler,
    });
    const user = userEvent.setup();
    renderAt('/spaces/s1');
    const input = await screen.findByRole('textbox', { name: 'New thread title' });
    await user.type(input, 'Trip');
    await user.keyboard('{Enter}{Enter}');
    expect(callsTo(fetchMock, 'POST', '/api/spaces/s1/threads')).toHaveLength(1);
    expect(isDisabled(screen.getByRole('button', { name: 'Create' }))).toBe(true);
    pending.release(json({ ...THREAD, id: 't2', title: 'Trip', unread_count: 0 }, 201));
    expect(await screen.findByRole('button', { name: 'Thread actions for Trip' })).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', '/api/spaces/s1/threads')).toHaveLength(1);
  });
});
