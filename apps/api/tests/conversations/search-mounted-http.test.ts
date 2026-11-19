// search-mounted-http.test.ts (spec 014, S14-SEARCH-API, CU-SEARCH-1). Proves
// GET /api/search over the REAL mounted server: boots createV2Server() exactly
// like notifications-http.test.ts, with the system-test dev auth path
// (BOB_SYSTEM_TEST=1 + loopback bind) minting tokens via /api/test-token that
// the real /api JWT guard accepts. The router is mounted in server.ts by this
// same change, so this file is the end-to-end proof that the mount works --
// not a hand-built express app that could go green while the route is dead in
// the running app. Every assertion is on the HTTP response.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createV2Server } from '../../src/server.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { createTask } from '../../src/tasks/store.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
let spaceId: string;

async function issueToken(userId: string): Promise<string> {
  const issued = await fetch(`${baseUrl}/api/test-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  expect(issued.status).toBe(200);
  const body = (await issued.json()) as { token: string };
  return body.token;
}

async function send(method: string, path: string, tok?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: tok ? { authorization: `Bearer ${tok}` } : {},
  });
}

describe('GET /api/search over the mounted server', () => {
  let owner: TestAccount;
  let outsider: TestAccount;
  let ownerToken: string;
  let outsiderToken: string;

  beforeAll(async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    pg = await createTestDb();
    db = asDb(pg);
    setSharedDb(Promise.resolve(db));
    owner = await addAccount(pg);
    outsider = await addAccount(pg);

    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    spaceId = space.id;
    await createTask(db, owner.userId, spaceId, { title: 'Buy milk', body: 'from the store' });

    const created = await createV2Server();
    server = created.server;
    await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
    ownerToken = await issueToken(owner.userId);
    outsiderToken = await issueToken(outsider.userId);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(pg).catch(() => undefined);
    await closeDb().catch(() => undefined);
    delete process.env.BOB_SYSTEM_TEST;
    delete process.env.BOB_V2_HOST;
  });

  it('no Authorization header is a 401 missing_token', async () => {
    const res = await send('GET', '/api/search?q=milk');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('missing_token');
  });

  it('the owner finds the task, with exactly the documented result shape', async () => {
    const res = await send('GET', '/api/search?q=milk', ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{
        resource_type: string;
        resource_id: string;
        space_id: string;
        title: string;
        snippet: string;
        updated_at: number;
        rank: number;
      }>;
    };
    const task = body.results.find((r) => r.resource_type === 'task');
    expect(task).toBeDefined();
    expect(task?.title).toBe('Buy milk');
    expect(task?.space_id).toBe(spaceId);
    for (const result of body.results) {
      expect(Object.keys(result).sort()).toEqual(
        ['resource_type', 'resource_id', 'space_id', 'title', 'snippet', 'updated_at', 'rank'].sort(),
      );
    }
  });

  it('an outsider (not a member) gets an empty list, never a 403', async () => {
    const res = await send('GET', '/api/search?q=milk', outsiderToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
  });

  it('space_id scoping for an outsider is empty for both a real and a random space, identically', async () => {
    const realScoped = await send('GET', `/api/search?q=milk&space_id=${spaceId}`, outsiderToken);
    const randomScoped = await send('GET', `/api/search?q=milk&space_id=${randomUUID()}`, outsiderToken);
    expect(realScoped.status).toBe(200);
    expect(randomScoped.status).toBe(200);
    const realBody = await realScoped.json();
    const randomBody = await randomScoped.json();
    expect(realBody).toEqual({ results: [] });
    expect(randomBody).toEqual({ results: [] });
    expect(realBody).toEqual(randomBody);
  });

  it('a missing q is a 400 invalid_request', async () => {
    const res = await send('GET', '/api/search', ownerToken);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });
});
