import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Bob's split welcome + sign-in (approved design B). Each test re-imports the modules for a fresh setup.
const publicConfig = (devSignIn = false): Response =>
  new Response(
    JSON.stringify({ supabaseUrl: 'http://localhost:54321', supabasePublishableKey: 'pk_test', pairingUrl: '', devSignIn }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function stubConfig(config: () => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      if (url === '/api/public-config') return config();
      throw new Error(`unrouted fetch: ${url}`);
    }),
  );
}

async function renderSignIn(props: { unavailable?: string | null; backHome?: React.ReactNode } = {}): Promise<ReturnType<typeof userEvent.setup>> {
  window.sessionStorage.clear();
  vi.resetModules();
  const { resetSupabaseSetupForTests } = await import('@/lib/auth/supabase-client');
  resetSupabaseSetupForTests();
  const { SignIn } = await import('./sign-in');
  const user = userEvent.setup();
  render(<SignIn unavailable={props.unavailable ?? null} backHome={props.backHome} />);
  return user;
}

describe('SignIn: Bob split welcome', () => {
  beforeEach(() => stubConfig(() => publicConfig()));
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('greets with the hero, the big Bob art and the form heading', async () => {
    await renderSignIn();
    expect(await screen.findByRole('heading', { name: 'Hello again, friend.' })).toBeTruthy();
    expect(screen.getByText('A little help. A little brighter day.')).toBeTruthy();
    const art = screen.getByRole('img', { name: /bob/i });
    expect(art.getAttribute('src')).toContain('/brand/bob/bob-playful.webp');
    expect(screen.getByRole('heading', { name: 'Sign in to Bob' })).toBeTruthy();
    expect(screen.getByText('We’ll email you a sign-in code.')).toBeTruthy();
  });

  it('keeps every sign-in action reachable', async () => {
    const user = await renderSignIn();
    for (const name of ['Send code', 'I have a code', 'Use password']) {
      expect(await screen.findByRole('button', { name })).toBeTruthy();
    }
    await user.click(screen.getByRole('button', { name: 'Use password' }));
    expect(screen.getByRole('button', { name: 'Sign in with password' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use a code instead' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByRole('button', { name: 'Send reset link' })).toBeTruthy();
    expect(screen.getByText('We’ll email you a password reset link.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Hello again, friend.' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    await user.type(await screen.findByRole('textbox', { name: 'Email' }), 'me@example.com');
    await user.click(await screen.findByRole('button', { name: 'I have a code' }));
    expect(await screen.findByRole('button', { name: 'Verify' })).toBeTruthy();
    expect(screen.getByText('Enter the code from your email.')).toBeTruthy();
  });

  it('keeps the hero when moving to code entry', async () => {
    const user = await renderSignIn({ unavailable: null });
    expect(screen.getByRole('heading', { name: 'Hello again, friend.' })).toBeTruthy();
    await user.type(await screen.findByRole('textbox', { name: 'Email' }), 'me@example.com');
    await user.click(screen.getByRole('button', { name: 'I have a code' }));
    expect(await screen.findByRole('button', { name: 'Verify' })).toBeTruthy();
    expect(screen.getByText('Enter the code from your email.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Hello again, friend.' })).toBeTruthy();
  });

  it('keeps a neutral loading frame and the back-home action while setup is pending', async () => {
    stubConfig(() => new Promise<Response>(() => {}));
    await renderSignIn({ backHome: <button type="button">Back home</button> });
    expect(screen.getByLabelText('Loading sign-in')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Hello again, friend.' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back home' })).toBeTruthy();
    expect(screen.queryByText('We’ll email you a sign-in code.')).toBeNull();
  });

  it('shows the hero when sign-in is unavailable', async () => {
    stubConfig(() => new Response('nope', { status: 500 }));
    await renderSignIn({ unavailable: 'Sign-in is not available right now.' });
    expect(await screen.findByText('Sign-in is not available right now.')).toBeTruthy();
    expect(screen.queryByText('We’ll email you a sign-in code.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Hello again, friend.' })).toBeTruthy();
  });

  it('points the waitlist link at the Bob site', async () => {
    await renderSignIn();
    const link = await screen.findByRole('link', { name: /Join the waitlist/ });
    expect(link.getAttribute('href')).toBe('https://heybob.xyz');
  });

  it('renders the optional back-home slot inside the frame, while loading and when ready', async () => {
    await renderSignIn({ backHome: <button type="button">Back home</button> });
    expect(screen.getByRole('button', { name: 'Back home' })).toBeTruthy();
    await screen.findByRole('textbox', { name: 'Email' });
    expect(screen.getByRole('button', { name: 'Back home' })).toBeTruthy();
  });
});
