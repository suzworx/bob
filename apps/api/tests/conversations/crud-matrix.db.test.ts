/**
 * The CRUD matrix: create / read / update / delete for every entity, driven
 * over HTTP through the SAME routes the web client calls (mounted at /api as
 * server.ts mounts them) against the LOCAL Supabase stack. Every write asserts
 * its status AND reads the entity back, because a 200 that changed nothing is
 * the bug class this suite exists to catch. Each create/update also proves a
 * blank title/body is a 4xx that writes nothing, and an unknown id is a 404.
 *
 * Runs only under apps/api/vitest.db.config.ts. The throwaway users come from
 * db-harness.ts; the dev account is never touched. Conversations cannot be
 * created by a stubbed chat turn (the AI stub never touches the store), so the
 * conversation rows are seeded through the store and every other operation on
 * them goes over HTTP.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createSpacesRouter } from '../../src/spaces/http.ts';
import { createThreadsRouter } from '../../src/spaces/threads-http.ts';
import { createTasksRouter } from '../../src/tasks/http.ts';
import { createCalendarsRouter } from '../../src/calendar/http.ts';
import { createNotesRouter } from '../../src/notes/http.ts';
import { createMemoriesRouter } from '../../src/memory/http.ts';
import { createActionItemsRouter } from '../../src/tasks/action-items-http.ts';
import {
  deleteConversationRoute,
  getConversationRoute,
  listConversationsRoute,
  renameConversationRoute,
} from '../../src/conversations/http.ts';
import { deleteMessagesFromRoute, markReplyInterruptedRoute } from '../../src/conversations/messages-http.ts';
import { webErrorHandler } from '../../src/platform/http/errors.ts';
import { ensureLocalStack, setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const DIMS = 1536;

/** Deterministic embedding so memory writes never call the gateway. */
const embed = async (content: string) => ({
  values: Array.from({ length: DIMS }, (_, i) => 0.5 + Math.sin(content.length * 7919 + i) * 0.01),
  model: 'text-embedding-3-small',
  dim: DIMS,
});

let env: MemoryTestDb;
let db: Db;
let server: Server;
let baseUrl: string;
let token: string;

/** The unknown-id probe: a well-formed id no row has (a malformed one is 400). */
const unknownId = (): string => randomUUID();
/** The one body every "space not found" 404 carries, whichever router answers. */
const SPACE_NOT_FOUND = { error: { code: 'not_found', message: 'space not found' } };

/** Inserts an active auth.sessions row (DELETE /spaces/:id runs
 *  requireActiveSession) as the local superuser, as memories-api.db does. */
async function createActiveSession(dbUrl: string, userId: string): Promise<string> {
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const sessionId = randomUUID();
    await sql`insert into auth.sessions (id, user_id) values (${sessionId}, ${userId})`;
    return sessionId;
  } finally {
    await sql.end();
  }
}

/** The /api surface under test, mounted in server.ts's order and shape. */
async function bootServer(): Promise<void> {
  const getDb = (): Promise<Db> => Promise.resolve(db);
  const active = requireActiveSession(getDb);
  const app = express();
  app.use('/api', createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api', express.json());
  app.get('/api/conversations', listConversationsRoute(appDeps));
  app.get('/api/conversations/:id', getConversationRoute(appDeps));
  app.patch('/api/conversations/:id', renameConversationRoute(appDeps));
  app.delete('/api/conversations/:id', deleteConversationRoute(appDeps));
  app.patch('/api/conversations/:id/messages/:messageId', markReplyInterruptedRoute(appDeps));
  app.delete('/api/conversations/:id/messages/:messageId', deleteMessagesFromRoute(appDeps));
  app.use('/api/memories', createMemoriesRouter({ getDb, embed, requireActiveSession: active }));
  app.use('/api/action-items', createActionItemsRouter({ getDb }));
  app.use('/api', createSpacesRouter({ getDb, requireActiveSession: active }));
  app.use('/api', createThreadsRouter({ getDb, events: { publish: () => undefined } }));
  app.use('/api', createTasksRouter({ getDb }));
  app.use('/api', createCalendarsRouter({ getDb }));
  app.use('/api', createNotesRouter({ getDb }));
  app.use('/api', webErrorHandler);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

/** One request as the web client makes it; the JSON body is parsed when present. */
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  env = await setupMemoryTestDb();
  db = env.db;
  // The conversation routes resolve the store through the process-wide getDb().
  setSharedDb(Promise.resolve(db));
  const statusEnv = await ensureLocalStack();
  const sessionId = await createActiveSession(statusEnv.DB_URL!, env.a.userId);
  token = await signToken({ userId: env.a.userId, sessionId });
  await bootServer();
});

afterAll(async () => {
  server?.close();
  await env?.cleanup();
});

describe('space', () => {
  let id: string;

  it('create: POST /spaces writes a group space; blank name is 400 and writes nothing', async () => {
    const before = (await api('GET', '/spaces')).json.spaces.length;
    expect((await api('POST', '/spaces', { kind: 'group', name: '   ' })).status).toBe(400);
    expect((await api('GET', '/spaces')).json.spaces.length).toBe(before);
    const created = await api('POST', '/spaces', { kind: 'group', name: 'Crud Space' });
    expect(created.status).toBe(201);
    id = created.json.id;
    expect((await api('GET', '/spaces')).json.spaces.length).toBe(before + 1);
  });

  it('read: list and get return the space; an unknown id is 404', async () => {
    const list = await api('GET', '/spaces');
    expect(list.json.spaces.map((s: { id: string }) => s.id)).toContain(id);
    const got = await api('GET', `/spaces/${id}`);
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ id, name: 'Crud Space', kind: 'group', role: 'owner' });
    expect((await api('GET', `/spaces/${unknownId()}`)).status).toBe(404);
  });

  it('update: PATCH renames; blank name is 400 and leaves it; unknown id is 404', async () => {
    expect((await api('PATCH', `/spaces/${id}`, { name: '  ' })).status).toBe(400);
    expect((await api('GET', `/spaces/${id}`)).json.name).toBe('Crud Space');
    expect((await api('PATCH', `/spaces/${id}`, { name: 'Renamed Space' })).status).toBe(200);
    expect((await api('GET', `/spaces/${id}`)).json.name).toBe('Renamed Space');
    expect((await api('PATCH', `/spaces/${unknownId()}`, { name: 'x' })).status).toBe(404);
  });

  it('delete: DELETE archives, PATCH {archived:false} restores; unknown id is 404', async () => {
    expect((await api('DELETE', `/spaces/${id}`)).status).toBe(200);
    expect((await api('GET', '/spaces')).json.spaces.map((s: { id: string }) => s.id)).not.toContain(id);
    const archived = await api('GET', '/spaces?archived=true');
    expect(archived.json.spaces.map((s: { id: string }) => s.id)).toContain(id);
    expect((await api('PATCH', `/spaces/${id}`, { archived: false })).status).toBe(200);
    expect((await api('GET', `/spaces/${id}`)).json.archived_at).toBeNull();
    expect((await api('DELETE', `/spaces/${unknownId()}`)).status).toBe(404);
  });
});

describe('thread', () => {
  let id: string;
  // Multi-author conversations live in shared spaces only (IDS U2).
  const space = (): string => env.spaces.groupABC;
  const titles = async (): Promise<string[]> =>
    (await api('GET', `/spaces/${space()}/threads`)).json.threads.map((t: { title: string }) => t.title);

  it('create: POST /spaces/:id/threads; blank title is 400 and writes nothing', async () => {
    const before = (await titles()).length;
    expect((await api('POST', `/spaces/${space()}/threads`, { title: ' \t ' })).status).toBe(400);
    expect((await titles()).length).toBe(before);
    const created = await api('POST', `/spaces/${space()}/threads`, { title: 'Crud Thread' });
    expect(created.status).toBe(201);
    id = created.json.id;
    expect(await titles()).toContain('Crud Thread');
  });

  it('create: POST /spaces/:unknown/threads is 404', async () => {
    const res = await api('POST', `/spaces/${unknownId()}/threads`, { title: 'x' });
    expect(res.status).toBe(404);
    expect(res.json).toEqual(SPACE_NOT_FOUND);
  });

  it('create: POST /spaces/:private/threads is 404 and writes nothing', async () => {
    const res = await api('POST', `/spaces/${env.spaces.privateA}/threads`, { title: 'Private Thread' });
    expect(res.status).toBe(404);
    expect(res.json).toEqual(SPACE_NOT_FOUND);
    expect((await api('GET', `/spaces/${env.spaces.privateA}/threads`)).json.threads).toEqual([]);
  });

  it('read: list and get return the thread; an unknown id is 404', async () => {
    expect((await api('GET', `/threads/${id}`)).json).toMatchObject({ id, title: 'Crud Thread' });
    expect((await api('GET', `/threads/${unknownId()}`)).status).toBe(404);
  });

  it('update: PATCH renames; blank title is 400 and leaves it; unknown id is 404', async () => {
    expect((await api('PATCH', `/threads/${id}`, { title: '' })).status).toBe(400);
    expect((await api('PATCH', `/threads/${id}`, { title: 'Renamed Thread' })).status).toBe(200);
    expect((await api('GET', `/threads/${id}`)).json.title).toBe('Renamed Thread');
    expect((await api('PATCH', `/threads/${unknownId()}`, { title: 'x' })).status).toBe(404);
  });

  it('delete: DELETE archives the thread; unknown id is 404', async () => {
    expect((await api('DELETE', `/threads/${id}`)).status).toBe(200);
    expect((await api('GET', `/threads/${id}`)).json.archived_at).not.toBeNull();
    expect(await titles()).not.toContain('Renamed Thread');
    expect((await api('DELETE', `/threads/${unknownId()}`)).status).toBe(404);
  });
});

describe('thread message', () => {
  let threadId: string;
  let id: string;
  const list = async (): Promise<Array<{ id: string; body: string; tombstoned_at: number | null }>> =>
    (await api('GET', `/threads/${threadId}/messages`)).json.messages;

  beforeAll(async () => {
    threadId = (await api('POST', `/spaces/${env.spaces.groupABC}/threads`, { title: 'Messages' })).json.id;
  });

  it('create: POST /threads/:id/messages; blank body is 400 and writes nothing', async () => {
    expect((await api('POST', `/threads/${threadId}/messages`, { body: '   ', client_message_id: 'c0' })).status).toBe(400);
    expect(await list()).toHaveLength(0);
    const created = await api('POST', `/threads/${threadId}/messages`, { body: 'hello', client_message_id: 'c1' });
    expect(created.status).toBe(201);
    id = created.json.id;
    expect((await list()).map((m) => m.body)).toEqual(['hello']);
    expect((await api('POST', `/threads/${unknownId()}/messages`, { body: 'x', client_message_id: 'c2' })).status).toBe(404);
  });

  it('read: list returns it; an unknown thread id is 404', async () => {
    expect((await list())[0]).toMatchObject({ id, body: 'hello', tombstoned_at: null });
    expect((await api('GET', `/threads/${unknownId()}/messages`)).status).toBe(404);
  });

  it('update: PATCH /messages/:id edits; blank body is 400 and leaves it; unknown id is 404', async () => {
    expect((await api('PATCH', `/messages/${id}`, { body: ' ' })).status).toBe(400);
    expect((await api('PATCH', `/messages/${id}`, { body: 'edited' })).status).toBe(200);
    expect((await list())[0]!.body).toBe('edited');
    expect((await api('PATCH', `/messages/${unknownId()}`, { body: 'x' })).status).toBe(404);
  });

  it('delete: DELETE /messages/:id tombstones it; unknown id is 404', async () => {
    expect((await api('DELETE', `/messages/${id}`)).status).toBe(200);
    expect((await list()).find((m) => m.id === id)?.tombstoned_at).not.toBeNull();
    expect((await api('DELETE', `/messages/${unknownId()}`)).status).toBe(404);
  });
});

describe('task', () => {
  let id: string;
  const space = (): string => env.spaces.privateA;
  const get = async (): Promise<any> => (await api('GET', `/tasks/${id}`)).json;
  const listed = async (query = ''): Promise<string[]> =>
    (await api('GET', `/spaces/${space()}/tasks${query}`)).json.tasks.map((t: { id: string }) => t.id);

  it('create: POST /spaces/:id/tasks; blank title is 400 and writes nothing', async () => {
    const before = (await listed()).length;
    expect((await api('POST', `/spaces/${space()}/tasks`, { title: '  ' })).status).toBe(400);
    expect((await listed()).length).toBe(before);
    const created = await api('POST', `/spaces/${space()}/tasks`, { title: 'Crud Task' });
    expect(created.status).toBe(201);
    id = created.json.id;
    expect(await listed()).toContain(id);
  });

  it('create: POST /spaces/:unknown/tasks is 404', async () => {
    const res = await api('POST', `/spaces/${unknownId()}/tasks`, { title: 'x' });
    expect(res.status).toBe(404);
    expect(res.json).toEqual(SPACE_NOT_FOUND);
  });

  it('read: list and get return the task; an unknown id is 404', async () => {
    expect(await get()).toMatchObject({ id, title: 'Crud Task', status: 'open', due: null });
    expect((await api('GET', `/tasks/${unknownId()}`)).status).toBe(404);
  });

  it('update: PATCH title, due and complete each land; blank title is 400; unknown id is 404', async () => {
    expect((await api('PATCH', `/tasks/${id}`, { revision: (await get()).revision, title: ' ' })).status).toBe(400);
    expect((await get()).title).toBe('Crud Task');
    expect((await api('PATCH', `/tasks/${id}`, { revision: (await get()).revision, title: 'Renamed Task' })).status).toBe(200);
    expect((await get()).title).toBe('Renamed Task');
    const due = { kind: 'date', date: '2030-01-02' };
    expect((await api('PATCH', `/tasks/${id}`, { revision: (await get()).revision, due })).status).toBe(200);
    expect((await get()).due).toEqual(due);
    expect((await api('PATCH', `/tasks/${id}`, { revision: (await get()).revision, status: 'completed' })).status).toBe(200);
    expect(await get()).toMatchObject({ status: 'completed', completed_by: env.a.userId });
    expect((await api('PATCH', `/tasks/${unknownId()}`, { revision: 1, title: 'x' })).status).toBe(404);
  });

  it('delete: DELETE trashes, POST restore brings it back; unknown id is 404', async () => {
    expect((await api('DELETE', `/tasks/${id}`)).status).toBe(204);
    expect(await listed()).not.toContain(id);
    expect(await listed('?trashed=true')).toContain(id);
    expect((await api('POST', `/tasks/${id}/restore`)).status).toBe(200);
    expect((await get()).trashed_at).toBeNull();
    expect(await listed()).toContain(id);
    expect((await api('DELETE', `/tasks/${unknownId()}`)).status).toBe(404);
    expect((await api('POST', `/tasks/${unknownId()}/restore`)).status).toBe(404);
  });
});

describe('note', () => {
  let id: string;
  const space = (): string => env.spaces.privateA;
  const get = async (): Promise<any> => (await api('GET', `/notes/${id}`)).json;
  const listed = async (query = ''): Promise<string[]> =>
    (await api('GET', `/spaces/${space()}/notes${query}`)).json.notes.map((n: { id: string }) => n.id);

  it('create: POST /spaces/:id/notes; blank title is 400 and writes nothing', async () => {
    const before = (await listed()).length;
    expect((await api('POST', `/spaces/${space()}/notes`, { title: '\n ' })).status).toBe(400);
    expect((await listed()).length).toBe(before);
    const created = await api('POST', `/spaces/${space()}/notes`, { title: 'Crud Note', body: 'first' });
    expect(created.status).toBe(201);
    id = created.json.id;
    expect(await listed()).toContain(id);
  });

  it('create: POST /spaces/:unknown/notes is 404', async () => {
    const res = await api('POST', `/spaces/${unknownId()}/notes`, { title: 'x' });
    expect(res.status).toBe(404);
    expect(res.json).toEqual(SPACE_NOT_FOUND);
  });

  it('read: list and get return the note; an unknown id is 404', async () => {
    expect(await get()).toMatchObject({ id, title: 'Crud Note', body: 'first', pinned: false });
    expect((await api('GET', `/notes/${unknownId()}`)).status).toBe(404);
  });

  it('update: PATCH edits, PUT/DELETE pin toggles; blank title is 400; unknown id is 404', async () => {
    expect((await api('PATCH', `/notes/${id}`, { revision: (await get()).revision, title: ' ' })).status).toBe(400);
    expect((await get()).title).toBe('Crud Note');
    const edit = { revision: (await get()).revision, title: 'Renamed Note', body: 'second' };
    expect((await api('PATCH', `/notes/${id}`, edit)).status).toBe(200);
    expect(await get()).toMatchObject({ title: 'Renamed Note', body: 'second' });
    expect((await api('PUT', `/notes/${id}/pin`)).status).toBe(200);
    expect((await get()).pinned).toBe(true);
    expect((await api('DELETE', `/notes/${id}/pin`)).status).toBe(200);
    expect((await get()).pinned).toBe(false);
    expect((await api('PATCH', `/notes/${unknownId()}`, { revision: 1, title: 'x' })).status).toBe(404);
    expect((await api('PUT', `/notes/${unknownId()}/pin`)).status).toBe(404);
  });

  it('delete: DELETE trashes, POST restore brings it back; unknown id is 404', async () => {
    expect((await api('DELETE', `/notes/${id}`)).status).toBe(204);
    expect(await listed()).not.toContain(id);
    expect(await listed('?trashed=true')).toContain(id);
    expect((await api('POST', `/notes/${id}/restore`)).status).toBe(200);
    expect((await get()).trashed_at).toBeNull();
    expect((await api('DELETE', `/notes/${unknownId()}`)).status).toBe(404);
    expect((await api('POST', `/notes/${unknownId()}/restore`)).status).toBe(404);
  });
});

describe('calendar event', () => {
  let calendarId: string;
  let id: string;
  const START = Date.UTC(2030, 0, 2, 9);
  const HOUR = 3_600_000;
  const get = async (): Promise<any> => (await api('GET', `/events/${id}`)).json;
  const window = async (): Promise<Array<{ event_id: string; title: string; cancelled: boolean }>> =>
    (await api('GET', `/calendars/${calendarId}/events?from=${START - HOUR}&to=${START + 3 * HOUR}`)).json.events;

  beforeAll(async () => {
    const created = await api('POST', `/spaces/${env.spaces.privateA}/calendars`, { name: 'Crud Cal', zone: 'UTC' });
    expect(created.status).toBe(201);
    calendarId = created.json.id;
  });

  it('create: POST /spaces/:unknown/calendars is 404', async () => {
    const res = await api('POST', `/spaces/${unknownId()}/calendars`, { name: 'x', zone: 'UTC' });
    expect(res.status).toBe(404);
    expect(res.json).toEqual(SPACE_NOT_FOUND);
  });

  it('create: POST /calendars/:id/events; blank title is 400 and writes nothing; unknown calendar is 404', async () => {
    const timed = { start_at: START, end_at: START + HOUR, zone: 'UTC' };
    expect((await api('POST', `/calendars/${calendarId}/events`, { ...timed, title: '  ' })).status).toBe(400);
    expect(await window()).toHaveLength(0);
    const created = await api('POST', `/calendars/${calendarId}/events`, { ...timed, title: 'Crud Event' });
    expect(created.status).toBe(201);
    id = created.json.id;
    expect((await window()).map((e) => e.event_id)).toEqual([id]);
    expect((await api('POST', `/calendars/${unknownId()}/events`, { ...timed, title: 'x' })).status).toBe(404);
  });

  it('read: the window lists it and get returns it; an unknown id is 404', async () => {
    expect((await window())[0]).toMatchObject({ title: 'Crud Event', cancelled: false });
    expect(await get()).toMatchObject({ id, title: 'Crud Event', status: 'confirmed' });
    expect((await api('GET', `/events/${unknownId()}`)).status).toBe(404);
  });

  it('update: PATCH (series) renames; blank title is 400 and leaves it; unknown id is 404', async () => {
    const patch = async (title: string, target = id) =>
      api('PATCH', `/events/${target}`, { revision: (await get()).revision, scope: 'series', patch: { title } });
    expect((await patch(' ')).status).toBe(400);
    expect((await get()).title).toBe('Crud Event');
    expect((await patch('Renamed Event')).status).toBe(200);
    expect((await get()).title).toBe('Renamed Event');
    expect((await window())[0]!.title).toBe('Renamed Event');
    expect((await patch('x', unknownId())).status).toBe(404);
  });

  it('delete: DELETE (series) cancels the event; unknown id is 404', async () => {
    expect((await api('DELETE', `/events/${id}`, { scope: 'series' })).status).toBe(200);
    expect((await get()).status).toBe('cancelled');
    expect((await window()).every((e) => e.cancelled || e.event_id !== id)).toBe(true);
    expect((await api('DELETE', `/events/${unknownId()}`, { scope: 'series' })).status).toBe(404);
  });
});

describe('invitation', () => {
  let spaceId: string;
  let id: string;
  const pending = async (): Promise<Array<{ id: string; invited_email: string }>> =>
    (await api('GET', `/spaces/${spaceId}/invitations`)).json.invitations;

  beforeAll(async () => {
    spaceId = (await api('POST', '/spaces', { kind: 'group', name: 'Invite Space' })).json.id;
  });

  it('create: POST /spaces/:id/invitations; a blank email is 400 and writes nothing', async () => {
    expect((await api('POST', `/spaces/${spaceId}/invitations`, { email: ' ', role: 'member' })).status).toBe(400);
    expect(await pending()).toHaveLength(0);
    const created = await api('POST', `/spaces/${spaceId}/invitations`, { email: 'crud@example.com', role: 'member' });
    expect(created.status).toBe(201);
    id = created.json.invitation.id;
    expect(typeof created.json.token).toBe('string');
    expect((await api('POST', `/spaces/${unknownId()}/invitations`, { email: 'x@example.com', role: 'member' })).status).toBe(404);
  });

  it('read: GET /spaces/:id/invitations lists it as pending', async () => {
    expect((await pending()).map((i) => i.id)).toEqual([id]);
  });

  it('delete: DELETE /invitations/:id revokes it; unknown id is 404', async () => {
    expect((await api('DELETE', `/invitations/${id}`)).status).toBe(204);
    expect((await pending()).map((i) => i.id)).not.toContain(id);
    expect((await api('DELETE', `/invitations/${unknownId()}`)).status).toBe(404);
  });
});

describe('memory', () => {
  let id: string;
  const listed = async (): Promise<Array<{ id: string; content: string }>> =>
    (await api('GET', '/memories')).json.memories;

  it('create: POST /memories; blank content is 400 and writes nothing', async () => {
    const before = (await listed()).length;
    expect((await api('POST', '/memories', { content: '   ' })).status).toBe(400);
    expect((await listed()).length).toBe(before);
    const created = await api('POST', '/memories', { content: 'the user likes crud tests' });
    expect(created.status).toBe(201);
    id = created.json.id;
  });

  it('read: GET /memories lists it', async () => {
    expect((await listed()).find((m) => m.id === id)?.content).toBe('the user likes crud tests');
  });

  it('update: PATCH corrects it; blank content is 400 and leaves it; unknown id is 404', async () => {
    expect((await api('PATCH', `/memories/${id}`, { content: ' ' })).status).toBe(400);
    expect((await listed()).find((m) => m.id === id)?.content).toBe('the user likes crud tests');
    expect((await api('PATCH', `/memories/${id}`, { content: 'the user loves crud tests' })).status).toBe(200);
    expect((await listed()).find((m) => m.id === id)?.content).toBe('the user loves crud tests');
    expect((await api('PATCH', '/memories/mem_unknown00', { content: 'x' })).status).toBe(404);
  });

  it('delete: DELETE removes it (an unknown id is 204 by design: no oracle)', async () => {
    expect((await api('DELETE', `/memories/${id}`)).status).toBe(204);
    expect((await listed()).map((m) => m.id)).not.toContain(id);
    expect((await api('DELETE', '/memories/mem_unknown00')).status).toBe(204);
  });
});

describe('action item', () => {
  let id: string;
  const find = async (): Promise<{ id: string; content: string; status: string } | undefined> =>
    (await api('GET', '/action-items')).json.action_items.find((i: { id: string }) => i.id === id);

  it('create: POST /memories {kind: action_item} makes an open action item', async () => {
    expect((await api('POST', '/memories', { content: 'file the crud report', kind: 'action_item' })).status).toBe(201);
    const items = (await api('GET', '/action-items')).json.action_items as Array<{ id: string; content: string }>;
    id = items.find((i) => i.content === 'file the crud report')!.id;
    expect(id).toBeTruthy();
  });

  it('read: GET /action-items lists it as open', async () => {
    expect(await find()).toMatchObject({ content: 'file the crud report', status: 'open' });
  });

  it('update: PATCH {status: done} lands; a bad status is 400; unknown id is 404', async () => {
    expect((await api('PATCH', `/action-items/${id}`, { status: '' })).status).toBe(400);
    expect((await find())?.status).toBe('open');
    expect((await api('PATCH', `/action-items/${id}`, { status: 'done' })).status).toBe(200);
    expect((await find())?.status).toBe('done');
    expect((await api('PATCH', '/action-items/ai_unknown00', { status: 'done' })).status).toBe(404);
  });
});

/** Seeds a conversation of user/assistant turns through the store (no AI turn
 *  can write one offline) and returns its id and message ids in order. */
async function seedConversation(title: string, texts: string[]): Promise<{ id: string; messages: string[] }> {
  const conversation = await createConversation(db, env.a.userId, title);
  const messages: string[] = [];
  for (const [index, text] of texts.entries()) {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    const message = await appendMessage(db, env.a.userId, conversation.id, { role, parts: [{ type: 'text', text }] });
    messages.push(message!.id);
  }
  return { id: conversation.id, messages };
}

describe('conversation', () => {
  let id: string;
  const get = async (): Promise<{ status: number; json: any }> => api('GET', `/conversations/${id}`);
  const listed = async (query = ''): Promise<Array<{ id: string; title: string; pinned: boolean }>> =>
    (await api('GET', `/conversations${query}`)).json.conversations;

  beforeAll(async () => {
    id = (await seedConversation('Crud Chat', ['hi', 'hello'])).id;
  });

  it('read: list and get return it; an unknown id is 404', async () => {
    expect((await listed()).map((c) => c.id)).toContain(id);
    expect((await get()).json).toMatchObject({ id, title: 'Crud Chat' });
    expect((await api('GET', '/conversations/cnv_unknown00')).status).toBe(404);
  });

  it('update: PATCH renames, pins and archives; blank title is 400; unknown id is 404', async () => {
    expect((await api('PATCH', `/conversations/${id}`, { title: '  ' })).status).toBe(400);
    expect((await get()).json.title).toBe('Crud Chat');
    expect((await api('PATCH', `/conversations/${id}`, { title: 'Renamed Chat' })).status).toBe(200);
    expect((await get()).json.title).toBe('Renamed Chat');
    expect((await api('PATCH', `/conversations/${id}`, { pinned: true })).status).toBe(200);
    expect((await listed()).find((c) => c.id === id)?.pinned).toBe(true);
    expect((await api('PATCH', `/conversations/${id}`, { archived: true })).status).toBe(200);
    expect((await listed()).map((c) => c.id)).not.toContain(id);
    expect((await listed('?archived=1')).map((c) => c.id)).toContain(id);
    expect((await api('PATCH', '/conversations/cnv_unknown00', { title: 'x' })).status).toBe(404);
  });

  it('delete: DELETE removes it and its messages', async () => {
    expect((await api('DELETE', `/conversations/${id}`)).status).toBe(204);
    expect((await get()).status).toBe(404);
    expect((await listed('?archived=1')).map((c) => c.id)).not.toContain(id);
  });
});

describe('conversation message', () => {
  let id: string;
  let messages: string[];
  const REPLY = 'First sentence. Second sentence.';
  type Message = { id: string; versions: Array<{ parts: Array<{ text?: string }>; selected: boolean }> };
  const read = async (): Promise<Message[]> => (await api('GET', `/conversations/${id}`)).json.messages;
  const text = (message: Message | undefined): string | undefined =>
    message?.versions.find((v) => v.selected)?.parts[0]?.text;

  beforeAll(async () => {
    ({ id, messages } = await seedConversation('Crud Messages', ['q1', REPLY, 'q2', 'a2']));
  });

  it('read: GET /conversations/:id lists every message in order', async () => {
    expect((await read()).map((m) => m.id)).toEqual(messages);
    expect(text((await read())[1])).toBe(REPLY);
  });

  it('update: PATCH (heard portion) truncates the reply; a bad body is 400; a user message or unknown id is 404', async () => {
    const path = (messageId: string): string => `/conversations/${id}/messages/${messageId}`;
    expect((await api('PATCH', path(messages[1]!), { heard_chars: -1, interrupted: true })).status).toBe(400);
    expect(text((await read())[1])).toBe(REPLY);
    expect((await api('PATCH', path(messages[1]!), { heard_chars: 16, interrupted: true })).status).toBe(200);
    expect(text((await read())[1])).toBe('First sentence.');
    expect((await api('PATCH', path(messages[0]!), { heard_chars: 1, interrupted: true })).status).toBe(404);
    expect((await api('PATCH', path('msg_unknown00'), { heard_chars: 1, interrupted: true })).status).toBe(404);
  });

  it('delete: DELETE "from here" drops that user message and everything after; unknown id is 404', async () => {
    const path = (messageId: string): string => `/conversations/${id}/messages/${messageId}`;
    expect((await api('DELETE', path(messages[3]!))).status).toBe(409); // an assistant anchor is refused
    expect((await read()).map((m) => m.id)).toEqual(messages);
    expect((await api('DELETE', path(messages[2]!))).status).toBe(204);
    expect((await read()).map((m) => m.id)).toEqual(messages.slice(0, 2));
    expect((await api('DELETE', path('msg_unknown00'))).status).toBe(404);
  });
});
