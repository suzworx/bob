import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme, generateThemeCSS } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { resetSupabaseSetupForTests } from '@/lib/auth/supabase-client';
import { resetSessionForTests } from '@/lib/auth/use-session';
import { App } from './app';
import { AppearanceControl } from './appearance-control';
import { THEME_OPTIONS } from './bob-theme';
import { resetThemeChoiceForTests, setThemeChoice } from './theme-choice';

const KEY = 'bob.theme';

function renderControl(): HTMLElement {
  render(
    <Theme theme={neutralTheme} mode="system">
      <AppearanceControl />
    </Theme>,
  );
  return screen.getByRole('radiogroup', { name: 'Appearance' });
}

// The SegmentedControl is a radio group: exactly one option is checked.
function pressed(group: HTMLElement): Record<string, string | null> {
  return Object.fromEntries(
    within(group)
      .getAllByRole('radio')
      .map((radio) => [radio.textContent ?? '', radio.getAttribute('aria-checked')]),
  );
}

describe('AppearanceControl', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetThemeChoiceForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a group named Appearance with System, Light and Dark, System pressed by default', () => {
    const group = renderControl();
    expect(pressed(group)).toEqual({ System: 'true', Light: 'false', Dark: 'false' });
  });

  it('stores dark when Dark is pressed and marks it pressed', async () => {
    const user = userEvent.setup();
    const group = renderControl();
    await user.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(window.localStorage.getItem(KEY)).toBe('dark');
    expect(pressed(group)).toEqual({ System: 'false', Light: 'false', Dark: 'true' });
  });

  it('stores light, and removes the key when System is pressed', async () => {
    const user = userEvent.setup();
    const group = renderControl();
    await user.click(within(group).getByRole('radio', { name: 'Light' }));
    expect(window.localStorage.getItem(KEY)).toBe('light');
    await user.click(within(group).getByRole('radio', { name: 'System' }));
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(pressed(group)).toEqual({ System: 'true', Light: 'false', Dark: 'false' });
  });

  it('keeps the choice when the pressed option is pressed again', async () => {
    const user = userEvent.setup();
    const group = renderControl();
    await user.click(within(group).getByRole('radio', { name: 'Dark' }));
    await user.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(window.localStorage.getItem(KEY)).toBe('dark');
    expect(pressed(group)).toEqual({ System: 'false', Light: 'false', Dark: 'true' });
  });

  it('starts from the stored choice', () => {
    window.localStorage.setItem(KEY, 'light');
    const group = renderControl();
    expect(pressed(group)).toEqual({ System: 'false', Light: 'true', Dark: 'false' });
  });

  it('follows the store when the choice changes elsewhere', () => {
    const group = renderControl();
    act(() => setThemeChoice('dark'));
    expect(pressed(group)).toEqual({ System: 'false', Light: 'false', Dark: 'true' });
    act(() => setThemeChoice('system'));
    expect(pressed(group)).toEqual({ System: 'true', Light: 'false', Dark: 'false' });
  });

  it('still applies the choice for the session when storage is blocked', async () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const user = userEvent.setup();
    const group = renderControl();
    await user.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(pressed(group)).toEqual({ System: 'false', Light: 'false', Dark: 'true' });
  });

  it('offers no theme picker: the theme is the brand\'s own', () => {
    renderControl();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('the App wears the chosen theme', () => {
  beforeEach(() => {
    resetSessionForTests();
    resetSupabaseSetupForTests();
    resetThemeChoiceForTests();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    const routes: Record<string, () => Response> = {
      '/api/public-config': () => json({ supabaseUrl: '', supabasePublishableKey: '', pairingUrl: '', devSignIn: true }),
      '/api/test-token': () => json({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
      '/api/conversations': () => json({ conversations: [] }),
      '/api/spaces': () => json({ spaces: [] }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
        const route = routes[url];
        if (!route) throw new Error(`unrouted fetch: ${url}`);
        return route();
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Menus, popovers and dialogs render outside the Theme's element. Astryx's root Theme mirrors its
  // theme name onto <html data-astryx-theme>, so their content is themed by <html> and app.tsx needs
  // no extra sync; this test fails if that ever stops being true.
  it('names the brand theme in data-astryx-theme, on the Theme element and on portal content, in either mode', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Dev sign-in (local only)' }));
    await screen.findByRole('button', { name: 'Account menu' });
    const rootName = (): string | null => document.documentElement.getAttribute('data-astryx-theme');
    const wrapperName = (): string | null => container.querySelector('[data-astryx-theme]')?.getAttribute('data-astryx-theme') ?? null;
    expect([rootName(), wrapperName()]).toEqual(['bob', 'bob']);

    act(() => setThemeChoice('dark'));
    expect([rootName(), wrapperName()]).toEqual(['bob', 'bob']);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    // jsdom cannot portal an Astryx popover (a Layer portals only when an ancestor cannot contain it;
    // Dialog mounts in place), so a node appended to <body> stands in for portal content. The theme's
    // token CSS is scoped to [data-astryx-theme="<name>"], and <html> carries that attribute, so it reaches it.
    const portalled = document.body.appendChild(document.createElement('div'));
    expect(container.contains(portalled)).toBe(false);
    expect(portalled.closest('[data-astryx-theme]')?.getAttribute('data-astryx-theme')).toBe('bob');
    portalled.remove();
    const { prose, component } = generateThemeCSS(THEME_OPTIONS[0]!.theme);
    expect(`${prose}${component}`).toContain('@scope ([data-astryx-theme="bob"])');

    act(() => setThemeChoice('light'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
