import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createV2Server } from '../../src/server.ts';
import { closeDb, setSharedDb } from '../../src/platform/db/db.ts';
import { createStaticUiHandler, resolveUiDist } from '../../src/platform/http/static-ui.ts';
import { isProduction, publicConfigHandler, resolveWebAuth, validateAuthConfig } from '../../src/account/auth.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let tempDir: string;
let absentDir: string;
let pg: TestDb;

// The server-booting cases reach getDb(); with no BOB_DATABASE_URL that would
// fall back to an in-process database, so each test gets the per-file real
// Postgres as the shared Db instead. The boot-validation cases never call it.
beforeAll(async () => {
  pg = await createTestDb();
});

afterAll(async () => {
  await closeTestDb(pg);
});

beforeEach(() => {
  setSharedDb(Promise.resolve(asDb(pg)));
  // The import chain dotenv-loads the repo .env (@bob/ai config.ts), so a
  // populated .env leaks SUPABASE_* here; these tests assert on the exact
  // first-missing var, so each test starts from a clean production env.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.BOB_DATABASE_URL;
  tempDir = mkdtempSync(join(tmpdir(), 'bob-prod-'));
  absentDir = mkdtempSync(join(tmpdir(), 'bob-absent-'));
  const dist = join(tempDir, 'apps', 'ui-v2', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>test</title>');
});

afterEach(async () => {
  delete process.env.BOB_PRODUCTION;
  delete process.env.BOB_V2_HOST;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.BOB_DATABASE_URL;
  delete process.env.BOB_SYSTEM_TEST;
  delete process.env.DEVICE_SHARED_SECRET;
  await closeDb().catch(() => undefined);
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(absentDir, { recursive: true, force: true });
});

describe('production guard (T011)', () => {
  it('runs the gate only when BOB_PRODUCTION=1', () => {
    delete process.env.BOB_PRODUCTION;
    expect(isProduction()).toBe(false);
    expect(validateAuthConfig(process.env)).toEqual({ ok: true });
    process.env.BOB_PRODUCTION = '1';
    expect(isProduction()).toBe(true);
    expect(validateAuthConfig(process.env)).toEqual({ ok: false, missing: 'SUPABASE_URL' });
  });

  it('names the first missing production variable', () => {
    process.env.BOB_PRODUCTION = '1';
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    expect(validateAuthConfig(process.env)).toEqual({ ok: false, missing: 'SUPABASE_PUBLISHABLE_KEY' });
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_x';
    expect(validateAuthConfig(process.env)).toEqual({ ok: false, missing: 'BOB_DATABASE_URL' });
  });

  it('mounts the JWT guard on /api/* even on a loopback bind in production (A-19 shape)', async () => {
    process.env.BOB_PRODUCTION = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    const { server } = await createV2Server();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, { method: 'POST' });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('missing_token');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('keeps /api/* mounted and guarded on a non-loopback bind (no unguarded mode)', async () => {
    process.env.BOB_V2_HOST = '0.0.0.0';
    const { server } = await createV2Server();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/conversations`);
    expect(response.status).toBe(401);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('A-20: a bearer in the query string or path is not accepted (guard reads the header only)', async () => {
    process.env.BOB_V2_HOST = '127.0.0.1';
    const { server } = await createV2Server();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const query = await fetch(`${base}/api/conversations?access_token=eyJ.abc.def`);
    expect(query.status).toBe(401);
    expect(((await query.json()) as { error: { code: string } }).error.code).toBe('missing_token');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('A-21: production with system-test on is refused at startup, naming BOB_SYSTEM_TEST', () => {
    process.env.BOB_PRODUCTION = '1';
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_x';
    process.env.BOB_DATABASE_URL = 'postgres://x';
    expect(validateAuthConfig(process.env)).toEqual({ ok: false, mustUnset: 'BOB_SYSTEM_TEST' });
  });

  it('A-22: resolveWebAuth under production never creates the test issuer, even with system-test on', async () => {
    process.env.BOB_PRODUCTION = '1';
    process.env.BOB_SYSTEM_TEST = '1';
    const resolved = await resolveWebAuth();
    expect(resolved.testIssuer).toBeNull();
  });

  it('A-23: /api/test-token answers 404 on a loopback bind under production even with system-test on', async () => {
    process.env.BOB_PRODUCTION = '1';
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    const { server } = await createV2Server();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: randomUUID() }),
    });
    expect(response.status).toBe(404);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

// Incident 2026-10-06: a dev .env pointed BOB_DATABASE_URL at the hosted
// pooler without BOB_PRODUCTION=1, and system-test sign-in wrote an
// email-less auth.users row per test-token call into production.
describe('system-test mode needs a local database', () => {
  // Fake project ref; the short password keeps the staged secret scan quiet.
  const POOLER = 'postgresql://bob_server.abcdefghijklmnop:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
  const DIRECT = 'postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres';
  const local = ['postgresql://bob_server:pw@127.0.0.1:54322/postgres', 'postgres://u:pw@localhost:5432/db', 'postgres://u:pw@[::1]:5432/db'];

  it('A-24: refuses BOB_SYSTEM_TEST=1 against a hosted, unparseable or absent database URL', () => {
    // No URL is not a local database: there is no stand-in any more, and the
    // boot check (startup.ts) refuses a server without one before this gate.
    expect(validateAuthConfig({ BOB_SYSTEM_TEST: '1' })).toEqual({ ok: false, localOnly: 'BOB_SYSTEM_TEST' });
    for (const url of [POOLER, DIRECT, 'not a url', '']) {
      expect(validateAuthConfig({ BOB_SYSTEM_TEST: '1', BOB_DATABASE_URL: url })).toEqual({
        ok: false,
        localOnly: 'BOB_SYSTEM_TEST',
      });
    }
  });

  it('A-25: allows BOB_SYSTEM_TEST=1 against a loopback database', () => {
    for (const url of local) {
      expect(validateAuthConfig({ BOB_SYSTEM_TEST: '1', BOB_DATABASE_URL: url })).toEqual({ ok: true });
    }
    expect(validateAuthConfig({ BOB_DATABASE_URL: POOLER })).toEqual({ ok: true });
  });

  // Seams, not a booted server: a server here would dial the hosted host. With
  // no test issuer, server.ts answers /api/test-token with 404 (as in A-23).
  it('A-26: no test issuer and no dev sign-in on a loopback bind with a hosted database', async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    process.env.BOB_DATABASE_URL = POOLER;
    expect((await resolveWebAuth()).testIssuer).toBeNull();
    let body: { devSignIn?: boolean } = {};
    const response = { status: () => ({ json: (value: typeof body) => { body = value; } }) };
    publicConfigHandler({} as never, response as never);
    expect(body.devSignIn).toBe(false);
    process.env.BOB_DATABASE_URL = local[0];
    publicConfigHandler({} as never, response as never);
    expect(body.devSignIn).toBe(true);
  });
});

describe('static web UI', () => {
  it('resolves apps/ui-v2/dist when present and null when absent', () => {
    expect(resolveUiDist(tempDir)).toBe(join(tempDir, 'apps', 'ui-v2', 'dist'));
    expect(resolveUiDist(absentDir)).toBeNull();
  });
  it('serves index.html for unknown GETs but does not swallow /api/*', async () => {
    const app = express();
    app.use(createStaticUiHandler(join(tempDir, 'apps', 'ui-v2', 'dist')));
    app.use('/api/chat', (_request, response) => response.status(200).json({ ok: true }));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const root = await fetch(`http://127.0.0.1:${port}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('test');
    const fallback = await fetch(`http://127.0.0.1:${port}/some/client/route`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain('test');
    const api = await fetch(`http://127.0.0.1:${port}/api/chat`);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ ok: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});