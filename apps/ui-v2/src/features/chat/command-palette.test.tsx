import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InternationalizationProvider } from '@astryxdesign/core/i18n';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { SpacesProvider } from '@/features/spaces/use-spaces';
import { CommandPalette } from './command-palette';

const PLACEHOLDER = 'Search chats, tasks, notes…';
const now = Date.now();
const ACTIVE_SPACE_KEY = 'bob.family.activeSpaceId';
const SPACE_ID = 'spc_1';

const taskResult = {
  resource_type: 'task',
  resource_id: 'tsk_1',
  space_id: SPACE_ID,
  title: 'Buy milk',
  snippet: 'Buy milk before Friday',
  updated_at: now,
  rank: 1,
};

const noteResult = {
  resource_type: 'note',
  resource_id: 'nte_1',
  space_id: SPACE_ID,
  title: 'Milk recipes',
  snippet: 'Recipes with milk',
  updated_at: now,
  rank: 2,
};

function conversation(id: string, title: string): Record<string, unknown> {
  return { id, title, createdAt: now, updatedAt: now };
}

let fetchMock: ReturnType<typeof vi.fn>;

type SearchStub = { status?: number; results?: Array<Record<string, unknown>> };

// Answers /api/conversations (with ?q= as a title filter, like the server),
// /api/search, and the spaces endpoints the command palette (and
// SpacesProvider, in the tests that render one) call; anything else fails
// loudly rather than hanging.
function stubConversations(conversations: Array<Record<string, unknown>>, search: SearchStub = {}): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    if (url === '/api/conversations' || url.startsWith('/api/conversations?q=')) {
      const q = new URLSearchParams(url.split('?')[1] ?? '').get('q')?.toLowerCase() ?? '';
      const matches = conversations.filter((c) => String(c.title).toLowerCase().includes(q));
      return new Response(JSON.stringify({ conversations: matches }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('/api/search?')) {
      return new Response(JSON.stringify({ results: search.results ?? [] }), {
        status: search.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/spaces') {
      return new Response(
        JSON.stringify({
          spaces: [
            {
              id: SPACE_ID,
              kind: 'group',
              name: 'Family',
              role: 'owner',
              membership_revision: 1,
              created_at: now,
              updated_at: now,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === `/api/spaces/${SPACE_ID}/members`) {
      return new Response(JSON.stringify({ members: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unrouted fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPalette(): ReturnType<typeof render> {
  return render(
    <Theme theme={neutralTheme} mode="system">
      <InternationalizationProvider locale="en">
        <CommandPalette />
      </InternationalizationProvider>
    </Theme>,
  );
}

function renderPaletteWithSpaces(): ReturnType<typeof render> {
  return render(
    <Theme theme={neutralTheme} mode="system">
      <InternationalizationProvider locale="en">
        <SpacesProvider>
          <CommandPalette />
        </SpacesProvider>
      </InternationalizationProvider>
    </Theme>,
  );
}

describe('CommandPalette', () => {
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

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
    stubConversations([conversation('c1', 'Trip plan'), conversation('c2', 'Second chat')]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is closed and fetches nothing until it is opened', () => {
    renderPalette();
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens on Ctrl+K, fetches the conversations, and closes on Escape', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByPlaceholderText(PLACEHOLDER)).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('option', { name: 'Trip plan' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull());
  });

  it('toggles closed on a second Ctrl+K', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByPlaceholderText(PLACEHOLDER);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    });
    await waitFor(() => expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull());
  });

  it('opens on the bob:open-palette event', async () => {
    renderPalette();
    act(() => {
      window.dispatchEvent(new Event('bob:open-palette'));
    });
    expect(await screen.findByPlaceholderText(PLACEHOLDER)).toBeTruthy();
  });

  it('lists the Go to destinations and at most 20 conversations', async () => {
    stubConversations(Array.from({ length: 25 }, (_, i) => conversation(`id${i}`, `Chat number ${i}`)));
    renderPalette();
    act(() => {
      window.dispatchEvent(new Event('bob:open-palette'));
    });
    await screen.findByRole('option', { name: 'Chat number 0' });
    for (const name of ['New chat', 'Today', 'Calendar', 'Memory', 'Devices', 'All spaces', 'Settings']) {
      expect(screen.getByRole('option', { name })).toBeTruthy();
    }
    expect(screen.getAllByRole('option', { name: /^Chat number/ })).toHaveLength(20);
  });

  it('filters by the typed text and says when nothing matches', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: 'Trip plan' });
    await user.keyboard('trip');
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Memory' })).toBeNull());
    expect(screen.getByRole('option', { name: 'Trip plan' })).toBeTruthy();
    await user.clear(screen.getByPlaceholderText(PLACEHOLDER));
    await user.keyboard('zzzz');
    expect(await screen.findByText('No results.')).toBeTruthy();
  });

  it('closes and navigates when a Go to item runs', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await user.click(await screen.findByRole('option', { name: 'Memory' }));
    expect(window.location.pathname).toBe('/memory');
    await waitFor(() => expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull());
  });

  it.each([['Today', '/today'], ['Devices', '/devices'], ['All spaces', '/spaces'], ['Integrations', '/integrations'], ['Settings', '/settings']])(
    'opens %s from the command palette', async (name, path) => {
      const user = userEvent.setup();
      renderPalette();
      await user.keyboard('{Control>}k{/Control}');
      await user.click(await screen.findByRole('option', { name }));
      expect(window.location.pathname).toBe(path);
      await waitFor(() => expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull());
    },
  );

  describe('highlight', () => {
    // The palette exposes its highlight as the input's aria-activedescendant.
    function highlighted(): string | null {
      const id = screen.getByPlaceholderText(PLACEHOLDER).getAttribute('aria-activedescendant');
      return (id && document.getElementById(id)?.getAttribute('data-value')) || null;
    }

    async function openPalette(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      renderPalette();
      await user.keyboard('{Control>}k{/Control}');
      await screen.findByRole('option', { name: 'Trip plan' });
      return user;
    }

    it('highlights the first item when it opens, so Enter runs it', async () => {
      window.history.replaceState(null, '', '/calendar');
      const user = await openPalette();
      // The palette registers its options asynchronously and retries the
      // highlight on requestAnimationFrame, so wait for it to land.
      await waitFor(() => expect(highlighted()).toBe('go:new-chat'));
      await user.keyboard('{Enter}');
      expect(window.location.pathname).toBe('/');
      await waitFor(() => expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull());
    });

    it('runs the top match on Enter after typing, with no arrow key', async () => {
      const user = await openPalette();
      await user.keyboard('mem');
      await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
      expect(highlighted()).toBe('go:memory');
      await user.keyboard('{Enter}');
      expect(window.location.pathname).toBe('/memory');
      await waitFor(() => expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull());
    });

    it('moves the highlight with ArrowDown and ArrowUp after typing', async () => {
      const user = await openPalette();
      await user.keyboard('l');
      await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
      expect(highlighted()).toBe('go:calendar');
      await user.keyboard('{ArrowDown}');
      expect(highlighted()).toBe('go:spaces');
      await user.keyboard('{ArrowUp}');
      expect(highlighted()).toBe('go:calendar');
      await user.keyboard('{Enter}');
      expect(window.location.pathname).toBe('/calendar');
    });

    it('re-highlights the first match when a stale highlight points past a shorter list', async () => {
      const user = await openPalette();
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}mem');
      await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
      expect(highlighted()).toBe('go:memory');
    });

    it('re-highlights the first match after the list has been empty', async () => {
      const user = await openPalette();
      await user.keyboard('zzzz');
      expect(await screen.findByText('No results.')).toBeTruthy();
      await user.keyboard('{Backspace}{Backspace}{Backspace}{Backspace}mem');
      await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
      expect(highlighted()).toBe('go:memory');
    });

    it('highlights the first server result when there is no local match, and Enter opens that task', async () => {
      stubConversations([conversation('c1', 'Trip plan'), conversation('c2', 'Second chat')], {
        results: [taskResult],
      });
      const user = await openPalette();
      await user.keyboard('milk');
      await waitFor(() => expect(screen.getByRole('option', { name: 'Buy milk' })).toBeTruthy());
      expect(highlighted()).toBe(`s:task:${taskResult.resource_id}`);
      await user.keyboard('{Enter}');
      expect(window.location.pathname).toBe(`/spaces/${SPACE_ID}/tasks`);
      expect(window.location.search).toBe(`?task=${taskResult.resource_id}`);
    });
  });

  it('navigates to /c/<id> when a conversation runs', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await user.click(await screen.findByRole('option', { name: 'Trip plan' }));
    expect(window.location.pathname).toBe('/c/c1');
    await waitFor(() => expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull());
  });

  it('removes every window listener it added when it unmounts', async () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderPalette();
    const mine = added.mock.calls.filter(([type]) => type === 'keydown' || type === 'bob:open-palette');
    expect(mine.map(([type]) => type).sort()).toEqual(['bob:open-palette', 'keydown']);
    unmount();
    for (const [type, handler] of mine) {
      expect(removed.mock.calls.some(([t, h]) => t === type && h === handler)).toBe(true);
    }
    await userEvent.setup().keyboard('{Control>}k{/Control}');
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
  });

  describe('server search', () => {
    it('shows grouped server results under their type headings', async () => {
      stubConversations([conversation('c1', 'Trip plan')], { results: [taskResult, noteResult] });
      const user = userEvent.setup();
      renderPalette();
      await user.keyboard('{Control>}k{/Control}');
      await screen.findByRole('option', { name: 'Trip plan' });
      await user.keyboard('milk');
      await waitFor(() => expect(screen.getByRole('option', { name: 'Buy milk' })).toBeTruthy());
      expect(
        within(screen.getByRole('group', { name: 'Tasks' })).getByRole('option', { name: 'Buy milk' }),
      ).toBeTruthy();
      expect(
        within(screen.getByRole('group', { name: 'Notes' })).getByRole('option', { name: 'Milk recipes' }),
      ).toBeTruthy();
    });

    it('finds a conversation by title that is not among the first 20, and opens it', async () => {
      const many = Array.from({ length: 24 }, (_, i) => conversation(`id${i}`, `Chat number ${i}`));
      stubConversations([...many, conversation('old', 'Ski trip packing')]);
      const user = userEvent.setup();
      renderPalette();
      await user.keyboard('{Control>}k{/Control}');
      await screen.findByRole('option', { name: 'Chat number 0' });
      expect(screen.queryByRole('option', { name: 'Ski trip packing' })).toBeNull();
      await user.keyboard('ski');
      const group = await screen.findByRole('group', { name: 'Conversations' });
      await user.click(await within(group).findByRole('option', { name: 'Ski trip packing' }));
      expect(window.location.pathname).toBe('/c/old');
    });

    it('lists a conversation the server also matched only once', async () => {
      stubConversations(Array.from({ length: 25 }, (_, i) => conversation(`id${i}`, `Chat number ${i}`)));
      const user = userEvent.setup();
      renderPalette();
      await user.keyboard('{Control>}k{/Control}');
      await screen.findByRole('option', { name: 'Chat number 0' });
      await user.keyboard('Chat number 2');
      // Local: 2 (the first 20 hold 0-19); the server adds 20-24.
      await waitFor(() => expect(screen.getAllByRole('option', { name: /^Chat number 2/ })).toHaveLength(6));
      expect(screen.getAllByRole('option', { name: 'Chat number 2' })).toHaveLength(1);
    });

    it('sends no /api/search request for a single character', async () => {
      const user = userEvent.setup();
      renderPalette();
      await user.keyboard('{Control>}k{/Control}');
      await screen.findByRole('option', { name: 'Trip plan' });
      await user.keyboard('m');
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/search?'))).toBe(false);
    });

    it('sends exactly one /api/search request for a quickly typed query', async () => {
      stubConversations([conversation('c1', 'Trip plan')], { results: [taskResult] });
      const user = userEvent.setup();
      renderPalette();
      await user.keyboard('{Control>}k{/Control}');
      await screen.findByRole('option', { name: 'Trip plan' });
      await user.keyboard('milk');
      await waitFor(() => expect(screen.getByRole('option', { name: 'Buy milk' })).toBeTruthy());
      const searchCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/search?'));
      expect(searchCalls).toHaveLength(1);
      expect(String(searchCalls[0]?.[0])).toMatch(/^\/api\/search\?q=milk/);
    });

    it('keeps local results visible and throws nothing when the search request fails', async () => {
      stubConversations([conversation('c1', 'Trip plan')], { status: 500 });
      const user = userEvent.setup();
      renderPalette();
      await user.keyboard('{Control>}k{/Control}');
      await screen.findByRole('option', { name: 'Trip plan' });
      await user.keyboard('trip');
      await waitFor(() => expect(screen.getByRole('option', { name: 'Trip plan' })).toBeTruthy());
    });

    // P0 shell-chat "Palette groups": a failed search is not "no results".
    it('says search is unavailable, not "No results", when the search request fails', async () => {
      stubConversations([conversation('c1', 'Trip plan')], { status: 500 });
      const user = userEvent.setup();
      renderPalette();
      await user.keyboard('{Control>}k{/Control}');
      await screen.findByRole('option', { name: 'Trip plan' });
      await user.keyboard('zzzz');
      expect(await screen.findByText("Search isn't working right now. Try again.")).toBeTruthy();
      expect(screen.queryByText('No results.')).toBeNull();
    });

    it.each([
      ['note', `/spaces/${SPACE_ID}/notes`, '?note=n1'],
      ['event', `/spaces/${SPACE_ID}/agenda`, '?event=n1'],
    ])('opens a found %s itself, not its space', async (type, path, search) => {
      stubConversations([conversation('c1', 'Trip plan')], {
        results: [{ ...taskResult, resource_type: type, resource_id: 'n1', title: 'Milk run' }],
      });
      const user = userEvent.setup();
      renderPalette();
      await user.keyboard('{Control>}k{/Control}');
      await screen.findByRole('option', { name: 'Trip plan' });
      await user.keyboard('milk');
      await user.click(await screen.findByRole('option', { name: /Milk run/ }));
      expect(window.location.pathname).toBe(path);
      expect(window.location.search).toBe(search);
    });

    it('names the space and opens the task in it when a server result is clicked', async () => {
      stubConversations([conversation('c1', 'Trip plan')], { results: [taskResult] });
      const user = userEvent.setup();
      renderPaletteWithSpaces();
      await user.keyboard('{Control>}k{/Control}');
      await screen.findByRole('option', { name: 'Trip plan' });
      await user.keyboard('milk');
      const option = await screen.findByRole('option', { name: /Buy milk/ });
      await waitFor(() => expect(option.textContent).toContain('Family'));
      await user.click(option);
      expect(window.localStorage.getItem(ACTIVE_SPACE_KEY)).toBe(SPACE_ID);
      expect(window.location.pathname).toBe(`/spaces/${SPACE_ID}/tasks`);
    });
  });
});
