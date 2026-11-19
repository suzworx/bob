import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { asServer, withUser } from '../../src/platform/db/db.ts';
import { createGoogleConnectionService } from '../../src/integrations/google-connection-service.ts';
import { addAccount, addSession, asDb, closeTestDb, createTestDb, withAdminAuth, type TestDb } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';

let pg: TestDb;
beforeAll(async () => { pg = await createTestDb(); });
afterAll(async () => closeTestDb(pg));
afterEach(() => vi.useRealTimers());
const proof = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
function setup() {
  const bridge = {
    authorize: vi.fn(async () => ({ url: 'https://connect.vercel.com/authorize' })),
    token: vi.fn(async () => ({ token: 'synthetic-provider-token', expiresAt: Date.now() + 60_000 })),
    revoke: vi.fn(async () => undefined),
  };
  const verify = vi.fn(async () => ({ providerAccountId: String(randomUUID()), email: 'native@example.test', capabilities: ['calendar.read' as const] }));
  const service = createGoogleConnectionService({ db: asDb(pg), bridge, verify, clientId: 'client',
    callbackUrls: ['https://app.example.test/integrations'], nativeCallbackUrl: 'https://app.example.test/api/google-accounts/native/return' });
  return { bridge, verify, web: service, native: service.native };
}

it('binds native completion to the owner, original session and app proof; web cannot consume it; response-loss retry is idempotent', async () => {
  const owner = await addAccount(pg); const other = await addAccount(pg); const second = await addSession(pg, owner.userId);
  const { native, web, bridge } = setup(); const p = proof();
  expect(native).toBeDefined();
  if (!native) throw new Error('native authorization missing');
  const attempt = await native.authorize(owner.userId, owner.sessionId, { capabilities: ['calendar.read'], codeChallenge: p.challenge });
  const body = { attemptId: attempt.attemptId, state: attempt.state, codeVerifier: p.verifier };
  await expect(web.complete(owner.userId, attempt.state)).rejects.toMatchObject({ code: 'reconnect_required' });
  for (const [userId, sessionId] of [[other.userId, other.sessionId], [owner.userId, second]] as const) {
    await expect(native.complete(userId, sessionId, body)).rejects.toMatchObject({ code: 'google_authorization_unavailable' });
  }
  await expect(native.complete(owner.userId, owner.sessionId, { ...body, codeVerifier: proof().verifier })).rejects.toMatchObject({ code: 'google_authorization_unavailable' });
  expect(bridge.token).not.toHaveBeenCalled();
  const completed = await native.complete(owner.userId, owner.sessionId, body);
  expect(completed.status).toBe('completed');
  expect(await native.complete(owner.userId, owner.sessionId, body)).toEqual(completed);
  expect(await native.cancel(owner.userId, owner.sessionId, body)).toEqual(completed);
  expect(bridge.token).toHaveBeenCalledTimes(1);
});

it('serializes duplicate completion and cancellation prevents an in-flight verified grant from linking', async () => {
  const owner = await addAccount(pg); const { native, bridge } = setup(); const p = proof();
  if (!native) throw new Error('native authorization missing');
  let release: (() => void) | undefined; let entered: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  bridge.token.mockImplementation(async () => { entered?.(); await new Promise<void>((resolve) => { release = resolve; }); return { token: 'synthetic', expiresAt: Date.now() + 60_000 }; });
  const a = await native.authorize(owner.userId, owner.sessionId, { capabilities: ['calendar.read'], codeChallenge: p.challenge });
  const input = { attemptId: a.attemptId, state: a.state, codeVerifier: p.verifier };
  const first = native.complete(owner.userId, owner.sessionId, input); await ready;
  expect(await native.complete(owner.userId, owner.sessionId, input)).toEqual({ status: 'processing', retryAfterMs: 1000 });
  expect(await native.cancel(owner.userId, owner.sessionId, input)).toEqual({ status: 'cancelled' });
  release?.(); expect(await first).toEqual({ status: 'cancelled' });
  expect(bridge.token).toHaveBeenCalledTimes(1);
  expect(await withUser(asDb(pg), owner.userId, (tx) => tx.query('select id from bob.google_accounts'))).toEqual([]);
});

it('rechecks revoked original sessions after provider verification', async () => {
  const owner = await addAccount(pg); const { native, verify } = setup(); const p = proof();
  if (!native) throw new Error('native authorization missing');
  const a = await native.authorize(owner.userId, owner.sessionId, { capabilities: ['calendar.read'], codeChallenge: p.challenge });
  verify.mockImplementation(async () => { await withAdminAuth(pg, (admin) => admin.endSession(owner.sessionId)); return { providerAccountId: 'sub', email: 'native@example.test', capabilities: ['calendar.read'] }; });
  await expect(native.complete(owner.userId, owner.sessionId, { attemptId: a.attemptId, state: a.state, codeVerifier: p.verifier })).rejects.toMatchObject({ code: 'google_authorization_unavailable' });
  expect(await withUser(asDb(pg), owner.userId, (tx) => tx.query('select id from bob.google_accounts'))).toEqual([]);
});

it('fences authorization queued behind account erasure while admitting a fresh session', async () => {
  const owner = await addAccount(pg); const { native } = setup(); const p = proof();
  if (!native) throw new Error('native authorization missing');
  let queued: Promise<unknown> | undefined;
  await asDb(pg).tx(async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`google-accounts:${owner.userId}`]);
    queued = native.authorize(owner.userId, owner.sessionId, { capabilities: ['calendar.read'], codeChallenge: p.challenge }).catch((error: unknown) => error);
    await asServer(tx, (server) => server.query('select bob_private.purge_account_google_native($1::uuid)', [owner.userId]));
  });
  expect(await queued).toMatchObject({ code: 'google_authorization_unavailable' });
  const fresh = await addSession(pg, owner.userId);
  expect(await native.authorize(owner.userId, fresh, { capabilities: ['calendar.read'], codeChallenge: p.challenge })).toMatchObject({ state: expect.any(String) });
});

it('expires uncompleted attempts and does not retrieve credentials for them', async () => {
  const owner = await addAccount(pg); const { native, bridge } = setup(); const p = proof();
  if (!native) throw new Error('native authorization missing');
  const a = await native.authorize(owner.userId,owner.sessionId,{ capabilities: ['calendar.read'], codeChallenge: p.challenge });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(a.expiresAt+1);
  expect(await native.complete(owner.userId,owner.sessionId,{ attemptId: a.attemptId, state: a.state, codeVerifier: p.verifier })).toEqual({ status: 'expired' });
  expect(bridge.token).not.toHaveBeenCalled();
});

it('never resets or exchanges a claimed attempt after its processing deadline', async () => {
  const owner = await addAccount(pg); const { native, bridge } = setup(); const p = proof();
  if (!native) throw new Error('native authorization missing');
  let release: (() => void) | undefined; let entered: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  bridge.token.mockImplementation(async () => { entered?.(); await new Promise<void>((resolve) => { release = resolve; }); return { token: 'synthetic', expiresAt: Date.now()+60000 }; });
  const a = await native.authorize(owner.userId,owner.sessionId,{ capabilities: ['calendar.read'], codeChallenge: p.challenge });
  const body = { attemptId: a.attemptId, state: a.state, codeVerifier: p.verifier };
  const original = native.complete(owner.userId,owner.sessionId,body); await ready;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now()+46_000);
  expect(await native.complete(owner.userId,owner.sessionId,body)).toEqual({ status: 'failed' });
  release?.(); expect(await original).toEqual({ status: 'failed' });
  expect(bridge.token).toHaveBeenCalledTimes(1);
  expect(await withUser(asDb(pg),owner.userId,(tx) => tx.query('select id from bob.google_accounts'))).toEqual([]);
});

it('keeps provider failure terminal and does not expose raw provider messages', async () => {
  const owner = await addAccount(pg); const { native, bridge } = setup(); const p = proof();
  if (!native) throw new Error('native authorization missing');
  bridge.token.mockRejectedValue(new Error('sensitive-provider-token'));
  const a = await native.authorize(owner.userId,owner.sessionId,{ capabilities: ['calendar.read'], codeChallenge: p.challenge });
  const body = { attemptId: a.attemptId, state: a.state, codeVerifier: p.verifier };
  expect(await native.complete(owner.userId,owner.sessionId,body)).toEqual({ status: 'failed' });
  expect(await native.complete(owner.userId,owner.sessionId,body)).toEqual({ status: 'failed' });
  expect(bridge.token).toHaveBeenCalledTimes(1);
});

it('lets an old web server supersede a native reconnect without making native state web-consumable', async () => {
  const owner = await addAccount(pg); const { native, web, bridge } = setup(); const p = proof();
  if (!native) throw new Error('native authorization missing');
  const initial = await native.authorize(owner.userId,owner.sessionId,{ capabilities: ['calendar.read'], codeChallenge: p.challenge });
  const done = await native.complete(owner.userId,owner.sessionId,{ attemptId: initial.attemptId, state: initial.state, codeVerifier: p.verifier });
  if (done.status !== 'completed') throw new Error('missing connected account');
  const a = await native.authorize(owner.userId,owner.sessionId,{ capabilities: ['calendar.read'], reconnectAccountId: done.account.id, codeChallenge: p.challenge });
  await web.authorize(owner.userId,['calendar.read'],done.account.id,'https://app.example.test');
  await expect(native.complete(owner.userId,owner.sessionId,{ attemptId: a.attemptId, state: a.state, codeVerifier: p.verifier })).rejects.toMatchObject({ code: 'google_authorization_unavailable' });
  expect(bridge.token).toHaveBeenCalledTimes(1);
});

it('database admission rejects an owned attempt that names another account session', async () => {
  const owner = await addAccount(pg); const other = await addAccount(pg); const p = proof();
  await expect(withUser(asDb(pg),owner.userId,(tx) => tx.query(`insert into bob.google_native_consent_attempts
    (user_id,session_id,state_hash,code_challenge,connect_subject,capabilities) values($1,$2,$3,$4,$5,$6)`,
  [owner.userId,other.sessionId,'a'.repeat(64),p.challenge,`gc_${'a'.repeat(43)}`,['calendar.read']]))).rejects.toThrow(/row.level security/i);
});

it('keeps the original session valid through each short finalization transaction by excluding concurrent revocation', async () => {
  const owner = await addAccount(pg);
  const url = await adminDatabaseUrl((pg as TestDb & { databaseName: string }).databaseName);
  await withUser(asDb(pg),owner.userId,async (tx) => {
    const [state] = await tx.query<{ active: boolean }>('select bob_private.google_native_session_active($1::uuid) as active',[owner.sessionId]);
    expect(state?.active).toBe(true);
    // Session deletion needs this conflicting lock. NOWAIT proves exclusion
    // without a clock sleep or hanging the transaction under review.
    await expect(withAdmin(url,async (admin) => admin`select id from auth.sessions where id=${owner.sessionId} for update nowait`))
      .rejects.toMatchObject({ code: '55P03' });
  });
  await withAdminAuth(pg,(admin) => admin.endSession(owner.sessionId));
  const { native } = setup(); const p = proof();
  if (!native) throw new Error('native authorization missing');
  await expect(native.authorize(owner.userId,owner.sessionId,{ capabilities: ['calendar.read'], codeChallenge: p.challenge }))
    .rejects.toMatchObject({ code: 'google_authorization_unavailable' });
});
