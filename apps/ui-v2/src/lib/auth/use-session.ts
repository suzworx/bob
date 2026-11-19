import { useCallback, useEffect, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { currentUiAction, withUiActionHeaders } from '@/lib/observability/ui-actions';
import {
  clearDevToken,
  getAuthClient,
  getDevTokenExpiry,
  getDevUserId,
  getStoredDevToken,
  getSupabaseSetup,
  isDevSignInEnabled,
  mintDevToken,
} from './supabase-client';

type SessionStatus = 'loading' | 'signed-out' | 'signed-in';

type SessionSnapshot = {
  status: SessionStatus;
  session: Session | null;
  /** Non-null when /api/public-config is unreachable or unconfigured. */
  unavailable: string | null;
};

const INITIAL_SNAPSHOT: SessionSnapshot = { status: 'loading', session: null, unavailable: null };

// Module-level store: one subscription per page load, shared by the gate in
// app.tsx, the sign-in surfaces, and every authHeaders()/fetchWithAuth() call.
let snapshot: SessionSnapshot = INITIAL_SNAPSHOT;
const listeners = new Set<(next: SessionSnapshot) => void>();
let initialised = false;

function publish(next: SessionSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener(next);
}

function signedIn(session: Session): SessionSnapshot {
  return { status: 'signed-in', session, unavailable: null };
}

function signedOut(): SessionSnapshot {
  return { status: 'signed-out', session: null, unavailable: null };
}

/** A Supabase-shaped session for the local dev bearer, so the rest of the app
 *  reads it exactly like a real one (it only ever uses session.user.email). */
function devSession(token: string): Session {
  const expiresAt = getDevTokenExpiry() ?? Date.now();
  return {
    access_token: token,
    refresh_token: '',
    expires_in: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
    expires_at: Math.floor(expiresAt / 1000),
    token_type: 'bearer',
    user: {
      id: getDevUserId(),
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      email: 'dev@bob.local',
    },
  };
}

/** Signs in through the loopback test issuer: mints a token for the stable
 *  dev user id and publishes the signed-in snapshot. True on success. */
export async function signInDev(): Promise<boolean> {
  try {
    const token = await mintDevToken();
    publish(signedIn(devSession(token)));
    return true;
  } catch {
    return false;
  }
}

/** The browser's IANA timezone, or 'UTC' when the runtime cannot say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

let zoneSeeded = false;
let recovering = false;

/**
 * The sign-in methods (`amr`) in the session's access token, or null when the
 * token cannot be read. A password-reset link yields `recovery`.
 */
function signInMethods(session: Session): string[] | null {
  try {
    const payload = session.access_token.split('.')[1] ?? '';
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { amr?: unknown };
    if (!Array.isArray(claims.amr)) return [];
    return claims.amr.map((entry: unknown) =>
      typeof entry === 'string' ? entry : String((entry as { method?: unknown } | null)?.method ?? ''),
    );
  } catch {
    return null;
  }
}

/**
 * First sign-in: an account with no `time_zone` gets the browser's, once, and
 * the session is refreshed so the next bearer carries it to the server. A zone
 * the person chose is never overwritten. Best effort -- the server uses UTC
 * until it lands. Deferred so it never runs inside onAuthStateChange, where
 * awaiting another auth call deadlocks supabase-js.
 *
 * Only an ordinary sign-in writes: a password-recovery session (the reset page
 * runs on one) must not write profile data, and a token that cannot be read is
 * not known to be ordinary. supabase-js emits PASSWORD_RECOVERY during its own
 * init, usually before this listener exists, so the token's `amr` is the check
 * that holds; the event is honoured too when it does arrive.
 */
function seedTimeZone(client: SupabaseClient, session: Session): void {
  const user = session.user as Session['user'] | undefined;
  if (zoneSeeded || recovering || !user || user.user_metadata?.time_zone) return;
  const methods = signInMethods(session);
  if (!methods || methods.includes('recovery')) return;
  zoneSeeded = true;
  setTimeout(() => {
    void (async (): Promise<void> => {
      try {
        const { error } = await client.auth.updateUser({ data: { time_zone: browserTimeZone() } });
        if (!error) await client.auth.refreshSession();
      } catch {
        // Left unset; the next page load tries again.
        zoneSeeded = false;
      }
    })();
  }, 0);
}

/**
 * True when this session came from a password-reset link (the token's `amr`
 * says `recovery`, or supabase-js announced PASSWORD_RECOVERY). Only such a
 * session may set a new password without the current one.
 */
export function isRecoverySession(session: Session | null): boolean {
  if (!session) return false;
  if (recovering) return true;
  return signInMethods(session)?.includes('recovery') ?? false;
}

async function ensureSession(): Promise<void> {
  if (initialised) return;
  initialised = true;
  const setup = await getSupabaseSetup();
  if (setup.devSignIn) {
    const devToken = getStoredDevToken();
    publish(devToken ? signedIn(devSession(devToken)) : signedOut());
    return;
  }
  if (setup.status === 'unavailable') {
    publish({ status: 'signed-out', session: null, unavailable: setup.message });
    return;
  }
  const { client } = setup;
  const { data } = await client.auth.getSession();
  publish(data.session ? signedIn(data.session) : signedOut());
  if (data.session) seedTimeZone(client, data.session);
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') recovering = true;
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION' || event === 'USER_UPDATED') {
      if (session) {
        publish(signedIn(session));
        seedTimeZone(client, session);
      }
    } else if (event === 'SIGNED_OUT') {
      publish(signedOut());
    }
  });
}

/**
 * The current bearer header for one request (contracts/web-auth.md). Resolved
 * per call, so a refreshed access token is always used (R6). The local dev
 * path uses the stored test-issuer token and never touches Supabase.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  if (isDevSignInEnabled()) {
    const devToken = getStoredDevToken();
    if (devToken) return { Authorization: `Bearer ${devToken}` };
  }
  const client = getAuthClient();
  if (!client) return {};
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function refreshSession(): Promise<boolean> {
  if (isDevSignInEnabled()) {
    try {
      const token = await mintDevToken();
      publish(signedIn(devSession(token)));
      return true;
    } catch {
      publish(signedOut());
      return false;
    }
  }
  const client = getAuthClient();
  if (!client) return false;
  const { error } = await client.auth.refreshSession();
  if (error) {
    publish(signedOut());
    return false;
  }
  return true;
}

async function bearerHeaders(existing?: HeadersInit): Promise<Headers> {
  const headers = new Headers(existing);
  const auth = await authHeaders();
  for (const [key, value] of Object.entries(auth)) headers.set(key, value);
  return headers;
}

/**
 * fetch() with the current bearer attached. A 401 refreshes the session once
 * and retries; a second 401 signs the session out WITHOUT touching the URL, so
 * the open conversation route is restored on the next sign-in (spec edge case).
 */
export async function fetchWithAuth(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const actionId = currentUiAction()?.action_id;
  let response = await fetch(input, withUiActionHeaders(input, { ...init, headers: await bearerHeaders(init.headers) }, actionId));
  if (response.status === 401) {
    if (await refreshSession()) {
      response = await fetch(input, withUiActionHeaders(input, { ...init, headers: await bearerHeaders(init.headers) }, actionId));
    }
    if (response.status === 401) {
      publish(signedOut());
    }
  }
  return response;
}

/**
 * Refresh once for a 401 from a transport that does not go through
 * fetchWithAuth (the AI SDK chat stream); a failed refresh signs the session
 * out and the app gate shows the sign-in screen.
 */
export async function handleUnauthorized(): Promise<void> {
  await refreshSession();
}

export function useSession(): SessionSnapshot & {
  signOut: () => Promise<void>;
  /** False when the global revoke failed: this device stays signed in so the person can retry. */
  signOutEverywhere: () => Promise<boolean>;
} {
  const [current, setCurrent] = useState<SessionSnapshot>(snapshot);

  useEffect(() => {
    const listener = (next: SessionSnapshot): void => setCurrent(next);
    listeners.add(listener);
    void ensureSession();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    if (isDevSignInEnabled()) {
      clearDevToken();
      publish(signedOut());
      return;
    }
    const client = getAuthClient();
    if (!client) return;
    try {
      await client.auth.signOut();
    } catch {
      // The local session is cleared either way, even if the revoke call fails.
    }
    publish(signedOut());
  }, []);

  // A global revoke that fails is reported, not hidden: signing out only this
  // device would tell the person every device is signed out when others are not.
  const signOutEverywhere = useCallback(async (): Promise<boolean> => {
    if (isDevSignInEnabled()) {
      clearDevToken();
      publish(signedOut());
      return true;
    }
    const client = getAuthClient();
    if (!client) return false;
    try {
      const { error } = await client.auth.signOut({ scope: 'global' });
      if (error) return false;
    } catch {
      return false;
    }
    publish(signedOut());
    return true;
  }, []);

  return { ...current, signOut, signOutEverywhere };
}

/** Test-only: reset the module singleton between test cases. */
export function resetSessionForTests(): void {
  snapshot = INITIAL_SNAPSHOT;
  listeners.clear();
  initialised = false;
  zoneSeeded = false;
  recovering = false;
}
