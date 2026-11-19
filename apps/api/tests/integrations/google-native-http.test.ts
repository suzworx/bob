import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createGoogleConnectionService } from '../../src/integrations/google-connection-service.ts';
import { createGoogleAccountsRouter } from '../../src/integrations/google-http.ts';
import { createGoogleNativeRouter, createGoogleNativeReturnRouter } from '../../src/integrations/google-native-http.ts';
import { webErrorHandler } from '../../src/platform/http/errors.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';
let pg: TestDb; let owner: TestAccount; let server: Server; let base: string;
const verifier = randomBytes(32).toString('base64url');
const input = { capabilities: ['calendar.read'], codeChallenge: createHash('sha256').update(verifier).digest('base64url') };
beforeAll(async () => {
  pg = await createTestDb(); owner = await addAccount(pg); const db = asDb(pg);
  const connection = createGoogleConnectionService({ db, clientId: 'client',
    callbackUrls: ['https://app.example.test/integrations'], nativeCallbackUrl: 'https://app.example.test/api/google-accounts/native/return',
    bridge: { authorize: async () => ({ url: 'https://connect.vercel.com/authorize' }),
      token: async () => ({ token: 'synthetic-secret', expiresAt: Date.now()+60000 }), revoke: async () => undefined },
    verify: async () => ({ providerAccountId: 'sub', email: 'native@example.test', capabilities: ['calendar.read'] }) });
  const app = express(); app.use(express.json()); app.use(createGoogleNativeReturnRouter());
  app.use((request,_response,next) => { if (request.get('authorization') === 'owner') request.account = { ...owner, exp: 2_000_000_000 }; next(); });
  app.use('/api/google-accounts/native',createGoogleNativeRouter({ getDb: async () => db, connection: connection.native }));
  app.use('/api/unconfigured',createGoogleNativeRouter({ getDb: async () => db }));
  app.use('/api/google-accounts',createGoogleAccountsRouter({ getDb: async () => db, connection }));
  app.use(webErrorHandler); server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeTestDb(pg); });
async function post(path: string, body: unknown, auth = 'owner'): Promise<Response> {
  return fetch(base+path,{ method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
it('allows native absent-Origin only with active auth and keeps browser Origin checks intact', async () => {
  expect((await post('/api/google-accounts/native/authorize',input,'')).status).toBe(401);
  expect((await post('/api/google-accounts/authorize',{ capabilities: ['calendar.read'] })).status).toBe(400);
  expect((await post('/api/google-accounts/native/authorize',{ ...input, callbackUrl: 'https://evil.example' })).status).toBe(400);
  expect((await post('/api/unconfigured/authorize',input)).status).toBe(503);
  const authorized = await post('/api/google-accounts/native/authorize',input);
  expect(authorized.status).toBe(200);
  const attempt = await authorized.json() as { attemptId: string; state: string };
  const proof = { attemptId: attempt.attemptId, state: attempt.state, codeVerifier: verifier };
  expect((await post('/api/google-accounts/native/complete',{ ...proof, codeVerifier: 'a'.repeat(43) })).status).toBe(404);
  const completed = await post('/api/google-accounts/native/complete',proof);
  expect(completed.status).toBe(200);
  const body = await completed.json();
  expect(body).toMatchObject({ status: 'completed', account: { access: ['calendar.read'], needsReconnect: false } });
  expect(JSON.stringify(body)).not.toMatch(/synthetic-secret|connectSubject|authorizationCapabilities/);
  expect(completed.headers.get('cache-control')).toBe('no-store');
});
it('relays only bounded state/outcome to the fixed app callback without auth, caching or provider errors', async () => {
  const state = 'a'.repeat(43);
  for (const [suffix,outcome] of [['','returned'],['&error=access_denied','cancelled'],['&error=provider_failure','failed']] as const) {
    const response = await fetch(`${base}/api/google-accounts/native/return?state=${state}${suffix}`,{ redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`xyz.heybob.oauth://google/callback?state=${state}&outcome=${outcome}`);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  }
  for (const query of [`state=${state}&state=${state}`,`state=${state}&code=secret`,`state=${state}&returnUrl=https://evil.example`,'state=short']) {
    const response = await fetch(`${base}/api/google-accounts/native/return?${query}`,{ redirect: 'manual' });
    expect(response.status).toBe(400); expect(response.headers.get('location')).toBeNull();
  }
});
