import { fetchWithAuth } from '@/lib/auth/use-session';
import { z } from 'zod';

const capability = z.enum(['calendar.read', 'calendar.write', 'gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify']);
const authorizationInput = z.object({ capabilities: z.array(capability).min(1).max(6), reconnectAccountId: z.string().uuid().optional() }).strict();
const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const authorizationResult = z.object({ url: z.string().url().refine((value) => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;
}), expiresAt: z.number().int().positive() });
export type GoogleCapability = z.infer<typeof capability>;

/** What the OAuth return query says. `cancelled` is the person's own choice,
 * not a failure; `invalid` is a stale or tampered link. */
export type GoogleCallback = { state: string } | { error: 'cancelled' | 'failed' | 'invalid' };

/** The query keys an OAuth return carries; any of them marks the URL as one. */
export const GOOGLE_CALLBACK_KEYS = ['state', 'error', 'code', 'request'] as const;

export function readGoogleCallback(search: string): GoogleCallback | null {
  const params = new URLSearchParams(search);
  if (!GOOGLE_CALLBACK_KEYS.some((key) => params.has(key))) return null;
  if (params.has('error')) return { error: params.get('error') === 'access_denied' ? 'cancelled' : 'failed' };
  const state = stateSchema.safeParse(params.get('state'));
  if (params.has('code') || params.has('request') || params.getAll('state').length !== 1 || !state.success) {
    return { error: 'invalid' };
  }
  return { state: state.data };
}

/** The URL without the OAuth return keys, keeping any other query and the hash
 * (the return lands on /integrations?state=…, or is forwarded there from /settings or /gmail). */
export function withoutGoogleCallback(location: { pathname: string; search: string; hash: string }): string {
  const params = new URLSearchParams(location.search);
  for (const key of GOOGLE_CALLBACK_KEYS) params.delete(key);
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
}

// Browser mirror of GoogleAccountSchema in web-schemas. `access` and
// `needsReconnect` default so an older server still parses.
const accountSchema = z.object({
  id: z.string(), email: z.string(), name: z.string().nullable(), selected: z.boolean(), createdAt: z.number(),
  customName: z.string().trim().min(1).max(60).nullable().optional(),
  access: z.array(capability).max(6).default([]),
  needsReconnect: z.boolean().default(false),
});
export type GoogleAccount = z.infer<typeof accountSchema>;

export async function listGoogleAccounts(): Promise<GoogleAccount[]> {
  const response = await fetchWithAuth('/api/google-accounts');
  if (!response.ok) throw new Error('list_failed');
  return z.object({ accounts: z.array(accountSchema) }).parse(await response.json()).accounts;
}

export async function startGoogleAuthorization(input: z.infer<typeof authorizationInput>, signal?: AbortSignal): Promise<string> {
  const response = await fetchWithAuth('/api/google-accounts/authorize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify(authorizationInput.parse(input)),
  });
  if (!response.ok) throw new Error('authorize_failed');
  const result = authorizationResult.parse(await response.json());
  if (result.expiresAt <= Date.now()) throw new Error('authorize_expired');
  return result.url;
}

/** Completes the connection and returns the account, or null when the server
 * answered without one (it still linked; the list reload shows it). */
export async function finishGoogleAuthorization(state: string): Promise<GoogleAccount | null> {
  const response = await fetchWithAuth('/api/google-accounts/callback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: stateSchema.parse(state) }),
  });
  if (!response.ok) throw new Error('callback_failed');
  const body = z.object({ account: accountSchema }).safeParse(await response.json().catch(() => null));
  return body.success ? body.data.account : null;
}

export async function disconnectGoogleAccount(id: string): Promise<boolean> {
  const response = await fetchWithAuth(`/api/google-accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return response.status === 204;
}

export async function selectGoogleAccount(id: string): Promise<void> {
  const response = await fetchWithAuth(`/api/google-accounts/${encodeURIComponent(id)}/select`, { method: 'POST' });
  if (!response.ok) throw new Error('select_failed');
}

export async function renameGoogleAccount(id: string, customName: string | null, signal?: AbortSignal): Promise<GoogleAccount> {
  const body = z.object({ customName: z.string().trim().min(1).max(60).nullable() }).parse({ customName });
  const response = await fetchWithAuth(`/api/google-accounts/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw new Error('rename_failed');
  return z.object({ account: accountSchema }).parse(await response.json()).account;
}
