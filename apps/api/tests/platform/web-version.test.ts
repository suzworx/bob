import type { Request, Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createV2Server } from '../../src/server.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { EXPECTED_SCHEMA_VERSION } from '../../src/web-health.ts';
import { createVersionHandler, createVersionRouter } from '../../src/web-version.ts';
import { resolveCommit } from '../../src/platform/commit.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const SHA = '7b30ed4c1f0a9e8d7c6b5a4f3e2d1c0b9a8f7e6d';

/** A Db whose schema lookups answer `version`, or throw when it is undefined. */
function fakeDb(version?: string): Db {
  const db: Db = {
    async query<T>(): Promise<T[]> {
      if (version === undefined) throw new Error('relation does not exist');
      return [{ version } as T];
    },
    tx<T>(fn: (inner: Db) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  return db;
}

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

async function call(handler: (req: Request, res: Response) => Promise<void>): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: {} };
  const response = {
    status(code: number): Response {
      captured.status = code;
      return response as unknown as Response;
    },
    set(name: string, value: string): Response {
      captured.headers[name] = value;
      return response as unknown as Response;
    },
    json(body: Record<string, unknown>): Response {
      captured.body = body;
      return response as unknown as Response;
    },
  };
  await handler({} as Request, response as unknown as Response);
  return captured;
}

describe('resolveCommit', () => {
  it('prefers the Railway commit, lower-cased', () => {
    expect(resolveCommit({ RAILWAY_GIT_COMMIT_SHA: SHA.toUpperCase(), BOB_COMMIT_SHA: 'abcdef1' })).toBe(SHA);
  });

  it('falls back to BOB_COMMIT_SHA on another host', () => {
    expect(resolveCommit({ BOB_COMMIT_SHA: 'abcdef1' })).toBe('abcdef1');
  });

  it('is null when no host names a commit', () => {
    expect(resolveCommit({})).toBeNull();
  });

  it('never echoes a value that is not a sha', () => {
    expect(resolveCommit({ RAILWAY_GIT_COMMIT_SHA: 'sb_secret_abc', BOB_COMMIT_SHA: 'not a sha' })).toBeNull();
    expect(resolveCommit({ BOB_COMMIT_SHA: 'abc12' })).toBeNull();
  });
});

describe('GET /api/version', () => {
  it('reports the commit, its short form and the schema', async () => {
    const handler = createVersionHandler({
      env: { RAILWAY_GIT_COMMIT_SHA: SHA },
      db: async () => fakeDb(EXPECTED_SCHEMA_VERSION ?? undefined),
    });
    const res = await call(handler);
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body).toEqual({
      commit: SHA,
      commit_short: SHA.slice(0, 7),
      schema_version: EXPECTED_SCHEMA_VERSION,
      schema_expected: EXPECTED_SCHEMA_VERSION,
      schema_status: 'ok',
    });
  });

  it('still answers 200 with nulls when neither commit nor schema is known', async () => {
    const handler = createVersionHandler({ env: {}, db: async () => fakeDb() });
    const res = await call(handler);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ commit: null, commit_short: null, schema_version: null, schema_status: 'unknown' });
  });

  it('answers unknown within the timeout when the database hangs', async () => {
    const handler = createVersionHandler({
      env: { BOB_COMMIT_SHA: 'abcdef1' },
      db: () => new Promise<Db>(() => {}),
      timeoutMs: 20,
    });
    const res = await call(handler);
    expect(res.body).toMatchObject({ commit: 'abcdef1', schema_status: 'unknown' });
  });

  it('mounts at the router root for GET only', () => {
    const router = createVersionRouter({ env: {}, db: appDeps.getDb });
    // Express keeps `methods` on each route at runtime but does not type it.
    const layers = router.stack.map((layer) => ({
      path: layer.route?.path,
      methods: (layer.route as unknown as { methods?: Record<string, boolean> } | undefined)?.methods,
    }));
    expect(layers).toEqual([{ path: '/', methods: { get: true } }]);
  });
});

describe('GET /api/version on the real mounted server', () => {
  let server: Server | null = null;
  let pg: TestDb;

  // The route reads the schema version through getDb(): give it this file's test database.
  beforeAll(async () => {
    pg = await createTestDb();
  });

  afterAll(async () => {
    await closeTestDb(pg).catch(() => undefined);
  });

  afterEach(async () => {
    // server.close() also drains the extraction worker before it calls back.
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    await closeDb().catch(() => undefined);
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
  });

  it('answers 200 without a token and exposes only the commit and the schema', async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = SHA;
    setSharedDb(Promise.resolve(asDb(pg)));
    const created = await createV2Server();
    server = created.server;
    await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
    const { port } = created.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const response = await fetch(`${base}/api/version`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['commit', 'commit_short', 'schema_expected', 'schema_status', 'schema_version']);
    expect(body).toMatchObject({ commit: SHA, commit_short: SHA.slice(0, 7), schema_expected: EXPECTED_SCHEMA_VERSION });

    // The guard still covers every other /api route.
    expect((await fetch(`${base}/api/conversations`)).status).toBe(401);
  });
});
