// notes-http.test.ts (spec 014, S14-T016). Proves the notes router's HTTP
// contract over the REAL mounted server: boots createV2Server() exactly like
// server-prod.test.ts / public-config.test.ts, with the system-test dev auth
// path (BOB_SYSTEM_TEST=1 + loopback bind) minting tokens via /api/test-token
// that the real /api JWT guard accepts. The notes router is mounted in
// server.ts by this same change, so this file is the end-to-end proof that the
// mount works -- not a hand-built express app that could go green while the
// route is dead in the running app (the exact seam that shipped 014's
// collaboration feature unmounted past 1007 green tests).
//
// Every assertion is on the HTTP response -- never on a store function's return
// value -- so a future unmount or misroute fails here.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createV2Server } from '../../src/server.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createSpace } from '../../src/spaces/store.ts';
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
let owner: TestAccount;
let outsider: TestAccount;
let ownerToken: string;
let outsiderToken: string;
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

async function send(method: string, path: string, tok: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tok}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Reject only this feature's read; real session admission and RLS setup still run. */
function rejectingDb(real: Db = db): Db {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (/\bfrom\s+bob\.notes\b/i.test(sql)) {
        throw new Error('injected store failure');
      }
      return real.query<T>(sql, params);
    },
    tx<T>(run: (transaction: Db) => Promise<T>): Promise<T> {
      return real.tx(transaction => run(rejectingDb(transaction)));
    },
  };
}

describe('notes HTTP API over the mounted server', () => {
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
    // outsider is deliberately never added to the space, so it is a non-member.

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

  it('creates a note in a space the caller belongs to -> 201 with the created body', async () => {
    const res = await send('POST', `/api/spaces/${spaceId}/notes`, ownerToken, {
      title: 'grocery list',
      body: 'milk, bread',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; space_id: string; revision: number; title: string };
    expect(body).toMatchObject({ space_id: spaceId, revision: 1, title: 'grocery list' });
    expect(body.id).toBeTruthy();
  });

  it('lists notes for that space -> the created note appears', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/notes`, ownerToken, {
      title: 'list me',
    });
    const { id } = (await created.json()) as { id: string };

    const res = await send('GET', `/api/spaces/${spaceId}/notes`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: Array<{ id: string }> };
    expect(body.notes.map((n) => n.id)).toContain(id);
  });

  it('gets a note by id -> the same note, with its revision', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/notes`, ownerToken, {
      title: 'read me',
    });
    const createdBody = (await created.json()) as { id: string; title: string; revision: number };

    const res = await send('GET', `/api/notes/${createdBody.id}`, ownerToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: createdBody.id, title: 'read me', revision: 1 });
  });

  it('PATCH with the CURRENT revision -> 200 and the revision moves', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/notes`, ownerToken, {
      title: 'edit me',
    });
    const { id } = (await created.json()) as { id: string };

    const res = await send('PATCH', `/api/notes/${id}`, ownerToken, {
      revision: 1,
      title: 'edited title',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, title: 'edited title', revision: 2 });
  });

  it('PATCH with a STALE revision -> 409 conflict carrying the current revision', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/notes`, ownerToken, {
      title: 'contended',
    });
    const { id } = (await created.json()) as { id: string };
    const first = await send('PATCH', `/api/notes/${id}`, ownerToken, { revision: 1, title: 'v2' });
    expect(first.status).toBe(200);

    const stale = await send('PATCH', `/api/notes/${id}`, ownerToken, { revision: 1, title: 'stale' });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: { code: string; current_revision: number } };
    expect(body.error.code).toBe('conflict');
    expect(body.error.current_revision).toBe(2);
  });

  it('a note in a space the caller is NOT a member of answers exactly like a missing id', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/notes`, ownerToken, {
      title: 'secret plan',
    });
    const { id } = (await created.json()) as { id: string };

    const hidden = await send('GET', `/api/notes/${id}`, outsiderToken);
    const missing = await send('GET', `/api/notes/${randomUUID()}`, outsiderToken);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const hiddenBody = (await hidden.json()) as { error: { code: string } };
    const missingBody = (await missing.json()) as { error: { code: string } };
    expect(hiddenBody).toEqual(missingBody);
    expect(hiddenBody).toMatchObject({ error: { code: 'not_found' } });
  });

  it('failure-injection: a rejecting store call answers a single 500 through the error handler', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/notes`, ownerToken, {
      title: 'failure target',
    });
    const { id } = (await created.json()) as { id: string };

    setSharedDb(Promise.resolve(rejectingDb()));
    try {
      const res = await send('GET', `/api/notes/${id}`, ownerToken);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body).toEqual({ error: { code: 'internal', message: 'Internal server error' } });
    } finally {
      setSharedDb(Promise.resolve(db));
    }
  });
});