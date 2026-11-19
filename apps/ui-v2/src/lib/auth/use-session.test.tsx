import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { authHeaders, browserTimeZone, fetchWithAuth, resetSessionForTests, useSession } from './use-session';

type SessionResult = { data: { session: { access_token: string } | null }; error: Error | null };
type AuthResult = { error: Error | null };

const clientMock = vi.hoisted(() => {
  const listeners: Array<(event: string, session: unknown) => void> = [];
  const auth = {
    getSession: vi.fn<() => Promise<SessionResult>>(async () => ({
      data: { session: null },
      error: null,
    })),
    onAuthStateChange: vi.fn<
      (
        callback: (event: string, session: unknown) => void,
      ) => { data: { subscription: { unsubscribe: () => void } } }
    >((callback) => {
      listeners.push(callback);
      return { data: { subscription: { unsubscribe: () => {} } } };
    }),
    refreshSession: vi.fn<() => Promise<SessionResult>>(async () => ({
      data: { session: null },
      error: null,
    })),
    signOut: vi.fn<() => Promise<AuthResult>>(async () => ({ error: null })),
    updateUser: vi.fn<(attributes: unknown) => Promise<AuthResult>>(async () => ({ error: null })),
  };
  return { auth, listeners };
});

const setupMock = vi.hoisted(() => ({
  getSupabaseSetup: vi.fn(),
  getAuthClient: vi.fn(),
}));

const devAuthMock = vi.hoisted(() => ({
  isDevSignInEnabled: vi.fn(),
  getStoredDevToken: vi.fn(),
  getDevTokenExpiry: vi.fn(),
  getDevUserId: vi.fn(),
  clearDevToken: vi.fn(),
  mintDevToken: vi.fn(),
}));

vi.mock('./supabase-client', () => ({
  getSupabaseSetup: setupMock.getSupabaseSetup,
  getAuthClient: setupMock.getAuthClient,
  isDevSignInEnabled: devAuthMock.isDevSignInEnabled,
  getStoredDevToken: devAuthMock.getStoredDevToken,
  getDevTokenExpiry: devAuthMock.getDevTokenExpiry,
  getDevUserId: devAuthMock.getDevUserId,
  clearDevToken: devAuthMock.clearDevToken,
  mintDevToken: devAuthMock.mintDevToken,
}));

function SessionProbe({
  onSnapshot,
}: {
  onSnapshot: (snapshot: ReturnType<typeof useSession>) => void;
}): ReactElement {
  onSnapshot(useSession());
  return <div />;
}

beforeEach(() => {
  resetSessionForTests();
  window.localStorage.clear();
  setupMock.getSupabaseSetup.mockReset();
  setupMock.getSupabaseSetup.mockResolvedValue({ status: 'ready', client: { auth: clientMock.auth } });
  setupMock.getAuthClient.mockReset();
  setupMock.getAuthClient.mockReturnValue({ auth: clientMock.auth });
  devAuthMock.isDevSignInEnabled.mockReset();
  devAuthMock.isDevSignInEnabled.mockReturnValue(false);
  devAuthMock.getStoredDevToken.mockReset();
  devAuthMock.getStoredDevToken.mockReturnValue(null);
  devAuthMock.getDevTokenExpiry.mockReset();
  devAuthMock.getDevTokenExpiry.mockReturnValue(null);
  devAuthMock.getDevUserId.mockReset();
  devAuthMock.getDevUserId.mockReturnValue('dev-user-id');
  devAuthMock.clearDevToken.mockReset();
  devAuthMock.mintDevToken.mockReset();
  devAuthMock.mintDevToken.mockResolvedValue('tok-dev');
  clientMock.auth.getSession.mockReset();
  clientMock.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  clientMock.auth.refreshSession.mockReset();
  clientMock.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: null });
  clientMock.auth.signOut.mockReset();
  clientMock.auth.signOut.mockResolvedValue({ error: null });
  clientMock.listeners.length = 0;
  vi.unstubAllGlobals();
});

describe('authHeaders', () => {
  it('returns the current access token as a bearer header', async () => {
    clientMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'tok-1' } },
      error: null,
    });
    await expect(authHeaders()).resolves.toEqual({ Authorization: 'Bearer tok-1' });
  });

  it('sends no Authorization header without a session', async () => {
    await expect(authHeaders()).resolves.toEqual({});
  });
});

describe('fetchWithAuth', () => {
  it('attaches the bearer and refreshes once before retrying a 401', async () => {
    clientMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'tok-1' } },
      error: null,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithAuth('/api/x');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clientMock.auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    const firstHeaders = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Headers;
    expect(firstHeaders.get('Authorization')).toBe('Bearer tok-1');
  });

  it('signs out without retrying when the refresh itself fails', async () => {
    clientMock.auth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: new Error('refresh_failed'),
    });
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    let latest: ReturnType<typeof useSession> | null = null;
    render(<SessionProbe onSnapshot={(snapshot) => { latest = snapshot; }} />);

    const response = await fetchWithAuth('/api/x');

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(latest?.status).toBe('signed-out'));
  });

  it('retries once and still signs out when a fresh token is also rejected', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    let latest: ReturnType<typeof useSession> | null = null;
    render(<SessionProbe onSnapshot={(snapshot) => { latest = snapshot; }} />);

    const response = await fetchWithAuth('/api/x');

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clientMock.auth.refreshSession).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(latest?.status).toBe('signed-out'));
  });

  it('does not refresh or retry on a non-401 response', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithAuth('/api/x');

    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clientMock.auth.refreshSession).not.toHaveBeenCalled();
  });
});

describe('useSession', () => {
  it('reports signed-in when a session already exists and signs out on request', async () => {
    clientMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'tok' } },
      error: null,
    });
    let latest: ReturnType<typeof useSession> | null = null;
    render(<SessionProbe onSnapshot={(snapshot) => { latest = snapshot; }} />);
    await waitFor(() => expect(latest?.status).toBe('signed-in'));

    await latest!.signOut();

    expect(clientMock.auth.signOut).toHaveBeenCalledWith();
    await waitFor(() => expect(latest?.status).toBe('signed-out'));
  });

  it('flips to signed-in when onAuthStateChange reports a new session', async () => {
    let latest: ReturnType<typeof useSession> | null = null;
    render(<SessionProbe onSnapshot={(snapshot) => { latest = snapshot; }} />);
    await waitFor(() => expect(latest?.status).toBe('signed-out'));

    for (const listener of clientMock.listeners) listener('SIGNED_IN', { access_token: 'tok' });

    await waitFor(() => expect(latest?.status).toBe('signed-in'));
  });

  it('publishes the updated user on USER_UPDATED', async () => {
    let latest: ReturnType<typeof useSession> | null = null;
    render(<SessionProbe onSnapshot={(snapshot) => { latest = snapshot; }} />);
    await waitFor(() => expect(latest?.status).toBe('signed-out'));

    for (const listener of clientMock.listeners) listener('SIGNED_IN', { access_token: 'tok' });
    await waitFor(() => expect(latest?.status).toBe('signed-in'));

    for (const listener of clientMock.listeners) {
      listener('USER_UPDATED', { access_token: 'tok', user: { user_metadata: { name: 'New' } } });
    }

    await waitFor(() => expect(latest?.session?.user.user_metadata.name).toBe('New'));
  });
});

describe('dev sign-in path (S12-DEVSIGNIN)', () => {
  it('authHeaders returns the stored dev token as a bearer when dev sign-in is enabled', async () => {
    devAuthMock.isDevSignInEnabled.mockReturnValue(true);
    devAuthMock.getStoredDevToken.mockReturnValue('tok-dev');
    await expect(authHeaders()).resolves.toEqual({ Authorization: 'Bearer tok-dev' });
    expect(clientMock.auth.getSession).not.toHaveBeenCalled();
  });

  it('signs in from a stored dev token without touching Supabase', async () => {
    devAuthMock.isDevSignInEnabled.mockReturnValue(true);
    devAuthMock.getStoredDevToken.mockReturnValue('tok-dev');
    setupMock.getSupabaseSetup.mockResolvedValue({
      status: 'unavailable',
      message: 'sign-in unavailable',
      devSignIn: true,
    });
    let latest: ReturnType<typeof useSession> | null = null;
    render(<SessionProbe onSnapshot={(snapshot) => { latest = snapshot; }} />);
    await waitFor(() => expect(latest?.status).toBe('signed-in'));
    const snapshot = latest!;
    expect(snapshot.session?.user.email).toBe('dev@bob.local');
    expect(snapshot.unavailable).toBeNull();
    expect(clientMock.auth.getSession).not.toHaveBeenCalled();
  });

  it('signing out in dev mode clears the stored dev token', async () => {
    devAuthMock.isDevSignInEnabled.mockReturnValue(true);
    devAuthMock.getStoredDevToken.mockReturnValue('tok-dev');
    setupMock.getSupabaseSetup.mockResolvedValue({
      status: 'unavailable',
      message: 'sign-in unavailable',
      devSignIn: true,
    });
    let latest: ReturnType<typeof useSession> | null = null;
    render(<SessionProbe onSnapshot={(snapshot) => { latest = snapshot; }} />);
    await waitFor(() => expect(latest?.status).toBe('signed-in'));
    await latest!.signOut();
    expect(devAuthMock.clearDevToken).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(latest?.status).toBe('signed-out'));
  });

  it('re-mints a dev token on a 401 and retries with the fresh bearer', async () => {
    devAuthMock.isDevSignInEnabled.mockReturnValue(true);
    devAuthMock.getStoredDevToken.mockReturnValueOnce('tok-1').mockReturnValue('tok-2');
    devAuthMock.mintDevToken.mockResolvedValue('tok-2');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithAuth('/api/x');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(devAuthMock.mintDevToken).toHaveBeenCalledTimes(1);
    const retryHeaders = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe('Bearer tok-2');
  });
});

describe('account time zone on first sign-in', () => {
  // A Supabase-shaped access token: only its `amr` claim is read client-side.
  const token = (method: string): string => {
    const part = (value: unknown): string => btoa(JSON.stringify(value)).replace(/=+$/, '');
    return `${part({ alg: 'ES256' })}.${part({ sub: 'u', amr: [{ method, timestamp: 1 }] })}.sig`;
  };
  const sessionWith = (userMetadata: Record<string, unknown>, method = 'password') => ({
    access_token: token(method),
    user: { user_metadata: userMetadata },
  });

  beforeEach(() => {
    clientMock.auth.updateUser.mockClear();
    clientMock.auth.refreshSession.mockClear();
  });

  it("sets the browser's zone once and refreshes so the bearer carries it", async () => {
    clientMock.auth.getSession.mockResolvedValue({ data: { session: sessionWith({}) }, error: null } as never);
    render(<SessionProbe onSnapshot={() => {}} />);
    await waitFor(() => expect(clientMock.auth.refreshSession).toHaveBeenCalledTimes(1));
    expect(clientMock.auth.updateUser).toHaveBeenCalledTimes(1);
    expect(clientMock.auth.updateUser).toHaveBeenCalledWith({ data: { time_zone: browserTimeZone() } });

    // Later auth events for the same page load never seed it again.
    for (const listener of clientMock.listeners) listener('TOKEN_REFRESHED', sessionWith({}));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clientMock.auth.updateUser).toHaveBeenCalledTimes(1);
  });

  it('never overwrites a zone the person chose', async () => {
    clientMock.auth.getSession.mockResolvedValue({
      data: { session: sessionWith({ time_zone: 'Asia/Kolkata' }) },
      error: null,
    } as never);
    let latest: ReturnType<typeof useSession> | undefined;
    render(<SessionProbe onSnapshot={(snapshot) => (latest = snapshot)} />);
    await waitFor(() => expect(latest?.status).toBe('signed-in'));
    for (const listener of clientMock.listeners) listener('SIGNED_IN', sessionWith({ time_zone: 'Asia/Kolkata' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clientMock.auth.updateUser).not.toHaveBeenCalled();
  });

  it('a password-recovery session never saves a zone', async () => {
    clientMock.auth.getSession.mockResolvedValue({
      data: { session: sessionWith({}, 'recovery') },
      error: null,
    } as never);
    let latest: ReturnType<typeof useSession> | undefined;
    render(<SessionProbe onSnapshot={(snapshot) => (latest = snapshot)} />);
    await waitFor(() => expect(latest?.status).toBe('signed-in'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clientMock.auth.updateUser).not.toHaveBeenCalled();
  });

  it('after a PASSWORD_RECOVERY event, no session in that page load saves a zone', async () => {
    let latest: ReturnType<typeof useSession> | undefined;
    render(<SessionProbe onSnapshot={(snapshot) => (latest = snapshot)} />);
    await waitFor(() => expect(latest?.status).toBe('signed-out'));
    for (const listener of clientMock.listeners) listener('PASSWORD_RECOVERY', sessionWith({}));
    for (const listener of clientMock.listeners) listener('USER_UPDATED', sessionWith({}));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clientMock.auth.updateUser).not.toHaveBeenCalled();
  });

  it('a session whose token cannot be read saves no zone', async () => {
    clientMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'mock_token', user: { user_metadata: {} } } },
      error: null,
    } as never);
    let latest: ReturnType<typeof useSession> | undefined;
    render(<SessionProbe onSnapshot={(snapshot) => (latest = snapshot)} />);
    await waitFor(() => expect(latest?.status).toBe('signed-in'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clientMock.auth.updateUser).not.toHaveBeenCalled();
  });
});
