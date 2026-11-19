import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { observeAuthOperations } from './auth-observability';

/**
 * Runtime configuration served by the API at GET /api/public-config
 * (contracts/web-auth.md) so one build works in every environment. It carries
 * only the publishable key — never a secret or service-role material.
 * `devSignIn` mirrors whether the loopback-only POST /api/test-token is
 * mounted (BOB_SYSTEM_TEST=1 on a loopback bind, never in production).
 */
export type PublicConfig = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  pairingUrl: string;
  devSignIn: boolean;
  rum?: RumConfig;
};

/** Browser monitoring settings; present only when the server has BOB_RUM_* set. The token is public and ingest-only. */
export type RumConfig = {
  clientToken: string;
  site: string;
  org: string;
  service: 'bob-web';
  env: 'production' | 'development';
  version: string;
};

function parseRum(value: unknown): RumConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { clientToken, site, org, service, env, version } = value as Record<string, unknown>;
  if (typeof clientToken !== 'string' || !clientToken || typeof site !== 'string' || !site || typeof org !== 'string' || !org) return undefined;
  if (service !== 'bob-web' || (env !== 'production' && env !== 'development') || typeof version !== 'string') return undefined;
  return { clientToken, site, org, service, env, version };
}

export type AuthSetup =
  | { status: 'ready'; client: SupabaseClient; devSignIn: boolean }
  | { status: 'unavailable'; message: string; devSignIn: boolean };

/** Shown when /api/public-config is unreachable or the server is unconfigured. */
export const SIGN_IN_UNAVAILABLE_MESSAGE =
  'Sign-in is not available right now. The server has not been configured for sign-in yet.';

let setupPromise: Promise<AuthSetup> | undefined;
let resolvedClient: SupabaseClient | null = null;
/** Whether the last /api/public-config advertised the dev sign-in path. */
let devSignInFlag = false;
let rumConfig: RumConfig | undefined;

async function loadConfig(): Promise<PublicConfig> {
  const response = await fetch('/api/public-config');
  if (!response.ok) throw new Error(`public-config ${response.status}`);
  const body = (await response.json()) as Partial<PublicConfig>;
  return {
    supabaseUrl: body.supabaseUrl ?? '',
    supabasePublishableKey: body.supabasePublishableKey ?? '',
    pairingUrl: body.pairingUrl ?? '',
    devSignIn: body.devSignIn === true,
    rum: parseRum(body.rum),
  };
}

/** The browser monitoring settings from the last /api/public-config, or undefined (off). */
export function getRumConfig(): RumConfig | undefined {
  return rumConfig;
}

/**
 * Resolves the browser Supabase client exactly once per page load. A failed
 * config fetch is a clear "not configured" state — never a fabricated
 * signed-in state (Constitution V). When the server advertises the dev
 * sign-in path no Supabase client is built at all: the local dev flow needs
 * neither Supabase nor Docker, and `devSignIn` lets the sign-in surface show
 * the dev button instead of the "server unconfigured" message.
 */
export function getSupabaseSetup(): Promise<AuthSetup> {
  setupPromise ??= loadConfig()
    .then((config) => {
      devSignInFlag = config.devSignIn;
      rumConfig = config.rum;
      if (config.devSignIn) {
        return { status: 'unavailable' as const, message: SIGN_IN_UNAVAILABLE_MESSAGE, devSignIn: true };
      }
      resolvedClient = createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true },
      });
      observeAuthOperations(resolvedClient.auth);
      return { status: 'ready' as const, client: resolvedClient, devSignIn: false };
    })
    .catch(() => ({ status: 'unavailable' as const, message: SIGN_IN_UNAVAILABLE_MESSAGE, devSignIn: devSignInFlag }));
  return setupPromise;
}

/** The resolved client, or null before getSupabaseSetup() settles (or on failure). */
export function getAuthClient(): SupabaseClient | null {
  return resolvedClient;
}

/** True when the last config advertised the loopback dev sign-in path. */
export function isDevSignInEnabled(): boolean {
  return devSignInFlag;
}

// --- Local-only dev sign-in (S12-DEVSIGNIN) --------------------------------

const DEV_USER_KEY = 'bob.dev.userId';
const DEV_TOKEN_KEY = 'bob.dev.token';
const DEV_TOKEN_EXPIRY_KEY = 'bob.dev.tokenExpiry';

/** The stable dev account id: a uuid kept in localStorage, created on first use. */
export function getDevUserId(): string {
  const existing = window.localStorage.getItem(DEV_USER_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem(DEV_USER_KEY, created);
  return created;
}

/** The dev token's expiry as epoch ms, or null when none is stored. */
export function getDevTokenExpiry(): number | null {
  const expiry = window.localStorage.getItem(DEV_TOKEN_EXPIRY_KEY);
  return expiry ? Number(expiry) : null;
}

/** The stored dev token when it is still valid, else null (an expired token is
 *  cleared so the next sign-in mints a fresh one). */
export function getStoredDevToken(): string | null {
  const token = window.localStorage.getItem(DEV_TOKEN_KEY);
  const expiry = getDevTokenExpiry();
  if (!token || expiry === null || Date.now() >= expiry) {
    if (token || expiry !== null) clearDevToken();
    return null;
  }
  return token;
}

/** POST /api/test-token for the stable dev user id and store the minted token. */
export async function mintDevToken(): Promise<string> {
  const userId = getDevUserId();
  const response = await fetch('/api/test-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!response.ok) throw new Error(`test-token ${response.status}`);
  const body = (await response.json()) as { token: string; expiresAt: number };
  window.localStorage.setItem(DEV_TOKEN_KEY, body.token);
  window.localStorage.setItem(DEV_TOKEN_EXPIRY_KEY, String(body.expiresAt * 1000));
  return body.token;
}

/** Clears the dev session. The dev user id is kept: it is the stable identity. */
export function clearDevToken(): void {
  window.localStorage.removeItem(DEV_TOKEN_KEY);
  window.localStorage.removeItem(DEV_TOKEN_EXPIRY_KEY);
}

/** Test-only: forget the cached config fetch and client between test cases. */
export function resetSupabaseSetupForTests(): void {
  setupPromise = undefined;
  resolvedClient = null;
  devSignInFlag = false;
  rumConfig = undefined;
}
