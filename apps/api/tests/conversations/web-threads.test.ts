// web-threads.ts route tests (spec 014, S06, contracts/api.md "Threads and
// messages"). A real HTTP server over real Postgres with the real store, so the
// identity-leak rule, the additive-edit guarantee, the authorship rules and
// the Zod rejections are exercised against genuine store behaviour. Includes
// the machine-checkable FR-008 assertion: web-threads.ts must not import
// @bob/ai, because posting a human message never invokes the model.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createThreadsRouter } from '../../src/spaces/threads-http.ts';
import { postMessage } from '../../src/conversations/thread-store.ts';
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

describe('threads HTTP API', () => {
  let owner: TestAccount;
  let member: TestAccount;
  let admin: TestAccount;
  let outsider: TestAccount;
  let ownerToken: string;
  let memberToken: string;
  let adminToken: string;
  let outsiderToken: string;
  let spaceId: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    owner = await addAccount(pg);
    member = await addAccount(pg);
    admin = await addAccount(pg);
    outsider = await addAccount(pg);
    ownerToken = await tokenFor(owner);
    memberToken = await tokenFor(member);
    adminToken = await tokenFor(admin);
    outsiderToken = await tokenFor(outsider);

    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    spaceId = space.id;
    await addMember(db, owner.userId, space.id, member.userId, 'member');
    await addMember(db, owner.userId, space.id, admin.userId, 'admin');

    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api', createThreadsRouter({ getDb: () => Promise.resolve(db), events: { publish: () => undefined } }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await closeTestDb(pg).catch(() => undefined);
  });

  it('FR-008: web-threads.ts must not import @bob/ai (human posting never invokes the model)', () => {
    const source = readFileSync(new URL('../../src/spaces/threads-http.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/@bob\/ai/);
  });

  it('401 without a token on every route', async () => {
    const routes: Array<[string, string, unknown?]> = [
      ['GET', `/api/spaces/${spaceId}/threads`],
      ['POST', `/api/spaces/${spaceId}/threads`, { title: 'x' }],
      ['GET', `/api/threads/${randomUUID()}`],
      ['PATCH', `/api/threads/${randomUUID()}`, { title: 'x' }],
      ['DELETE', `/api/threads/${randomUUID()}`],
      ['GET', `/api/threads/${randomUUID()}/messages`],
      ['POST', `/api/threads/${randomUUID()}/messages`, { body: 'x', client_message_id: 'c' }],
      ['PATCH', `/api/messages/${randomUUID()}`, { body: 'x' }],
      ['DELETE', `/api/messages/${randomUUID()}`],
      ['GET', `/api/messages/${randomUUID()}/revisions`],
      ['PUT', `/api/threads/${randomUUID()}/read`],
    ];
    for (const [method, path, body] of routes) {
      const res = await send(method, path, null, body);
      expect(res.status).toBe(401);
    }
  });

  it('400 invalid_request for a Zod-rejected body', async () => {
    const blankTitle = await send('POST', `/api/spaces/${spaceId}/threads`, ownerToken, {
      title: '   ',
    });
    expect(blankTitle.status).toBe(400);

    const noClientId = await send(
      'POST',
      `/api/threads/${randomUUID()}/messages`,
      ownerToken,
      { body: 'hello' },
    );
    expect(noClientId.status).toBe(400);

    const longBody = await send(
      'POST',
      `/api/threads/${randomUUID()}/messages`,
      ownerToken,
      { body: 'x'.repeat(8001), client_message_id: 'c' },
    );
    expect(longBody.status).toBe(400);
  });

  it('creates a thread, lists it with unread_count, reads and renames it', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/threads`, ownerToken, {
      title: 'Groceries',
    });
    expect(created.status).toBe(201);
    const thread = (await created.json()) as { id: string; title: string; unread_count: number };
    expect(thread.title).toBe('Groceries');
    expect(thread.unread_count).toBe(0);

    const list = await send('GET', `/api/spaces/${spaceId}/threads`, ownerToken);
    expect(list.status).toBe(200);
    expect((await list.json()) as { threads: unknown[] }).toMatchObject({
      threads: [expect.objectContaining({ id: thread.id })],
    });

    const read = await send('GET', `/api/threads/${thread.id}`, memberToken);
    expect(read.status).toBe(200);
    expect((await read.json()) as { title: string }).toMatchObject({ title: 'Groceries' });

    const renamed = await send('PATCH', `/api/threads/${thread.id}`, ownerToken, {
      title: 'Groceries + eggs',
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()) as { title: string }).toMatchObject({
      title: 'Groceries + eggs',
    });
  });

  it('posts a human message (201), dedupes a retry (200, same id), and lists ascending', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/threads`, ownerToken, {
      title: 'School run',
    });
    const thread = (await created.json()) as { id: string };

    const posted = await send('POST', `/api/threads/${thread.id}/messages`, ownerToken, {
      body: 'Pick up at 3pm',
      client_message_id: 'school-1',
    });
    expect(posted.status).toBe(201);
    const message = (await posted.json()) as { id: string; sequence: number; author_user_id: string };

    const retried = await send('POST', `/api/threads/${thread.id}/messages`, ownerToken, {
      body: 'Pick up at 3pm (resent)',
      client_message_id: 'school-1',
    });
    expect(retried.status).toBe(200);
    expect((await retried.json()) as { id: string }).toMatchObject({ id: message.id });

    const messages = await send('GET', `/api/threads/${thread.id}/messages`, ownerToken);
    expect(messages.status).toBe(200);
    const body = (await messages.json()) as { messages: unknown[]; next_cursor: string | null };
    expect(body.messages).toHaveLength(1);
    expect(body.next_cursor).toBeNull();
    expect(body.messages[0]).toMatchObject({
      id: message.id,
      sequence: 1,
      author_user_id: owner.userId,
    });
  });

  it('messages carry their origin; device_id never appears in the response', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/threads`, ownerToken, {
      title: 'Origin check',
    });
    const thread = (await created.json()) as { id: string };

    const webPosted = await send('POST', `/api/threads/${thread.id}/messages`, ownerToken, {
      body: 'typed from the web',
      client_message_id: 'origin-web-1',
    });
    expect(webPosted.status).toBe(201);
    expect((await webPosted.json()) as { origin: string }).toMatchObject({ origin: 'web_text' });

    // The web route never accepts a device_id, so a device-origin message is
    // inserted through the store directly, exactly as the Cardputer turn path does.
    const devicePosted = await postMessage(db, owner.userId, {
      threadId: thread.id,
      body: 'spoken from the Cardputer',
      clientMessageId: 'origin-device-1',
      deviceId: randomUUID(),
    });
    expect(devicePosted.message.origin).toBe('device');

    const list = await send('GET', `/api/threads/${thread.id}/messages`, ownerToken);
    const body = (await list.json()) as { messages: Array<Record<string, unknown>> };
    const deviceMessage = body.messages.find((m) => m.client_message_id === 'origin-device-1');
    expect(deviceMessage).toMatchObject({ origin: 'device' });
    for (const message of body.messages) {
      expect(message).not.toHaveProperty('device_id');
    }
  });

  it('editing is additive over HTTP: a reply posted after the edit still exists', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/threads`, ownerToken, {
      title: 'Trip plan',
    });
    const thread = (await created.json()) as { id: string };

    const first = await send('POST', `/api/threads/${thread.id}/messages`, ownerToken, {
      body: 'We leave at 8',
      client_message_id: 'trip-1',
    });
    const firstMsg = (await first.json()) as { id: string };
    const reply = await send('POST', `/api/threads/${thread.id}/messages`, ownerToken, {
      body: 'Packing list',
      client_message_id: 'trip-2',
      reply_to_message_id: firstMsg.id,
    });
    expect(reply.status).toBe(201);

    const edited = await send('PATCH', `/api/messages/${firstMsg.id}`, ownerToken, {
      body: 'We leave at 7:30',
    });
    expect(edited.status).toBe(200);
    expect((await edited.json()) as { body: string; revision: number }).toMatchObject({
      body: 'We leave at 7:30',
      revision: 2,
    });

    const list = await send('GET', `/api/threads/${thread.id}/messages`, ownerToken);
    const body = (await list.json()) as { messages: Array<{ id: string; body: string; sequence: number }> };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toMatchObject({ body: 'Packing list' });
  });

  it('a member cannot edit another member message (404, no oracle)', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/threads`, ownerToken, {
      title: 'Moderation',
    });
    const thread = (await created.json()) as { id: string };
    const posted = await send('POST', `/api/threads/${thread.id}/messages`, ownerToken, {
      body: 'owner text',
      client_message_id: 'mod-1',
    });
    const msg = (await posted.json()) as { id: string };

    const denied = await send('PATCH', `/api/messages/${msg.id}`, memberToken, { body: 'hijack' });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: { code: 'not_found', message: 'message not found' } });
  });

  it('an admin may tombstone another member message as moderation', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/threads`, memberToken, {
      title: 'Moderation 2',
    });
    const thread = (await created.json()) as { id: string };
    const posted = await send('POST', `/api/threads/${thread.id}/messages`, memberToken, {
      body: 'to be removed',
      client_message_id: 'mod-2',
    });
    const msg = (await posted.json()) as { id: string };

    const res = await send('DELETE', `/api/messages/${msg.id}`, adminToken);
    expect(res.status).toBe(200);
    expect((await res.json()) as { tombstoned_at: number | null; tombstoned_by: string }).toMatchObject({
      tombstoned_by: admin.userId,
    });

    // A plain member cannot moderate ANOTHER member's message (404, no oracle).
    const ownerMsg = await send('POST', `/api/threads/${thread.id}/messages`, ownerToken, {
      body: 'keep this',
      client_message_id: 'mod-3',
    });
    const target = (await ownerMsg.json()) as { id: string };
    const denied = await send('DELETE', `/api/messages/${target.id}`, memberToken);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: { code: 'not_found', message: 'message not found' } });
  });

  it('a deleted message comes back with an empty body and no revisions', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/threads`, ownerToken, {
      title: 'Deletion',
    });
    const thread = (await created.json()) as { id: string };
    const posted = await send('POST', `/api/threads/${thread.id}/messages`, memberToken, {
      body: 'secret plan',
      client_message_id: 'del-1',
    });
    const msg = (await posted.json()) as { id: string };

    const deleted = await send('DELETE', `/api/messages/${msg.id}`, memberToken);
    expect(deleted.status).toBe(200);
    expect((await deleted.json()) as { body: string; tombstoned_at: number | null }).toMatchObject({
      body: '',
      tombstoned_at: expect.any(Number),
    });

    const list = await send('GET', `/api/threads/${thread.id}/messages`, ownerToken);
    const listBody = (await list.json()) as { messages: Array<{ id: string; body: string }> };
    expect(listBody.messages.find((m) => m.id === msg.id)).toMatchObject({ body: '' });

    const revisions = await send('GET', `/api/messages/${msg.id}/revisions`, ownerToken);
    expect(revisions.status).toBe(200);
    expect(await revisions.json()).toEqual({ revisions: [] });
  });

  it('GET revisions returns the current revision history', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/threads`, ownerToken, {
      title: 'Revisions',
    });
    const thread = (await created.json()) as { id: string };
    const posted = await send('POST', `/api/threads/${thread.id}/messages`, ownerToken, {
      body: 'v1',
      client_message_id: 'rev-1',
    });
    const msg = (await posted.json()) as { id: string };
    await send('PATCH', `/api/messages/${msg.id}`, ownerToken, { body: 'v2' });

    const res = await send('GET', `/api/messages/${msg.id}/revisions`, ownerToken);
    expect(res.status).toBe(200);
    expect((await res.json()) as { revisions: unknown[] }).toMatchObject({
      revisions: [
        { revision: 2, body: 'v2', author_user_id: owner.userId },
      ],
    });
  });

  it('unread counts move through PUT read, per person', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/threads`, ownerToken, {
      title: 'Unread',
    });
    const thread = (await created.json()) as { id: string };
    await send('POST', `/api/threads/${thread.id}/messages`, ownerToken, {
      body: 'for you',
      client_message_id: 'unread-1',
    });
    await send('POST', `/api/threads/${thread.id}/messages`, memberToken, {
      body: 'and you',
      client_message_id: 'unread-2',
    });

    const before = await send('GET', `/api/spaces/${spaceId}/threads`, memberToken);
    const beforeBody = (await before.json()) as { threads: Array<{ id: string; unread_count: number }> };
    expect(beforeBody.threads.find((t) => t.id === thread.id)).toMatchObject({ unread_count: 2 });

    const read = await send('PUT', `/api/threads/${thread.id}/read`, memberToken, {
      last_read_sequence: 1,
    });
    expect(read.status).toBe(200);
    expect((await read.json()) as { last_read_sequence: number }).toMatchObject({
      last_read_sequence: 1,
    });

    const after = await send('GET', `/api/spaces/${spaceId}/threads`, memberToken);
    const afterBody = (await after.json()) as { threads: Array<{ id: string; unread_count: number }> };
    expect(afterBody.threads.find((t) => t.id === thread.id)).toMatchObject({ unread_count: 1 });

    // The owner's own cursor is independent.
    const ownerList = await send('GET', `/api/spaces/${spaceId}/threads`, ownerToken);
    const ownerBody = (await ownerList.json()) as { threads: Array<{ id: string; unread_count: number }> };
    expect(ownerBody.threads.find((t) => t.id === thread.id)).toMatchObject({ unread_count: 2 });
  });

  it('archiving a thread removes it from the list', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/threads`, ownerToken, {
      title: 'Archived soon',
    });
    const thread = (await created.json()) as { id: string };

    const archived = await send('DELETE', `/api/threads/${thread.id}`, ownerToken);
    expect(archived.status).toBe(200);
    expect((await archived.json()) as { archived_at: number | null }).toMatchObject({
      archived_at: expect.any(Number),
    });

    const list = await send('GET', `/api/spaces/${spaceId}/threads`, ownerToken);
    const body = (await list.json()) as { threads: Array<{ id: string }> };
    expect(body.threads.map((t) => t.id)).not.toContain(thread.id);
  });

  it('404 not_found for an id outside the audience equals a missing id', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/threads`, ownerToken, {
      title: 'Secret thread',
    });
    const thread = (await created.json()) as { id: string };
    await send('POST', `/api/threads/${thread.id}/messages`, ownerToken, {
      body: 'private',
      client_message_id: 'leak-1',
    });

    const hiddenThread = await send('GET', `/api/threads/${thread.id}`, outsiderToken);
    const missingThread = await send('GET', `/api/threads/${randomUUID()}`, outsiderToken);
    expect(hiddenThread.status).toBe(404);
    expect(missingThread.status).toBe(404);
    const missingThreadBody: unknown = await missingThread.json();
    expect(missingThreadBody).toEqual({ error: { code: 'not_found', message: 'thread not found' } });
    expect(await hiddenThread.json()).toEqual(missingThreadBody);

    const hiddenMessages = await send('GET', `/api/threads/${thread.id}/messages`, outsiderToken);
    const missingMessages = await send('GET', `/api/threads/${randomUUID()}/messages`, outsiderToken);
    expect(hiddenMessages.status).toBe(404);
    expect(missingMessages.status).toBe(404);
    const missingMessagesBody: unknown = await missingMessages.json();
    expect(missingMessagesBody).toEqual({ error: { code: 'not_found', message: 'thread not found' } });
    expect(await hiddenMessages.json()).toEqual(missingMessagesBody);
  });
});