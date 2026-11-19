import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthApiError, AuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';
import { resetSupabaseSetupForTests } from '@/lib/auth/supabase-client';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

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

const publicConfig = (): Response =>
  json({
    supabaseUrl: 'http://localhost:54321',
    supabasePublishableKey: 'pk_test',
    pairingUrl: '',
    devSignIn: false,
  });

// Forgot password lives on the password form.
async function openForgot(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Use password' }));
  await user.click(await screen.findByRole('button', { name: 'Forgot password?' }));
}

describe('SignIn: Forgot password', () => {
  beforeEach(() => {
    resetSupabaseSetupForTests();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    stubFetch({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows forgot password button in password mode only', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    const { SignIn } = await import('./sign-in');
    const user = userEvent.setup();
    render(<SignIn unavailable={null} />);
    await screen.findByRole('textbox', { name: 'Email' });
    expect(screen.queryByRole('button', { name: 'Forgot password?' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Use password' }));
    expect(await screen.findByRole('button', { name: 'Forgot password?' })).toBeTruthy();
  });

  it('shows forgot password form when button is clicked', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    const { SignIn } = await import('./sign-in');
    const user = userEvent.setup();
    render(<SignIn unavailable={null} />);
    await openForgot(user);
    expect(await screen.findByRole('button', { name: 'Send reset link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeTruthy();
  });

  it('returns to sign in when back button is clicked', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    const { SignIn } = await import('./sign-in');
    const user = userEvent.setup();
    render(<SignIn unavailable={null} />);
    await openForgot(user);
    const backButton = await screen.findByRole('button', { name: 'Back to sign in' });
    await user.click(backButton);
    expect(await screen.findByRole('button', { name: 'Use password' })).toBeTruthy();
  });

  it('shows empty email error when send is clicked with no email', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    const { SignIn } = await import('./sign-in');
    const user = userEvent.setup();
    render(<SignIn unavailable={null} />);
    await openForgot(user);
    const sendButton = await screen.findByRole('button', { name: 'Send reset link' });
    await user.click(sendButton);
    expect(await screen.findByText('Enter your email address first.')).toBeTruthy();
  });

  it('shows the neutral failure and re-enables the button when the reset request rejects', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    const { SignIn } = await import('./sign-in');
    const { getSupabaseSetup } = await import('@/lib/auth/supabase-client');
    const user = userEvent.setup();
    render(<SignIn unavailable={null} />);
    await openForgot(user);
    // The client is the one SignIn resolved, so the spy sits on what the form calls.
    const setup = await getSupabaseSetup();
    if (setup.status !== 'ready') throw new Error('expected a ready sign-in setup');
    const reset = vi
      .spyOn(setup.client.auth, 'resetPasswordForEmail')
      .mockRejectedValue(new Error('network down'));
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'me@example.com');

    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('Sign-in failed. Check your details and try again.')).toBeTruthy();
    expect(reset).toHaveBeenCalledTimes(1);

    // Busy cleared: a second click reaches the provider again instead of being swallowed.
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(reset).toHaveBeenCalledTimes(2);
  });
});

const noSession = { user: null, session: null } as const;
const providerError = (status: number, code: string): AuthApiError => new AuthApiError('provider detail', status, code);
const SENT_NOTICE = 'Check your email for a sign-in code or a magic link.';
const NEUTRAL_ERROR = 'Sign-in failed. Check your details and try again.';

// Renders the ready form with an email typed in. The returned auth is the one
// SignIn resolved, so the spies sit on what the form calls.
async function renderReadyForm(
  typedEmail = 'me@example.com',
): Promise<{ user: ReturnType<typeof userEvent.setup>; auth: SupabaseClient['auth'] }> {
  stubFetch({ '/api/public-config': publicConfig });
  const { SignIn } = await import('./sign-in');
  const { getSupabaseSetup } = await import('@/lib/auth/supabase-client');
  const user = userEvent.setup();
  render(<SignIn unavailable={null} />);
  const email = await screen.findByRole('textbox', { name: 'Email' });
  const setup = await getSupabaseSetup();
  if (setup.status !== 'ready') throw new Error('expected a ready sign-in setup');
  await user.type(email, typedEmail);
  return { user, auth: setup.client.auth };
}

describe('SignIn: provider errors', () => {
  beforeEach(() => {
    resetSupabaseSetupForTests();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [37, 'seconds'],
    [1, 'second'],
  ])('says how long to wait when the per-email cooldown (%i %s) blocks a send', async (seconds, unit) => {
    const { user, auth } = await renderReadyForm();
    vi.spyOn(auth, 'signInWithOtp').mockResolvedValue({
      data: noSession,
      error: new AuthApiError(
        `For security purposes, you can only request this after ${seconds} ${unit}.`,
        429,
        'over_email_send_rate_limit',
      ),
    });
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(`Wait ${seconds} ${unit}, then request a new code.`)).toBeTruthy();
    expect(screen.queryByText(/For security purposes/)).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Six-digit code' })).toBeTruthy();
    expect(screen.queryByText(SENT_NOTICE)).toBeNull();
  });

  it('says the hourly email cap was hit and still lets a code from an earlier email be entered', async () => {
    const { user, auth } = await renderReadyForm();
    vi.spyOn(auth, 'signInWithOtp').mockResolvedValue({
      data: noSession,
      error: new AuthApiError('email rate limit exceeded', 429, 'over_email_send_rate_limit'),
    });
    const verify = vi.spyOn(auth, 'verifyOtp').mockResolvedValue({ data: noSession, error: null });
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(
      await screen.findByText(
        'Too many sign-in emails were sent recently. Use a code you already received, try again later, or sign in with your password.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('email rate limit exceeded')).toBeNull();
    expect(screen.queryByText(SENT_NOTICE)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send a new code' })).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: 'Six-digit code' }), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(verify).toHaveBeenCalledWith({ email: 'me@example.com', token: '123456', type: 'email' });
  });

  it('tells the user to wait a few minutes on a bare 429', async () => {
    const { user, auth } = await renderReadyForm();
    vi.spyOn(auth, 'signInWithOtp').mockResolvedValue({
      data: noSession,
      error: new AuthApiError('provider detail', 429, undefined),
    });
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('Too many attempts. Wait a few minutes, then try again.')).toBeTruthy();
    expect(screen.queryByText('provider detail')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Six-digit code' })).toBeTruthy();
  });

  it('goes straight to code entry for "I have a code" without sending anything', async () => {
    const { user, auth } = await renderReadyForm();
    const send = vi.spyOn(auth, 'signInWithOtp').mockResolvedValue({ data: noSession, error: null });
    await user.click(screen.getByRole('button', { name: 'I have a code' }));
    expect(await screen.findByRole('textbox', { name: 'Six-digit code' })).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText(SENT_NOTICE)).toBeNull();
  });

  it('asks phones for the number keypad on the code field', async () => {
    const { user } = await renderReadyForm();
    await user.click(screen.getByRole('button', { name: 'I have a code' }));
    const field = await screen.findByRole('textbox', { name: 'Six-digit code' });
    expect(field.getAttribute('inputmode')).toBe('numeric');
    expect(field.getAttribute('autocomplete')).toBe('one-time-code');
  });

  it('needs an email before "I have a code" moves on', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    const { SignIn } = await import('./sign-in');
    const user = userEvent.setup();
    render(<SignIn unavailable={null} />);
    await user.click(await screen.findByRole('button', { name: 'I have a code' }));
    expect(await screen.findByText('Enter your email address first.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Six-digit code' })).toBeNull();
  });

  it('offers a new code when verifying fails as wrong or expired', async () => {
    const { user, auth } = await renderReadyForm();
    const send = vi.spyOn(auth, 'signInWithOtp').mockResolvedValue({ data: noSession, error: null });
    vi.spyOn(auth, 'verifyOtp').mockResolvedValue({ data: noSession, error: providerError(403, 'otp_expired') });
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByRole('textbox', { name: 'Six-digit code' }), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('That code is wrong or has expired. Request a new code.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Six-digit code' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Send a new code' }));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('shows the connection message when the request throws or cannot reach the service', async () => {
    const { user, auth } = await renderReadyForm();
    const send = vi.spyOn(auth, 'signInWithOtp').mockRejectedValue(new TypeError('Failed to fetch'));
    const message = "Couldn't reach the sign-in service. Check your connection and try again.";
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(message)).toBeTruthy();

    send.mockResolvedValue({ data: noSession, error: new AuthRetryableFetchError('offline', 0) });
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    [422, 'otp_disabled'],
    [422, 'signup_disabled'],
    [400, 'user_not_found'],
    [422, 'validation_failed'],
  ])('answers an unknown email (%i %s) exactly like a sent code', async (status, code) => {
    const { user, auth } = await renderReadyForm();
    vi.spyOn(auth, 'signInWithOtp').mockResolvedValue({ data: noSession, error: providerError(status, code) });
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(SENT_NOTICE)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Six-digit code' })).toBeTruthy();
    expect(screen.queryByText(NEUTRAL_ERROR)).toBeNull();
  });

  it('keeps a wrong password neutral', async () => {
    const { user, auth } = await renderReadyForm();
    vi.spyOn(auth, 'signInWithPassword').mockResolvedValue({
      data: noSession,
      error: providerError(400, 'invalid_credentials'),
    });
    await user.click(screen.getByRole('button', { name: 'Use password' }));
    await user.type(screen.getByLabelText('Password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Sign in with password' }));
    expect(await screen.findByText(NEUTRAL_ERROR)).toBeTruthy();
  });
});

const INVALID_EMAIL_MESSAGE = 'Enter a valid email address, like you@example.com.';
const CODE_REQUIRED_MESSAGE = 'Enter the 6-digit code from your email.';

// #864, #865: a malformed address or a missing code is a local check, so it is
// answered on the field without calling the provider. A well-formed address
// with no account still gets the neutral notice (see "answers an unknown email").
describe('SignIn: local field checks', () => {
  beforeEach(() => {
    resetSupabaseSetupForTests();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a malformed email on the field without sending a code', async () => {
    const { user, auth } = await renderReadyForm('qa-invalid');
    const send = vi.spyOn(auth, 'signInWithOtp').mockResolvedValue({ data: noSession, error: null });
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(INVALID_EMAIL_MESSAGE)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Email' }).getAttribute('aria-invalid')).toBe('true');
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText(SENT_NOTICE)).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Six-digit code' })).toBeNull();
  });

  it('rejects a malformed email for "I have a code" too, and clears the error on edit', async () => {
    const { user } = await renderReadyForm('qa-invalid');
    await user.click(screen.getByRole('button', { name: 'I have a code' }));
    expect(await screen.findByText(INVALID_EMAIL_MESSAGE)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Six-digit code' })).toBeNull();

    await user.type(screen.getByRole('textbox', { name: 'Email' }), '@example.com');
    expect(screen.queryByText(INVALID_EMAIL_MESSAGE)).toBeNull();
  });

  it('keeps the neutral notice for a well-formed address with no account', async () => {
    const { user, auth } = await renderReadyForm('nobody@example.com');
    const send = vi
      .spyOn(auth, 'signInWithOtp')
      .mockResolvedValue({ data: noSession, error: providerError(422, 'otp_disabled') });
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(SENT_NOTICE)).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(INVALID_EMAIL_MESSAGE)).toBeNull();
  });

  it('asks for the code on Verify with an empty code, without the generic error or the sent notice', async () => {
    const { user, auth } = await renderReadyForm();
    vi.spyOn(auth, 'signInWithOtp').mockResolvedValue({ data: noSession, error: null });
    const verify = vi.spyOn(auth, 'verifyOtp').mockResolvedValue({ data: noSession, error: null });
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(SENT_NOTICE)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(CODE_REQUIRED_MESSAGE)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Six-digit code' }).getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText(NEUTRAL_ERROR)).toBeNull();
    expect(screen.queryByText(SENT_NOTICE)).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it('asks for the whole code when it is too short', async () => {
    const { user, auth } = await renderReadyForm();
    const verify = vi.spyOn(auth, 'verifyOtp').mockResolvedValue({ data: noSession, error: null });
    await user.click(screen.getByRole('button', { name: 'I have a code' }));
    await user.type(await screen.findByRole('textbox', { name: 'Six-digit code' }), '123');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(CODE_REQUIRED_MESSAGE)).toBeTruthy();
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('SignIn: invite-only waitlist hint', () => {
  beforeEach(() => {
    resetSupabaseSetupForTests();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the waitlist link on the code form', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    const { SignIn } = await import('./sign-in');
    render(<SignIn unavailable={null} />);
    const link = await screen.findByRole('link', { name: /Join the waitlist/ });
    expect(link.getAttribute('href')).toBe('https://heybob.xyz');
  });

  it('shows the waitlist link on the password form', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    const { SignIn } = await import('./sign-in');
    const user = userEvent.setup();
    render(<SignIn unavailable={null} />);
    await user.click(await screen.findByRole('button', { name: 'Use password' }));
    const link = await screen.findByRole('link', { name: /Join the waitlist/ });
    expect(link.getAttribute('href')).toBe('https://heybob.xyz');
  });

  it('keeps showing the same notice and link whether the send succeeded or the address has no account', async () => {
    const { user, auth } = await renderReadyForm();
    const send = vi.spyOn(auth, 'signInWithOtp').mockResolvedValue({ data: noSession, error: null });
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(SENT_NOTICE)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Join the waitlist/ }).getAttribute('href')).toBe(
      'https://heybob.xyz',
    );

    send.mockResolvedValue({ data: noSession, error: providerError(422, 'otp_disabled') });
    await user.click(screen.getByRole('button', { name: 'Send a new code' }));
    expect(await screen.findByText(SENT_NOTICE)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Join the waitlist/ }).getAttribute('href')).toBe(
      'https://heybob.xyz',
    );
  });

  it('does not show the hint on the reset-request screen', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    const { SignIn } = await import('./sign-in');
    const user = userEvent.setup();
    render(<SignIn unavailable={null} />);
    await openForgot(user);
    await screen.findByRole('button', { name: 'Send reset link' });
    expect(screen.queryByRole('link', { name: /Join the waitlist/ })).toBeNull();
  });
});
