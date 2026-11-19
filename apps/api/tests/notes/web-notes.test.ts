// web-notes.ts route tests (spec 014, S14-T016, contracts/api.md "Notes and
// assets"). A real HTTP server over real Postgres with the real store, so the
// identity-leak rule, the optimistic-concurrency 409 body and the Zod
// rejections are exercised against genuine store behaviour rather than fakes.
// Each state-changing route also has one failure-injection test: drive the
// store to throw and assert the route returns the mapped error and does not
// continue to a success status. The router is UNMOUNTED in server.ts (a later
// task mounts it); this file builds its own express app instead.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createNote, trashNote } from '../../src/notes/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createNotesRouter } from '../../src/notes/http.ts';
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
let token: string;

async function send(method: string, path: string, tok: string | null, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function tokenFor(account: TestAccount): Promise<string> {
  return signToken({ userId: account.userId, sessionId: account.sessionId });
}

describe('notes HTTP API', () => {
  let owner: TestAccount;
  let outsider: TestAccount;
  let ownerToken: string;
  let outsiderToken: string;
  let spaceId: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    owner = await addAccount(pg);
    outsider = await addAccount(pg);
    ownerToken = await tokenFor(owner);
    outsiderToken = await tokenFor(outsider);

    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    spaceId = space.id;
    await addMember(db, owner.userId, space.id, outsider.userId, 'member');
    // outsider immediately leaves so later calls are genuinely non-member.
    await (await import('../../src/spaces/store.ts')).revokeMember(db, owner.userId, space.id, outsider.userId);

    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api', createNotesRouter({ getDb: () => Promise.resolve(db) }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    token = ownerToken;
  });

  afterAll(async () => {
    server?.close();
    await closeTestDb(pg).catch(() => undefined);
  });

  it('creates, lists, reads and edits a note', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/notes`, token, {
      title: 'grocery list',
      body: 'milk, bread',
    });
    expect(created.status).toBe(201);
    const note = (await created.json()) as { id: string; revision: number; pinned: boolean };
    expect(note.revision).toBe(1);
    expect(note.pinned).toBe(false);

    const list = await send('GET', `/api/spaces/${spaceId}/notes`, token);
    expect(list.status).toBe(200);
    expect((await list.json()) as { notes: unknown[] }).toMatchObject({
      notes: [expect.objectContaining({ id: note.id })],
    });

    const read = await send('GET', `/api/notes/${note.id}`, token);
    expect(read.status).toBe(200);
    expect((await read.json()) as { title: string }).toMatchObject({ title: 'grocery list' });

    const patched = await send('PATCH', `/api/notes/${note.id}`, token, {
      revision: 1,
      title: 'grocery list + eggs',
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()) as { title: string; revision: number }).toMatchObject({
      title: 'grocery list + eggs',
      revision: 2,
    });
  });

  it('404 not_found for an id outside the audience equals a missing id', async () => {
    const note = await createNote(db, owner.userId, spaceId, { title: 'secret plan' });
    const hidden = await send('GET', `/api/notes/${note.id}`, outsiderToken);
    const missing = await send('GET', `/api/notes/${randomUUID()}`, outsiderToken);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const hiddenBody = (await hidden.json()) as { error: { code: string } };
    const missingBody = (await missing.json()) as { error: { code: string } };
    expect(hiddenBody).toEqual(missingBody);
    expect(hiddenBody).toMatchObject({ error: { code: 'not_found' } });
  });

  it('409 conflict body carries the current revision on a stale PATCH', async () => {
    const note = await createNote(db, owner.userId, spaceId, { title: 'contended' });
    const first = await send('PATCH', `/api/notes/${note.id}`, token, { revision: 1, title: 'v2' });
    expect(first.status).toBe(200);

    const stale = await send('PATCH', `/api/notes/${note.id}`, token, { revision: 1, title: 'stale' });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: { code: string; current_revision: number } };
    expect(body.error.code).toBe('conflict');
    expect(body.error.current_revision).toBe(2);
  });

  it('400 invalid_request for a Zod-rejected body', async () => {
    const res = await send('POST', `/api/spaces/${spaceId}/notes`, token, { title: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'invalid_request' },
    });
  });

  it('401 without a token', async () => {
    const res = await send('GET', `/api/spaces/${spaceId}/notes`, null);
    expect(res.status).toBe(401);
  });

  it('failure-injection: POST create by a non-member does not continue to 200/201', async () => {
    // createNote checks active membership before the insert (requireSpaceMember),
    // so a non-member's create is refused with 404 -- the same answer as a
    // missing space -- and the insert never runs. Assert the refusal and that
    // no note is created.
    const before = await send('GET', `/api/spaces/${spaceId}/notes`, token);
    const beforeCount = ((await before.json()) as { notes: unknown[] }).notes.length;

    const res = await send('POST', `/api/spaces/${spaceId}/notes`, outsiderToken, { title: 'trespass' });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
    expect(res.status).toBe(404);

    const after = await send('GET', `/api/spaces/${spaceId}/notes`, token);
    expect(((await after.json()) as { notes: unknown[] }).notes.length).toBe(beforeCount);
  });

  it('failure-injection: PATCH maps a store conflict and does not continue', async () => {
    const note = await createNote(db, owner.userId, spaceId, { title: 'patch target' });
    const res = await send('PATCH', `/api/notes/${note.id}`, token, { revision: 999, title: 'x' });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'conflict' },
    });
  });

  it('failure-injection: DELETE maps a store not-found and does not continue', async () => {
    const note = await createNote(db, owner.userId, spaceId, { title: 'delete target' });
    // An outsider cannot trash it -> the store throws StoreNotFoundError -> 404.
    const res = await send('DELETE', `/api/notes/${note.id}`, outsiderToken);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('failure-injection: restore maps a store not-found and does not continue', async () => {
    const note = await createNote(db, owner.userId, spaceId, { title: 'restore target' });
    await trashNote(db, owner.userId, note.id);
    const res = await send('POST', `/api/notes/${note.id}/restore`, outsiderToken);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('failure-injection: PUT pin maps a store not-found and does not continue', async () => {
    const note = await createNote(db, owner.userId, spaceId, { title: 'pin target' });
    const res = await send('PUT', `/api/notes/${note.id}/pin`, outsiderToken);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('failure-injection: DELETE pin maps a store not-found and does not continue', async () => {
    const note = await createNote(db, owner.userId, spaceId, { title: 'unpin target' });
    const res = await send('DELETE', `/api/notes/${note.id}/pin`, outsiderToken);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('pin, unpin, revisions and search happy paths', async () => {
    const note = await createNote(db, owner.userId, spaceId, { title: 'pinboard entry', body: 'searchable text' });

    const pinned = await send('PUT', `/api/notes/${note.id}/pin`, token);
    expect(pinned.status).toBe(200);
    expect((await pinned.json()) as { pinned: boolean }).toMatchObject({ pinned: true });

    const unpinned = await send('DELETE', `/api/notes/${note.id}/pin`, token);
    expect(unpinned.status).toBe(200);
    expect((await unpinned.json()) as { pinned: boolean }).toMatchObject({ pinned: false });

    await send('PATCH', `/api/notes/${note.id}`, token, { revision: 1, title: 'pinboard entry v2' });
    const revisions = await send('GET', `/api/notes/${note.id}/revisions`, token);
    expect(revisions.status).toBe(200);
    const revisionsBody = (await revisions.json()) as { revisions: Array<{ revision: number }> };
    expect(revisionsBody.revisions.map((r) => r.revision)).toEqual([2, 1]);

    const search = await send('GET', `/api/spaces/${spaceId}/notes/search?q=searchable`, token);
    expect(search.status).toBe(200);
    expect((await search.json()) as { notes: unknown[] }).toMatchObject({
      notes: [expect.objectContaining({ id: note.id })],
    });
  });

  it('trash then restore round-trips through the HTTP API', async () => {
    const note = await createNote(db, owner.userId, spaceId, { title: 'trash round trip' });

    const trashed = await send('DELETE', `/api/notes/${note.id}`, token);
    expect(trashed.status).toBe(204);

    const listAfterTrash = await send('GET', `/api/spaces/${spaceId}/notes`, token);
    expect((await listAfterTrash.json()) as { notes: unknown[] }).toMatchObject({
      notes: expect.not.arrayContaining([expect.objectContaining({ id: note.id })]),
    });

    const restored = await send('POST', `/api/notes/${note.id}/restore`, token);
    expect(restored.status).toBe(200);
    expect((await restored.json()) as { trashed_at: number | null }).toMatchObject({ trashed_at: null });
  });
});
