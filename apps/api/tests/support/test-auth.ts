// Test JWT helpers (T005, specs/008-supabase-auth-pairing).
// An ES256 key pair generated at module load; signToken() mints Supabase-shaped
// access tokens (sub, session_id, role, aud 'authenticated', iss, iat, exp)
// that verify against testJwks. The T010 web-guard tests reuse both.
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';

/** Issuer the guard verifies against; test tokens are minted with this value. */
export const testIssuer = 'http://supabase.test/auth/v1';

const { publicKey, privateKey } = await generateKeyPair('ES256');

/** Local JWKS exposing the test public key for local jose verification (R5). */
export const testJwks = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });

export interface SignTokenOptions {
  userId: string;
  sessionId: string;
  /** Seconds until exp. Default 3600. */
  expiresInSeconds?: number;
  /** Defaults to testIssuer. */
  issuer?: string;
  /** Defaults to 'authenticated' (the audience the guard requires). */
  audience?: string;
}

/**
 * Mints a Supabase-shaped access token signed by the test ES256 key. The
 * web-auth guard verifies it with issuer testIssuer and audience
 * 'authenticated' (contracts/web-auth.md "Verification").
 */
export async function signToken(options: SignTokenOptions): Promise<string> {
  const {
    userId,
    sessionId,
    expiresInSeconds = 3600,
    issuer = testIssuer,
    audience = 'authenticated',
  } = options;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: userId, session_id: sessionId, role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuedAt(now)
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(now + expiresInSeconds)
    .sign(privateKey);
}