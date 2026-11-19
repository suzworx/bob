// search-http.test.ts (spec 014, S14-SEARCH-API, contracts/api.md "/api/search").
// Proves the search router's HTTP contract over a tiny express app
// (search-mounted-http.test.ts proves the real server.ts mount), with the same
// JWT guard the other /api routers sit behind and a real Postgres store. Every assertion is
// on the HTTP response -- never on a store function's return value.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db, withUser } from '../../src/platform/db/db.ts';
import { archiveSpace, createSpace } from '../../src/spaces/store.ts';
import { createTask } from '../../src/tasks/store.ts';
import { createNote } from '../../src/notes/store.ts';
import { createCalendar, createEvent } from '../../src/calendar/store.ts';
import { createThread } from '../../src/conversations/thread-store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { webErrorHandler } from '../../src/platform/http/errors.ts';
import { createSearchRouter } from '../../src/conversations/search-http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
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

async function search(query: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/search${query}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('scoped search HTTP API', () => {
  let owner: TestAccount;
  let ownerToken: string;
  let spaceId: string;
  let otherSpaceId: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    owner = await addAccount(pg);
    ownerToken = await signToken({ userId: owner.userId, sessionId: owner.sessionId });

    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    spaceId = space.id;
    const other = await createSpace(db, owner.userId, { kind: 'group', name: 'Work' });
    otherSpaceId = other.id;

    // Milk rows in the shared space: a task, a note and an event all match
    // "milk"; a thread is titled so it does NOT match. A second task in the
    // work space matches "milk" too, for the space-scoping case.
    await createTask(db, owner.userId, spaceId, { title: 'Buy milk', body: 'from the store' });
    await createNote(db, owner.userId, spaceId, { title: 'Milk recipes', body: 'how to cook with milk' });
    const cal = await createCalendar(db, owner.userId, spaceId, { name: 'Home', zone: 'UTC' });
    await createEvent(db, owner.userId, cal.id, {
      title: 'Milk tasting',
      allDay: true,
      startDate: '2026-09-01',
      endDate: '2026-09-02',
      zone: 'UTC',
    });
    await createThread(db, owner.userId, { spaceId, title: 'Family board' });
    await createTask(db, owner.userId, otherSpaceId, { title: 'milk run', body: 'errand' });

    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api', createSearchRouter({ getDb: () => Promise.resolve(db) }));
    app.use('/api', webErrorHandler);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await closeTestDb(pg).catch(() => undefined);
  });

  // IDS U2: a shared conversation's id is opaque; the space kind labels it.
  it('a shared conversation with a non-uuid id is returned as a thread', async () => {
    const id = `cnv_${randomUUID()}`;
    await withUser(db, owner.userId, (tx) =>
      tx.query(
        `insert into bob.conversations (id, user_id, space_id, created_by, title) values ($1, $2, $3, $2, 'Opaque board')`,
        [id, owner.userId, spaceId],
      ),
    );
    const res = await search('?q=Opaque&type=thread', ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ resource_type: string; resource_id: string }> };
    expect(body.results).toEqual([expect.objectContaining({ resource_type: 'thread', resource_id: id })]);
  });

  it('a query matching a task, a note and an event returns all three with their types', async () => {
    const res = await search(`?q=milk&space_id=${spaceId}`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ resource_type: string; title: string }>;
    };
    expect(body.results.map((r) => r.resource_type).sort()).toEqual(['event', 'note', 'task']);
    expect(body.results.map((r) => r.title).sort()).toEqual([
      'Buy milk',
      'Milk recipes',
      'Milk tasting',
    ]);
  });

  it('type=note narrows the same query to notes only', async () => {
    const res = await search('?q=milk&type=note', ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ resource_type: string }> };
    expect(body.results.length).toBe(1);
    expect(body.results[0]?.resource_type).toBe('note');
  });

  it('space_id scopes the search, and an unreadable/missing space answers an empty list', async () => {
    const scoped = await search(`?q=milk&space_id=${spaceId}`, ownerToken);
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as {
      results: Array<{ resource_type: string; space_id: string }>;
    };
    expect(scopedBody.results.length).toBe(3);
    expect(scopedBody.results.every((r) => r.space_id === spaceId)).toBe(true);

    // A different space the caller IS a member of returns that space's rows.
    const workScoped = await search(`?q=milk&space_id=${otherSpaceId}`, ownerToken);
    expect(workScoped.status).toBe(200);
    const workBody = (await workScoped.json()) as { results: Array<{ title: string; space_id: string }> };
    expect(workBody.results.length).toBe(1);
    expect(workBody.results[0]?.title).toBe('milk run');
    expect(workBody.results[0]?.space_id).toBe(otherSpaceId);

    // A space the caller cannot reach (or that does not exist) is an EMPTY list,
    // never a 403 -- identical to a nonexistent space.
    const unknown = await search(`?q=milk&space_id=${randomUUID()}`, ownerToken);
    expect(unknown.status).toBe(200);
    expect((await unknown.json()) as { results: unknown[] }).toMatchObject({ results: [] });
  });

  it('archiving a space removes its resources from search results', async () => {
    const tripSpace = await createSpace(db, owner.userId, { kind: 'group', name: 'Trip' });
    await createTask(db, owner.userId, tripSpace.id, { title: 'Book hotel', body: 'for the trip' });

    const before = await search('?q=hotel', ownerToken);
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as { results: Array<{ title: string }> };
    expect(beforeBody.results.map((r) => r.title)).toContain('Book hotel');

    await archiveSpace(db, owner.userId, tripSpace.id);

    const after = await search('?q=hotel', ownerToken);
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as { results: unknown[] };
    expect(afterBody.results).toEqual([]);
  });

  it('an empty q is a 400 with a named code', async () => {
    const res = await search('?q=', ownerToken);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('an exact title match outranks a body match', async () => {
    await createTask(db, owner.userId, spaceId, { title: 'acme', body: 'the flagship' });
    await createNote(db, owner.userId, spaceId, { title: 'notes', body: 'about acme project' });
    const res = await search('?q=acme', ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ resource_type: string; title: string; rank: number }>;
    };
    expect(body.results.length).toBe(2);
    expect(body.results[0]?.resource_type).toBe('task');
    expect(body.results[0]?.title).toBe('acme');
    expect(body.results[0]?.rank).toBeLessThan(body.results[1]!.rank);
  });

  it('paging by limit is stable across repeated calls', async () => {
    await createTask(db, owner.userId, spaceId, { title: 'milk jug', body: 'to buy' });
    const first = await search('?q=milk&limit=2', ownerToken);
    const second = await search('?q=milk&limit=2', ownerToken);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { results: Array<{ resource_id: string }> };
    const b = (await second.json()) as { results: Array<{ resource_id: string }> };
    expect(a.results.length).toBe(2);
    expect(a.results.map((r) => r.resource_id)).toEqual(b.results.map((r) => r.resource_id));
  });
});