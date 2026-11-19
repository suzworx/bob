import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { SpacesProvider } from '@/features/spaces/use-spaces';
import { createQueryClient } from '@/lib/query-client';
import type { AccountEventHandlers } from '@/lib/use-account-events';
import { subscribeDevices } from '../features/devices/devices-events';
import { resetDrafts } from '../features/chat/drafts';
import { resetOperatorAccess } from '../features/metrics/use-operator-access';
import { groupChatPath, navigateTo } from './routes';
import { Shell } from './shell';

// The account-events stream is stood in for: it keeps the latest handlers so a
// test can feed events, and counts the streams opened so "one for the whole app"
// is checked. `open` is how many are mounted now, `opened` how many ever were.
const stream = vi.hoisted(() => ({
  handlers: null as AccountEventHandlers | null,
  open: 0,
  opened: 0,
}));
vi.mock('@/lib/use-account-events', async () => {
  const { useEffect } = await import('react');
  return {
    useAccountEvents: (handlers: AccountEventHandlers): void => {
      stream.handlers = handlers;
      useEffect(() => {
        stream.open += 1;
        stream.opened += 1;
        return () => {
          stream.open -= 1;
        };
      }, []);
    },
  };
});

// Delivers one event, as the stream would.
function emit(send: (handlers: AccountEventHandlers) => void): void {
  act(() => {
    if (stream.handlers === null) throw new Error('no account-events stream is open');
    send(stream.handlers);
  });
}

// The footer's "Sign out everywhere" comes from the session store. A spy stands
// in for it; the rest of the module (fetchWithAuth) stays real.
const auth = vi.hoisted(() => ({ signOutEverywhere: vi.fn(async (): Promise<void> => {}) }));
vi.mock('@/lib/auth/use-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/use-session')>();
  return {
    ...actual,
    useSession: () => ({
      status: 'signed-in' as const,
      session,
      unavailable: null,
      signOut: async (): Promise<void> => {},
      signOutEverywhere: auth.signOutEverywhere,
    }),
  };
});

// The real chat surface, wrapped to count how many times one is mounted, so a
// remount (which would end hands-free and drop the spoken tail) is observable.
const surface = vi.hoisted(() => ({ mounts: 0 }));
vi.mock('../features/chat/chat-surface', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/chat/chat-surface')>();
  const { createElement, useEffect } = await import('react');
  return {
    ...actual,
    ChatSurface: (props: Parameters<typeof actual.ChatSurface>[0]) => {
      useEffect(() => {
        surface.mounts += 1;
      }, []);
      return createElement(actual.ChatSurface, props);
    },
  };
});

// Only AppShell is stood in for, and only while `drawer.closesOnClick` is set:
// at phone width the real AppShell shows its sideNav in a drawer that closes (and
// so unmounts the sideNav) when an item in it is clicked. jsdom has no phone
// breakpoint, so this reproduces that one behaviour; SpacesNav and
// CreateSpaceDialog stay real. Otherwise AppShell is the real one.
const drawer = vi.hoisted(() => ({ closesOnClick: false, closes: 0 }));
vi.mock('@astryxdesign/core/AppShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/AppShell')>();
  const { createElement, useState } = await import('react');
  type Props = Parameters<typeof actual.AppShell>[0];
  function DrawerShell(props: Props) {
    const [open, setOpen] = useState(true);
    return createElement(
      'div',
      null,
      open ? createElement('div', { 'data-testid': 'nav-drawer', onClick: () => setOpen(false) }, props.sideNav) : null,
      props.children,
    );
  }
  return {
    ...actual,
    AppShell: (props: Props) =>
      drawer.closesOnClick ? createElement(DrawerShell, props) : createElement(actual.AppShell, props),
    // In drawer mode the shell is "mobile": the phone top bar shows, and its
    // drawer-closing calls are counted. A new function each call, as Astryx's is.
    useAppShellMobile: () =>
      drawer.closesOnClick
        ? { ...actual.useAppShellMobile(), isMobile: true, closeMobileNav: () => { drawer.closes += 1; } }
        : actual.useAppShellMobile(),
  };
});

// Astryx's toggle reads its state from the real AppShell's context, which the
// drawer stand-in above does not provide, so in drawer mode it is stood in for
// by a button with the same accessible name. Its position is what is tested.
vi.mock('@astryxdesign/core/MobileNav', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/MobileNav')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    MobileNavToggle: (props: Parameters<typeof actual.MobileNavToggle>[0]) =>
      drawer.closesOnClick ? createElement('button', { type: 'button', 'aria-label': 'Open navigation' }) : createElement(actual.MobileNavToggle, props),
  };
});

// Other domains' contract modules (devices, notifications) are stood in for:
// the shell only places them. `devicesSummary` is what the rail's dot reads.
const devicesSummary = vi.hoisted(() => ({ connected: 0, total: 0 }));
vi.mock('../features/devices/use-devices-summary', () => ({ useDevicesSummary: () => devicesSummary }));
vi.mock('../features/notifications/notifications-bell', async () => {
  const { createElement } = await import('react');
  return { NotificationsBell: () => createElement('button', { type: 'button', 'aria-label': 'Notifications' }) };
});

// Settings composes sections from several domains; the shell only routes to it.
vi.mock('../features/account/account-page', async () => {
  const { createElement } = await import('react');
  return { SettingsPage: () => createElement('h1', null, 'Settings') };
});
vi.mock('../features/spaces/all-spaces-page', async () => {
  const { createElement } = await import('react');
  return { AllSpacesPage: () => createElement('h1', null, 'All spaces') };
});
vi.mock('@/features/integrations/integrations-page', async () => {
  const { createElement } = await import('react');
  return { IntegrationsPage: () => createElement('h1', null, 'Integrations') };
});
vi.mock('@/features/insights/insights-page', async () => {
  const { createElement } = await import('react');
  return { InsightsPage: () => createElement('h1', null, 'Insights') };
});
vi.mock('@/features/routines/routines-page', async () => {
  const { createElement } = await import('react');
  return { RoutinesPage: () => createElement('h1', null, 'Routines') };
});
vi.mock('../features/admin/admin-page', async () => {
  const { createElement } = await import('react');
  return { AdminPage: () => createElement('h1', null, 'Admin') };
});

const NOTICE = "That chat isn't here any more, so here's a fresh one.";
const LOAD_FAILED = "Couldn't open this chat.";
const now = Date.now();

const SPACE = {
  id: 's1',
  kind: 'group',
  name: 'Home',
  role: 'owner',
  membership_revision: 1,
  created_at: now,
  updated_at: now,
};

// jsdom has no IntersectionObserver, which ChatMessageList watches its top with
// while older messages remain. This one never sees the top, so only the
// "Load earlier messages" button loads a page.
class TopNeverVisible {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const session = {
  user: { id: '12345678-1234-4234-8234-123456789abe', email: 'ada@example.com', user_metadata: { full_name: 'Ada' } },
} as unknown as Session;

const detail = {
  id: 'c1',
  title: 'Trip plan',
  createdAt: now,
  updatedAt: now,
  messages: [
    {
      id: 'm1',
      role: 'user',
      position: 0,
      versions: [{ id: 'v1', parts: [{ type: 'text', text: 'hello' }], versionIndex: 0, selected: true }],
    },
    {
      id: 'm2',
      role: 'assistant',
      position: 1,
      versions: [{ id: 'v2', parts: [{ type: 'text', text: 'hi there' }], versionIndex: 0, selected: true }],
    },
  ],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// Answers by "METHOD url", then by URL; anything unrouted fails loudly rather
// than hanging. `routes` answers first, so a test can hold one request pending.
function stubFetch(routes: Record<string, () => Promise<Response>> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const route = routes[`${method} ${url}`] ?? routes[url];
      if (route) return route();
      if (url === '/api/group-chats') return json({ chats: [] });
      if (url === '/api/spaces') return json({ spaces: [] });
      if (url === '/api/active') return json({ active: null });
      if (url === '/api/operator/access') return new Response(null, { status: 404 });
      if (url === '/api/conversations') {
        return json({
          conversations: [
            { id: 'c1', title: 'Trip plan', createdAt: now, updatedAt: now },
            { id: 'c2', title: 'Second chat', createdAt: now, updatedAt: now },
          ],
        });
      }
      if (url === '/api/conversations/c1') return json(detail);
      if (url === '/api/conversations/missing') return new Response(null, { status: 404 });
      if (url.startsWith('/api/notifications')) return json({ notifications: [], next_cursor: null, unread_count: 0 });
      throw new Error(`unrouted fetch: ${url}`);
    }),
  );
}

// The pages read shared data through react-query, as app.tsx provides it.
function renderShell(onSignOut: () => Promise<void> = async () => {}): void {
  render(
    <Theme theme={neutralTheme} mode="system">
      <LayerProvider>
        <QueryClientProvider client={createQueryClient()}>
          <SpacesProvider>
            <Shell session={session} onSignOut={onSignOut} />
          </SpacesProvider>
        </QueryClientProvider>
      </LayerProvider>
    </Theme>,
  );
}

// Lets anything an event set off get as far as its request, so "no request was
// made" is a check on more than the instant after the event.
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

// The requests the stubbed fetch has seen for one method and URL.
function requestsTo(method: string, url: string): unknown[][] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([input, init]) => input === url && (init?.method ?? 'GET').toUpperCase() === method);
}

// window.history is the one object every test in this file shares, and nothing
// in a test's own body can undo what an earlier one left on it. Captured here,
// while the module body runs and before any spy can be installed, so the
// beforeEach below can put the real methods back whatever happened before.
const realPushState = window.history.pushState.bind(window.history);
const realReplaceState = window.history.replaceState.bind(window.history);

describe('Shell', () => {
  beforeEach(() => {
    // Unconditional and complete: the real navigation methods (a spy that
    // outlived its own test would otherwise arrive carrying that test's
    // calls), then a single known path and no leftover state entry.
    window.history.pushState = realPushState;
    window.history.replaceState = realReplaceState;
    window.history.replaceState(null, '', '/');
    // The rail saves its width and collapse (autoSaveId); each test starts expanded.
    window.localStorage.clear();
    auth.signOutEverywhere.mockClear();
    stream.handlers = null;
    stream.open = 0;
    stream.opened = 0;
    surface.mounts = 0;
    resetDrafts();
    resetOperatorAccess();
    stubFetch();
  });

  afterEach(() => {
    drawer.closesOnClick = false;
    drawer.closes = 0;
    cleanup();
    vi.unstubAllGlobals();
  });

  it('offers Admin in the account menu only to the owner or an operator, opening /admin', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    await settle();
    expect(screen.queryByRole('menuitem', { name: 'Admin' })).toBeNull();

    cleanup();
    resetOperatorAccess();
    stubFetch({ '/api/operator/access': async () => new Response(null, { status: 204 }) });
    renderShell();
    await settle();
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Admin' }));
    expect(window.location.pathname).toBe('/admin');
  });

  it('greets with the account\'s "name" metadata over "full_name"', async () => {
    const named = {
      user: { id: '12345678-1234-4234-8234-123456789abe', email: 'ada@example.com', user_metadata: { name: 'Ada Lovelace', full_name: 'Ada L' } },
    } as unknown as Session;
    render(
      <Theme theme={neutralTheme} mode="system">
        <QueryClientProvider client={createQueryClient()}>
          <SpacesProvider>
            <Shell session={named} onSignOut={async () => {}} />
          </SpacesProvider>
        </QueryClientProvider>
      </Theme>,
    );
    expect(await screen.findByText('Hi, Ada Lovelace')).toBeTruthy();
  });

  it('never shows the email local part as a name, and offers to add one', async () => {
    const emailOnly = {
      user: { id: '12345678-1234-4234-8234-123456789abe', email: 'ada@example.com', user_metadata: {} },
    } as unknown as Session;
    render(
      <Theme theme={neutralTheme} mode="system">
        <QueryClientProvider client={createQueryClient()}>
          <SpacesProvider>
            <Shell session={emailOnly} onSignOut={async () => {}} />
          </SpacesProvider>
        </QueryClientProvider>
      </Theme>,
    );
    expect(await screen.findByText('Hello, friend')).toBeTruthy();
    expect(screen.queryByText(/^Hi, ada/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add your name' })).toBeTruthy();
    // With no name to show, the account row falls back to the email.
    expect(screen.getByText('ada@example.com').closest('.astryx-side-nav-item')).not.toBeNull();
  });

  it('opens a conversation into /c/<id> and returns to a new chat', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(screen.getByText('hi there')).toBeTruthy();
    expect(window.location.pathname).toBe('/c/c1');

    await user.click(screen.getByText('New chat'));
    expect(await screen.findByText('Hi, Ada')).toBeTruthy();
    expect(screen.queryByText('hello')).toBeNull();
    expect(window.location.pathname).toBe('/');
  });

  it('restores the conversation in the URL on mount', async () => {
    window.history.replaceState(null, '', '/c/c1');
    renderShell();
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(screen.getByText('hi there')).toBeTruthy();
    expect(window.location.pathname).toBe('/c/c1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Trip plan' })).toBeTruthy();
  });

  it('uses a neutral heading when a deep-linked conversation is absent from the active history list', async () => {
    window.history.replaceState(null, '', '/c/c1');
    stubFetch({ '/api/conversations': async () => json({ conversations: [] }) });
    renderShell();
    expect(await screen.findByRole('heading', { level: 1, name: 'Conversation' })).toBeTruthy();
    expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(1);
  });

  it('puts the notifications bell in the rail footer, not in the list of destinations', async () => {
    renderShell();
    const bell = await screen.findByRole('button', { name: 'Notifications' });
    expect(bell.closest('nav')).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'Notifications' })).toBeNull();
  });

  it('opens the Today page on /today, listed in Pages above Calendar (#870)', async () => {
    window.history.replaceState(null, '', '/today');
    const pushState = vi.spyOn(window.history, 'pushState');
    renderShell();
    expect(await screen.findByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
    expect(window.location.pathname).toBe('/today');
    expect(pushState).not.toHaveBeenCalled();
    const nav = screen.getByRole('navigation', { name: 'Side navigation' });
    const labels = within(nav).getAllByText(/^(Today|Calendar)$/).map((node) => node.textContent);
    expect(labels.slice(0, 2)).toEqual(['Today', 'Calendar']);
    pushState.mockRestore();
  });

  it('redirects a landing on /family to /spaces without adding a history entry', async () => {
    window.history.replaceState(null, '', '/family');
    // A delta, not an absolute: how many entries earlier tests left on the
    // stack cannot change whether this redirect adds one.
    const entriesBefore = window.history.length;
    const pushState = vi.spyOn(window.history, 'pushState');
    renderShell();
    // /spaces with no space is All spaces (stood in for here: the spaces domain owns it).
    expect(await screen.findByRole('heading', { level: 1, name: 'All spaces' })).toBeTruthy();
    expect(window.location.pathname).toBe('/spaces');
    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.length).toBe(entriesBefore);
    pushState.mockRestore();
  });

  // IDS: a link that still carries the stored id (an email sent before the
  // prefixed URLs, a bookmark) is rewritten in place and opens once, by its stored id.
  it('redirects a landing on /c/cnv_<uuid> to /c/conv_<hex> in place and opens it by its stored id', async () => {
    const stored = 'cnv_5baa4dd3-311c-4abb-adc1-0eecd0ea06ca';
    stubFetch({ [`/api/conversations/${stored}`]: async () => json({ ...detail, id: stored }) });
    window.history.replaceState(null, '', `/c/${stored}`);
    const entriesBefore = window.history.length;
    const pushState = vi.spyOn(window.history, 'pushState');
    renderShell();
    expect(await screen.findByText('hi there')).toBeTruthy();
    expect(window.location.pathname).toBe('/c/conv_5baa4dd3311c4abbadc10eecd0ea06ca');
    await settle();
    expect(requestsTo('GET', `/api/conversations/${stored}`)).toHaveLength(1);
    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.length).toBe(entriesBefore);
    pushState.mockRestore();
  });

  it('redirects a landing on /spaces/<uuid>/threads/<uuid> to the prefixed /conversations URL in place', async () => {
    window.history.replaceState(
      null,
      '',
      '/spaces/6f86817c-ea95-481d-8456-8e608d5db780/threads/5baa4dd3-311c-4abb-adc1-0eecd0ea06ca',
    );
    const entriesBefore = window.history.length;
    const pushState = vi.spyOn(window.history, 'pushState');
    renderShell();
    await waitFor(() =>
      expect(window.location.pathname).toBe(
        '/spaces/spc_6f86817cea95481d84568e608d5db780/conversations/conv_5baa4dd3311c4abbadc10eecd0ea06ca',
      ),
    );
    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.length).toBe(entriesBefore);
    pushState.mockRestore();
  });

  it('shows a notice and resets to / when the URL conversation is gone', async () => {
    window.history.replaceState(null, '', '/c/missing');
    renderShell();
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(window.location.pathname).toBe('/');
    expect(screen.getByText('Hi, Ada')).toBeTruthy();
  });

  it('offers no Retry for a conversation that is gone', async () => {
    window.history.replaceState(null, '', '/c/missing');
    renderShell();
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('keeps the URL and offers Retry when opening fails with a 500, and Retry reloads it', async () => {
    window.history.replaceState(null, '', '/c/c1');
    let failing = true;
    stubFetch({
      '/api/conversations/c1': async () => (failing ? new Response(null, { status: 500 }) : json(detail)),
    });
    const user = userEvent.setup();
    renderShell();
    expect(await screen.findByText(LOAD_FAILED)).toBeTruthy();
    expect(window.location.pathname).toBe('/c/c1');
    // Not the "gone" path, and not a new chat: no notice, no landing, no composer.
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByText('Hi, Ada')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Message input' })).toBeNull();

    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    expect(window.location.pathname).toBe('/c/c1');
    expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(2);
  });

  it('treats a dropped connection as a failed open too, and New chat leaves it', async () => {
    stubFetch({
      '/api/conversations/c1': async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText(LOAD_FAILED)).toBeTruthy();
    expect(window.location.pathname).toBe('/c/c1');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    await user.click(screen.getByText('New chat'));
    expect(await screen.findByText('Hi, Ada')).toBeTruthy();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    expect(window.location.pathname).toBe('/');
  });

  it('shows no composer while another conversation opens, then restores it', async () => {
    const otherDetail = {
      ...detail,
      id: 'c2',
      title: 'Second chat',
      messages: [
        {
          id: 'm3',
          role: 'user',
          position: 0,
          versions: [{ id: 'v3', parts: [{ type: 'text', text: 'second question' }], versionIndex: 0, selected: true }],
        },
        {
          id: 'm4',
          role: 'assistant',
          position: 1,
          versions: [{ id: 'v4', parts: [{ type: 'text', text: 'second answer' }], versionIndex: 0, selected: true }],
        },
      ],
    };
    // c2's detail request is held until the test lets it go.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubFetch({
      '/api/conversations/c2': async () => {
        await held;
        return json(otherDetail);
      },
    });

    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    // The composer is a contenteditable whose mention trigger makes it a
    // combobox named "Message input". c1 is live, so it is there now, which
    // gives the absence check below its meaning.
    const composer = { name: 'Message input' };
    expect(screen.getByRole('combobox', composer)).toBeTruthy();

    await user.click(screen.getByText('Second chat'));
    expect(await screen.findByRole('status', { name: 'Opening chat' })).toBeTruthy();
    // c1's surface must be gone, or a send here would be stored in c1.
    expect(screen.queryByRole('combobox', composer)).toBeNull();
    expect(screen.queryByText('hello')).toBeNull();

    release();
    expect(await screen.findByText('second question')).toBeTruthy();
    expect(screen.getByText('second answer')).toBeTruthy();
    expect(screen.getByRole('combobox', composer)).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Opening chat' })).toBeNull();
  });

  it('opens a 300-message conversation on its latest 200 and loads the rest on request', {
    timeout: 30_000,
  }, async () => {
    vi.stubGlobal('IntersectionObserver', TopNeverVisible);
    const long = {
      ...detail,
      id: 'long',
      messages: Array.from({ length: 300 }, (_, n) => ({
        id: `n${n}`,
        role: n % 2 === 0 ? 'user' : 'assistant',
        position: n,
        versions: [
          { id: `v${n}`, parts: [{ type: 'text', text: `line ${n}` }], versionIndex: 0, selected: true },
        ],
      })),
    };
    stubFetch({ '/api/conversations/long': async () => json(long) });
    window.history.replaceState(null, '', '/c/long');
    const user = userEvent.setup();
    renderShell();
    expect(await screen.findByText('line 299')).toBeTruthy();
    const rows = (): number => screen.queryAllByText(/^line \d+$/).length;
    expect(rows()).toBe(200);
    expect(screen.getByText('line 100')).toBeTruthy();
    expect(screen.queryByText('line 99')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(await screen.findByText('line 0')).toBeTruthy();
    expect(rows()).toBe(300);
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });

  it('brings back the draft typed in a conversation after switching away and back', async () => {
    const second = {
      ...detail,
      id: 'c2',
      title: 'Second chat',
      messages: [
        {
          id: 'm3',
          role: 'user',
          position: 0,
          versions: [{ id: 'v3', parts: [{ type: 'text', text: 'second question' }], versionIndex: 0, selected: true }],
        },
      ],
    };
    stubFetch({ '/api/conversations/c2': async () => json(second) });
    const user = userEvent.setup();
    renderShell();
    const composerBox = (): HTMLElement => screen.getByRole('combobox', { name: 'Message input' });

    await user.click(await screen.findByText('Trip plan'));
    await screen.findByText('hello');
    await user.type(composerBox(), 'unsent thought');

    await user.click(screen.getByText('Second chat'));
    await screen.findByText('second question');
    expect(composerBox().textContent).toBe('');
    await user.type(composerBox(), 'other draft');

    await user.click(screen.getByText('Trip plan'));
    await screen.findByText('hello');
    await waitFor(() => expect(composerBox().textContent).toBe('unsent thought'));

    await user.click(screen.getByText('Second chat'));
    await screen.findByText('second question');
    await waitFor(() => expect(composerBox().textContent).toBe('other draft'));
  });

  // #524: the connection drops while the reader is typing. The banner says so,
  // the chat is not remounted under them, and the draft typed while offline is
  // still in the box once the connection is back.
  it('shows an offline banner on `offline`, hides it on `online`, and keeps the draft typed offline', async () => {
    const user = userEvent.setup();
    renderShell();
    const composerBox = (): HTMLElement => screen.getByRole('combobox', { name: 'Message input' });
    await waitFor(() => expect(composerBox()).toBeTruthy());
    const mounted = surface.mounts;
    expect(screen.queryByText("You're offline")).toBeNull();

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(await screen.findByText("You're offline")).toBeTruthy();
    await user.type(composerBox(), 'typed on the train');

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(screen.queryByText("You're offline")).toBeNull());
    expect(composerBox().textContent).toBe('typed on the train');
    expect(surface.mounts).toBe(mounted);
  });

  it('opens a page from the nav into its path and New chat returns to the chat', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await within(screen.getByRole('navigation', { name: 'Side navigation' })).findByRole('link', { name: 'Memory' }));
    expect(await screen.findByRole('heading', { name: 'Memory' })).toBeTruthy();
    expect(window.location.pathname).toBe('/memory');
    expect(screen.queryByText('Hi, Ada')).toBeNull();

    await user.click(screen.getByText('New chat'));
    expect(await screen.findByText('Hi, Ada')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Memory' })).toBeNull();
    expect(window.location.pathname).toBe('/');
  });

  it('exposes page destinations as native links and preserves modified clicks', async () => {
    renderShell();
    const link = await screen.findByRole('link', { name: 'Memory' });
    expect(link.getAttribute('href')).toBe('/memory');
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      expect(fireEvent.click(link, modifier)).toBe(true);
      expect(window.location.pathname).toBe('/');
    }
    expect(fireEvent.click(link)).toBe(false);
    expect(await screen.findByRole('heading', { name: 'Memory' })).toBeTruthy();
    expect(window.location.pathname).toBe('/memory');
  });

  it('reloads the last open conversation when it is picked again from a page', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();

    await user.click(within(screen.getByRole('navigation', { name: 'Side navigation' })).getByRole('link', { name: 'Memory' }));
    expect(await screen.findByRole('heading', { name: 'Memory' })).toBeTruthy();
    expect(window.location.pathname).toBe('/memory');
    expect(screen.queryByText('hello')).toBeNull();

    await user.click(screen.getByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Memory' })).toBeNull();
    expect(window.location.pathname).toBe('/c/c1');
  });

  it('opens a conversation when the URL moves to /c/<id> from outside the sidebar', async () => {
    renderShell();
    await screen.findByText('Trip plan');
    act(() => navigateTo('/c/c1'));
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(screen.getByText('hi there')).toBeTruthy();
    expect(window.location.pathname).toBe('/c/c1');
    // One fetch for it, however the URL got there.
    expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(1);
  });

  it('starts a new chat when the URL moves to / from an open conversation', async () => {
    window.history.replaceState(null, '', '/c/c1');
    renderShell();
    expect(await screen.findByText('hello')).toBeTruthy();
    act(() => navigateTo('/'));
    expect(await screen.findByText('Hi, Ada')).toBeTruthy();
    expect(screen.queryByText('hello')).toBeNull();
    expect(window.location.pathname).toBe('/');
  });

  it('opens the conversation a page links to, and reloads it when it was the last open one', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    await user.click(within(screen.getByRole('navigation', { name: 'Side navigation' })).getByRole('link', { name: 'Memory' }));
    expect(await screen.findByRole('heading', { name: 'Memory' })).toBeTruthy();

    act(() => navigateTo('/c/c1'));
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Memory' })).toBeNull();
    // The sidebar's click and the URL change made one fetch each, not two.
    expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(2);
  });

  it('carries each stored message origin into its metadata for the spoken badge', async () => {
    const spoken = {
      ...detail,
      messages: detail.messages.map((message) =>
        message.role === 'assistant' ? { ...message, origin: 'device' } : message,
      ),
    };
    stubFetch({ '/api/conversations/c1': async () => json(spoken) });
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hi there')).toBeTruthy();
    // The device note ("via <device>") is plain supporting text next to the time (chat owns its wording).
    expect(screen.getAllByText(/^via (your device|.+)$/)).toHaveLength(1);
    expect(screen.queryByText('via Cardputer')).toBeNull();
  });

  it('shows the reader by name in the footer and signs out from the account menu', async () => {
    const onSignOut = vi.fn(async (): Promise<void> => {});
    const user = userEvent.setup();
    renderShell(onSignOut);
    // The greeting says "Hi, Ada", so the account row names Ada too, not the email.
    expect((await screen.findByText('Ada')).closest('.astryx-side-nav-item')).not.toBeNull();
    expect(screen.queryByText('ada@example.com')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(auth.signOutEverywhere).not.toHaveBeenCalled();
  });

  it('offers Settings and Sign out (last, after a divider) in the account menu: Sign out everywhere lives on /settings', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Settings', 'Sign out']);
    expect(screen.getAllByRole('separator').length).toBeGreaterThan(0);
    expect(auth.signOutEverywhere).not.toHaveBeenCalled();
  });

  it('opens /settings from the account menu', async () => {
    const user = userEvent.setup();
    renderShell();
    try {
      await user.click(await screen.findByRole('button', { name: 'Account menu' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Settings' }));
      expect(window.location.pathname).toBe('/settings');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('has no Appearance item or control in the sidebar: it lives on /settings', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'Account menu' });
    expect(screen.queryByRole('button', { name: 'Appearance' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Appearance' })).toBeNull();
  });

  it('collapses to an icon rail with no account text, and expands back', async () => {
    const user = userEvent.setup();
    renderShell();
    // The account row is a SideNavItem, so Astryx collapses it for us: its label
    // leaves the row and survives only as the icon's tooltip, never as text
    // clipped at the rail's edge.
    const email = (): HTMLElement => screen.getByText('Ada');
    expect((await screen.findByText('Ada')).closest('.astryx-side-nav-item')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Chats' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(await screen.findByRole('button', { name: 'Chats' })).toBeTruthy();
    expect(email().closest('.astryx-side-nav-item')).toBeNull();
    expect(email().closest('[role="tooltip"]')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    expect(email().closest('.astryx-side-nav-item')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Chats' })).toBeNull();
  });

  it('leaves a new chat as it is when New chat is pressed on one, with no message', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByText('Hi, Ada');
    const mounted = surface.mounts;
    await user.click(await screen.findByText('New chat'));
    await settle();
    expect(screen.queryByText('Already on a new chat.')).toBeNull();
    expect(surface.mounts).toBe(mounted);
    expect(window.location.pathname).toBe('/');
  });

  // P0 rail IA (redesign 2026-10): New chat, Search | Today, Calendar, Memory, Devices | Spaces | chats.
  it('orders the rail as New chat, Search, then Today, Calendar, Memory, Devices, Integrations, with no More, Connectors or Metrics', async () => {
    renderShell();
    const nav = await screen.findByRole('navigation', { name: 'Side navigation' });
    await screen.findByText('Trip plan');
    const labels = within(nav)
      .getAllByText(/^(New chat|Search|Today|Calendar|Memory|Devices|Integrations|Spaces|Trip plan)$/)
      .map((node) => node.textContent);
    expect(labels.slice(0, 7)).toEqual(['New chat', 'Search', 'Today', 'Calendar', 'Memory', 'Devices', 'Integrations']);
    expect(labels.indexOf('Trip plan')).toBeGreaterThan(6);
    for (const gone of [/^More$/, /^Connectors$/, /^Metrics$/, /^Administration$/]) {
      expect(within(nav).queryByText(gone)).toBeNull();
    }
  });

  it('shows the Search shortcut', async () => {
    renderShell();
    const search = (await screen.findByText('Search')).closest('.astryx-side-nav-item');
    expect(search?.querySelector('kbd')).not.toBeNull();
  });

  it('drops the Search shortcut hint in the phone drawer, and keeps it on desktop', async () => {
    drawer.closesOnClick = true;
    renderShell();
    const search = (await screen.findByText('Search')).closest('.astryx-side-nav-item');
    expect(search).not.toBeNull();
    expect(search?.querySelector('kbd')).toBeNull();
  });

  it('puts the drawer toggle after New chat in the phone top bar', async () => {
    drawer.closesOnClick = true;
    renderShell();
    const bar = await screen.findByRole('navigation', { name: 'Mobile navigation' });
    const controls = within(bar).getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(controls).toEqual(['New chat', 'Open navigation']);
  });

  it('has no search field in the rail; its one Search row opens the command palette', async () => {
    const opened = vi.fn();
    window.addEventListener('bob:open-palette', opened);
    try {
      const user = userEvent.setup();
      renderShell();
      const search = await screen.findByText('Search');
      // Wait for the conversation list, where the field used to sit.
      await screen.findByText('Trip plan');
      const rail = search.closest('nav');
      expect(rail).not.toBeNull();
      expect(within(rail as HTMLElement).queryByRole('textbox')).toBeNull();
      expect(within(rail as HTMLElement).queryByRole('searchbox')).toBeNull();
      await user.click(search);
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('bob:open-palette', opened);
    }
  });

  it('opens /devices from the top-level Devices item, selected there', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByRole('link', { name: 'Devices' }));
    expect(window.location.pathname).toBe('/devices');
    expect((await screen.findByRole('link', { name: 'Devices' })).getAttribute('aria-current')).toBe('page');
  });

  it('opens /integrations from the rail, selected there', async () => {
    const user = userEvent.setup();
    renderShell();
    const link = await screen.findByRole('link', { name: 'Integrations' });
    expect(link.getAttribute('href')).toBe('/integrations');
    await user.click(link);
    expect(window.location.pathname).toBe('/integrations');
    expect(await screen.findByRole('heading', { level: 1, name: 'Integrations' })).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'Integrations' })).getAttribute('aria-current')).toBe('page');
  });

  it.each([['Insights', '/insights'], ['Routines', '/routines']])('opens %s from its native rail link', async (label, path) => {
    const user = userEvent.setup();
    renderShell();
    const link = await screen.findByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe(path);
    await user.click(link);
    expect(window.location.pathname).toBe(path);
    expect(await screen.findByRole('heading', { level: 1, name: label })).toBeTruthy();
    expect(screen.getByRole('link', { name: label }).getAttribute('aria-current')).toBe('page');
  });

  it('marks Devices with a connected dot only while a device is connected', async () => {
    renderShell();
    const devices = await screen.findByRole('link', { name: 'Devices' });
    expect(devices.closest('.astryx-side-nav-item')?.querySelector('[aria-label="1 connected"]')).toBeNull();
    cleanup();
    devicesSummary.connected = 1;
    devicesSummary.total = 1;
    try {
      renderShell();
      expect(await screen.findByLabelText('1 connected')).toBeTruthy();
    } finally {
      devicesSummary.connected = 0;
      devicesSummary.total = 0;
    }
  });

  it('lands an old /pair?code= link on /devices/pair inside the shell, code kept, without a history entry', async () => {
    // The pair dialog opens over the device list; jsdom has no modal <dialog>.
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    window.history.replaceState(null, '', '/pair?code=ABCD-2345');
    const entriesBefore = window.history.length;
    renderShell();
    expect(window.location.pathname).toBe('/devices/pair');
    expect(window.location.search).toBe('?code=ABCD-2345');
    expect(window.history.length).toBe(entriesBefore);
    expect(screen.getByRole('navigation', { name: 'Side navigation' })).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'Devices' })).getAttribute('aria-current')).toBe('page');
  });

  it.each([
    ['/connectors?state=s1', '/integrations', '?state=s1', ''],
    ['/gmail?state=s1', '/integrations', '?state=s1', ''],
    ['/settings?state=s1#accounts', '/integrations', '?state=s1', ''],
    ['/account', '/settings', '', '#profile'],
    ['/usage', '/settings', '', '#usage'],
    ['/admin/monitoring?lens=ai', '/admin', '?lens=ai', '#monitoring'],
  ])('redirects a landing on %s in place, query kept', async (from, path, search, hash) => {
    window.history.replaceState(null, '', from);
    const pushState = vi.spyOn(window.history, 'pushState');
    renderShell();
    expect([window.location.pathname, window.location.search, window.location.hash]).toEqual([path, search, hash]);
    const title = path === '/settings' ? 'Settings' : path === '/integrations' ? 'Integrations' : 'Admin';
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
    expect(pushState).not.toHaveBeenCalled();
    pushState.mockRestore();
  });

  it('navigates to / with the chat landing when the brand heading is clicked from a page', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await within(screen.getByRole('navigation', { name: 'Side navigation' })).findByRole('link', { name: 'Calendar' }));
    expect(await screen.findByRole('heading', { name: 'Calendar' })).toBeTruthy();
    expect(window.location.pathname).toBe('/calendar');

    const pushState = vi.spyOn(window.history, 'pushState');
    await user.click(screen.getByRole('link', { name: 'Bob home' }));
    expect(pushState).toHaveBeenCalledWith(null, '', '/');
    expect(await screen.findByText('Hi, Ada')).toBeTruthy();
    expect(window.location.pathname).toBe('/');
    pushState.mockRestore();
  });

  it('shows the Bob brand mark in the side-nav heading, not inside a NavIcon circle', async () => {
    renderShell();
    const heading = await screen.findByRole('link', { name: 'Bob home' });
    const mark = heading.querySelector('svg[viewBox="0 0 24 24"]');
    expect(mark).not.toBeNull();
    expect(mark?.closest('.astryx-nav-icon')).toBeNull();
    expect(heading.querySelector('.astryx-nav-icon')).toBeNull();
  });

  it('remembers the rail collapse across a reload (autoSaveId)', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
    await screen.findByRole('button', { name: 'Expand sidebar' });
    cleanup();
    renderShell();
    expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    await screen.findByRole('button', { name: 'Collapse sidebar' });
  });

  it('asks before deleting, and deleting the open conversation starts a new chat', async () => {
    // jsdom has no modal <dialog>; the Astryx alert dialog calls showModal() on open.
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    stubFetch({ 'DELETE /api/conversations/c1': async () => new Response(null, { status: 204 }) });
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Conversation actions for Trip plan' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await screen.findByRole('alertdialog');
    // Nothing is deleted, and the chat stays, until it is confirmed.
    expect(requestsTo('DELETE', '/api/conversations/c1')).toHaveLength(0);
    expect(screen.getByText('hello')).toBeTruthy();

    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Hi, Ada')).toBeTruthy();
    expect(screen.queryByText('hello')).toBeNull();
    expect(window.location.pathname).toBe('/');
    expect(requestsTo('DELETE', '/api/conversations/c1')).toHaveLength(1);
  });

  it('reloads the open conversation when a message is appended to it', async () => {
    const grown = {
      ...detail,
      messages: [
        ...detail.messages,
        {
          id: 'm5',
          role: 'user',
          position: 2,
          versions: [{ id: 'v5', parts: [{ type: 'text', text: 'from the device' }], versionIndex: 0, selected: true }],
        },
      ],
    };
    let reads = 0;
    stubFetch({ '/api/conversations/c1': async () => json(++reads === 1 ? detail : grown) });
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();

    // A message in another conversation is none of this chat's business.
    emit((handlers) => handlers.onMessageAppended?.('c2', 'm7'));
    await settle();
    expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(1);

    // The device's message (m5) is not one this chat shows, so the chat refetches.
    emit((handlers) => handlers.onMessageAppended?.('c1', 'm5'));
    expect(await screen.findByText('from the device')).toBeTruthy();
    expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(2);
  });

  it('leaves the open chat alone when the event names a message it already shows', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    const mounts = surface.mounts;

    // m1 and m2 are on screen, so an event naming either is this chat's own turn.
    emit((handlers) => handlers.onMessageAppended?.('c1', 'm1'));
    emit((handlers) => handlers.onMessageAppended?.('c1', 'm2'));
    await settle();
    expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(1);
    expect(surface.mounts).toBe(mounts);
  });

  it('reloads the open conversation for a message it does not show, or one with no id', async () => {
    // The refresh only replaces the chat when it brings something new.
    let reads = 0;
    stubFetch({ '/api/conversations/c1': async () => json(++reads === 1 ? detail : grownDetail) });
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    const mounts = surface.mounts;

    emit((handlers) => handlers.onMessageAppended?.('c1', 'm9'));
    await waitFor(() => expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(2));
    await waitFor(() => expect(surface.mounts).toBe(mounts + 1));

    // A frame that names no message cannot be told from another surface's.
    emit((handlers) => handlers.onMessageAppended?.('c1', null));
    await waitFor(() => expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(3));
  });

  it('holds that reload until the open conversation\'s turn ends', async () => {
    const encoder = new TextEncoder();
    const frame = (chunk: unknown): Uint8Array =>
      encoder.encode(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`);
    // The reply is a stream the test holds open, so the turn stays in flight.
    let reply: ReadableStreamDefaultController<Uint8Array> | undefined;
    stubFetch({
      'POST /api/chat': async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              reply = controller;
              for (const chunk of [
                { type: 'start', messageId: 'a9' },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'Working on it' },
              ]) {
                controller.enqueue(frame(chunk));
              }
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } },
        ),
    });
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    await user.type(screen.getByRole('combobox', { name: 'Message input' }), 'and then?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    // The streaming reply is split across elements, so read it from the page text.
    await waitFor(() => expect(document.body.textContent).toContain('Working on it'));

    // Mid-reply: the reload would remount the surface and lose the reply. The
    // message is another surface's (unknown here), so the reload is wanted, later.
    emit((handlers) => handlers.onMessageAppended?.('c1', 'm5'));
    await settle();
    expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(1);
    expect(document.body.textContent).toContain('Working on it');

    const rest = [{ type: 'text-end', id: 't1' }, { type: 'finish', messageMetadata: { conversationId: 'c1' } }, '[DONE]'];
    for (const chunk of rest) reply?.enqueue(frame(chunk));
    reply?.close();
    // Once the turn ends the held reload runs. The surface's own check that the
    // reply was saved reads the conversation as well, so that is the third read.
    await waitFor(() => expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(3));
  });

  it('does not reload the chat when its own turn\'s event lands mid-reply and the answer ends', async () => {
    const encoder = new TextEncoder();
    const frame = (chunk: unknown): Uint8Array =>
      encoder.encode(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`);
    let reply: ReadableStreamDefaultController<Uint8Array> | undefined;
    stubFetch({
      'POST /api/chat': async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              reply = controller;
              for (const chunk of [
                { type: 'start', messageId: 'a9' },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'Working on it' },
              ]) {
                controller.enqueue(frame(chunk));
              }
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } },
        ),
    });
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    await user.type(screen.getByRole('combobox', { name: 'Message input' }), 'and then?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('Working on it'));
    const mounts = surface.mounts;

    // The server publishes the user's own message, under the id the browser sent.
    const [, init] = requestsTo('POST', '/api/chat')[0] as [unknown, RequestInit];
    const sent = JSON.parse(String(init.body)) as { message: { id: string } };
    emit((handlers) => handlers.onMessageAppended?.('c1', sent.message.id));

    const rest = [{ type: 'text-end', id: 't1' }, { type: 'finish', messageMetadata: { conversationId: 'c1' } }, '[DONE]'];
    for (const chunk of rest) reply?.enqueue(frame(chunk));
    reply?.close();
    // Only the surface's own saved-reply check reads again; no held reload follows.
    await waitFor(() => expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(2));
    await settle();
    expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(2);
    expect(surface.mounts).toBe(mounts);
  });

  // Every reply to /api/chat says its turn created conversation c9; each has its
  // own message id and text, so a second turn does not collide with the first.
  function creatingChat(): Record<string, () => Promise<Response>> {
    let replies = 0;
    return {
      'POST /api/chat': async () => {
        replies += 1;
        const chunks = [
          { type: 'start', messageId: `a${replies}` },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: `Reply ${replies}.` },
          { type: 'text-end', id: 't1' },
          { type: 'finish', messageMetadata: { conversationId: 'c9' } },
          '[DONE]',
        ];
        const frames = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
        return new Response(frames.join(''), {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
        });
      },
      '/api/conversations/c9': async () => json({ messages: [{ role: 'assistant' }] }),
    };
  }

  // A landing card only fills the composer; the reader then presses Send.
  async function sendPlanFromLanding(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(await screen.findByText('Plan my week'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false),
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
  }

  it('keeps the same chat mounted when its first reply creates the conversation', async () => {
    stubFetch(creatingChat());
    const user = userEvent.setup();
    renderShell();
    await sendPlanFromLanding(user);
    await waitFor(() => expect(window.location.pathname).toBe('/c/c9'));
    await waitFor(() => expect(document.body.textContent).toContain('Reply 1.'));
    // Adopting the id is not a remount, and the exchange that streamed stays put.
    expect(surface.mounts).toBe(1);
    expect(document.body.textContent).toContain('Plan my week');

    await user.type(screen.getByRole('combobox', { name: 'Message input' }), 'and then?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('Reply 2.'));
    const bodies = requestsTo('POST', '/api/chat').map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)) as { id?: string },
    );
    expect(bodies).toHaveLength(2);
    expect('id' in bodies[0]).toBe(false);
    expect(bodies[1].id).toBe('c9');
    expect(surface.mounts).toBe(1);
    for (const text of ['Plan my week', 'Reply 1.', 'and then?', 'Reply 2.']) {
      expect(document.body.textContent).toContain(text);
    }
  });

  it('still remounts on New chat and on picking a conversation, after one is created', async () => {
    stubFetch(creatingChat());
    const user = userEvent.setup();
    renderShell();
    await sendPlanFromLanding(user);
    await waitFor(() => expect(window.location.pathname).toBe('/c/c9'));
    await waitFor(() => expect(document.body.textContent).toContain('Reply 1.'));
    expect(surface.mounts).toBe(1);

    await user.click(screen.getByText('New chat'));
    expect(await screen.findByText('Hi, Ada')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Reply 1.');
    expect(surface.mounts).toBe(2);

    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(screen.getByText('hi there')).toBeTruthy();
    expect(surface.mounts).toBe(3);
  });

  it('refreshes the list on every deletion and starts a new chat when the open one is deleted', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    const listReads = requestsTo('GET', '/api/conversations').length;

    // Another conversation going changes the list, not the chat.
    emit((handlers) => handlers.onConversationDeleted?.('c2'));
    await waitFor(() => expect(requestsTo('GET', '/api/conversations')).toHaveLength(listReads + 1));
    expect(screen.getByText('hello')).toBeTruthy();

    emit((handlers) => handlers.onConversationDeleted?.('c1'));
    expect(await screen.findByText('Hi, Ada')).toBeTruthy();
    expect(screen.queryByText('hello')).toBeNull();
    expect(window.location.pathname).toBe('/');
    await waitFor(() => expect(requestsTo('GET', '/api/conversations')).toHaveLength(listReads + 2));
  });

  it('refreshes the list when a conversation is created or renamed', async () => {
    renderShell();
    await screen.findByText('Trip plan');
    const listReads = requestsTo('GET', '/api/conversations').length;
    emit((handlers) => handlers.onConversationUpdated?.('c1'));
    await waitFor(() => expect(requestsTo('GET', '/api/conversations')).toHaveLength(listReads + 1));
  });

  it('tells the devices page when a device changes', async () => {
    const changed = vi.fn();
    const unsubscribe = subscribeDevices(changed);
    try {
      renderShell();
      await screen.findByText('Trip plan');
      emit((handlers) => handlers.onDeviceChanged?.());
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('tells the sidebar when the active conversation moves', async () => {
    const moved = vi.fn();
    window.addEventListener('bob:active-changed', moved);
    try {
      renderShell();
      await screen.findByText('Trip plan');
      emit((handlers) => handlers.onActiveChanged?.());
      expect(moved).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('bob:active-changed', moved);
    }
  });

  it('refetches everything when the stream reopens', async () => {
    const moved = vi.fn();
    window.addEventListener('bob:active-changed', moved);
    const changed = vi.fn();
    const unsubscribe = subscribeDevices(changed);
    try {
      const user = userEvent.setup();
      renderShell();
      await user.click(await screen.findByText('Trip plan'));
      expect(await screen.findByText('hello')).toBeTruthy();
      const listReads = requestsTo('GET', '/api/conversations').length;

      emit((handlers) => handlers.onReconnect?.());
      await waitFor(() => expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(2));
      expect(requestsTo('GET', '/api/conversations')).toHaveLength(listReads + 1);
      expect(moved).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(await screen.findByText('hello')).toBeTruthy();
    } finally {
      unsubscribe();
      window.removeEventListener('bob:active-changed', moved);
    }
  });

  // What a background refresh gets once the device has added a message (m5).
  const grownDetail = {
    ...detail,
    messages: [
      ...detail.messages,
      {
        id: 'm5',
        role: 'user',
        position: 2,
        versions: [{ id: 'v5', parts: [{ type: 'text', text: 'from the device' }], versionIndex: 0, selected: true }],
      },
    ],
  };

  it('does not remount the open chat when the stream reopens and nothing changed', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    const mounts = surface.mounts;

    emit((handlers) => handlers.onReconnect?.());
    await waitFor(() => expect(requestsTo('GET', '/api/conversations/c1')).toHaveLength(2));
    await settle();
    // Fetched, found the same two messages, and left the chat as it was.
    expect(surface.mounts).toBe(mounts);
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    expect(screen.getByText('hello')).toBeTruthy();
    expect(screen.getByText('hi there')).toBeTruthy();
  });

  it('shows the new messages a background refresh brings, keeping the conversation open', async () => {
    let reads = 0;
    stubFetch({ '/api/conversations/c1': async () => json(++reads === 1 ? detail : grownDetail) });
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    const mounts = surface.mounts;

    emit((handlers) => handlers.onMessageAppended?.('c1', 'm5'));
    expect(await screen.findByText('from the device')).toBeTruthy();
    expect(surface.mounts).toBe(mounts + 1);
    expect(screen.getByText('hello')).toBeTruthy();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    expect(window.location.pathname).toBe('/c/c1');
  });

  // The server restarting behind the proxy: the first read of c1 opens the chat,
  // then `later(n)` answers the n-th background read.
  function stubRestartingServer(later: (read: number) => Response): () => number {
    let reads = 0;
    stubFetch({
      '/api/conversations/c1': async () => (++reads === 1 ? json(detail) : later(reads)),
    });
    return () => requestsTo('GET', '/api/conversations/c1').length;
  }

  // Only the timers are faked, so the fetch stub and Date stay real. Restored by
  // the caller's `finally`.
  async function openTripPlanThenFakeTimers(): Promise<void> {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByText('Trip plan'));
    expect(await screen.findByText('hello')).toBeTruthy();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('keeps the messages on screen when the refresh after a reconnect gets a 502, and retries once', async () => {
    const reads = stubRestartingServer(() => new Response(null, { status: 502 }));
    await openTripPlanThenFakeTimers();
    const mounts = surface.mounts;
    try {
      emit((handlers) => handlers.onReconnect?.());
      await vi.waitFor(() => expect(reads()).toBe(2));
      // No banner and no blank view: the chat is as it was.
      expect(screen.queryByText(LOAD_FAILED)).toBeNull();
      expect(screen.getByText('hello')).toBeTruthy();

      // One retry after 3s, which fails too; nothing is fetched after that.
      await advance(3000);
      await vi.waitFor(() => expect(reads()).toBe(3));
      await advance(30000);
      expect(reads()).toBe(3);
      expect(screen.queryByText(LOAD_FAILED)).toBeNull();
      expect(screen.getByText('hello')).toBeTruthy();
      expect(screen.getByText('hi there')).toBeTruthy();
      expect(surface.mounts).toBe(mounts);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows what the retry brings once the server is back', async () => {
    const reads = stubRestartingServer((read) => (read === 2 ? new Response(null, { status: 502 }) : json(grownDetail)));
    await openTripPlanThenFakeTimers();
    const mounts = surface.mounts;
    try {
      emit((handlers) => handlers.onMessageAppended?.('c1', 'm5'));
      await vi.waitFor(() => expect(reads()).toBe(2));
      expect(screen.queryByText('from the device')).toBeNull();
      expect(screen.getByText('hello')).toBeTruthy();

      await advance(3000);
      await vi.waitFor(() => expect(screen.getByText('from the device')).toBeTruthy());
      expect(surface.mounts).toBe(mounts + 1);
      expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the waiting retry when the reader starts a new chat', async () => {
    const reads = stubRestartingServer(() => new Response(null, { status: 502 }));
    await openTripPlanThenFakeTimers();
    try {
      emit((handlers) => handlers.onReconnect?.());
      await vi.waitFor(() => expect(reads()).toBe(2));

      // fireEvent, not userEvent: its async wrapper waits on a real setTimeout.
      fireEvent.click(screen.getByText('New chat'));
      await vi.waitFor(() => expect(screen.getByText('Hi, Ada')).toBeTruthy());
      await advance(30000);
      expect(reads()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one account-events stream open across the chat and the pages', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByText('Trip plan');
    expect(stream.open).toBe(1);

    await user.click(within(screen.getByRole('navigation', { name: 'Side navigation' })).getByRole('link', { name: 'Memory' }));
    expect(await screen.findByRole('heading', { name: 'Memory' })).toBeTruthy();
    await user.click(screen.getByText('New chat'));
    expect(await screen.findByText('Hi, Ada')).toBeTruthy();
    // Never a second stream, and never a reopened one.
    expect(stream.open).toBe(1);
    expect(stream.opened).toBe(1);
  });

  it('shows a space name in the rail', async () => {
    stubFetch({
      '/api/spaces': async () => json({ spaces: [SPACE] }),
      '/api/spaces/s1/members': async () => json({ members: [] }),
    });
    renderShell();
    expect(await screen.findByRole('link', { name: 'Home' })).toBeTruthy();
  });

  it('renders the spaces route full-height, without the page padding wrapper', async () => {
    stubFetch({
      '/api/spaces': async () => json({ spaces: [SPACE] }),
      '/api/spaces/s1/members': async () => json({ members: [] }),
      '/api/spaces/s1/threads': async () => json({ threads: [] }),
    });
    window.history.replaceState(null, '', '/spaces/s1');
    renderShell();
    // The page's own region (SpaceHeader's h1, naming the space) mounts under
    // the shell's unpadded, non-scrolling wrapper used only for route 'spaces'.
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
  });

  it('still wraps a non-spaces page in the padded scroll region', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await within(screen.getByRole('navigation', { name: 'Side navigation' })).findByRole('link', { name: 'Calendar' }));
    expect(await screen.findByRole('heading', { name: 'Calendar' })).toBeTruthy();
  });

  it('on a phone, shows one top bar with the page title and New chat, and closes the drawer when the page changes', async () => {
    drawer.closesOnClick = true;
    renderShell();
    const bar = await screen.findByRole('navigation', { name: 'Mobile navigation' });
    expect(within(bar).getByRole('button', { name: 'New chat' })).toBeTruthy();
    await settle();
    const before = drawer.closes;
    await settle();
    // Re-renders alone (a new closeMobileNav each time) never close it.
    expect(drawer.closes).toBe(before);
    act(() => navigateTo('/settings#notifications'));
    await waitFor(() => expect(drawer.closes).toBe(before + 1));
    expect(within(bar).getByText('Settings')).toBeTruthy();
  });

  it('phone drawer: one compact group, no New space row, All spaces kept', async () => {
    drawer.closesOnClick = true;
    stubFetch();
    renderShell();
    const drawerNav = await screen.findByTestId('nav-drawer');
    expect(await within(drawerNav).findByRole('link', { name: 'All spaces' })).toBeTruthy();
    expect(within(drawerNav).queryByRole('button', { name: 'New space' })).toBeNull();
    // Start and the destinations share one section: Pages has no group of its own.
    expect(within(drawerNav).queryByText('Pages')).toBeNull();
    expect(within(drawerNav).getByRole('link', { name: 'Tools' })).toBeTruthy();
  });

it('lists collaborative chats with personal chats and opens their existing conversation route', async () => {
  const chatId = '12345678-1234-4234-8234-123456789abc';
  stubFetch({ '/api/group-chats': async () => json({ chats: [{
    id: chatId, space_id: '12345678-1234-4234-8234-123456789abd', title: 'Shared weekend',
    created_by: '12345678-1234-4234-8234-123456789abe', role: 'owner', created_at: now, updated_at: now,
  }] }) });
  renderShell();
  const shared = await screen.findByRole('link', { name: 'Shared weekend' });
  expect(screen.getByRole('link', { name: 'Trip plan' })).toBeTruthy();
  expect(screen.queryByText('Group chats')).toBeNull();
  await userEvent.click(shared);
  await waitFor(() => expect(window.location.pathname).toBe(groupChatPath(chatId)));
  expect(screen.getByRole('link', { name: 'Shared weekend' }).getAttribute('aria-current')).toBe('page');
});

it('refreshes shared chat recency on the existing thread message event', async () => {
  const chatId = '12345678-1234-4234-8234-123456789abc';
  const spaceId = '12345678-1234-4234-8234-123456789abd';
  let updatedAt = now - 1000;
  stubFetch({ '/api/group-chats': async () => json({ chats: [{
    id: chatId, space_id: spaceId, title: 'Shared weekend',
    created_by: session.user.id, role: 'owner', created_at: now - 1000, updated_at: updatedAt,
  }] }) });
  renderShell();
  const shared = await screen.findByRole('link', { name: 'Shared weekend' });
  const personal = screen.getByRole('link', { name: 'Trip plan' });
  expect(personal.compareDocumentPosition(shared) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  updatedAt = now + 1000;
  emit((handlers) => handlers.onThreadMessageAppended?.(chatId, spaceId));
  await waitFor(() => expect(shared.compareDocumentPosition(personal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
  expect(stream.open).toBe(1);
});
});
