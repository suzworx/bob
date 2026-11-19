import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as supabaseClient from '@/lib/auth/supabase-client';
import { resetSessionForTests } from '@/lib/auth/use-session';
import { ResetPage } from './reset-page';

vi.mock('../../app/routes', () => ({ navigateTo: vi.fn() }));

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

function mockSupabaseSetup(client: SupabaseClient): void {
  vi.spyOn(supabaseClient, 'getSupabaseSetup').mockResolvedValue({
    status: 'ready',
    client,
    devSignIn: false,
  });
}

// A token shaped like a reset link's: its `amr` says `recovery`.
function recoveryToken(): string {
  const payload = btoa(JSON.stringify({ amr: [{ method: 'recovery', timestamp: 1 }] })).replace(/=+$/, '');
  return `header.${payload}.sig`;
}

function createMockSupabaseClient(
  updateUserFn?: () => PromiseLike<{ error: unknown }>,
  { recovery = true }: { recovery?: boolean } = {},
): SupabaseClient {
  const mockSession = {
    access_token: 'mock_token',
    token_type: 'bearer',
    expires_in: 3600,
    user: { id: 'user-id', email: 'test@example.com' },
  };
  if (recovery) mockSession.access_token = recoveryToken();
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: mockSession } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
      updateUser: updateUserFn || vi.fn().mockResolvedValue({ error: null }),
    },
  } as unknown as SupabaseClient;
}

describe('ResetPage', () => {
  beforeEach(() => {
    resetSessionForTests();
    vi.resetAllMocks();
    window.localStorage.clear();
    stubFetch({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows no-session message when not signed in', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    vi.spyOn(supabaseClient, 'getSupabaseSetup').mockResolvedValue({
      status: 'unavailable',
      message: 'Not available',
      devSignIn: false,
    });
    render(<ResetPage />);
    expect(await screen.findByText('Open the password reset link from your email to set a new password.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send a new link' })).toBeTruthy();
  });

  it('refuses the password form to an ordinary signed-in session and points to Settings', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    const updateUser = vi.fn();
    mockSupabaseSetup(createMockSupabaseClient(updateUser, { recovery: false }));
    render(<ResetPage />);
    expect(await screen.findByRole('button', { name: 'Go to Settings' })).toBeTruthy();
    expect(screen.queryByLabelText('New password')).toBeNull();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('explains an expired link and offers a new one', async () => {
    window.history.replaceState(null, '', '/reset#error=access_denied&error_code=otp_expired');
    stubFetch({ '/api/public-config': publicConfig });
    vi.spyOn(supabaseClient, 'getSupabaseSetup').mockResolvedValue({ status: 'unavailable', message: 'x', devSignIn: false });
    render(<ResetPage />);
    expect(await screen.findByRole('heading', { name: 'This reset link has expired' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send a new link' })).toBeTruthy();
    window.history.replaceState(null, '', '/');
  });

  it('shows password form heading when page renders', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    vi.spyOn(supabaseClient, 'getSupabaseSetup').mockResolvedValue({
      status: 'unavailable',
      message: 'Not available',
      devSignIn: false,
    });
    render(<ResetPage />);
    expect(await screen.findByRole('heading', { name: 'Reset your password' })).toBeTruthy();
  });

  it('validates minimum password length (9 chars shows error)', async () => {
    stubFetch({ '/api/public-config': publicConfig, '/api/test-token': () => json({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 }) });
    const mockUpdateUser = vi.fn();
    const mockClient = createMockSupabaseClient(() => Promise.resolve({ error: null }));
    (mockClient.auth as unknown as { updateUser: typeof mockUpdateUser }).updateUser = mockUpdateUser;
    mockSupabaseSetup(mockClient);
    const user = userEvent.setup();
    render(<ResetPage />);
    const passwordInput1 = await screen.findByLabelText('New password');
    const passwordInput2 = await screen.findByLabelText('Confirm new password');
    const submitButton = await screen.findByRole('button', { name: /Update password/i });
    await user.type(passwordInput1, 'Pass9ch');
    await user.type(passwordInput2, 'Pass9ch');
    await user.click(submitButton);
    expect(await screen.findByText('Password must be at least 10 characters.')).toBeTruthy();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('validates password requirements (10 lowercase-only shows error)', async () => {
    stubFetch({ '/api/public-config': publicConfig, '/api/test-token': () => json({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 }) });
    const mockUpdateUser = vi.fn();
    const mockClient = createMockSupabaseClient(() => Promise.resolve({ error: null }));
    (mockClient.auth as unknown as { updateUser: typeof mockUpdateUser }).updateUser = mockUpdateUser;
    mockSupabaseSetup(mockClient);
    const user = userEvent.setup();
    render(<ResetPage />);
    const passwordInput1 = await screen.findByLabelText('New password');
    const passwordInput2 = await screen.findByLabelText('Confirm new password');
    const submitButton = await screen.findByRole('button', { name: /Update password/i });
    await user.type(passwordInput1, 'lowercase10');
    await user.type(passwordInput2, 'lowercase10');
    await user.click(submitButton);
    expect(await screen.findByText('Password needs an upper-case letter, a lower-case letter and a number.')).toBeTruthy();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('validates password confirmation mismatch', async () => {
    stubFetch({ '/api/public-config': publicConfig, '/api/test-token': () => json({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 }) });
    const mockUpdateUser = vi.fn();
    const mockClient = createMockSupabaseClient(() => Promise.resolve({ error: null }));
    (mockClient.auth as unknown as { updateUser: typeof mockUpdateUser }).updateUser = mockUpdateUser;
    mockSupabaseSetup(mockClient);
    const user = userEvent.setup();
    render(<ResetPage />);
    const passwordInput1 = await screen.findByLabelText('New password');
    const passwordInput2 = await screen.findByLabelText('Confirm new password');
    const submitButton = await screen.findByRole('button', { name: /Update password/i });
    await user.type(passwordInput1, 'Password123');
    await user.type(passwordInput2, 'Password456');
    await user.click(submitButton);
    expect(await screen.findByText('Passwords do not match.')).toBeTruthy();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('shows success state when password is updated', async () => {
    stubFetch({ '/api/public-config': publicConfig, '/api/test-token': () => json({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 }) });
    const mockUpdateUser = vi.fn().mockResolvedValue({ error: null });
    const mockClient = createMockSupabaseClient(() => Promise.resolve({ error: null }));
    (mockClient.auth as unknown as { updateUser: typeof mockUpdateUser }).updateUser = mockUpdateUser;
    mockSupabaseSetup(mockClient);
    const user = userEvent.setup();
    render(<ResetPage />);
    const passwordInput1 = await screen.findByLabelText('New password');
    const passwordInput2 = await screen.findByLabelText('Confirm new password');
    const submitButton = await screen.findByRole('button', { name: /Update password/i });
    await user.type(passwordInput1, 'Password123');
    await user.type(passwordInput2, 'Password123');
    await user.click(submitButton);
    expect(await screen.findByText('Your password has been changed.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Continue to Bob' })).toBeTruthy();
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'Password123' });
  });

  it('shows failure message when update returns error', async () => {
    stubFetch({ '/api/public-config': publicConfig, '/api/test-token': () => json({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 }) });
    const mockUpdateUser = vi.fn().mockResolvedValue({ error: new Error('Update failed') });
    const mockClient = createMockSupabaseClient(() => Promise.resolve({ error: new Error('Update failed') }));
    (mockClient.auth as unknown as { updateUser: typeof mockUpdateUser }).updateUser = mockUpdateUser;
    mockSupabaseSetup(mockClient);
    const user = userEvent.setup();
    render(<ResetPage />);
    const passwordInput1 = await screen.findByLabelText('New password');
    const passwordInput2 = await screen.findByLabelText('Confirm new password');
    const submitButton = await screen.findByRole('button', { name: /Update password/i });
    await user.type(passwordInput1, 'Password123');
    await user.type(passwordInput2, 'Password123');
    await user.click(submitButton);
    expect(await screen.findByText('The password could not be updated. Try again.')).toBeTruthy();
    expect(mockUpdateUser).toHaveBeenCalled();
  });

  it('shows the failure message and frees the button when the update rejects', async () => {
    stubFetch({ '/api/public-config': publicConfig });
    const mockUpdateUser = vi.fn().mockRejectedValue(new Error('network down'));
    mockSupabaseSetup(createMockSupabaseClient(mockUpdateUser));
    const user = userEvent.setup();
    render(<ResetPage />);
    await user.type(await screen.findByLabelText('New password'), 'Password123');
    await user.type(await screen.findByLabelText('Confirm new password'), 'Password123');
    await user.click(await screen.findByRole('button', { name: /Update password/i }));
    expect(await screen.findByText('The password could not be updated. Try again.')).toBeTruthy();
    // While busy the label reads "Updating…", so this name only matches once busy clears.
    const retry = await screen.findByRole('button', { name: 'Update password' });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'Password123' });
  });

  it('updates the password exactly once when Enter is pressed in the confirm input', async () => {
    stubFetch({ '/api/public-config': publicConfig, '/api/test-token': () => json({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 }) });
    const mockUpdateUser = vi.fn().mockResolvedValue({ error: null });
    const mockClient = createMockSupabaseClient(() => Promise.resolve({ error: null }));
    (mockClient.auth as unknown as { updateUser: typeof mockUpdateUser }).updateUser = mockUpdateUser;
    mockSupabaseSetup(mockClient);
    const user = userEvent.setup();
    render(<ResetPage />);
    const passwordInput1 = await screen.findByLabelText('New password');
    const passwordInput2 = await screen.findByLabelText('Confirm new password');
    await user.type(passwordInput1, 'Password123');
    await user.type(passwordInput2, 'Password123');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Your password has been changed.')).toBeTruthy();
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'Password123' });
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });
});
