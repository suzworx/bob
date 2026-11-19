// web-publication.ts route tests (spec 014, GitHub issue #142). A real HTTP
// server over real Postgres with the real store. Provenance leakage is the point: the
// published copy and the promoted task must disclose nothing about their private
// source, and editing the copy must never touch the source.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace, ensurePrivateSpace } from '../../src/spaces/store.ts';
import { createNote, getNote } from '../../src/notes/store.ts';
import { listTasks } from '../../src/tasks/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createNotesRouter } from '../../src/notes/http.ts';
import { createPublicationRouter } from '../../src/spaces/publication-http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, withUserRaw, type TestAccount, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;

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

async function remembered(userId: string, content: string): Promise<string> {
  const id = `mem_${randomUUID()}`;
  await withUserRaw(pg, userId, (tx) =>
    tx.query(
      `INSERT INTO bob.memories (id, user_id, kind, content, confidence, surface)
       VALUES ($1, $2, 'action_item', $3, 0.9, 'device')`,
      [id, userId, content],
    ),
  );
  return id;
}

describe('publication HTTP API', () => {
  let author: TestAccount;
  let member: TestAccount;
  let authorToken: string;
  let memberToken: string;
  let privateId: string;
  let familyId: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    author = await addAccount(pg);
    member = await addAccount(pg);
    authorToken = await signToken({ userId: author.userId, sessionId: author.sessionId });
    memberToken = await signToken({ userId: member.userId, sessionId: member.sessionId });
    privateId = (await ensurePrivateSpace(db, author.userId)).id;
    familyId = (await createSpace(db, author.userId, { kind: 'group', name: 'Family' })).id;
    await addMember(db, author.userId, familyId, member.userId, 'member');

    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api', createNotesRouter({ getDb: () => Promise.resolve(db) }));
    app.use('/api', createPublicationRouter({ getDb: () => Promise.resolve(db) }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await closeTestDb(pg).catch(() => undefined);
  });

  it('publishes only the selected fields, and the copy names nothing about its source', async () => {
    const source = await createNote(db, author.userId, privateId, { title: 'Trip ideas', body: 'private musing' });
    const res = await send('POST', `/api/notes/${source.id}/publish`, authorToken, {
      space_id: familyId,
      fields: { title: true },
    });
    expect(res.status).toBe(201);
    const copy = (await res.json()) as Record<string, unknown>;
    expect(copy.title).toBe('Trip ideas');
    expect(copy.body).toBe('');
    expect(copy.space_id).toBe(familyId);
    expect(copy.revision).toBe(1);
    const text = JSON.stringify(copy);
    expect(text).not.toContain(source.id);
    expect(text).not.toContain(privateId);
    expect(text).not.toContain('private musing');

    // The member reads an ordinary note, and its history holds only the copy.
    const seen = await send('GET', `/api/notes/${String(copy.id)}/revisions`, memberToken);
    expect(seen.status).toBe(200);
    const revisions = JSON.stringify(await seen.json());
    expect(revisions).not.toContain('private musing');
    expect(revisions).not.toContain(source.id);
  });

  it('editing the published copy never touches the source', async () => {
    const source = await createNote(db, author.userId, privateId, { title: 'Recipe', body: 'original' });
    const res = await send('POST', `/api/notes/${source.id}/publish`, authorToken, {
      space_id: familyId,
      fields: { title: true, body: true },
    });
    const copy = (await res.json()) as { id: string };
    const edit = await send('PATCH', `/api/notes/${copy.id}`, memberToken, { revision: 1, body: 'family edit' });
    expect(edit.status).toBe(200);
    const after = await getNote(db, author.userId, source.id);
    expect(after.body).toBe('original');
    expect(after.revision).toBe(1);
  });

  it('a member cannot publish the author\'s private note: same 404 as a missing id', async () => {
    const source = await createNote(db, author.userId, privateId, { title: 'Mine', body: 'x' });
    const body = { space_id: familyId, fields: { title: true } };
    const hidden = await send('POST', `/api/notes/${source.id}/publish`, memberToken, body);
    const missing = await send('POST', `/api/notes/${randomUUID()}/publish`, memberToken, body);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
  });

  it('promotes a memory into an ordinary task that discloses nothing about the memory', async () => {
    const memoryId = await remembered(author.userId, 'call the dentist about the private thing');
    const res = await send('POST', `/api/memories/${memoryId}/promote`, authorToken, {
      space_id: familyId,
      title: 'Call the dentist',
    });
    expect(res.status).toBe(201);
    const task = (await res.json()) as Record<string, unknown>;
    expect(task.title).toBe('Call the dentist');
    expect(task.body).toBeNull();
    const text = JSON.stringify(task);
    expect(text).not.toContain(memoryId);
    expect(text).not.toContain('private thing');

    // Independently editable by a member through the ordinary task store.
    const tasks = await listTasks(db, member.userId, familyId);
    expect(tasks.map((t) => t.id)).toContain(task.id);
  });

  it('promoting someone else\'s memory answers exactly like a missing one', async () => {
    const memoryId = await remembered(author.userId, 'author only');
    const body = { space_id: familyId, title: 'peek' };
    const hidden = await send('POST', `/api/memories/${memoryId}/promote`, memberToken, body);
    const missing = await send('POST', `/api/memories/mem_${randomUUID()}/promote`, memberToken, body);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
  });

  it('rejects bad input and a missing token', async () => {
    const source = await createNote(db, author.userId, privateId, { title: 'T' });
    expect((await send('POST', `/api/notes/${source.id}/publish`, authorToken, { space_id: familyId, fields: {} })).status).toBe(400);
    expect((await send('POST', `/api/notes/${source.id}/publish`, authorToken, { space_id: 'nope', fields: { title: true } })).status).toBe(400);
    expect((await send('POST', `/api/memories/mem_x/promote`, authorToken, { space_id: familyId, title: 'x' })).status).toBe(400);
    expect((await send('POST', `/api/memories/mem_${randomUUID()}/promote`, authorToken, { space_id: familyId, title: '' })).status).toBe(400);
    expect((await send('POST', `/api/notes/${source.id}/publish`, null, { space_id: familyId, fields: { title: true } })).status).toBe(401);
  });
});
