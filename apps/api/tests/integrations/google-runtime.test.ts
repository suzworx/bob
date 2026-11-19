import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { WebSocketExpress } from 'websocket-express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGoogleRuntime } from '../../src/integrations/google-runtime.ts';
import { createAppDeps } from '../../src/app-deps.ts';
import { apiModules } from '../../src/api-modules.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { withUser } from '../../src/platform/db/db.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const config = {
  BOB_GOOGLE_BRIDGE_URL: 'https://bridge.example.test/api/connect',
  BOB_GOOGLE_BRIDGE_SECRET: 'synthetic_secret_for_runtime_tests_only_123',
  BOB_GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
  BOB_GOOGLE_CALLBACK_URLS: 'https://app.example.test/google/callback,https://second.example.test/gmail',
};
const requestFetch = globalThis.fetch;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('stays dormant without configuration and rejects partial configuration without secrets', () => {
  const getDb = vi.fn();
  expect(createGoogleRuntime(getDb, {})).toBeUndefined();
  expect(getDb).not.toHaveBeenCalled();
  expect(() => createGoogleRuntime(getDb, { BOB_GOOGLE_BRIDGE_SECRET: 'sensitive-invalid-value' }))
    .toThrow(/^google_runtime_configuration_invalid$/);
  expect(() => createGoogleRuntime(getDb, { ...config, BOB_GOOGLE_BRIDGE_URL: 'http://invalid.test' }))
    .toThrow(/^google_runtime_configuration_invalid$/);
  expect(() => createGoogleRuntime(getDb, { ...config, BOB_GOOGLE_CALLBACK_URLS: 'https://app.example.test/?credential=private' }))
    .toThrow(/^google_runtime_configuration_invalid$/);
  expect(() => createGoogleRuntime(getDb, { ...config, BOB_GOOGLE_CALLBACK_URLS: 'https://app.example.test/a,https://app.example.test/b' }))
    .toThrow(/^google_runtime_configuration_invalid$/);
  expect(getDb).not.toHaveBeenCalled();
});

it('enables the same private tools for web and device while keeping test overrides', () => {
  for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
  const deps = createAppDeps();
  expect(deps.googleConnection).toBeDefined();
  expect(deps.googleAgenda).toBeDefined();
  expect(deps.googleTools).toBeTypeOf('function');
  expect(deps.turn.googleTools).toBe(deps.googleTools);
  const custom = vi.fn(async () => ({}));
  const overridden = createAppDeps({ googleTools: custom, googleAgenda: deps.googleAgenda, googleConnection: deps.googleConnection });
  expect(overridden.googleTools).toBe(custom);
  expect(overridden.turn.googleTools).toBe(custom);
  expect(overridden.googleConnection).toBe(deps.googleConnection);
});

describe('runtime route composition', () => {
  let pg: TestDb;
  beforeAll(async () => { pg = await createTestDb(); });
  afterAll(async () => { await closeTestDb(pg); });

  it('mounts the configured service and persists owner consent before calling the bridge', async () => {
    for (const key of Object.keys(config)) vi.stubEnv(key, '');
    const db = asDb(pg);
    const getDb = vi.fn(async () => db);
    const bridgeFetch = vi.fn(async () => Response.json({ url: 'https://connect.vercel.com/authorize/test' }));
    vi.stubGlobal('fetch', bridgeFetch);
    const runtime = createGoogleRuntime(getDb, config);
    if (!runtime) throw new Error('runtime fixture missing');
    expect(getDb).not.toHaveBeenCalled();
    expect(bridgeFetch).not.toHaveBeenCalled();
    const deps = createAppDeps({ googleConnection: runtime.connection, googleTools: runtime.tools, googleAgenda: runtime.agenda });
    deps.getDb = getDb;
    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    const module = apiModules.find(entry => entry.name === 'google-accounts');
    if (!module?.mount) throw new Error('module fixture missing');
    module.mount(app as unknown as WebSocketExpress, deps);
    const server = await new Promise<Server>(resolve => { const handle = app.listen(0, () => resolve(handle)); });
    try {
      const owner = await addAccount(pg);
      const token = await signToken({ userId: owner.userId, sessionId: owner.sessionId });
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/google-accounts/authorize`;
      for (const origin of [undefined, 'https://unknown.example.test', 'null', 'https://app.example.test/']) {
        const denied = await requestFetch(endpoint, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
            'x-forwarded-host': 'app.example.test', ...(origin === undefined ? {} : { origin }) },
          body: JSON.stringify({ capabilities: ['gmail.read'] }),
        });
        expect(denied.status).toBe(400);
      }
      expect(bridgeFetch).not.toHaveBeenCalled();
      expect(await withUser(db, owner.userId, tx => tx.query('select state_hash from bob.google_consent_attempts'))).toEqual([]);
      const response = await requestFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/google-accounts/authorize`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: 'https://app.example.test' },
        body: JSON.stringify({ capabilities: ['calendar.read', 'gmail.read'] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ url: 'https://connect.vercel.com/authorize/test', expiresAt: expect.any(Number) });
      expect(bridgeFetch).toHaveBeenCalledOnce();
      const rows = await withUser(db, owner.userId, tx => tx.query<{ connect_subject: string; capabilities: string[] }>(
        'select connect_subject,capabilities from bob.google_consent_attempts',
      ));
      expect(rows).toEqual([{ connect_subject: expect.stringMatching(/^gc_/), capabilities: ['calendar.read', 'gmail.read'] }]);
      expect(bridgeFetch).toHaveBeenCalledWith(config.BOB_GOOGLE_BRIDGE_URL, expect.objectContaining({
        headers: { authorization: `Bearer ${config.BOB_GOOGLE_BRIDGE_SECRET}`, 'content-type': 'application/json' },
        body: expect.stringContaining(rows[0]?.connect_subject ?? 'missing-subject'),
      }));
      expect(bridgeFetch).toHaveBeenLastCalledWith(config.BOB_GOOGLE_BRIDGE_URL, expect.objectContaining({
        body: expect.stringContaining('https://app.example.test/google/callback?state='),
      }));
      const second = await requestFetch(endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: 'https://second.example.test' },
        body: JSON.stringify({ capabilities: ['gmail.read'] }),
      });
      expect(second.status).toBe(200);
      expect(bridgeFetch).toHaveBeenLastCalledWith(config.BOB_GOOGLE_BRIDGE_URL, expect.objectContaining({
        body: expect.stringContaining('https://second.example.test/gmail?state='),
      }));
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
