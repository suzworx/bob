import { z } from 'zod';
import { googleCapabilitiesFromScopes } from './google-capabilities.ts';
import { GoogleCredentialError, type GoogleCapability } from './google-credentials.ts';

const identifier = z.string().min(1).max(255);
const seconds = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().positive().max(86400));
const tokenInfoSchema = z.object({
  aud: identifier, azp: identifier.optional(), sub: identifier,
  expires_in: seconds, scope: z.string().max(16384),
});
const userInfoSchema = z.object({
  sub: identifier, email: z.string().email().max(320), email_verified: z.literal(true),
  name: z.string().max(512).optional(),
});
interface GrantOptions {
  expectedClientId: string;
  expectedProviderAccountId?: string;
  signal?: AbortSignal;
}
interface GoogleGrant {
  providerAccountId: string;
  email: string;
  name?: string;
  capabilities: GoogleCapability[];
}

async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new GoogleCredentialError('unavailable');
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 32768) throw new GoogleCredentialError('unavailable');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

async function request(url: string, token: string, method: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetchImpl(url, { method, signal, redirect: 'error', cache: 'no-store',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' } });
  if (!response.ok || response.redirected) {
    void response.body?.cancel().catch(() => undefined);
    throw new GoogleCredentialError([400, 401, 403].includes(response.status) ? 'reconnect_required' : 'unavailable');
  }
  return readBounded(response, signal);
}

async function inspectGrant(token: string, options: GrantOptions, signal: AbortSignal, fetchImpl: typeof fetch): Promise<GoogleGrant> {
  const started = Date.now();
  // Google's auth library uses POST with a bearer header; tokens never enter URLs.
  // https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/oauth2client.ts
  const info = tokenInfoSchema.parse(await request('https://oauth2.googleapis.com/tokeninfo', token, 'POST', signal, fetchImpl));
  if (info.aud !== options.expectedClientId || (info.azp !== undefined && info.azp !== options.expectedClientId)) {
    throw new GoogleCredentialError('reconnect_required');
  }
  const user = userInfoSchema.parse(await request('https://openidconnect.googleapis.com/v1/userinfo', token, 'GET', signal, fetchImpl));
  if (user.sub !== info.sub || (options.expectedProviderAccountId !== undefined && user.sub !== options.expectedProviderAccountId)
    || Date.now() >= started + info.expires_in * 1000) throw new GoogleCredentialError('reconnect_required');
  signal.throwIfAborted();
  return { providerAccountId: user.sub, email: user.email, ...(user.name === undefined ? {} : { name: user.name }),
    capabilities: googleCapabilitiesFromScopes(info.scope.split(/\s+/).filter(Boolean)) };
}

/** Server-only: verify current Google identity and actual grants, never broker metadata.
 * A partial grant is returned honestly; the caller enforces its required capability. */
export async function verifyGoogleGrant(token: string, options: GrantOptions, fetchImpl: typeof fetch = fetch): Promise<GoogleGrant> {
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  const timer = setTimeout(abort, 10000);
  options.signal?.addEventListener('abort', abort, { once: true });
  let rejectAbort: (error: Error) => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => { rejectAbort(new GoogleCredentialError('unavailable')); };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(token) || token.length > 16384 || !identifier.safeParse(options.expectedClientId).success) {
      throw new GoogleCredentialError('reconnect_required');
    }
    if (options.signal?.aborted) abort();
    return await Promise.race([inspectGrant(token, options, controller.signal, fetchImpl), cancelled]);
  } catch (error) {
    throw new GoogleCredentialError(error instanceof GoogleCredentialError ? error.code : 'unavailable');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort();
  }
}
