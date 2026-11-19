import { useState, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import type { Space } from '@/features/spaces/use-spaces';
import { useThreads } from '@/features/spaces/use-threads';
import { NEW_THREAD } from '../../app/routes';

// DeviceHeaderControl renders only with a paired device (devices domain):
// one ready, online device here, as the account the tests stand in for.
vi.mock('@/features/devices/use-devices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/devices/use-devices')>();
  return {
    ...actual,
    useDevices: () => ({
      state: 'ready',
      devices: [{ id: 'd1', name: 'device', online: true, last_seen_at: Date.now() }],
      activeSpace: null,
      activeConversation: null,
      loads: 1,
      refresh: async () => undefined,
    }),
    refreshDevices: async () => undefined,
  };
});
import { clearDraft } from '@/features/chat/drafts';
import { ThreadPanel, ThreadTitleBar } from './thread-panel';

// Phone is Astryx's mobile breakpoint; jsdom has no layout, so the test sets it.
const shell = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (original) => {
  const actual = await original<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ ...actual.useAppShellMobile(), isMobile: shell.isMobile }) };
});

// The panel reads the caller's id from the session; fetchWithAuth is the plain
// global fetch so the tests stub the network in one place.
vi.mock('@/lib/auth/use-session', () => ({
  useSession: () => ({ session: { user: { id: 'u-self' } } }),
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

const MEMBERS = [
  { user_id: 'u-self', role: 'owner', joined_at: 1, display_name: 'Sam', handle: 'sam', email: null },
  { user_id: 'u-riley', role: 'member', joined_at: 2, display_name: 'Riley', handle: 'riley', email: null },
];

const SPACE: Space = {
  id: 's1',
  kind: 'group',
  name: 'Home',
  role: 'owner',
  membership_revision: 1,
  created_at: 0,
  updated_at: 0,
  members: MEMBERS,
};

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

const TOMBSTONED_MESSAGE = {
  ...threadMessage('m3', 'u-riley-0123456789', ''),
  tombstoned_at: 1756100000000,
  tombstoned_by: 'u-riley-0123456789',
};

const EDITED_MESSAGE = { ...threadMessage('m4', 'u-riley-0123456789', 'On it!'), revision: 2 };

const OWN_MESSAGE = threadMessage('m5', 'u-self', 'Buy milk');

const MESSAGES = [
  threadMessage('m1', null, 'Milk is on the list, @sam'),
  threadMessage('m2', 'u-riley-0123456789', 'Thanks!'),
  TOMBSTONED_MESSAGE,
  EDITED_MESSAGE,
  OWN_MESSAGE,
];

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Routes are keyed "METHOD /path" (no query string). Everything the panel
// mounts has a default, so a test overrides only what it exercises; an
// unrouted call fails loudly.
function stubFetch(overrides: Record<string, Handler> = {}): ReturnType<typeof vi.fn> {
  const routes: Record<string, Handler> = {
    'GET /api/spaces/s1/threads': () => json({ threads: [THREAD] }),
    'GET /api/threads/t1/messages': () => json({ messages: MESSAGES, next_cursor: null }),
    'PUT /api/threads/t1/read': () => json({}),
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

// The panel does not own which thread is open, and the open thread's title bar
// lives in the space header; this harness stands in for SpacesPage, driving
// openThreadId and rendering ThreadTitleBar the same way it does.
function Harness({
  space = SPACE,
  initialOpenThreadId = null,
  onOpenThreadSpy,
}: {
  space?: Space;
  initialOpenThreadId?: string | null;
  onOpenThreadSpy?: (id: string | null) => void;
}): ReactElement {
  const [openThreadId, setOpenThreadId] = useState<string | null>(initialOpenThreadId);
  const threads = useThreads(space.id);
  const open = threads.threads.find((thread) => thread.id === openThreadId) ?? null;
  const openThread = (id: string | null): void => {
    onOpenThreadSpy?.(id);
    setOpenThreadId(id);
  };
  return (
    <>
      {open !== null && (
        <ThreadTitleBar
          space={space}
          thread={open}
          threads={threads}
          onNewThread={() => openThread(NEW_THREAD)}
          onArchived={() => openThread(null)}
          onBack={() => openThread(null)}
        />
      )}
      <ThreadPanel space={space} openThreadId={openThreadId} onOpenThread={openThread} />
    </>
  );
}

function renderPanel(
  options: {
    space?: Space;
    initialOpenThreadId?: string | null;
    onOpenThreadSpy?: (id: string | null) => void;
  } = {},
): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <Theme theme={neutralTheme}>
      <QueryClientProvider client={client}>
        <Harness {...options} />
      </QueryClientProvider>
    </Theme>,
  );
}

afterEach(() => {
  clearDraft('t1');
  cleanup();
  vi.unstubAllGlobals();
});

beforeAll(() => {
  // jsdom has no modal <dialog>; the Astryx alert dialog calls showModal() on open.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

describe('ThreadPanel', () => {
  it("shows an open thread's messages and the composer", async () => {
    const fetchMock = stubFetch();
    renderPanel({ initialOpenThreadId: THREAD.id });
    const region = await screen.findByRole('region', { name: 'Thread messages' });
    expect(within(region).getByText('Thanks!')).toBeTruthy();
    expect(within(region).getByRole('combobox', { name: 'Message' })).toBeTruthy();
    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/threads/t1/read')).toHaveLength(1));
  });

  it('invites the first thread when the space genuinely has none', async () => {
    stubFetch({ 'GET /api/spaces/s1/threads': () => json({ threads: [] }) });
    renderPanel();
    expect(await screen.findByText("Start this space's first thread")).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'New thread title' })).toBeTruthy();
  });

  it('closes the create form back to a plain invitation, and reopens it', async () => {
    stubFetch({ 'GET /api/spaces/s1/threads': () => json({ threads: [] }) });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Start this space's first thread");
    await user.click(screen.getByRole('button', { name: 'Cancel new thread' }));
    expect(screen.queryByRole('textbox', { name: 'New thread title' })).toBeNull();
    const reopen = screen.getByRole('button', { name: 'Start a thread' });
    await user.click(reopen);
    expect(screen.getByRole('textbox', { name: 'New thread title' })).toBeTruthy();
  });

  // The Threads tab with none open is the list: unread counts, one menu per row.
  it('lists the threads with their unread count, each opening its thread', async () => {
    stubFetch({
      'GET /api/spaces/s1/threads': () => json({ threads: [{ ...THREAD, unread_count: 4 }] }),
    });
    const onOpenThreadSpy = vi.fn();
    const user = userEvent.setup();
    renderPanel({ onOpenThreadSpy });
    const list = await screen.findByRole('list', { name: 'Threads' });
    expect(within(list).getByText('Groceries')).toBeTruthy();
    expect(within(list).getByText('4')).toBeTruthy();
    expect(screen.queryByText("Start this space's first thread")).toBeNull();
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    await user.click(within(list).getByText('Groceries'));
    expect(onOpenThreadSpy).toHaveBeenCalledWith('t1');
  });

  // CI #1243: a row-menu item (rendered in a portal) must not also open the row.
  it('choosing a row-menu item does not open the thread', async () => {
    stubFetch({
      'GET /api/active': () => json({ active: null }),
      'PUT /api/devices/active-conversation': () => json({}),
    });
    const onOpenThreadSpy = vi.fn();
    const user = userEvent.setup();
    renderPanel({ onOpenThreadSpy });
    await user.click(await screen.findByRole('button', { name: 'Thread actions for Groceries' }));
    await user.click(await screen.findByRole('menuitem', { name: /^Use on/ }));
    expect(screen.getByRole('list', { name: 'Threads' })).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Thread actions for Groceries' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    expect(onOpenThreadSpy).not.toHaveBeenCalled();
  });

  it('offers New thread from the list', async () => {
    stubFetch();
    const onOpenThreadSpy = vi.fn();
    const user = userEvent.setup();
    renderPanel({ onOpenThreadSpy });
    await user.click(await screen.findByRole('button', { name: 'New thread' }));
    expect(onOpenThreadSpy).toHaveBeenCalledWith(NEW_THREAD);
  });

  it('shows Retry when the threads cannot be loaded', async () => {
    stubFetch({ 'GET /api/spaces/s1/threads': () => json({ error: 'boom' }, 500) });
    renderPanel();
    expect(await screen.findByText("Threads couldn't be loaded.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it("shows that the thread isn't available for an unknown openThreadId", async () => {
    stubFetch();
    renderPanel({ initialOpenThreadId: 'missing-thread' });
    expect(await screen.findByText("That thread isn't available.")).toBeTruthy();
  });

  it('shows the open thread instead of the list', async () => {
    stubFetch();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await screen.findByRole('region', { name: 'Thread messages' });
    expect(screen.queryByRole('list', { name: 'Threads' })).toBeNull();
  });
});

async function openComposer(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const region = await screen.findByRole('region', { name: 'Thread messages' });
  const box = within(region).getByRole('combobox', { name: 'Message' });
  await user.click(box);
  return box;
}

async function pickBob(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.keyboard('@');
  await user.click(await screen.findByRole('option', { name: /Bob/ }));
}

describe('ThreadPanel asking Bob', () => {
  it('asks Bob for an @bob message, shows thinking, then the reply', async () => {
    let releaseInvocation!: (response: Response) => void;
    const invocationPromise = new Promise<Response>((resolve) => { releaseInvocation = resolve; });
    let invocationBody: unknown = null;
    const messages = [...MESSAGES];
    const fetchMock = stubFetch({
      'POST /api/threads/t1/messages': () => json(threadMessage('m3', 'u-self', '@bob add milk'), 201),
      'POST /api/threads/t1/invocations': (init) => {
        invocationBody = init?.body ? JSON.parse(String(init.body)) : null;
        return invocationPromise;
      },
      'GET /api/invocations/i1': () =>
        json({ id: 'i1', thread_id: 't1', space_id: 's1', state: 'completed', result_message_id: 'm4', error_code: null }),
      'GET /api/threads/t1/messages': () => json({ messages, next_cursor: null }),
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await openComposer(user);
    await pickBob(user);
    await user.keyboard('add milk{Enter}');

    expect(await screen.findByText('Thinking…')).toBeTruthy();
    await waitFor(() => expect(invocationBody).toEqual({ trigger_message_id: 'm3' }));

    messages.push(threadMessage('m4', null, 'Milk added.'));
    releaseInvocation(json({ invocation_id: 'i1' }, 202));

    expect(await screen.findByText('Milk added.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Thinking…')).toBeNull());
    expect(callsTo(fetchMock, 'POST', '/api/threads/t1/invocations')).toHaveLength(1);
  });

  it('a plain message makes no invocation call', async () => {
    const fetchMock = stubFetch({
      'POST /api/threads/t1/messages': () => json(threadMessage('m3', 'u-self', 'Buy oat milk'), 201),
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    const box = await openComposer(user);
    await user.type(box, 'Buy oat milk{Enter}');
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/threads/t1/messages')).toHaveLength(1));
    expect(callsTo(fetchMock, 'POST', '/api/threads/t1/invocations')).toHaveLength(0);
  });

  it('says Bob is busy on a 409', async () => {
    stubFetch({
      'POST /api/threads/t1/messages': () => json(threadMessage('m3', 'u-self', '@bob add milk'), 201),
      'POST /api/threads/t1/invocations': () => json({ error: { code: 'conflict' } }, 409),
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await openComposer(user);
    await pickBob(user);
    await user.keyboard('add milk{Enter}');
    expect(
      await screen.findByText('Bob is already answering in this thread. Ask again when that reply lands.'),
    ).toBeTruthy();
  });

  it('shows an alert when the invocation failed', async () => {
    stubFetch({
      'POST /api/threads/t1/messages': () => json(threadMessage('m3', 'u-self', '@bob add milk'), 201),
      'POST /api/threads/t1/invocations': () => json({ invocation_id: 'i1' }, 202),
      'GET /api/invocations/i1': () =>
        json({ id: 'i1', thread_id: 't1', space_id: 's1', state: 'failed', result_message_id: null, error_code: 'model_error' }),
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await openComposer(user);
    await pickBob(user);
    await user.keyboard('add milk{Enter}');
    expect(await screen.findByText('Bob could not answer. Try asking again.')).toBeTruthy();
  });
});

describe('ThreadPanel new thread', () => {
  it('shows the create form for /threads/new even when the space has threads, then opens the new one', async () => {
    const created = { ...THREAD, id: 't2', title: 'Holiday' };
    stubFetch({
      'POST /api/spaces/s1/threads': () => json(created, 201),
      'GET /api/threads/t2/messages': () => json({ messages: [], next_cursor: null }),
    });
    const onOpenThreadSpy = vi.fn();
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: NEW_THREAD, onOpenThreadSpy });
    await user.type(await screen.findByRole('textbox', { name: 'New thread title' }), 'Holiday');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onOpenThreadSpy).toHaveBeenCalledWith('t2'));
  });

  it('Back on the open thread returns to the thread list', async () => {
    stubFetch();
    const onOpenThreadSpy = vi.fn();
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id, onOpenThreadSpy });
    await screen.findByRole('region', { name: 'Thread messages' });
    await user.click(screen.getByRole('button', { name: 'Back to threads' }));
    await waitFor(() => expect(onOpenThreadSpy).toHaveBeenCalledWith(null));
    expect(await screen.findByRole('list', { name: 'Threads' })).toBeTruthy();
  });
});

describe('ThreadPanel thread actions', () => {
  async function openPanel(): Promise<void> {
    await screen.findByRole('region', { name: 'Thread messages' });
  }

  async function openThreadMenu(
    user: ReturnType<typeof userEvent.setup>,
    title: string,
    item: string,
  ): Promise<void> {
    await user.click(await screen.findByRole('button', { name: `Thread actions for ${title}` }));
    await user.click(await screen.findByRole('menuitem', { name: item }));
  }

  it('renames the open thread', async () => {
    let patchBody: unknown = null;
    const fetchMock = stubFetch({
      'PATCH /api/threads/t1': (init) => {
        patchBody = init?.body ? JSON.parse(String(init.body)) : null;
        return json({ ...THREAD, title: 'Weekly shop' });
      },
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await openPanel();
    await openThreadMenu(user, 'Groceries', 'Rename');
    const field = await screen.findByRole('textbox', { name: 'Thread title' });
    await user.clear(field);
    await user.type(field, 'Weekly shop{Enter}');

    await waitFor(() => expect(patchBody).toEqual({ title: 'Weekly shop' }));
    expect(callsTo(fetchMock, 'PATCH', '/api/threads/t1')).toHaveLength(1);
    expect(await screen.findByText('Weekly shop')).toBeTruthy();
  });

  it('keeps the rename form and says so when the rename fails', async () => {
    stubFetch({
      'PATCH /api/threads/t1': () => json({ error: { code: 'store_error' } }, 500),
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await openPanel();
    await openThreadMenu(user, 'Groceries', 'Rename');
    const field = await screen.findByRole('textbox', { name: 'Thread title' });
    await user.clear(field);
    await user.type(field, 'Weekly shop{Enter}');

    expect(await screen.findByText('That thread could not be renamed.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Thread title' })).toBeTruthy();
  });

  // #524: a rename that lost a race is announced through the title bar's one
  // status region, which is mounted empty before it, and the typed title stays.
  it('announces a rename conflict in its status region and keeps the typed title', async () => {
    stubFetch({
      'PATCH /api/threads/t1': () => json({ error: { code: 'conflict' } }, 409),
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await openPanel();
    // Every status region empty before the rename; the conflict must land in
    // one of these (mounted beforehand), not in a region inserted with its text.
    const before = screen.getAllByRole('status').filter((node) => node.closest('button') === null && node.textContent === '');
    expect(before.length).toBeGreaterThan(0);
    await openThreadMenu(user, 'Groceries', 'Rename');
    const field = await screen.findByRole('textbox', { name: 'Thread title' });
    await user.clear(field);
    await user.type(field, 'Weekly shop{Enter}');

    const conflict = /changed this thread while you were renaming/;
    let region: HTMLElement | undefined;
    await waitFor(() => {
      region = before.find((node) => conflict.test(node.textContent ?? ''));
      expect(region).toBeTruthy();
    });
    expect((screen.getByRole('textbox', { name: 'Thread title' }) as HTMLInputElement).value).toBe('Weekly shop');
    expect(screen.queryByText('That thread could not be renamed.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel renaming thread' }));
    expect(region?.textContent).toBe('');
  });

  // P1: archive is reversible, so no dialog: it leaves at once with an Undo toast.
  it('archives the open thread at once with an Undo toast, and sends the request once it closes', async () => {
    const fetchMock = stubFetch({
      'DELETE /api/threads/t1': () => json({ ...THREAD, archived_at: Date.now() }),
    });
    const onOpenThreadSpy = vi.fn();
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id, onOpenThreadSpy });
    await openPanel();
    await openThreadMenu(user, 'Groceries', 'Archive');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(onOpenThreadSpy).toHaveBeenCalledWith(null));
    expect((await screen.findAllByText('Archived Groceries')).length).toBeGreaterThan(0);
    expect(callsTo(fetchMock, 'DELETE', '/api/threads/t1')).toHaveLength(0);
    await waitFor(() => expect(callsTo(fetchMock, 'DELETE', '/api/threads/t1')).toHaveLength(1), { timeout: 9000 });
  }, 15000);

  // Restored promise: archive happens once however fast the clicks come.
  it('a double click on Archive hides the thread once and sends one DELETE', async () => {
    const fetchMock = stubFetch({
      'GET /api/spaces/s1/threads': () => json({ threads: [THREAD, { ...THREAD, id: 't9', title: 'Trip' }] }),
      'DELETE /api/threads/t1': () => json({ ...THREAD, archived_at: Date.now() }),
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: null });
    await user.click(await screen.findByRole('button', { name: 'Thread actions for Groceries' }));
    await user.dblClick(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Thread actions for Groceries' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Thread actions for Trip' })).toBeTruthy();
    await waitFor(() => expect(callsTo(fetchMock, 'DELETE', '/api/threads/t1')).toHaveLength(1), { timeout: 9000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(callsTo(fetchMock, 'DELETE', '/api/threads/t1')).toHaveLength(1);
  }, 15000);

  it('Undo on the archive toast keeps the thread and sends nothing', async () => {
    const fetchMock = stubFetch({
      'DELETE /api/threads/t1': () => json({ ...THREAD, archived_at: Date.now() }),
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: null });
    const row = await screen.findByRole('button', { name: 'Thread actions for Groceries' });
    await user.click(row);
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Thread actions for Groceries' })).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Undo', hidden: true }));
    expect(await screen.findByRole('button', { name: 'Thread actions for Groceries' })).toBeTruthy();
    expect(callsTo(fetchMock, 'DELETE', '/api/threads/t1')).toHaveLength(0);
  });

  it('hides Archive from a member who neither created the thread nor runs the space', async () => {
    const memberSpace: Space = { ...SPACE, role: 'member' };
    stubFetch({
      'GET /api/spaces/s1/threads': () => json({ threads: [{ ...THREAD, created_by: 'u-other' }] }),
    });
    const user = userEvent.setup();
    renderPanel({ space: memberSpace, initialOpenThreadId: THREAD.id });
    await openPanel();
    await openThreadMenu(user, 'Groceries', 'Rename');
    expect(await screen.findByRole('textbox', { name: 'Thread title' })).toBeTruthy();
    await user.keyboard('{Escape}');

    await user.click(await screen.findByRole('button', { name: 'Thread actions for Groceries' }));
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
  });
});

describe('ThreadPanel message actions', () => {
  async function openPanel(): Promise<void> {
    await screen.findByRole('region', { name: 'Thread messages' });
  }

  it('renders a deleted message as Message deleted', async () => {
    stubFetch();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await openPanel();
    expect(await screen.findByText('Message deleted')).toBeTruthy();
  });

  it('marks an edited message', async () => {
    stubFetch();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await openPanel();
    expect(await screen.findByText('On it!')).toBeTruthy();
    expect(screen.getByText('edited')).toBeTruthy();
  });

  it('offers actions only on your own messages', async () => {
    stubFetch();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await openPanel();
    await screen.findByText('Buy milk');
    // Edit and delete sit inline under your own message and nowhere else;
    // copy is on every message that still has a body.
    expect(screen.getAllByRole('button', { name: 'Edit this message' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Delete this message' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Copy message' })).toHaveLength(4);
  });

  it('edits your message', async () => {
    let patchBody: unknown = null;
    const fetchMock = stubFetch({
      'PATCH /api/messages/m5': (init) => {
        patchBody = init?.body ? JSON.parse(String(init.body)) : null;
        return json({ ...OWN_MESSAGE, body: 'Buy oat milk', revision: 2 });
      },
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await openPanel();
    await user.click(await screen.findByRole('button', { name: 'Edit this message' }));
    const field = await screen.findByRole('textbox', { name: 'Edit message' });
    await user.clear(field);
    await user.type(field, 'Buy oat milk');
    await user.click(screen.getByRole('button', { name: 'Save edit' }));

    await waitFor(() => expect(patchBody).toEqual({ body: 'Buy oat milk' }));
    expect(callsTo(fetchMock, 'PATCH', '/api/messages/m5')).toHaveLength(1);
    expect(await screen.findByText('Buy oat milk')).toBeTruthy();
    expect(screen.getAllByText('edited')).toHaveLength(2);
  });

  it('deletes your message after confirming', async () => {
    const fetchMock = stubFetch({
      'DELETE /api/messages/m5': () =>
        json({ ...OWN_MESSAGE, body: '', tombstoned_at: 1756100000002, tombstoned_by: 'u-self' }),
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await openPanel();
    await user.click(await screen.findByRole('button', { name: 'Delete this message' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete message' }));

    await waitFor(() => expect(callsTo(fetchMock, 'DELETE', '/api/messages/m5')).toHaveLength(1));
    expect(await screen.findAllByText('Message deleted')).toHaveLength(2);
  });

  it('keeps the editor and says so when the save fails', async () => {
    stubFetch({
      'PATCH /api/messages/m5': () => json({ error: { code: 'store_error' } }, 500),
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await openPanel();
    await user.click(await screen.findByRole('button', { name: 'Edit this message' }));
    const field = await screen.findByRole('textbox', { name: 'Edit message' });
    await user.clear(field);
    await user.type(field, 'Buy oat milk');
    await user.click(screen.getByRole('button', { name: 'Save edit' }));

    expect(await screen.findByText('Your edit could not be saved.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Edit message' })).toBeTruthy();
  });
});

// #565/#667: the device has one entry on the open thread, the bar's own
// control; the list rows' menus offer Use on device for each thread.
describe('ThreadPanel device actions', () => {
  it('the title bar shows a visible Use on device, then On device', async () => {
    let active: unknown = null;
    const fetchMock = stubFetch({
      'GET /api/active': () => json({ active }),
      'PUT /api/devices/active-conversation': () => {
        active = { conversation_id: 'thr_t1', title: 'Groceries' };
        return json({});
      },
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await user.click(await screen.findByRole('button', { name: 'Use on device' }));
    expect(await screen.findByText('Sent to device.')).toBeTruthy();
    const puts = callsTo(fetchMock, 'PUT', '/api/devices/active-conversation');
    expect(puts.map(([, init]) => JSON.parse(String((init as RequestInit).body)))).toEqual([
      { conversation_id: null, space_id: 's1', thread_id: 't1' },
    ]);
    expect(screen.getByText('On device')).toBeTruthy();
  });

  it("keeps device items out of the open thread's menu", async () => {
    stubFetch({ 'GET /api/active': () => json({ active: null }) });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await screen.findByRole('region', { name: 'Thread messages' });
    await user.click(await screen.findByRole('button', { name: 'Thread actions for Groceries' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Rename', 'Archive']);
  });

  it('a thread row menu offers Use on device for that thread', async () => {
    const fetchMock = stubFetch({
      'GET /api/active': () => json({ active: null }),
      'PUT /api/devices/active-conversation': () => json({}),
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: null });
    await user.click(await screen.findByRole('button', { name: 'Thread actions for Groceries' }));
    await user.click(await screen.findByRole('menuitem', { name: /^Use on device/ }));
    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/devices/active-conversation')).toHaveLength(1));
  });
});

describe('ThreadPanel live updates', () => {
  it('bob:thread-message refetches the open thread', async () => {
    let messages = MESSAGES;
    stubFetch({
      'GET /api/active': () => json({ active: null }),
      'GET /api/threads/t1/messages': () => json({ messages, next_cursor: null }),
    });
    renderPanel({ initialOpenThreadId: THREAD.id });
    await screen.findByRole('region', { name: 'Thread messages' });
    messages = [...MESSAGES, threadMessage('m-device', null, 'Spoken on the Cardputer')];
    act(() => {
      window.dispatchEvent(new CustomEvent('bob:thread-message', { detail: { threadId: 't1', spaceId: 's1' } }));
    });
    expect(await screen.findByText('Spoken on the Cardputer')).toBeTruthy();
  });
});

// Mockup 16: on a phone the open thread's title is the visible title, with one
// muted "<space>, N people" line under it and the "..." menu beside it. The
// page's one h1 stays the space name (spaces-page.test), so the title is h2.
describe('ThreadTitleBar on a phone', () => {
  afterEach(() => {
    shell.isMobile = false;
  });

  it('shows the thread title as a visible heading and the space and people as its subtitle', async () => {
    shell.isMobile = true;
    stubFetch();
    renderPanel({ initialOpenThreadId: THREAD.id });
    expect(await screen.findByRole('heading', { level: 2, name: 'Groceries' })).toBeTruthy();
    expect(screen.getByText('Home, 2 people')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Thread actions for Groceries' })).toBeTruthy();
  });

  it('keeps the desktop title as plain text, with no page heading and no subtitle', async () => {
    stubFetch();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await screen.findByRole('region', { name: 'Thread messages' });
    expect(screen.queryByRole('heading', { level: 1, name: 'Groceries' })).toBeNull();
    expect(screen.queryByText('Home, 2 people')).toBeNull();
    expect(screen.getByText('Groceries')).toBeTruthy();
  });
});

// A phone thread shows the paired device like the main chat: one compact row
// directly above the composer (status line + Use on), not items in the menu.
describe('ThreadPanel device row on a phone', () => {
  afterEach(() => {
    shell.isMobile = false;
  });

  it('shows Use on device and the status line above the composer, outside the menu', async () => {
    shell.isMobile = true;
    stubFetch({ 'GET /api/active': () => json({ active: null }) });
    renderPanel({ initialOpenThreadId: THREAD.id });
    const use = await screen.findByRole('button', { name: 'Use on device' });
    const composer = within(await screen.findByRole('region', { name: 'Thread messages' })).getByRole('combobox', { name: 'Message' });
    expect(use.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps device items out of the phone menu and offers the device once', async () => {
    shell.isMobile = true;
    stubFetch({ 'GET /api/active': () => json({ active: null }) });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await screen.findByRole('button', { name: 'Use on device' });
    await user.click(screen.getByRole('button', { name: 'Thread actions for Groceries' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Tools', 'Rename', 'Archive']);
    expect(screen.getAllByRole('button', { name: 'Use on device' })).toHaveLength(1);
  });

  it('sends the thread to the device from the row and shows the status line', async () => {
    shell.isMobile = true;
    let active: unknown = null;
    const fetchMock = stubFetch({
      'GET /api/active': () => json({ active }),
      'PUT /api/devices/active-conversation': () => {
        active = { conversation_id: 'thr_t1', title: 'Groceries' };
        return json({});
      },
    });
    const user = userEvent.setup();
    renderPanel({ initialOpenThreadId: THREAD.id });
    await user.click(await screen.findByRole('button', { name: 'Use on device' }));
    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/devices/active-conversation')).toHaveLength(1));
    expect(await screen.findByText('On device')).toBeTruthy();
  });
});
