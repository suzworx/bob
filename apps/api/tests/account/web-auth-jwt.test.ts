import { describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createLocalVerifier, validateAuthConfig } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession, type TokenVerifier } from '../../src/platform/http/auth-guard.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, createTestDb, withAdminAuth } from '../support/test-db.ts';

const USER_ID = '3f1f3f28-7c3e-4b1e-9f3e-3f3f3f3f3f3f';
const SESSION_ID = '9c2e9c2e-8d4f-4a2e-9c2e-9c2e9c2e9c2e';

interface AccountShape {
  userId: string;
  sessionId: string;
  exp: number;
}

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

async function guardHit(verifier: TokenVerifier, header: string | undefined, path = '/api/chat') {
  const next = vi.fn();
  const req: { get: () => string | undefined; path: string; account?: AccountShape } = {
    get: () => header,
    path,
    account: undefined,
  };
  const res = response();
  await createJwtWebAuthGuard(verifier)(req as never, res as never, next);
  return { req, res, next };
}

const verifier = createLocalVerifier({ jwks: testJwks, issuer: testIssuer });

describe('JWT web guard (contracts/web-auth.md A-01..A-09, A-15..A-19)', () => {
  it('A-01: no Authorization header -> 401 missing_token, route never runs', async () => {
    const { res, next } = await guardHit(verifier, undefined);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'missing_token' } });
    expect(next).not.toHaveBeenCalled();
  });

  it('A-02: malformed JWT -> 401 invalid_token', async () => {
    const { res } = await guardHit(verifier, 'Bearer not-a-jwt');
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'invalid_token' } });
  });

  it('A-03: JWT signed by the wrong key -> 401 invalid_token', async () => {
    const { publicKey } = await generateKeyPair('ES256');
    const otherVerifier = createLocalVerifier({
      jwks: createLocalJWKSet({ keys: [await exportJWK(publicKey)] }),
      issuer: testIssuer,
    });
    const token = await signToken({ userId: USER_ID, sessionId: SESSION_ID });
    const { res } = await guardHit(otherVerifier, `Bearer ${token}`);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'invalid_token' } });
  });

  it('A-04: wrong issuer -> 401 invalid_token', async () => {
    const token = await signToken({ userId: USER_ID, sessionId: SESSION_ID, issuer: 'http://evil.test/auth/v1' });
    const { res } = await guardHit(verifier, `Bearer ${token}`);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'invalid_token' } });
  });

  it('A-05: wrong audience -> 401 invalid_token', async () => {
    const token = await signToken({ userId: USER_ID, sessionId: SESSION_ID, audience: 'service_role' });
    const { res } = await guardHit(verifier, `Bearer ${token}`);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'invalid_token' } });
  });

  it('A-06: expired JWT -> 401 expired_token', async () => {
    const token = await signToken({ userId: USER_ID, sessionId: SESSION_ID, expiresInSeconds: -60 });
    const { res } = await guardHit(verifier, `Bearer ${token}`);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'expired_token' } });
  });

  it('A-20: only ES256 verifies; an otherwise valid token signed with another algorithm -> 401 invalid_token (#725)', async () => {
    for (const alg of ['ES384', 'RS256']) {
      const { publicKey, privateKey } = await generateKeyPair(alg);
      const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg }] });
      const token = await new SignJWT({ sub: USER_ID, session_id: SESSION_ID, role: 'authenticated' })
        .setProtectedHeader({ alg })
        .setIssuedAt()
        .setIssuer(testIssuer)
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .sign(privateKey);
      const { res, next } = await guardHit(createLocalVerifier({ jwks, issuer: testIssuer }), `Bearer ${token}`);
      expect(res.statusCode, alg).toBe(401);
      expect(res.body).toMatchObject({ error: { code: 'invalid_token' } });
      expect(next).not.toHaveBeenCalled();
    }
    const valid = await guardHit(verifier, `Bearer ${await signToken({ userId: USER_ID, sessionId: SESSION_ID })}`);
    expect(valid.next).toHaveBeenCalledOnce();
  });

  it('A-18: an old BOB_WEB_TOKEN bearer is an unrecognized token -> 401 invalid_token', async () => {
    const { res } = await guardHit(verifier, 'Bearer old-shared-secret');
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'invalid_token' } });
  });

  it('A-07: valid JWT -> req.account set and the route proceeds', async () => {
    const token = await signToken({ userId: USER_ID, sessionId: SESSION_ID });
    const { req, res, next } = await guardHit(verifier, `Bearer ${token}`);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(req.account).toMatchObject({ userId: USER_ID, sessionId: SESSION_ID });
    expect(typeof req.account?.exp).toBe('number');
  });

  it('A-08: requireActiveSession passes with an active session', async () => {
    const pg = await createTestDb();
    await addAccount(pg, { id: USER_ID, sessionId: SESSION_ID });
    const db = asDb(pg);
    const next = vi.fn();
    const req = { account: { userId: USER_ID, sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 } };
    const res = response();
    await requireActiveSession(() => Promise.resolve(db))(req as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  }, 30_000);

  it('A-09: requireActiveSession fails for a revoked/signed-out session -> 401 invalid_token', async () => {
    const pg = await createTestDb();
    await addAccount(pg, { id: USER_ID, sessionId: SESSION_ID });
    const db = asDb(pg);
    await withAdminAuth(pg, (admin) => admin.endSession(SESSION_ID));
    const next = vi.fn();
    const req = { account: { userId: USER_ID, sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 } };
    const res = response();
    await requireActiveSession(() => Promise.resolve(db))(req as never, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'invalid_token' } });
    expect(next).not.toHaveBeenCalled();
  });

  it('A-09b: requireActiveSession refuses when no account was set by the guard', async () => {
    const pg = await createTestDb();
    const db = asDb(pg);
    const next = vi.fn();
    const res = response();
    await requireActiveSession(() => Promise.resolve(db))({ account: undefined } as never, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('A-15: production gate names each missing variable; the full set starts', () => {
    expect(validateAuthConfig({ BOB_PRODUCTION: '1' })).toEqual({ ok: false, missing: 'SUPABASE_URL' });
    expect(
      validateAuthConfig({ BOB_PRODUCTION: '1', SUPABASE_URL: 'https://x.supabase.co' }),
    ).toEqual({ ok: false, missing: 'SUPABASE_PUBLISHABLE_KEY' });
    expect(
      validateAuthConfig({
        BOB_PRODUCTION: '1',
        SUPABASE_URL: 'https://x.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
      }),
    ).toEqual({ ok: false, missing: 'BOB_DATABASE_URL' });
    expect(
      validateAuthConfig({
        BOB_PRODUCTION: '1',
        SUPABASE_URL: 'https://x.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
        BOB_DATABASE_URL: 'postgresql://u:p@host/db',
      }),
    ).toEqual({ ok: true });
    expect(validateAuthConfig({})).toEqual({ ok: true });
  });

  it('A-16: legacy owner without DEVICE_SHARED_SECRET fails the production gate', () => {
    const full = {
      BOB_PRODUCTION: '1',
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
      BOB_DATABASE_URL: 'postgresql://u:p@host/db',
    };
    expect(validateAuthConfig({ ...full, BOB_LEGACY_DEVICE_OWNER: USER_ID })).toEqual({
      ok: false,
      missing: 'DEVICE_SHARED_SECRET',
    });
    expect(validateAuthConfig({ ...full, BOB_LEGACY_DEVICE_OWNER: USER_ID, DEVICE_SHARED_SECRET: 's' })).toEqual({
      ok: true,
    });
  });

  it('A-17: journal of rejected requests contains no token, eyJ, claim, or email', async () => {
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    const token = await signToken({ userId: USER_ID, sessionId: SESSION_ID });
    await guardHit(verifier, undefined);
    await guardHit(verifier, 'Bearer not-a-jwt');
    await guardHit(verifier, `Bearer ${token.slice(0, 20)}`);
    await guardHit(verifier, 'Bearer old-shared-secret');
    setJournalSink(null);
    const joined = lines.join('');
    expect(joined).toContain('v2.auth_rejected');
    expect(joined).not.toContain('eyJ');
    expect(joined).not.toContain(USER_ID);
    expect(joined).not.toContain(SESSION_ID);
    expect(joined).not.toContain('@');
    expect(joined).not.toContain('old-shared-secret');
  });

  it('A-19: the guard itself never exempts /health or /v2/cardputer (mounting decides)', async () => {
    const health = await guardHit(verifier, undefined, '/health');
    expect(health.res.statusCode).toBe(401);
    expect(health.res.body).toMatchObject({ error: { code: 'missing_token' } });
    const device = await guardHit(verifier, undefined, '/v2/cardputer');
    expect(device.res.statusCode).toBe(401);
    const token = await signToken({ userId: USER_ID, sessionId: SESSION_ID });
    const ok = await guardHit(verifier, `Bearer ${token}`, '/v2/cardputer');
    expect(ok.next).toHaveBeenCalledOnce();
  });
});

describe('fresh global web admission', () => {
  it.each(['revoked', 'unavailable'])('refuses %s eligibility without reaching the route', async (kind) => {
    const check = vi.fn(async () => { if (kind === 'unavailable') throw new Error('database unavailable'); return false; });
    const next = vi.fn();
    const res = response();
    const account = { userId: USER_ID, sessionId: SESSION_ID, exp: 9999999999 };
    const req = { method: 'GET', path: '/conversations', get: () => 'Bearer test' };
    await createJwtWebAuthGuard(async () => account, [], check)(req as never, res as never, next);
    expect(check).toHaveBeenCalledWith(account);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it('preserves explicit public exceptions without consulting the database', async () => {
    const check = vi.fn(async () => false);
    const next = vi.fn();
    const req = { method: 'GET', path: '/invitations/public-token', get: () => undefined };
    await createJwtWebAuthGuard(verifier, [{ method: 'GET', pattern: /^\/invitations\/[^/]+$/ }], check)(req as never, response() as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(check).not.toHaveBeenCalled();
  });
});
