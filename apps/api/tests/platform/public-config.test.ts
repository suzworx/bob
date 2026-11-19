/**
 * A-10..A-14 (contracts/web-auth.md): the unauthenticated GET /api/public-config
 * and the loopback-only system-test POST /api/test-token, against the real
 * mounted server.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createV2Server } from '../../src/server.ts';
import { closeDb, setSharedDb } from '../../src/platform/db/db.ts';
import { asDb, closeTestDb, createTestDb, type TestDb, withAdminAuth } from '../support/test-db.ts';

let server: Server | null = null;
let pg: TestDb;
/** Every booted server's extraction worker: server.close() does not stop it. */
const workers: Array<{ stop(): Promise<void> }> = [];

const ENV_KEYS = [
  'BOB_SYSTEM_TEST',
  'BOB_V2_HOST',
  'BOB_PRODUCTION',
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'BOB_PAIRING_URL',
  'BOB_PUBLIC_SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'BOB_RUM_CLIENT_TOKEN',
  'BOB_RUM_SITE',
  'BOB_RUM_ORG',
  'RAILWAY_GIT_COMMIT_SHA',
] as const;

async function boot(): Promise<{ baseUrl: string }> {
  const created = await createV2Server();
  server = created.server;
  workers.push(created.memoryWorker);
  await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const address = created.server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

// Every boot reaches getDb(), so each test shares this file's test database
// rather than whatever the process environment would otherwise resolve to.
beforeAll(async () => {
  pg = await createTestDb();
});

beforeEach(() => {
  setSharedDb(Promise.resolve(asDb(pg)));
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  await Promise.all(workers.splice(0).map((worker) => worker.stop().catch(() => undefined)));
  await closeDb().catch(() => undefined);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

describe('GET /api/public-config (A-10, A-11)', () => {
  it('A-10: is unauthenticated and returns the publishable configuration', async () => {
    process.env.SUPABASE_URL = 'https://xyz.supabase.co';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test_key';
    const { baseUrl } = await boot();
    const response = await fetch(`${baseUrl}/api/public-config`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      supabaseUrl: 'https://xyz.supabase.co',
      supabasePublishableKey: 'sb_publishable_test_key',
      pairingUrl: 'https://app.heybob.xyz/pair',
      devSignIn: false,
    });
  });

  it('carries no telemetry vendor fields and never serves exporter credentials', async () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer otlp-secret-never-served';
    const { baseUrl } = await boot();
    const response = await fetch(`${baseUrl}/api/public-config`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['devSignIn', 'pairingUrl', 'supabasePublishableKey', 'supabaseUrl']);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/langfuse/i);
    expect(text).not.toContain('otlp-secret-never-served');
  });

  it('omits rum unless the token, site and org are all set', async () => {
    process.env.BOB_RUM_SITE = 'watch2.example.test';
    process.env.BOB_RUM_ORG = 'default';
    const { baseUrl } = await boot();
    const partial = (await (await fetch(`${baseUrl}/api/public-config`)).json()) as Record<string, unknown>;
    expect(partial).not.toHaveProperty('rum');
  });

  it('serves the public ingest-only rum settings when all three are set, and nothing else secret', async () => {
    process.env.BOB_RUM_CLIENT_TOKEN = 'rum-ingest-token-public';
    process.env.BOB_RUM_SITE = 'watch2.example.test';
    process.env.BOB_RUM_ORG = 'default';
    process.env.RAILWAY_GIT_COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer otlp-secret-never-served';
    const { baseUrl } = await boot();
    const body = (await (await fetch(`${baseUrl}/api/public-config`)).json()) as Record<string, unknown>;
    expect(body.rum).toEqual({
      clientToken: 'rum-ingest-token-public',
      site: 'watch2.example.test',
      org: 'default',
      service: 'bob-web',
      env: 'development',
      version: 'abcdef1',
    });
    expect(JSON.stringify(body)).not.toContain('otlp-secret-never-served');
  });

  it('reports rum env production under BOB_PRODUCTION=1', async () => {
    process.env.BOB_PRODUCTION = '1';
    process.env.BOB_RUM_CLIENT_TOKEN = 'rum-ingest-token-public';
    process.env.BOB_RUM_SITE = 'watch2.example.test';
    process.env.BOB_RUM_ORG = 'default';
    const { baseUrl } = await boot();
    const body = (await (await fetch(`${baseUrl}/api/public-config`)).json()) as { rum?: { env: string } };
    expect(body.rum?.env).toBe('production');
  });

  it('uses BOB_PAIRING_URL when set, defaulting to app.heybob.xyz/pair', async () => {
    const { baseUrl } = await boot();
    const defaulted = (await (await fetch(`${baseUrl}/api/public-config`)).json()) as { pairingUrl: string };
    expect(defaulted.pairingUrl).toBe('https://app.heybob.xyz/pair');

    process.env.BOB_PAIRING_URL = 'https://example.test/pair';
    const { baseUrl: custom } = await boot();
    const overridden = (await (await fetch(`${custom}/api/public-config`)).json()) as { pairingUrl: string };
    expect(overridden.pairingUrl).toBe('https://example.test/pair');
  });

  it('hands the browser BOB_PUBLIC_SUPABASE_URL when set, so a LAN device reaches local Supabase', async () => {
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    const { baseUrl } = await boot();
    const defaulted = (await (await fetch(`${baseUrl}/api/public-config`)).json()) as { supabaseUrl: string };
    expect(defaulted.supabaseUrl).toBe('http://127.0.0.1:54321');

    process.env.BOB_PUBLIC_SUPABASE_URL = 'http://192.168.1.29:54321';
    const { baseUrl: lan } = await boot();
    const overridden = (await (await fetch(`${lan}/api/public-config`)).json()) as { supabaseUrl: string };
    expect(overridden.supabaseUrl).toBe('http://192.168.1.29:54321');
  });

  it('A-11: never exposes secret or service-role material', async () => {
    process.env.SUPABASE_URL = 'https://xyz.supabase.co';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test_key';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_top_secret_value';
    const { baseUrl } = await boot();
    const body = JSON.stringify(await (await fetch(`${baseUrl}/api/public-config`)).json());
    expect(body).not.toContain('sb_secret');
    expect(body).not.toContain('secret');
    expect(body).not.toContain('service_role');
    expect(body).not.toContain('top_secret');
  });
});

describe('POST /api/test-token (A-12..A-14)', () => {
  it('A-12: on loopback with BOB_SYSTEM_TEST=1 issues a token that passes the guard and creates the account row', async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    const userId = randomUUID();
    const { baseUrl } = await boot();
    const issued = await fetch(`${baseUrl}/api/test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    expect(issued.status).toBe(200);
    const body = (await issued.json()) as { token: string; expiresAt: number };
    expect(body.token.length).toBeGreaterThan(0);
    expect(Number.isInteger(body.expiresAt)).toBe(true);

    // auth.users is not readable as bob_server; check it through the admin seam.
    const created = await withAdminAuth(pg, (admin) => admin.getUser(userId));
    expect(created, 'test-token must create the account row').not.toBeNull();

    const guarded = await fetch(`${baseUrl}/api/conversations`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(guarded.status).toBe(200);
  }, 30_000);

  it('A-12b (issue #151): a minted token satisfies requireActiveSession — /api/events succeeds instead of 401ing', async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    const userId = randomUUID();
    const { baseUrl } = await boot();
    const issued = await fetch(`${baseUrl}/api/test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    expect(issued.status).toBe(200);
    const body = (await issued.json()) as { token: string; expiresAt: number };
    expect(body.token.length).toBeGreaterThan(0);

    // /api/events runs requireActiveSession, which checks bob_private
    // .session_active against auth.sessions. Before the fix the issuer never
    // created that row, so this 401ed; now it must pass and open the stream.
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/events`, {
      headers: { authorization: `Bearer ${body.token}` },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    controller.abort();
    await stream.body?.cancel().catch(() => undefined);
  }, 30_000);

  it('A-13: returns 404 when BOB_SYSTEM_TEST is unset', async () => {
    process.env.BOB_V2_HOST = '127.0.0.1';
    const { baseUrl } = await boot();
    const response = await fetch(`${baseUrl}/api/test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: randomUUID() }),
    });
    expect(response.status).toBe(404);
  });

  it('A-14: returns 404 on a non-loopback bind even with BOB_SYSTEM_TEST=1', async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '0.0.0.0';
    const { baseUrl } = await boot();
    const response = await fetch(`${baseUrl}/api/test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: randomUUID() }),
    });
    expect(response.status).toBe(404);
  });
});

describe('public-config devSignIn (S12-DEVSIGNIN)', () => {
  it('is true exactly when a working /api/test-token is mounted: loopback bind with BOB_SYSTEM_TEST=1', async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    const { baseUrl } = await boot();
    const config = (await (await fetch(`${baseUrl}/api/public-config`)).json()) as { devSignIn: boolean };
    expect(config.devSignIn).toBe(true);
    const issued = await fetch(`${baseUrl}/api/test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: randomUUID() }),
    });
    expect(issued.status).toBe(200);
  });

  it('is false when BOB_SYSTEM_TEST is unset', async () => {
    process.env.BOB_V2_HOST = '127.0.0.1';
    const { baseUrl } = await boot();
    const config = (await (await fetch(`${baseUrl}/api/public-config`)).json()) as { devSignIn: boolean };
    expect(config.devSignIn).toBe(false);
  });

  it('is false on a non-loopback bind even with BOB_SYSTEM_TEST=1', async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '0.0.0.0';
    const { baseUrl } = await boot();
    const config = (await (await fetch(`${baseUrl}/api/public-config`)).json()) as { devSignIn: boolean };
    expect(config.devSignIn).toBe(false);
  });

  it('is false under BOB_PRODUCTION=1 even on a loopback bind, where /api/test-token answers 404', async () => {
    process.env.BOB_PRODUCTION = '1';
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    const { baseUrl } = await boot();
    const config = (await (await fetch(`${baseUrl}/api/public-config`)).json()) as { devSignIn: boolean };
    expect(config.devSignIn).toBe(false);
    const issued = await fetch(`${baseUrl}/api/test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: randomUUID() }),
    });
    expect(issued.status).toBe(404);
  });
});