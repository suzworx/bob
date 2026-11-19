import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetSupabaseSetupForTests, SIGN_IN_UNAVAILABLE_MESSAGE } from '@/lib/auth/supabase-client';
import { resetSessionForTests } from '@/lib/auth/use-session';
import { App } from './app';
import { setThemeChoice } from './theme-choice';
import { SignIn } from '../features/account/sign-in';

vi.mock('../features/account/sign-in', async (original) => {
  const actual = await original<typeof import('../features/account/sign-in')>();
  return { ...actual, SignIn: vi.fn(actual.SignIn) };
});

// The Memory page's chunk is "gone from the server": its lazy import rejects the way Chrome reports a stale build.
// A throwing factory would be wrapped in a vitest error, so the module exposes a getter that throws instead;
// shell.tsx (which renders /memory, like every signed-in page) reads MemoryPage inside the import's .then,
// which rejects with this exact error.
// No other test in this file opens /memory, so the failing import is not cached over a working one.
vi.mock('../features/memory/memory-page', () => ({
  get MemoryPage(): never {
    throw new TypeError('Failed to fetch dynamically imported module: https://app.heybob.xyz/assets/memory-page-abc123.js');
  },
}));

const DEV_BUTTON = 'Dev sign-in (local only)';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// Answers by URL path; anything unrouted fails loudly rather than hanging.
function stubFetch(routes: Record<string, () => Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      const route = routes[url];
      if (!route) throw new Error(`unrouted fetch: ${url}`);
      return route();
    }),
  );
}

const devConfig = (): Response =>
  json({ supabaseUrl: '', supabasePublishableKey: '', pairingUrl: '', devSignIn: true });

describe('App', () => {
  beforeEach(() => {
    vi.mocked(SignIn).mockClear();
    resetSessionForTests();
    resetSupabaseSetupForTests();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    stubFetch({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the sign-in heading and the dev button when the server advertises dev sign-in', async () => {
    stubFetch({ '/api/public-config': devConfig });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in to Bob' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: DEV_BUTTON })).toBeTruthy();
  });

  it('draws lucide icons at stroke-width 1.5', async () => {
    stubFetch({
      '/api/public-config': devConfig,
      '/api/test-token': () => json({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
      '/api/conversations': () => json({ conversations: [] }),
      '/api/group-chats': () => json({ chats: [] }),
      '/api/spaces': () => json({ spaces: [] }),
    });
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole('button', { name: DEV_BUTTON }));
    await screen.findByText('New chat');
    await waitFor(() => expect(container.querySelector('svg.lucide')).not.toBeNull());
    expect(container.querySelector('svg.lucide')?.getAttribute('stroke-width')).toBe('1.5');
  });

  it('shows the unavailable message and no dev button when public-config fails', async () => {
    stubFetch({ '/api/public-config': () => new Response(null, { status: 500 }) });
    render(<App />);
    expect(await screen.findByText(SIGN_IN_UNAVAILABLE_MESSAGE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: DEV_BUTTON })).toBeNull();
  });

  it('signs in through the dev path and shows the signed-in shell', async () => {
    stubFetch({
      '/api/public-config': devConfig,
      '/api/test-token': () => json({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
      '/api/conversations': () => json({ conversations: [] }),
      '/api/group-chats': () => json({ chats: [] }),
      '/api/spaces': () => json({ spaces: [] }),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: DEV_BUTTON }));
    expect(await screen.findByText('New chat')).toBeTruthy();
    expect(await screen.findByText('No chats yet')).toBeTruthy();
    expect(screen.getByText('Sign out')).toBeTruthy();
  });

  it('shows the reset page at /reset whatever the session state', async () => {
    stubFetch({ '/api/public-config': devConfig });
    window.history.replaceState(null, '', '/reset');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Reset your password' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sign in to Bob' })).toBeNull();
  });

  it('shows the invitation at /invite/<token> while signed out', async () => {
    stubFetch({
      '/api/public-config': devConfig,
      '/api/invitations/abc': () =>
        json({
          preview: {
            space_name: 'Test Family',
            space_kind: 'group',
            inviter_display_name: 'Alice',
            exposes_history: true,
          },
        }),
    });
    window.history.replaceState(null, '', '/invite/abc');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Test Family' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sign in to Bob' })).toBeNull();
  });

  // The root Astryx Theme stamps its resolved mode on <html> as data-theme
  // ('light' | 'dark'; no attribute while it follows the system).
  describe('appearance', () => {
    const themeAttribute = (): string | null => document.documentElement.getAttribute('data-theme');

    beforeEach(() => {
      document.documentElement.removeAttribute('data-theme');
      stubFetch({ '/api/public-config': devConfig });
    });

    it.each(['light', 'dark'] as const)('gives the Theme the stored %s mode', async (stored) => {
      window.localStorage.setItem('bob.theme', stored);
      render(<App />);
      await screen.findByRole('heading', { name: 'Sign in to Bob' });
      expect(themeAttribute()).toBe(stored);
    });

    it('leaves the Theme on the system mode when nothing is stored', async () => {
      render(<App />);
      await screen.findByRole('heading', { name: 'Sign in to Bob' });
      expect(themeAttribute()).toBeNull();
    });

    it('moves the Theme when the choice changes while the app is open', async () => {
      render(<App />);
      await screen.findByRole('heading', { name: 'Sign in to Bob' });
      act(() => setThemeChoice('dark'));
      expect(themeAttribute()).toBe('dark');
      act(() => setThemeChoice('light'));
      expect(themeAttribute()).toBe('light');
      act(() => setThemeChoice('system'));
      expect(themeAttribute()).toBeNull();
    });
  });

  it('keeps a signed-out visitor on the sign-in surface at a page route', async () => {
    stubFetch({ '/api/public-config': devConfig });
    window.history.replaceState(null, '', '/spaces');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in to Bob' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Spaces' })).toBeNull();
  });

  it('keeps deep-route navigation inside the sign-in frame and removes it at home', async () => {
    stubFetch({ '/api/public-config': devConfig });
    window.history.replaceState(null, '', '/calendar');
    const user = userEvent.setup();
    render(<App />);
    const backHome = await screen.findByRole('button', { name: 'Back to home' });
    expect(vi.mocked(SignIn).mock.lastCall?.[0]).toEqual(expect.objectContaining({ backHome: expect.anything() }));
    await user.click(backHome);
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByRole('button', { name: 'Back to home' })).toBeNull();
    expect(vi.mocked(SignIn).mock.lastCall?.[0]).not.toHaveProperty('backHome');
  });

  it('shows no Back to home button on / while signed out', async () => {
    stubFetch({ '/api/public-config': devConfig });
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in to Bob' });
    expect(screen.queryByRole('button', { name: 'Back to home' })).toBeNull();
  });

  it('shows a reload prompt, not a blank root, when a lazy page chunk is gone after a deploy', async () => {
    stubFetch({
      '/api/public-config': devConfig,
      '/api/test-token': () => json({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
    });
    window.history.replaceState(null, '', '/memory');
    // React logs every error an error boundary catches; keep the expected one out of the test output.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const user = userEvent.setup();
      const { container } = render(<App />);
      await user.click(await screen.findByRole('button', { name: DEV_BUTTON }));
      expect(await screen.findByText('A new version of Bob is available')).toBeTruthy();
      expect(screen.getByText('Reload to get it.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
      expect(container.childElementCount).toBeGreaterThan(0);
    } finally {
      consoleError.mockRestore();
    }
  });
});
