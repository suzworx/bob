import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDevToken,
  getAuthClient,
  getDevUserId,
  getStoredDevToken,
  getSupabaseSetup,
  mintDevToken,
  resetSupabaseSetupForTests,
  SIGN_IN_UNAVAILABLE_MESSAGE,
} from './supabase-client';

const createClient = vi.hoisted(() => vi.fn());
vi.mock('@supabase/supabase-js', () => ({ createClient }));

const CONFIG = {
  supabaseUrl: 'https://xyz.supabase.co',
  supabasePublishableKey: 'sb_publishable_test',
  pairingUrl: 'https://app.heybob.xyz/pair',
  devSignIn: false,
};

function configResponse(): Response {
  return new Response(JSON.stringify(CONFIG), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  resetSupabaseSetupForTests();
  createClient.mockReset();
  createClient.mockReturnValue({ auth: {} });
  vi.unstubAllGlobals();
});

describe('supabase client bootstrap', () => {
  it('fetches /api/public-config once and creates a single client with the publishable key', async () => {
    const fetchMock = vi.fn(async () => configResponse());
    vi.stubGlobal('fetch', fetchMock);

    const first = await getSupabaseSetup();
    const second = await getSupabaseSetup();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('ready');
    expect(second).toBe(first);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(CONFIG.supabaseUrl, CONFIG.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    expect(getAuthClient()).not.toBeNull();
  });

  it('reports unavailable instead of fabricating a client when config cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));

    const setup = await getSupabaseSetup();

    expect(setup.status).toBe('unavailable');
    if (setup.status === 'unavailable') {
      expect(setup.message).toBe(SIGN_IN_UNAVAILABLE_MESSAGE);
    }
    expect(getAuthClient()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('dev sign-in (S12-DEVSIGNIN)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('builds no Supabase client when the server advertises dev sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ...CONFIG, devSignIn: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const setup = await getSupabaseSetup();

    expect(setup.devSignIn).toBe(true);
    expect(setup.status).toBe('unavailable');
    expect(createClient).not.toHaveBeenCalled();
    expect(getAuthClient()).toBeNull();
  });

  it('keeps a stable dev user id in localStorage', () => {
    const first = getDevUserId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(window.localStorage.getItem('bob.dev.userId')).toBe(first);
    expect(getDevUserId()).toBe(first);
  });

  it('mints a dev token through POST /api/test-token and stores it', async () => {
    const userId = getDevUserId();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ token: 'tok-dev', expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const token = await mintDevToken();

    expect(token).toBe('tok-dev');
    expect(fetchMock).toHaveBeenCalledWith('/api/test-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    expect(getStoredDevToken()).toBe('tok-dev');
  });

  it('treats an expired dev token as absent and clears it', () => {
    window.localStorage.setItem('bob.dev.token', 'tok-old');
    window.localStorage.setItem('bob.dev.tokenExpiry', String(Date.now() - 1000));
    expect(getStoredDevToken()).toBeNull();
    expect(window.localStorage.getItem('bob.dev.token')).toBeNull();
  });

  it('clearDevToken clears the token but keeps the stable dev user id', () => {
    getDevUserId();
    window.localStorage.setItem('bob.dev.token', 'tok');
    window.localStorage.setItem('bob.dev.tokenExpiry', String(Date.now() + 1000));
    clearDevToken();
    expect(window.localStorage.getItem('bob.dev.token')).toBeNull();
    expect(window.localStorage.getItem('bob.dev.tokenExpiry')).toBeNull();
    expect(window.localStorage.getItem('bob.dev.userId')).not.toBeNull();
  });
});