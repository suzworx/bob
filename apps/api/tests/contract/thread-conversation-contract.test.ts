// #756 contract lock: the external thread/conversation API as it is today. Real
// routers over the test database, volatile ids and times normalised, every
// response snapshotted with its exact status. These must stay green, unchanged,
// through the storage move (PR1..PR5).
import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocket } from 'ws';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

// AI-stub mode as core-invocations-stub.test.ts: no real model call anywhere.
vi.mock('@bob/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  AI_STUB_MODE: true,
}));

import { createAppDeps } from '../../src/app-deps.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import * as pairing from '../../src/devices/pairing-service.ts';
import { createDevicesRouter } from '../../src/devices/http.ts';
import { createThreadsRouter } from '../../src/spaces/threads-http.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createInvocationsRouter } from '../../src/conversations/invocations-http.ts';
import { getActiveRoute, getConversationRoute, listConversationsRoute } from '../../src/conversations/http.ts';
import { webChat } from '../../src/conversations/chat-http.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { agentConfigFromEnv, selectAgent, STUB_INVOCATION_REPLY } from '../../src/voice/agent-adapters.ts';
import { parseDeviceRef, threadRef } from '../../src/devices/conversation-ref.ts';
import { ActiveResponseSchema, ConversationDetailSchema, DevicesResponseSchema } from '../../src/web-schemas.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

const appDeps = createAppDeps();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let ids = new Map<string, string>();
beforeEach(() => {
  ids = new Map();
});

/** One stable placeholder per distinct id, numbered in order of first sight within a test. */
function stable(raw: string, kind: string): string {
  const key = raw.toLowerCase();
  if (!ids.has(key)) ids.set(key, `<${kind}-${ids.size + 1}>`);
  return ids.get(key)!;
}

function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    if (UUID.test(value)) return stable(value, 'uuid');
    // thr_, msg_, ver_ and bob: refs wrap a uuid; the prefix is contract, the uuid is not.
    const prefixed = /^([a-z]+[_:])(.+)$/.exec(value);
    if (prefixed && UUID.test(prefixed[2]!)) return `${prefixed[1]}${stable(prefixed[2]!, 'uuid')}`;
    if (/^cnv_[A-Za-z0-9_-]+$/.test(value)) return `cnv_${stable(value, 'cnv')}`;
    return value;
  }
  if (typeof value === 'number' && value > 1e12) return '<epoch-ms>';
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalize(inner)]));
  }
  return value;
}

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
let owner: TestAccount;
let member: TestAccount;
let ownerToken: string;
let memberToken: string;
let spaceId: string;

async function send(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Asserts the exact status, Zod-parses with the module's exported schema when it has one, normalises. */
async function contract(res: Response, status: number, schema?: z.ZodTypeAny): Promise<{ status: number; body: unknown }> {
  const body = (await res.json()) as unknown;
  expect({ status: res.status, body }).toMatchObject({ status });
  if (schema) schema.parse(body);
  return { status: res.status, body: normalize(body) };
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
  owner = await addAccount(pg);
  member = await addAccount(pg);
  ownerToken = await signToken({ userId: owner.userId, sessionId: owner.sessionId });
  memberToken = await signToken({ userId: member.userId, sessionId: member.sessionId });
  spaceId = (await createSpace(db, owner.userId, { kind: 'group', name: 'Family' })).id;
  await addMember(db, owner.userId, spaceId, member.userId, 'member');

  // A paired, connected Cardputer, exactly as web-device-conversation.test.ts pairs one.
  const issued = await pairing.issueCode(db, {
    model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.9',
  });
  const deviceId = await pairing.approve(db, owner.userId, issued.pairingId, 'Desk');
  const socket = { readyState: 1, close: (): void => {}, send: (): void => {} };
  getDeviceSessions().register(socket as unknown as WebSocket, { id: `sess-${deviceId}`, stage: 'ready' }, owner.userId, deviceId);

  const getDb = (): Promise<Db> => Promise.resolve(db);
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.post('/api/chat', webChat(appDeps));
  app.get('/api/conversations', listConversationsRoute(appDeps));
  app.get('/api/conversations/:id', getConversationRoute(appDeps));
  app.get('/api/active', getActiveRoute(appDeps));
  app.use('/api/devices', createDevicesRouter({
    getDb, requireActiveSession: requireActiveSession(getDb), events: pairing.getAccountEvents(), deviceSessions: getDeviceSessions(),
  }));
  app.use('/api', createThreadsRouter({ getDb, events: { publish: () => undefined } }));
  app.use('/api', createInvocationsRouter({ appTurnTools: createAppTurnExtension(saveAppIdea), getDb, agent: selectAgent(agentConfigFromEnv(true, false)) }));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  getDeviceSessions().clear();
  server?.close();
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

/** A fresh shared space (owner + member) so a list snapshot never depends on another test. */
async function freshSpace(name: string): Promise<string> {
  const id = (await createSpace(db, owner.userId, { kind: 'group', name })).id;
  await addMember(db, owner.userId, id, member.userId, 'member');
  return id;
}

async function newThread(space: string, title: string): Promise<string> {
  const res = await send('POST', `/api/spaces/${space}/threads`, ownerToken, { title });
  return ((await res.json()) as { id: string }).id;
}

describe('/api/threads contract', () => {
  it('create, list (ThreadSummary) and read a thread', async () => {
    const space = await freshSpace('Threads');
    const created = await send('POST', `/api/spaces/${space}/threads`, ownerToken, { title: 'Groceries' });
    const thread = await contract(created, 201);
    expect(thread).toMatchSnapshot('POST /api/spaces/:id/threads');
    const schoolRun = await newThread(space, 'School run');
    // Assert newest activity first using explicit fixture times, not database
    // clock ordering between rapid inserts (timestamps can tie or move).
    const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
    await withAdmin(url, (sql) => sql.unsafe(
      `update bob.conversations set updated_at = case when id = $1 then
         '2025-01-02T00:00:00Z'::timestamptz else '2025-01-01T00:00:00Z'::timestamptz end
       where space_id = $2::uuid`, [schoolRun, space],
    ));
    expect(await contract(await send('GET', `/api/spaces/${space}/threads`, ownerToken), 200)).toMatchSnapshot('GET /api/spaces/:id/threads');
    const id = ((thread.body as { id: string }).id);
    expect(id).toMatch(/^<uuid-\d+>$/);
  });

  it('post, idempotent re-post, list, edit, stale revision, revisions, tombstone', async () => {
    const threadId = await newThread(spaceId, 'Messages');
    const first = await send('POST', `/api/threads/${threadId}/messages`, ownerToken, { body: 'Buy milk', client_message_id: 'c-1' });
    const posted = await contract(first, 201);
    expect(posted).toMatchSnapshot('POST messages (new)');
    const again = await send('POST', `/api/threads/${threadId}/messages`, ownerToken, { body: 'Buy milk (resent)', client_message_id: 'c-1' });
    const reposted = await contract(again, 200);
    expect(reposted.body).toEqual(posted.body);
    expect(reposted).toMatchSnapshot('POST messages (same client_message_id)');
    expect(await contract(await send('GET', `/api/threads/${threadId}/messages`, ownerToken), 200)).toMatchSnapshot('GET messages (one, no duplicate)');

    const messageId = ((await (await send('GET', `/api/threads/${threadId}/messages`, ownerToken)).json()) as { messages: Array<{ id: string }> }).messages[0]!.id;
    expect(await contract(await send('PATCH', `/api/messages/${messageId}`, ownerToken, { body: 'Buy milk and eggs' }), 200)).toMatchSnapshot('PATCH message (revision 2)');
    expect(await contract(await send('PATCH', `/api/messages/${messageId}`, ownerToken, { body: 'stale write', revision: 1 }), 400)).toMatchSnapshot('PATCH message with stale revision');
    expect(await contract(await send('GET', `/api/messages/${messageId}/revisions`, ownerToken), 200)).toMatchSnapshot('GET revisions');
    expect(await contract(await send('DELETE', `/api/messages/${messageId}`, ownerToken), 200)).toMatchSnapshot('DELETE message (tombstone)');
    expect(await contract(await send('GET', `/api/threads/${threadId}/messages`, ownerToken), 200)).toMatchSnapshot('GET messages (tombstone rendering)');
  });

  it('mark read moves unread_count from 1 to 0', async () => {
    const space = await freshSpace('Unread');
    const threadId = await newThread(space, 'News');
    await send('POST', `/api/threads/${threadId}/messages`, ownerToken, { body: 'Dinner at 7', client_message_id: 'u-1' });
    expect(await contract(await send('GET', `/api/spaces/${space}/threads`, memberToken), 200)).toMatchSnapshot('member list before read');
    expect(await contract(await send('PUT', `/api/threads/${threadId}/read`, memberToken), 200)).toMatchSnapshot('PUT read');
    expect(await contract(await send('GET', `/api/spaces/${space}/threads`, memberToken), 200)).toMatchSnapshot('member list after read');
  });

  it('invocation: 202, invocation state, assistant message with author_user_id null', async () => {
    const threadId = await newThread(spaceId, 'Ask Bob');
    const trigger = await send('POST', `/api/threads/${threadId}/messages`, ownerToken, { body: '@bob add milk', client_message_id: 'i-1' });
    const triggerId = ((await trigger.json()) as { id: string }).id;
    const invoked = await send('POST', `/api/threads/${threadId}/invocations`, ownerToken, { trigger_message_id: triggerId });
    const { invocation_id: invocationId } = (await invoked.clone().json()) as { invocation_id: string };
    expect(await contract(invoked, 202)).toMatchSnapshot('POST invocations');
    expect(await contract(await send('GET', `/api/invocations/${invocationId}`, ownerToken), 200)).toMatchSnapshot('GET invocation');
    const messages = await contract(await send('GET', `/api/threads/${threadId}/messages`, ownerToken), 200);
    const assistant = (messages.body as { messages: Array<{ author_user_id: string | null; body: string }> }).messages.at(-1)!;
    expect(assistant).toMatchObject({ author_user_id: null, body: STUB_INVOCATION_REPLY });
    expect(messages).toMatchSnapshot('GET messages (assistant reply)');
  });
});

describe('/api/conversations and /api/chat contract', () => {
  it('list and detail (ConversationDetailSchema) of a seeded conversation', async () => {
    const conversation = await createConversation(db, owner.userId, 'Trip plan');
    await appendMessage(db, owner.userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'When do we leave?' }] });
    await appendMessage(db, owner.userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'At 8.' }] });
    expect(await contract(await send('GET', '/api/conversations', ownerToken), 200)).toMatchSnapshot('GET /api/conversations');
    expect(await contract(await send('GET', `/api/conversations/${conversation.id}`, ownerToken), 200, ConversationDetailSchema))
      .toMatchSnapshot('GET /api/conversations/:id');
  });

  it('a /api/chat turn on the stub AI streams UI-message SSE', async () => {
    const res = await send('POST', '/api/chat', ownerToken, {
      message: { id: 'msg-contract-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    });
    expect(res.status).toBe(200);
    const events = (await res.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .map((data) => (data === '[DONE]' ? data : (JSON.parse(data) as unknown)));
    expect({ status: res.status, contentType: res.headers.get('content-type'), events: normalize(events) })
      .toMatchSnapshot('POST /api/chat (stub)');
  });
});

describe('/api/devices/active-conversation contract', () => {
  it('pointing the Cardputer at a space thread', async () => {
    const threadId = await newThread(spaceId, 'Weekend');
    const res = await send('PUT', '/api/devices/active-conversation', ownerToken, {
      conversation_id: null, space_id: spaceId, thread_id: threadId,
    });
    expect(await contract(res, 200)).toMatchSnapshot('PUT active-conversation (thread)');
    expect(await contract(await send('GET', '/api/active', ownerToken), 200, ActiveResponseSchema)).toMatchSnapshot('GET /api/active (thread)');
    expect(await contract(await send('GET', '/api/devices', ownerToken), 200, DevicesResponseSchema)).toMatchSnapshot('GET /api/devices (thread)');
  });

  it('pointing the Cardputer at a private cnv_ conversation', async () => {
    const conversation = await createConversation(db, owner.userId, 'Private notes');
    expect(conversation.id).toMatch(/^cnv_/);
    const res = await send('PUT', '/api/devices/active-conversation', ownerToken, {
      conversation_id: conversation.id, space_id: null,
    });
    expect(await contract(res, 200)).toMatchSnapshot('PUT active-conversation (cnv_)');
    expect(await contract(await send('GET', '/api/active', ownerToken), 200, ActiveResponseSchema)).toMatchSnapshot('GET /api/active (cnv_)');
  });

  it('device ref format: cnv_ passes through, thr_ wraps a lower-cased uuid', () => {
    const threadId = '550E8400-E29B-41D4-A716-446655440000';
    expect({
      threadRef: threadRef(threadId),
      parsedThread: parseDeviceRef(threadRef(threadId)),
      parsedConversation: parseDeviceRef('cnv_abcdefgh'),
      parsedBadThread: parseDeviceRef('thr_not-a-uuid'),
      parsedEmpty: parseDeviceRef(''),
    }).toMatchSnapshot('device-conversation-ref');
  });
});
