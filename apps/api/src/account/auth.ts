import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { createLocalJWKSet, decodeJwt, createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { JWTExpired } from 'jose/errors';
import { resolveTimeZone } from '@bob/ai';
import { moduleJournal } from '../platform/logger.ts';
import { TokenVerificationError, type AccountContext, type TokenVerifier } from '../platform/http/auth-guard.ts';
import { asServer, type Db } from '../platform/db/db.ts';
import { TestTokenRequestSchema } from './schemas.ts';
import { LOOPBACK_HOSTS, usesLocalDatabase } from './dev-account.ts';
import { resolveCommit } from '../platform/commit.ts';

const journal = moduleJournal('account');

/**
 * True when the bind address reaches only this machine. The mounting rule
 * keys off the address the server actually listens on, never off a separate
 * browser-only setting: the two drifted apart once and left `/api/*` mounted
 * unguarded on a LAN-reachable socket.
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** Constant-time shared-secret comparison, reused by the device guard. */
export function validToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** True when the server is intended for public exposure behind a tunnel. */
export function isProduction(): boolean {
  return process.env.BOB_PRODUCTION === '1';
}

// --- Supabase JWT web guard (T010, contracts/web-auth.md) ------------------

/** jose key provider: the local and remote JWKS both satisfy jwtVerify. */
type KeyProvider = JWTVerifyGetKey;

const AUDIENCE = 'authenticated';

/** The only JWT algorithm the guard accepts (#725): hosted Supabase and local
 *  `supabase start` both sign access tokens with an ES256 (P-256) key, and the
 *  system-test issuer and test helpers use ES256 too. Pinned so a changed key
 *  set can never widen what verifies (algorithm confusion). */
const ALGORITHMS = ['ES256'];

function verifyWith(keys: KeyProvider, issuer: string): TokenVerifier {
  return async (token: string): Promise<AccountContext> => {
    let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
    try {
      payload = (await jwtVerify(token, keys, { issuer, audience: AUDIENCE, algorithms: ALGORITHMS })).payload;
    } catch (error) {
      if (error instanceof JWTExpired) throw new TokenVerificationError('expired_token');
      throw new TokenVerificationError('invalid_token');
    }
    const { sub, session_id, exp } = payload;
    if (typeof sub !== 'string' || typeof session_id !== 'string' || typeof exp !== 'number') {
      throw new TokenVerificationError('invalid_token');
    }
    return { userId: sub, sessionId: session_id, exp };
  };
}

/** Verifier against Supabase's published JWKS (research R5): local
 *  verification per request, key rotation without restart, no shared JWT
 *  secret kept on the server. */
function createSupabaseVerifier({ supabaseUrl }: { supabaseUrl: string }): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));
  return verifyWith(jwks, `${supabaseUrl}/auth/v1`);
}

/** Verifier against a caller-supplied local JWKS (tests, system-test issuer). */
export function createLocalVerifier({ jwks, issuer }: { jwks: KeyProvider; issuer: string }): TokenVerifier {
  return verifyWith(jwks, issuer);
}

/**
 * Startup auth-gate outcome. `missing` = a production-required variable is
 * unset; `invalid` = a variable is set but malformed; `mustUnset` = a variable
 * must be absent under production (T036 + review finding, web-auth.md gate
 * matrix). All three name the offending variable so startV2Server can say why.
 */
type AuthConfigResult =
  | { ok: true }
  | { ok: false; missing: string }
  | { ok: false; invalid: string }
  | { ok: false; mustUnset: string }
  | { ok: false; localOnly: string };

const PRODUCTION_REQUIRED_KEYS = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'BOB_DATABASE_URL'] as const;

/** A uuid in canonical 8-4-4-4-12 hex form (the legacy owner account id). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure startup-gate check (web-auth.md "Production gate matrix"). A malformed
 * BOB_LEGACY_DEVICE_OWNER is refused whether or not BOB_PRODUCTION is set
 * (T036). Under BOB_PRODUCTION=1 the three Supabase variables are required,
 * BOB_SYSTEM_TEST must be unset — the loopback test issuer must never mint
 * tokens on a production bind (review finding) — and DEVICE_SHARED_SECRET is
 * required only when BOB_LEGACY_DEVICE_OWNER is set. Outside production,
 * BOB_SYSTEM_TEST=1 is refused unless usesLocalDatabase. Names the first
 * offending variable.
 */
export function validateAuthConfig(env: Record<string, string | undefined>): AuthConfigResult {
  const owner = env.BOB_LEGACY_DEVICE_OWNER;
  if (owner && !UUID_PATTERN.test(owner)) return { ok: false, invalid: 'BOB_LEGACY_DEVICE_OWNER' };
  if (env.BOB_PRODUCTION !== '1') {
    return env.BOB_SYSTEM_TEST === '1' && !usesLocalDatabase(env) ? { ok: false, localOnly: 'BOB_SYSTEM_TEST' } : { ok: true };
  }
  if (env.BOB_SYSTEM_TEST === '1') return { ok: false, mustUnset: 'BOB_SYSTEM_TEST' };
  for (const key of PRODUCTION_REQUIRED_KEYS) {
    if (!env[key]) return { ok: false, missing: key };
  }
  if (owner && !env.DEVICE_SHARED_SECRET) {
    return { ok: false, missing: 'DEVICE_SHARED_SECRET' };
  }
  return { ok: true };
}

// --- T011: public-config, system-test issuer, verifier resolution -----------

/** Default pairing URL served by GET /api/public-config (web-auth.md). */
const DEFAULT_PAIRING_URL = 'https://app.heybob.xyz/pair';

/**
 * True when the dev sign-in path is advertised: the exact condition under
 * which server.ts mounts POST /api/test-token (loopback bind + system-test
 * issuer). Computed here from the same inputs the mount uses so the UI flag
 * can never disagree with the mounted route; never true under production.
 */
function devSignInEnabled(): boolean {
  return (
    process.env.BOB_SYSTEM_TEST === '1' &&
    !isProduction() &&
    usesLocalDatabase(process.env) &&
    isLoopbackHost(process.env.BOB_V2_HOST ?? '0.0.0.0')
  );
}

/** Unauthenticated GET /api/public-config (web-auth.md): the publishable key
 *  only, never a secret or service-role value (R6). Unset values fall back to
 *  '' so the route works in system-test and no-Supabase dev; the UI keys off
 *  their presence. devSignIn mirrors whether /api/test-token is mounted.
 *  BOB_PUBLIC_SUPABASE_URL is the Supabase address the BROWSER uses, when it
 *  differs from the one the server verifies against: local Supabase issues
 *  tokens for http://127.0.0.1:54321, which the server must keep, but a phone
 *  or laptop on the LAN reaches the same stack at http://<lan-ip>:54321. */
export function publicConfigHandler(_request: Request, response: Response): void {
  const { BOB_RUM_CLIENT_TOKEN: clientToken, BOB_RUM_SITE: site, BOB_RUM_ORG: org } = process.env;
  // The RUM client token is a public, ingest-only browser token (it ships to browsers by design).
  // All three must be set, else `rum` is omitted and browser monitoring stays off.
  const rum = clientToken && site && org
    ? { clientToken, site, org, service: 'bob-web', env: isProduction() ? 'production' : 'development', version: resolveCommit()?.slice(0, 7) ?? 'unknown' }
    : undefined;
  response.status(200).json({
    ...(rum ? { rum } : {}),
    supabaseUrl: process.env.BOB_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
    pairingUrl: process.env.BOB_PAIRING_URL ?? DEFAULT_PAIRING_URL,
    devSignIn: devSignInEnabled(),
  });
}

/** Verifier that refuses every token: keeps the guard mounted and rejecting
 *  when no issuer is configured (web-auth.md gate matrix last row). */
function createRejectingVerifier(): TokenVerifier {
  return async (): Promise<AccountContext> => {
    throw new TokenVerificationError('invalid_token');
  };
}

/** Issuer of the boot-time system-test key pair (web-auth.md "System-test issuer"). */
const SYSTEM_TEST_ISSUER = 'http://bob.test/auth/v1';

/** Boot-time issuer for BOB_SYSTEM_TEST=1 (web-auth.md): an ES256 key pair
 *  generated at boot; the verifier and the test-token signer share it, so
 *  minted tokens pass the regular guard. */
interface SystemTestIssuer {
  verifier: TokenVerifier;
  issue: (userId: string) => Promise<{ token: string; expiresAt: number; sessionId: string }>;
}

async function createSystemTestIssuer(): Promise<SystemTestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
  return {
    verifier: createLocalVerifier({ jwks, issuer: SYSTEM_TEST_ISSUER }),
    issue: async (userId: string) => {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + 3600;
      const sessionId = randomUUID();
      const token = await new SignJWT({ sub: userId, session_id: sessionId, role: 'authenticated' })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuedAt(now)
        .setIssuer(SYSTEM_TEST_ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime(expiresAt)
        .sign(privateKey);
      return { token, expiresAt, sessionId };
    },
  };
}

/** POST /api/test-token handler (web-auth.md "System-test issuer"): signs a
 *  token for the requested account and ensures its auth.users and auth.sessions
 *  rows exist so the bob.* foreign keys hold and requireActiveSession (which
 *  checks bob_private.session_active against auth.sessions) passes. Mounted
 *  only on a loopback bind with BOB_SYSTEM_TEST=1; absent otherwise (404 at
 *  the mount site). The response shape stays { token, expiresAt } -- the UI
 *  parses it.
 *
 *  Correction (issue #151): this used to run two raw inserts directly, each
 *  wrapped in a try/catch that assumed a refused insert meant "the row
 *  already exists" (as it does for resolveDevAccount's pre-seeded dev
 *  account). On a real Supabase Postgres neither insert can ever succeed --
 *  bob_server, the role the API connects as, holds no privilege on
 *  auth.users or auth.sessions (Supabase grants those only to
 *  supabase_auth_admin / dashboard_user / the table owner) -- so both were
 *  silently swallowed every time and requireActiveSession could never pass.
 *  The tests' old in-process database never restricted these grants, so this
 *  stayed green in every test while dead against a real database. The fix routes both writes
 *  through bob_private.ensure_test_session, a SECURITY DEFINER function
 *  granted execute to bob_server only (migration
 *  20260916070000_system_test_session.sql); a genuine failure now propagates
 *  to webErrorHandler's generic 500 (issue #152) instead of being hidden
 *  behind a 200 that names a token nothing can ever authenticate. */
export function createTestTokenHandler(
  issuer: SystemTestIssuer,
  db: () => Promise<Db>,
): (request: Request, response: Response) => Promise<void> {
  return async (request: Request, response: Response): Promise<void> => {
    const parsed = TestTokenRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: 'invalid_request' } });
      return;
    }
    const issued = await issuer.issue(parsed.data.userId);
    await asServer(await db(), (server) =>
      server.query('select bob_private.ensure_test_session($1, $2)', [
        parsed.data.userId,
        issued.sessionId,
      ]),
    );
    response.status(200).json({ token: issued.token, expiresAt: issued.expiresAt });
  };
}

/** Boot-time web-auth resolution (T011): the verifier the /api/* guard runs
 *  and, under BOB_SYSTEM_TEST=1, the issuer backing /api/test-token. */
interface ResolvedWebAuth {
  verifier: TokenVerifier;
  testIssuer: SystemTestIssuer | null;
}

/** Resolves the /api/* verifier (web-auth.md "Production gate matrix"):
 *  system-test local key pair, else the Supabase JWKS, else a rejecting
 *  verifier with a startup warning. Never an unguarded mode. In production the
 *  system-test issuer is refused outright (review finding): /api/test-token
 *  mints a token for any account, so a loopback bind behind a tunnel would let
 *  anyone sign in as anyone. It is refused against a non-local database too:
 *  servers built without bootChecks (tests, HIL) skip validateAuthConfig. */
export async function resolveWebAuth(): Promise<ResolvedWebAuth> {
  if (process.env.BOB_SYSTEM_TEST === '1') {
    if (isProduction() || !usesLocalDatabase(process.env)) {
      journal('v2.web_auth_system_test_refused', {});
    } else {
      const testIssuer = await createSystemTestIssuer();
      return { verifier: testIssuer.verifier, testIssuer };
    }
  }
  if (process.env.SUPABASE_URL) {
    return { verifier: createSupabaseVerifier({ supabaseUrl: process.env.SUPABASE_URL }), testIssuer: null };
  }
  journal('v2.web_auth_unconfigured', { reason: 'no_issuer' });
  return { verifier: createRejectingVerifier(), testIssuer: null };
}

/**
 * The account's timezone: `user_metadata.time_zone` in the bearer the JWT
 * guard has already verified for this request (the app sets it on first sign-in
 * and from the Account page). UTC when absent, unreadable or not a zone `Intl`
 * accepts. Never logged: a zone next to a user id narrows who someone is.
 */
export function accountTimeZone(request: Request): string {
  const header = request.headers?.authorization ?? '';
  if (!header.startsWith('Bearer ')) return 'UTC';
  try {
    const metadata = decodeJwt(header.slice('Bearer '.length)).user_metadata;
    return resolveTimeZone((metadata as { time_zone?: unknown } | undefined)?.time_zone);
  } catch {
    return 'UTC';
  }
}
