import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SideNav } from '@astryxdesign/core/SideNav';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { ConversationNav } from './conversation-nav';
import type { SharedConversationList } from './use-shared-conversations';

// The devices domain's contract hook: a paired device turns the row's device items on.
const devicesSummary = vi.hoisted(() => ({ value: { connected: 1, total: 1 } }));
vi.mock('@/features/devices/use-devices-summary', () => ({ useDevicesSummary: () => devicesSummary.value }));
import { useConversationList } from './use-conversation-list';

type Row = { id: string; title: string; createdAt: number; updatedAt: number; pinned?: boolean; archived?: boolean };

const now = Date.now();
const DAY = 86_400_000;

// A tiny in-memory server for the routes the sidebar uses.
let rows: Row[];
let serverActive: string | null;
let listStatus: number;
let activateStatus: number;
let patchStatus: number;
let detailStatus: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubServer(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const [path = '', search = ''] = url.split('?');
      if (path === '/api/active') return json({ active: serverActive ? { conversation_id: serverActive } : null });
      if (path === '/api/conversations' && method === 'GET') {
        if (listStatus !== 200) return new Response(null, { status: listStatus });
        const params = new URLSearchParams(search);
        const q = (params.get('q') ?? '').toLowerCase();
        const wantArchived = params.get('archived') === '1';
        const filtered = rows
          .filter((row) => row.title.toLowerCase().includes(q))
          .filter((row) => (wantArchived ? row.archived === true : row.archived !== true))
          .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true));
        return json({ conversations: filtered });
      }
      if (path === '/api/devices/active-conversation' && method === 'PUT') {
        return json(activateStatus === 409 ? { error: { code: 'no_device' } } : {}, activateStatus);
      }
      const id = path.split('/')[3] ?? '';
      if (method === 'GET' && path.startsWith('/api/conversations/')) {
        if (detailStatus !== 200) return new Response(null, { status: detailStatus });
        const title = rows.find((row) => row.id === id)?.title ?? 'Untitled';
        return json({
          id,
          title,
          createdAt: now,
          updatedAt: now,
          messages: [
            {
              id: 'm1',
              role: 'user',
              position: 0,
              versions: [{ id: 'v1', versionIndex: 0, selected: true, parts: [{ type: 'text', text: 'Hi' }] }],
            },
            {
              id: 'm2',
              role: 'assistant',
              position: 1,
              versions: [{ id: 'v2', versionIndex: 0, selected: true, parts: [{ type: 'text', text: 'Hello!' }] }],
            },
          ],
        });
      }
      if (method === 'PATCH') {
        if (patchStatus !== 200) return new Response(null, { status: patchStatus });
        const body = JSON.parse(String(init?.body)) as { title?: string; pinned?: boolean; archived?: boolean };
        rows = rows.map((row) => (row.id === id ? { ...row, ...body } : row));
        return json({});
      }
      if (method === 'DELETE') {
        rows = rows.filter((row) => row.id !== id);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unrouted fetch: ${method} ${url}`);
    }),
  );
}

// The requests the stub has seen for one method and URL, with their bodies.
function requestsTo(method: string, url: string): Array<{ body: unknown }> {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([input, init]) => input === url && (init?.method ?? 'GET').toUpperCase() === method)
    .map(([, init]) => ({ body: init?.body }));
}

const onSelect = vi.fn();
const onDeleted = vi.fn();
const onSelectShared = vi.fn();

// The real conversations hook, as the shell wires it.
function Harness({
  selectedId = null,
  collapsed = false,
  sharedList,
}: {
  selectedId?: string | null;
  collapsed?: boolean;
  sharedList?: SharedConversationList;
}): ReactElement {
  const list = useConversationList();
  return (
    <Theme theme={neutralTheme} mode="system">
      <SideNav collapsible={{ isCollapsed: collapsed, onCollapsedChange: () => {} }}>
        <ConversationNav
          list={list}
          selectedId={selectedId}
          onSelect={onSelect}
          onDeleted={onDeleted}
          collapsed={collapsed}
          sharedList={sharedList}
          onSelectShared={onSelectShared}
        />
      </SideNav>
    </Theme>
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, title: string, item: string | RegExp): Promise<void> {
  await user.click(await screen.findByRole('button', { name: `Conversation actions for ${title}` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

// The phone drawer is AppShell at its mobile breakpoint, which jsdom does not
// have; the flag stands in for `isMobile` and is reset after each test.
const phone = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ isMobile: phone.isMobile, closeMobileNav: () => {} }) };
});

describe('ConversationNav', () => {
  it('lists chats in the compact row size on the phone drawer, and the default size on desktop', async () => {
    try {
      phone.isMobile = true;
      const { unmount } = render(<Harness />);
      const phoneRow = (await screen.findByRole('link', { name: 'Trip plan' })).closest('.astryx-side-nav-item');
      expect(phoneRow?.getAttribute('data-size')).toBe('sm');
      unmount();

      phone.isMobile = false;
      render(<Harness />);
      const desktopRow = (await screen.findByRole('link', { name: 'Trip plan' })).closest('.astryx-side-nav-item');
      expect(desktopRow?.getAttribute('data-size')).toBe('md');
    } finally {
      phone.isMobile = false;
    }
  });

  it('offers conversation links without intercepting modified navigation', async () => {
    render(<Harness />);
    const link = await screen.findByRole('link', { name: 'Trip plan' });
    expect(link.getAttribute('href')).toBe('/c/c1');
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      expect(fireEvent.click(link, modifier)).toBe(true);
      expect(onSelect).not.toHaveBeenCalled();
    }
    expect(fireEvent.click(link)).toBe(false);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('c1');
  });
  // jsdom has no modal <dialog>; the Astryx alert dialog calls showModal() on open.
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
    rows = [
      { id: 'c1', title: 'Trip plan', createdAt: now, updatedAt: now },
      { id: 'c2', title: 'Second chat', createdAt: now, updatedAt: now - 10 * DAY },
    ];
    serverActive = null;
    listStatus = 200;
    activateStatus = 200;
    patchStatus = 200;
    detailStatus = 200;
    onSelect.mockClear();
    onDeleted.mockClear();
    onSelectShared.mockClear();
    stubServer();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('groups by recency and reports a picked row', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(await screen.findByText('Today')).toBeTruthy();
    expect(screen.getByText('Earlier')).toBeTruthy();
    await user.click(screen.getByText('Second chat'));
    expect(onSelect).toHaveBeenCalledWith('c2');
  });

  it('interleaves shared and private chats by recency with no separate category or private actions', async () => {
    const sharedList: SharedConversationList = {
      conversations: [{ id: 'shared-chat', title: 'Dinner together', createdAt: now, updatedAt: now - DAY, shared: true }],
      state: 'ready', reload: vi.fn(),
    };
    render(<Harness sharedList={sharedList} selectedId="shared-chat" />);
    await screen.findByRole('link', { name: 'Trip plan' });
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Trip plan', 'Dinner together', 'Second chat']);
    const shared = screen.getByRole('link', { name: 'Dinner together' });
    expect(shared.getAttribute('href')).toContain('/groups/');
    expect(screen.queryByText('Group chats')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conversation actions for Dinner together' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Conversation actions for Trip plan' })).toBeTruthy();
    fireEvent.click(shared, { ctrlKey: true });
    expect(onSelectShared).not.toHaveBeenCalled();
    fireEvent.click(shared);
    expect(onSelectShared).toHaveBeenCalledWith('shared-chat');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([200, 503])('keeps shared-only chats visible when private listing returns %s', async (status) => {
    rows = []; listStatus = status;
    render(<Harness sharedList={{ conversations: [{ id: 'shared-chat', title: 'Dinner together', createdAt: now, updatedAt: now, shared: true }], state: 'ready', reload: vi.fn() }} />);
    expect(await screen.findByRole('link', { name: 'Dinner together' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText('Loading chats')).toBeNull());
    expect(screen.queryByText('No chats yet')).toBeNull();
    if (status === 503) expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('keeps private chats visible when shared listing fails and retries both lists', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    render(<Harness sharedList={{ conversations: [], state: 'failed', reload }} />);
    expect(await screen.findByRole('link', { name: 'Trip plan' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('says when there are no conversations, and when they could not be loaded, with a retry', async () => {
    rows = [];
    const first = render(<Harness />);
    expect(await screen.findByText('No chats yet')).toBeTruthy();
    first.unmount();

    listStatus = 500;
    const user = userEvent.setup();
    render(<Harness />);
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load your chats.");
    listStatus = 200;
    rows = [{ id: 'c1', title: 'Trip plan', createdAt: now, updatedAt: now }];
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Trip plan')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('has no search field: finding a conversation is the command palette', async () => {
    render(<Harness />);
    await screen.findByText('Trip plan');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('renames in a dialog: Save PATCHes the trimmed title and the row shows it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openMenu(user, 'Trip plan', 'Rename');
    const field = await screen.findByLabelText('Chat name');
    expect((field as HTMLInputElement).value).toBe('Trip plan');
    await user.clear(field);
    await user.type(field, '  Holiday  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Holiday')).toBeTruthy();
    expect(screen.queryByText('Trip plan')).toBeNull();
    await waitFor(() => expect(document.querySelector('dialog[aria-label="Rename chat"][open]')).toBeNull());
    const patches = requestsTo('PATCH', '/api/conversations/c1');
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0]?.body))).toEqual({ title: 'Holiday' });
  });

  // P0 shell-chat "Rename": a failure is said inline and the typed title is kept;
  // moving focus away (a tap elsewhere on phone) never loses the edit.
  it('keeps the edit when focus leaves, and says inline when the rename fails', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openMenu(user, 'Trip plan', 'Rename');
    const field = await screen.findByLabelText('Chat name');
    await user.clear(field);
    await user.type(field, 'Holiday');
    field.blur();
    expect((screen.getByLabelText('Chat name') as HTMLInputElement).value).toBe('Holiday');

    patchStatus = 503;
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("Couldn't rename it. Try again.")).toBeTruthy();
    expect((screen.getByLabelText('Chat name') as HTMLInputElement).value).toBe('Holiday');
    expect(screen.getByText('Trip plan')).toBeTruthy();
  });

  it('asks before deleting, then deletes on confirm and reports it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openMenu(user, 'Trip plan', 'Delete');
    const dialog = await screen.findByRole('alertdialog');
    expect(requestsTo('DELETE', '/api/conversations/c1')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(requestsTo('DELETE', '/api/conversations/c1')).toHaveLength(0);
    expect(screen.getByText('Trip plan')).toBeTruthy();

    await openMenu(user, 'Trip plan', 'Delete');
    const named = await screen.findByRole('alertdialog');
    expect(within(named).getByText('Delete "Trip plan"?')).toBeTruthy();
    const confirm = within(named).getByRole('button', { name: 'Delete' });
    await user.click(confirm);
    await waitFor(() => expect(screen.queryByText('Trip plan')).toBeNull());
    expect(requestsTo('DELETE', '/api/conversations/c1')).toHaveLength(1);
    expect(onDeleted).toHaveBeenCalledWith('c1');
    expect(screen.getByText('Second chat')).toBeTruthy();
  });

  // P0 shell-chat "Delete": a failed delete keeps the dialog open and says so in it.
  it('keeps the delete dialog open with the error when the delete fails', async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.mocked(fetch).getMockImplementation();
    if (!fetchImpl) throw new Error('the server stub is not installed');
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      (init?.method ?? 'GET').toUpperCase() === 'DELETE' ? new Response(null, { status: 500 }) : fetchImpl(input, init),
    );
    render(<Harness />);
    await openMenu(user, 'Trip plan', 'Delete');
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByText(/Couldn't delete it\. Try again\./)).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Conversation actions for Trip plan' })).toBeTruthy();
  });

  // P0 shell-chat "Row MoreMenu": only an opened row mounts its menu items.
  it('mounts no row menu items until a row menu is opened', async () => {
    const user = userEvent.setup();
    rows = Array.from({ length: 30 }, (_, index) => ({ id: `c${index}`, title: `Chat ${index}`, createdAt: now, updatedAt: now }));
    render(<Harness />);
    await screen.findByText('Chat 0');
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Conversation actions for Chat 3' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent ?? '');
    // Grouped: Pin, Rename | the device's | Download | Archive, Delete last.
    expect(items[0]).toMatch(/^Pin/);
    expect(items[1]).toMatch(/^Rename/);
    expect(items.at(-2)).toMatch(/^Archive/);
    expect(items.at(-1)).toMatch(/^Delete/);
    expect(items.some((text) => text.startsWith('Download'))).toBe(true);
    expect(document.querySelectorAll('[role="menuitem"]').length).toBe(items.length);
  });

  it('offers no device items when no device is paired', async () => {
    devicesSummary.value = { connected: 0, total: 0 };
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByRole('button', { name: 'Conversation actions for Trip plan' }));
    await screen.findByRole('menuitem', { name: 'Rename' });
    expect(screen.queryByRole('menuitem', { name: /device/i })).toBeNull();
    devicesSummary.value = { connected: 1, total: 1 };
  });

  it('shows the first 50 chats and a Show more for the rest, never a silent cap', async () => {
    const user = userEvent.setup();
    rows = Array.from({ length: 60 }, (_, index) => ({ id: `c${index}`, title: `Chat ${index}`, createdAt: now, updatedAt: now - index }));
    render(<Harness />);
    await screen.findByText('Chat 0');
    expect(screen.queryByText('Chat 55')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Chat 55')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('Use on device: puts the pointer once, says so for a moment and marks the row', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByText('Trip plan');
    expect(screen.queryByRole('img', { name: 'On device' })).toBeNull();

    // What GET /api/active will answer once the device has the conversation.
    serverActive = 'c1';
    await openMenu(user, 'Trip plan', 'Use on device');
    await screen.findByText('Sent to device.');
    const puts = requestsTo('PUT', '/api/devices/active-conversation');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0]?.body))).toEqual({ conversation_id: 'c1', space_id: null });
    expect(await screen.findByRole('img', { name: 'On device' })).toBeTruthy();
  });

  it('New conversation on device from a row clears the pointer in the main space', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openMenu(user, 'Trip plan', /^New conversation on device/);
    await screen.findByText('Sent to device.');
    const puts = requestsTo('PUT', '/api/devices/active-conversation');
    expect(puts.map((put) => JSON.parse(String(put.body)))).toEqual([{ conversation_id: null, space_id: null }]);
  });

  it('says no Cardputer is connected, and leaves the marker alone', async () => {
    activateStatus = 409;
    const user = userEvent.setup();
    render(<Harness />);
    await openMenu(user, 'Trip plan', 'Use on device');
    await screen.findByText('No device is connected.');
    expect(screen.queryByRole('img', { name: 'On device' })).toBeNull();
  });

  it('says so when the conversation could not be sent to the Cardputer', async () => {
    activateStatus = 500;
    const user = userEvent.setup();
    render(<Harness />);
    await openMenu(user, 'Trip plan', 'Use on device');
    await screen.findByText('Could not reach the device.');
    expect(screen.queryByText('Sent to device.')).toBeNull();
    expect(screen.queryByRole('img', { name: 'On device' })).toBeNull();
  });

  it('marks the row the server says is active on the device, and only that one', async () => {
    serverActive = 'c2';
    render(<Harness />);
    const dot = await screen.findByRole('img', { name: 'On device' });
    expect(screen.getAllByRole('img', { name: 'On device' })).toHaveLength(1);
    // The nearest ancestor holding both the dot and Second chat's menu is that
    // one row: it must not also hold the other conversation.
    const menu = screen.getByRole('button', { name: 'Conversation actions for Second chat' });
    let row: HTMLElement | null = dot;
    while (row && !row.contains(menu)) row = row.parentElement;
    expect(row?.textContent).toContain('Second chat');
    expect(row?.textContent).not.toContain('Trip plan');
  });

  it('refetches /api/active when the bob:active-changed event fires', async () => {
    render(<Harness />);
    // Initially nothing is active on the device; wait for mount to complete.
    await screen.findByText('Trip plan');
    const initialRequests = requestsTo('GET', '/api/active').length;

    // Another device makes c1 active.
    serverActive = 'c1';
    window.dispatchEvent(new Event('bob:active-changed'));
    // The hook should refetch, and the dot should appear on c1.
    const dot = await screen.findByRole('img', { name: 'On device' });
    expect(requestsTo('GET', '/api/active').length).toBeGreaterThan(initialRequests);
    const menu = screen.getByRole('button', { name: 'Conversation actions for Trip plan' });
    let row: HTMLElement | null = dot;
    while (row && !row.contains(menu)) row = row.parentElement;
    expect(row?.textContent).toContain('Trip plan');

    // Another device switches to c2.
    const beforeSwitch = requestsTo('GET', '/api/active').length;
    serverActive = 'c2';
    window.dispatchEvent(new Event('bob:active-changed'));
    // The dot should move to c2.
    await waitFor(() => {
      const dots = screen.queryAllByRole('img', { name: 'On device' });
      expect(dots).toHaveLength(1);
      const menu2 = screen.getByRole('button', { name: 'Conversation actions for Second chat' });
      let row2: HTMLElement | null = dots[0];
      while (row2 && !row2.contains(menu2)) row2 = row2.parentElement;
      expect(row2?.textContent).toContain('Second chat');
    });
    expect(requestsTo('GET', '/api/active').length).toBeGreaterThan(beforeSwitch);
  });

  it('shows a pinned row under a "Pinned" heading, and its menu offers "Unpin"', async () => {
    rows = [
      { id: 'c1', title: 'Trip plan', createdAt: now, updatedAt: now, pinned: true },
      { id: 'c2', title: 'Second chat', createdAt: now, updatedAt: now - 10 * DAY },
    ];
    const user = userEvent.setup();
    render(<Harness />);
    expect(await screen.findByText('Pinned')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Conversation actions for Trip plan' }));
    expect(await screen.findByRole('menuitem', { name: 'Unpin' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Pin' })).toBeNull();
  });

  it('"Pin" PATCHes pinned:true and moves the row under Pinned', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByText('Second chat');
    await openMenu(user, 'Second chat', 'Pin');
    await waitFor(() => expect(requestsTo('PATCH', '/api/conversations/c2')).toHaveLength(1));
    expect(JSON.parse(String(requestsTo('PATCH', '/api/conversations/c2')[0]?.body))).toEqual({ pinned: true });
    expect(await screen.findByText('Pinned')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Conversation actions for Second chat' }));
    expect(await screen.findByRole('menuitem', { name: 'Unpin' })).toBeTruthy();
  });

  // P1 shell-chat "Archive": reversible, so a Toast with Undo and no dialog.
  it('"Archive" shows an Undo toast that restores the chat', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openMenu(user, 'Trip plan', 'Archive');
    expect(await screen.findByText('Chat archived')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // The toast lives in Astryx's own viewport layer; its Undo is found by its text.
    const undo = screen.getByText('Undo').closest('button');
    expect(undo).not.toBeNull();
    if (undo) await user.click(undo);
    await waitFor(() => {
      const patches = requestsTo('PATCH', '/api/conversations/c1').map((call) => JSON.parse(String(call.body)));
      expect(patches).toEqual([{ archived: true }, { archived: false }]);
    });
    expect(await screen.findByRole('button', { name: 'Conversation actions for Trip plan' })).toBeTruthy();
  });

  it('"Archive" removes the row; "Archived" shows it; "Unarchive" restores it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByText('Trip plan');
    await openMenu(user, 'Trip plan', 'Archive');
    // The archived list is prefetched into a collapsed disclosure (CSS-only
    // collapse), so the row text can still be in the DOM; the live row's own
    // action button is the reliable signal that it left the main list.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Conversation actions for Trip plan' })).toBeNull(),
    );

    await user.click(await screen.findByRole('button', { name: 'Archived' }));
    await user.click(await screen.findByRole('button', { name: 'Archived conversation actions for Trip plan' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Unarchive' }));

    await waitFor(() => {
      const patches = requestsTo('PATCH', '/api/conversations/c1');
      expect(patches.some((call) => JSON.parse(String(call.body)).archived === false)).toBe(true);
    });
    expect(await screen.findByRole('button', { name: 'Conversation actions for Trip plan' })).toBeTruthy();
  });

  it('shows no "Archived" item when nothing is archived', async () => {
    render(<Harness />);
    await screen.findByText('Trip plan');
    await waitFor(() => expect(requestsTo('GET', '/api/conversations?archived=1')).toHaveLength(1));
        expect(screen.queryByRole('button', { name: 'Archived' })).toBeNull();
  });

  it('shows an error toast on a PATCH failure, and the row stays', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByText('Trip plan');
    patchStatus = 503;
    await openMenu(user, 'Trip plan', 'Pin');
    expect(await screen.findByText("Couldn't update that chat.")).toBeTruthy();
    expect(screen.getByText('Trip plan')).toBeTruthy();
    expect(screen.queryByText('Pinned')).toBeNull();
  });

  it('"Download" downloads the conversation as a file named after its title', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByText('Trip plan');
    await openMenu(user, 'Trip plan', 'Download');

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('Trip-plan.md');

    clickSpy.mockRestore();
  });

  it('says it could not download when the detail fails to load', async () => {
    detailStatus = 500;
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByText('Trip plan');
    await openMenu(user, 'Trip plan', 'Download');
    expect(await screen.findByText("Couldn't download that chat.")).toBeTruthy();
  });

  describe('collapsed to the icon rail', () => {
    it('opens a shared-only chat from the same Chats flyout with its route selected', async () => {
      rows = [];
      const user = userEvent.setup();
      render(<Harness collapsed selectedId="shared-chat" sharedList={{ conversations: [{ id: 'shared-chat', title: 'Dinner together', createdAt: now, updatedAt: now, shared: true }], state: 'ready', reload: vi.fn() }} />);
      await user.click(await screen.findByRole('button', { name: /^Chats/ }));
      const shared = await screen.findByRole('link', { name: 'Dinner together' });
      expect(shared.getAttribute('href')).toContain('/groups/');
      expect(shared.getAttribute('aria-current')).toBe('page');
      await user.click(shared);
      expect(onSelectShared).toHaveBeenCalledWith('shared-chat');
      expect(screen.queryByText('Group chats')).toBeNull();
    });

    it('shows one Chats item holding every row, with no row menus', async () => {
      const user = userEvent.setup();
      render(<Harness collapsed selectedId="c2" />);
      const item = await screen.findByRole('button', { name: /^Chats/ });
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('button', { name: /Conversation actions for/ })).toBeNull();
      // Newest first, as the list came, and grouped under no heading.
      expect(screen.queryByText('Today')).toBeNull();

      await user.click(item);
      const trip = await screen.findByText('Trip plan');
      const second = screen.getByText('Second chat');
      expect(trip.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await user.click(second);
      expect(onSelect).toHaveBeenCalledWith('c2');
    });

    it('renders nothing when there are no conversations', async () => {
      rows = [];
      render(<Harness collapsed />);
      await waitFor(() => expect(requestsTo('GET', '/api/conversations')).toHaveLength(1));
      // Let the (empty) answer land, so "nothing" is checked once the list is 'empty'.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      // The empty state is a message in the wide rail only; the icon rail holds
      // no item at all (SideNav's own empty live region is not ours to count).
      expect(screen.queryByText('No chats yet')).toBeNull();
      expect(screen.queryByText(/^Chats/)).toBeNull();
      expect(screen.queryByRole('button', { name: /^Chats/ })).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
      // (Astryx's toast viewport keeps an empty assertive region; only our own error counts.)
      expect(screen.queryByText("Couldn't load your chats.")).toBeNull();
    });
  });
});
