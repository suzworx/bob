/**
 * Cross-account isolation matrix (T014, specs/008-supabase-auth-pairing/tasks.md,
 * SC-003, FR-008). Two accounts, A and B, walk every HTTP route mounted on the
 * committed apps/api/src/server.ts, every account-scoped device socket message
 * from schemas.ts ClientControlDtoSchema, and the account-scoped store paths
 * (active_conversations, devices, pairing). The matrix proves B can never see
 * or change A's data, and that every "belongs to someone else" answer is
 * byte-identical to "does not exist" (no oracle).
 *
 * The whole matrix runs twice: once on the createTestDb connection as it comes
 * and once after `set role bob_server` (the guard pattern from
 * tests/store-conversations-pg.test.ts). createTestDb already connects as
 * bob_server, so both legs run the RLS-forced role exactly as production
 * connects; the 'superuser' leg name predates the move to real Postgres.
 *
 * /api/events, /api/pair, /api/active and activate landed with T029; /api/devices
 * (T033) is not mounted yet and is covered at the store layer instead.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocket } from 'ws';
import express from 'express';
import { z } from 'zod';

vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());

// S14-PG-AGENT-MOCK: /api/chat here runs against real Postgres too, so
// web-chat.ts's memory-enabled branch builds a per-turn agent via
// createBobAgent, imported by the relative path below -- a different
// module id than '@bob/ai', so it must be mocked separately (same pattern
// as web-chat.test.ts / turn.test.ts) or A-7/A-8 reach the real AI Gateway.
// @bob/ai embeddings.ts imports `gateway` from this same resolved module
// for the retrieval query embedder; a stub with no `doEmbed` fails that
// embed call locally, caught by memory-retrieval.ts's degrade path, so no
// network request is attempted.
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
  capSpeechInput: vi.fn((text: string) => text),
  transcribeAudio: vi.fn(async () => ({ text: 'hello' })),
  synthesizeSpeech: vi.fn(async () => ({
    audio: Buffer.from('mp3').toString('base64'),
    format: 'mp3',
    contentType: 'audio/mpeg',
  })),
  bobAgent: {
    version: 'agent-v1' as const,
    id: 'test-agent',
    tools: {},
    stream: vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of [
            { type: 'start', messageId: 'assistant-sdk-id-1' },
            { type: 'text-start', id: 'text-1', text: '' },
            { type: 'text-delta', id: 'text-1', text: 'done' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', finishReason: 'stop' },
          ]) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
    })),
  },
  get BOB_SYSTEM_TEST_MODE() {
    return false;
  },
  get AI_STUB_MODE() {
    return false;
  },
  isProviderError: (error: unknown) =>
    error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || /fetch failed|timeout/i.test(error.message)),
  providerErrorStatus: () => undefined,
  debugLog: vi.fn(),
  isFrameDebugEnabled: vi.fn(() => false),
  logAgentConfig: vi.fn(),
  setDebugSink: vi.fn(),
}) ) as Factory),
    ((async (importOriginal) => {
  const { bobAgent: mockAgent } = await importOriginal<typeof import('@bob/ai')>();
  return {
    createBobAgent: vi.fn(() => mockAgent),
    bobAgent: mockAgent,
    assistantAgent: mockAgent,
    chatModel: {},
    gateway: Object.assign(vi.fn(() => ({})), { embeddingModel: vi.fn(() => ({})) }),
    logAgentConfig: vi.fn(),
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createPairingRouter } from '../../src/devices/pairing-http.ts';
import { createDevicesRouter } from '../../src/devices/http.ts';
import { createWebEventsRouter } from '../../src/account/events-http.ts';
import { webChat } from '../../src/conversations/chat-http.ts';
import {
  activateConversationRoute,
  deleteConversationRoute,
  getActiveRoute,
  getConversationRoute,
  listConversationsRoute,
  renameConversationRoute,
} from '../../src/conversations/http.ts';
import { webSpeech, webVoice } from '../../src/voice/http.ts';
import { closeDb, setSharedDb, withUser, type Db } from '../../src/platform/db/db.ts';
import {
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
  type StoredConversation,
} from '../../src/conversations/store.ts';
import { getActive, setActive } from '../../src/conversations/active.ts';
import {
  approvePairing,
  claimPairing,
  denyPairing,
  PairingNotFoundError,
  revokeDevice,
  sha256,
} from '../../src/devices/pairing-store.ts';
import * as pairing from '../../src/devices/pairing-service.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { persistDeviceTurn } from '../../src/voice/cardputer-conversation.ts';
import { collectEvents, openSse, type SseEvent } from '../support/sse.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
/** A fake ws socket for session/socket tests: send is a mock, readyState 1. */
interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
}

function makeSocket(): FakeSocket {
  return { readyState: 1, send: vi.fn() };
}

/** A client control DTO with the required envelope fields (session.test.ts shape). */
function control(type: string, extra: Record<string, unknown> = {}): ClientControlDto {
  return { v: V2_VERSION, type, id: 'test_ctrl_000001', payload: {}, ...extra } as unknown as ClientControlDto;
}

/** The last JSON DTO the fake socket sent, parsed. */
function lastSent(socket: FakeSocket): unknown {
  const calls = socket.send.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(calls[calls.length - 1]![0] as string);
}

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_NAME = 'Isolation Card';

/** A paired-device upgrade outcome for an arbitrary account. */
function deviceAuthFor(userId: string) {
  return { kind: 'device' as const, userId, deviceId: DEVICE_ID, name: DEVICE_NAME };
}

/** The per-mode matrix state (one run per describe.each mode). */
interface MatrixCtx {
  mode: string;
  pg: TestDb;
  db: Db;
  accountA: TestAccount;
  accountB: TestAccount;
  accountC: TestAccount;
  eventAccountA: TestAccount;
  eventAccountB: TestAccount;
  eventTokenB: string;
  tokenA: string;
  tokenB: string;
  server: Server;
  baseUrl: string;
}

/** A conversation id that belongs to nobody; must be a well-formed opaque id. */
const UNKNOWN_CONVERSATION = 'cnv_00000000000000000000';

async function tokenFor(account: TestAccount): Promise<string> {
  return signToken({ userId: account.userId, sessionId: account.sessionId });
}

/** Opens the /api/events SSE stream for a bearer token; abort() closes it. */
async function openEvents(ctx: MatrixCtx, token: string): Promise<{
  events: AsyncGenerator<SseEvent>;
  abort: () => void;
}> {
  const { response, events, abort } = await openSse(ctx.baseUrl, token);
  expect(response.status).toBe(200);
  return { events, abort };
}

describe.each(['superuser', 'bob_server'] as const)('cross-account isolation matrix (%s)', (mode) => {
  const ctx = { mode } as MatrixCtx;

  beforeAll(async () => {
    ctx.pg = await createTestDb();
    // Every account row must exist BEFORE the connection switches to
    // bob_server: the auth.users/sessions inserts run as the base role.
    ctx.accountA = await addAccount(ctx.pg);
    ctx.accountB = await addAccount(ctx.pg);
    ctx.accountC = await addAccount(ctx.pg);
    ctx.eventAccountA = await addAccount(ctx.pg);
    ctx.eventAccountB = await addAccount(ctx.pg);
    if (mode === 'bob_server') await ctx.pg.exec('set role bob_server');
    ctx.db = asDb(ctx.pg);
    setSharedDb(Promise.resolve(ctx.db));
    ctx.tokenA = await tokenFor(ctx.accountA);
    ctx.tokenB = await tokenFor(ctx.accountB);
    ctx.eventTokenB = await tokenFor(ctx.eventAccountB);

    // The routes exactly as server.ts mounts them today (T011/T028/T029).
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.get('/api/conversations', listConversationsRoute(appDeps));
    app.get('/api/conversations/:id', getConversationRoute(appDeps));
    app.patch('/api/conversations/:id', renameConversationRoute(appDeps));
    app.delete('/api/conversations/:id', deleteConversationRoute(appDeps));
    app.get('/api/active', getActiveRoute(appDeps));
    app.post('/api/conversations/:id/activate', activateConversationRoute(appDeps));
    app.post('/api/voice', webVoice(appDeps));
    app.post('/api/speech', webSpeech(appDeps));
    app.use(
      '/api/pair',
      createPairingRouter({
        getDb: () => Promise.resolve(ctx.db),
        pairing,
        requireActiveSession: requireActiveSession(() => Promise.resolve(ctx.db)),
      }),
    );
    app.use(
      '/api/events',
      createWebEventsRouter({ getDb: () => Promise.resolve(ctx.db), events: getAccountEvents() }),
    );
    app.use(
      '/api/devices',
      createDevicesRouter({
        getDb: () => Promise.resolve(ctx.db),
        requireActiveSession: requireActiveSession(() => Promise.resolve(ctx.db)),
        events: getAccountEvents(),
        deviceSessions: getDeviceSessions(),
      }),
    );
    app.post('/api/chat', webChat(appDeps));
    await new Promise<void>((resolve) => {
      ctx.server = app.listen(0, () => resolve());
    });
    ctx.baseUrl = `http://127.0.0.1:${(ctx.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    ctx.server?.close();
    await closeDb().catch(() => undefined);
    await closeTestDb(ctx.pg).catch(() => undefined);
  });

  async function get(path: string, token: string): Promise<Response> {
    return fetch(`${ctx.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  async function send(method: string, path: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${ctx.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function seedConversation(userId: string, title = 'private', messages = 0): Promise<StoredConversation> {
    const conversation = await createConversation(ctx.db, userId, title);
    for (let index = 0; index < messages; index += 1) {
      await appendMessage(ctx.db, userId, conversation.id, {
        role: index % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `m${index}` }],
      });
    }
    return conversation;
  }

  it('A-1 lists never include the other account rows', async () => {
    const aConv = await seedConversation(ctx.accountA.userId, 'A secret');
    const bConv = await seedConversation(ctx.accountB.userId, 'B visible');

    const res = await get('/api/conversations', ctx.tokenB);
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { conversations: Array<{ id: string }> }).conversations.map(
      (entry) => entry.id,
    );
    expect(ids).toContain(bConv.id);
    expect(ids).not.toContain(aConv.id);
  });

  it('A-2 get on an other-account conversation answers 404 identical to unknown', async () => {
    const aConv = await seedConversation(ctx.accountA.userId, 'A secret', 3);
    const theirs = await get(`/api/conversations/${aConv.id}`, ctx.tokenB);
    const unknown = await get(`/api/conversations/${UNKNOWN_CONVERSATION}`, ctx.tokenB);
    const theirsText = await theirs.text();
    const unknownText = await unknown.text();
    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(theirsText).toBe(unknownText);
    expect(theirsText).toBe('{"error":{"code":"not_found"}}');
  });

  it('A-3 rename on an other-account conversation answers 404 identical to unknown; owner title unchanged', async () => {
    const aConv = await seedConversation(ctx.accountA.userId, 'A title');
    const theirs = await send('PATCH', `/api/conversations/${aConv.id}`, ctx.tokenB, {
      title: 'hijacked',
    });
    const unknown = await send('PATCH', `/api/conversations/${UNKNOWN_CONVERSATION}`, ctx.tokenB, {
      title: 'hijacked',
    });
    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await theirs.text()).toBe(await unknown.text());
    expect((await getConversation(ctx.db, ctx.accountA.userId, aConv.id))?.title).toBe('A title');
  });

  it('A-4 delete on an other-account conversation is the same quiet 204 as unknown; owner row survives', async () => {
    const aConv = await seedConversation(ctx.accountA.userId, 'A keeps', 2);
    const theirs = await send('DELETE', `/api/conversations/${aConv.id}`, ctx.tokenB, undefined);
    const unknown = await send('DELETE', `/api/conversations/${UNKNOWN_CONVERSATION}`, ctx.tokenB, undefined);
    expect(theirs.status).toBe(204);
    expect(unknown.status).toBe(204);
    expect(await theirs.text()).toBe(await unknown.text());
    expect((await getConversation(ctx.db, ctx.accountA.userId, aConv.id))?.title).toBe('A keeps');
    expect((await getConversation(ctx.db, ctx.accountA.userId, aConv.id))?.messages).toHaveLength(2);
  });

  it('A-5 activate on an other-account conversation answers 404 identical to unknown; A pointer untouched', async () => {
    const aConv = await seedConversation(ctx.accountA.userId, 'A active');
    await withUser(ctx.db, ctx.accountA.userId, (tx) => setActive(tx, ctx.accountA.userId, aConv.id, 'web_text'));

    const theirs = await send('POST', `/api/conversations/${aConv.id}/activate`, ctx.tokenB, {});
    const unknown = await send('POST', `/api/conversations/${UNKNOWN_CONVERSATION}/activate`, ctx.tokenB, {});
    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await theirs.text()).toBe(await unknown.text());
    const aActive = await getActive(ctx.db, ctx.accountA.userId);
    expect(aActive?.conversationId).toBe(aConv.id);
    expect(aActive?.surface).toBe('web_text');
  });

  it('A-6 GET /api/active as B never reflects A pointer', async () => {
    const aConv = await seedConversation(ctx.accountA.userId, 'A active');
    await withUser(ctx.db, ctx.accountA.userId, (tx) => setActive(tx, ctx.accountA.userId, aConv.id, 'picker'));
    const bConv = await seedConversation(ctx.accountB.userId, 'B active');
    await withUser(ctx.db, ctx.accountB.userId, (tx) => setActive(tx, ctx.accountB.userId, bConv.id, 'picker'));

    const res = await get('/api/active', ctx.tokenB);
    expect(res.status).toBe(200);
    const active = (await res.json()) as { active: { conversation_id: string } | null };
    expect(active.active?.conversation_id).toBe(bConv.id);
    expect(active.active?.conversation_id).not.toBe(aConv.id);
  });

  it('A-7 chat on an other-account conversation answers 404 identical to unknown; nothing appended', async () => {
    const aConv = await seedConversation(ctx.accountA.userId, 'A chat', 1);
    const message = { id: 'msg-isolation-01', role: 'user', parts: [{ type: 'text', text: 'hello' }] };

    const theirs = await send('POST', '/api/chat', ctx.tokenB, { id: aConv.id, message });
    const unknown = await send('POST', '/api/chat', ctx.tokenB, { id: UNKNOWN_CONVERSATION, message });
    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await theirs.text()).toBe(await unknown.text());
    const detail = (await getConversation(ctx.db, ctx.accountA.userId, aConv.id))!;
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]!.origin).toBe('web_text');
  });

  it('A-8 chat creating a conversation lands only in the caller account', async () => {
    const message = { id: 'msg-isolation-02', role: 'user', parts: [{ type: 'text', text: 'new chat' }] };
    const res = await send('POST', '/api/chat', ctx.tokenB, { message });
    expect(res.status).toBe(200);
    const sse = await res.text();
    const match = sse.match(/"conversationId":"(cnv_[^"]+)"/);
    expect(match).toBeTruthy();
    const createdId = match![1]!;
    const detail = (await getConversation(ctx.db, ctx.accountB.userId, createdId))!;
    expect(detail.title).toBe('new chat');
    expect(detail.messages.map((entry) => entry.role)).toEqual(['user', 'assistant']);
    expect(detail.messages[0]!.origin).toBe('web_text');
    expect(detail.messages[1]!.origin).toBe('web_text');
    const bIds = (await listConversations(ctx.db, ctx.accountB.userId)).map((entry) => entry.id);
    expect(bIds).toContain(createdId);
    const aIds = (await listConversations(ctx.db, ctx.accountA.userId)).map((entry) => entry.id);
    expect(aIds).not.toContain(createdId);
    const aActive = await getActive(ctx.db, ctx.accountA.userId);
    expect(aActive?.conversationId).not.toBe(createdId);
  });

  it('A-9 voice as B never changes A pointer', async () => {
    const aConv = await seedConversation(ctx.accountA.userId, 'A voice');
    await withUser(ctx.db, ctx.accountA.userId, (tx) => setActive(tx, ctx.accountA.userId, aConv.id, 'web_text'));
    const bConv = await seedConversation(ctx.accountB.userId, 'B voice');
    await withUser(ctx.db, ctx.accountB.userId, (tx) => setActive(tx, ctx.accountB.userId, bConv.id, 'web_text'));

    const res = await send('POST', '/api/voice', ctx.tokenB, {
      audio: Buffer.from('audio').toString('base64'),
      format: 'webm',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'hello' });

    const aActive = (await getActive(ctx.db, ctx.accountA.userId))!;
    expect(aActive.conversationId).toBe(aConv.id);
    expect(aActive.surface).toBe('web_text');
    const bActive = (await getActive(ctx.db, ctx.accountB.userId))!;
    expect(bActive.conversationId).toBe(bConv.id);
    expect(bActive.surface).toBe('web_voice');
  });

  it('A-10 speech as B touches no account data', async () => {
    const aConv = await seedConversation(ctx.accountA.userId, 'A speech');
    const before = (await getConversation(ctx.db, ctx.accountA.userId, aConv.id))!;
    const aActiveBefore = await getActive(ctx.db, ctx.accountA.userId);

    const res = await send('POST', '/api/speech', ctx.tokenB, { text: 'speak this' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    const bytes = await res.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(0);

    const after = (await getConversation(ctx.db, ctx.accountA.userId, aConv.id))!;
    expect(after.messages).toEqual(before.messages);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(await getActive(ctx.db, ctx.accountA.userId)).toEqual(aActiveBefore);
  });

  it('A-11 pairing: on A owned pairing, B lookup/approve answer 404 identical to unknown; B deny is a quiet no-op', async () => {
    const { userId: aId } = ctx.accountA;
    const claim = `claim-${randomUUID()}`;
    const issued = await pairing.issueCode(ctx.db, { model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim, ip: '203.0.113.1' });
    const deviceId = await approvePairing(ctx.db, aId, issued.pairingId);

    // A's code is consumed (status approved): B lookup answers exactly like a
    // never-issued code (identical status and body bytes, no oracle).
    const bLookup = await send('POST', '/api/pair/lookup', ctx.tokenB, { user_code: issued.userCode });
    const unknownLookup = await send('POST', '/api/pair/lookup', ctx.tokenB, { user_code: 'WWWW-WWWW' });
    expect(bLookup.status).toBe(404);
    expect(unknownLookup.status).toBe(404);
    expect(await bLookup.text()).toBe(await unknownLookup.text());

    // B approve of A's already-approved pairing answers 404 identical to unknown.
    const bApprove = await send('POST', '/api/pair/approve', ctx.tokenB, { pairing_id: issued.pairingId });
    const unknownApprove = await send('POST', '/api/pair/approve', ctx.tokenB, { pairing_id: randomUUID() });
    expect(bApprove.status).toBe(404);
    expect(unknownApprove.status).toBe(404);
    expect(await bApprove.text()).toBe(await unknownApprove.text());

    // B deny of A's approved pairing is the same 204 as unknown and changes nothing.
    const bDeny = await send('POST', '/api/pair/deny', ctx.tokenB, { pairing_id: issued.pairingId });
    const unknownDeny = await send('POST', '/api/pair/deny', ctx.tokenB, { pairing_id: randomUUID() });
    expect(bDeny.status).toBe(204);
    expect(unknownDeny.status).toBe(204);
    // A can still claim the delivered token: the pairing and device are intact.
    const delivered = await claimPairing(ctx.db, issued.pairingId, sha256(claim), sha256('olxd_test_after_deny'));
    expect(delivered?.deviceId).toBe(deviceId);
  });

  it('A-12 pairing: B cannot approve or revoke A device at the store layer', async () => {
    const { userId: aId } = ctx.accountA;
    const { userId: bId } = ctx.accountB;
    const claim = `claim-${randomUUID()}`;
    const issued = await pairing.issueCode(ctx.db, { model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim, ip: '203.0.113.2' });
    const deviceId = await approvePairing(ctx.db, aId, issued.pairingId);
    await expect(approvePairing(ctx.db, bId, issued.pairingId)).rejects.toBeInstanceOf(PairingNotFoundError);
    await expect(revokeDevice(ctx.db, bId, deviceId)).rejects.toBeInstanceOf(PairingNotFoundError);
    // B's deny is a silent no-op (pairing not pending): the device is still A's.
    await denyPairing(ctx.db, bId, issued.pairingId);
    expect((await claimPairing(ctx.db, issued.pairingId, sha256(claim), sha256('olxd_still_a')))?.deviceId).toBe(deviceId);
  });

  it('A-13 the /api/events stream never delivers another account events', async () => {
    const aConv = await createConversation(ctx.db, ctx.eventAccountA.userId, 'A event');
    const bConv = await createConversation(ctx.db, ctx.eventAccountB.userId, 'B event');

    const { events: stream, abort } = await openEvents(ctx, ctx.eventTokenB);
    const events = getAccountEvents();
    // A background collector keeps every event frame so no read is ever
    // abandoned; the test then inspects what actually arrived.
    const { frames, done: pump } = collectEvents(stream);
    // Settle so the stream's subscribe() has run before anything publishes.
    await new Promise((resolve) => setTimeout(resolve, 30));

    events.publish(ctx.eventAccountA.userId, { type: 'conversation.updated', conversation_id: aConv.id, updated_at: Date.now() });
    events.publish(ctx.eventAccountA.userId, {
      type: 'active.changed',
      conversation_id: aConv.id,
      title: aConv.title,
      surface: 'web_text',
      changed_at: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(frames).toHaveLength(0);

    events.publish(ctx.eventAccountB.userId, { type: 'conversation.updated', conversation_id: bConv.id, updated_at: Date.now() });
    const deadline = Date.now() + 3000;
    while (frames.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe('conversation.updated');
    expect((frames[0]!.data as { conversation_id: string }).conversation_id).toBe(bConv.id);
    expect(frames.every((frame) => (frame.data as { conversation_id?: string }).conversation_id !== aConv.id)).toBe(true);
    abort();
    await pump.catch(() => undefined);
  });

  it('A-14 devices: GET as B never lists A devices', async () => {
    const { userId: aId } = ctx.accountA;
    const issued = await pairing.issueCode(ctx.db, {
      model: 'M5Stack Cardputer',
      fwVersion: '0.9.0',
      claim: `claim-${randomUUID()}`,
      ip: '203.0.113.21',
    });
    const aDevice = await approvePairing(ctx.db, aId, issued.pairingId);

    const res = await get('/api/devices', ctx.tokenB);
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { devices: Array<{ id: string }> }).devices.map((entry) => entry.id);
    expect(ids).not.toContain(aDevice);
  });

  it('A-15 devices: PATCH on A device answers 404 identical to unknown; A name unchanged', async () => {
    const { userId: aId } = ctx.accountA;
    const issued = await pairing.issueCode(ctx.db, {
      model: 'M5Stack Cardputer',
      fwVersion: '0.9.0',
      claim: `claim-${randomUUID()}`,
      ip: '203.0.113.22',
    });
    const aDevice = await approvePairing(ctx.db, aId, issued.pairingId);

    const theirs = await send('PATCH', `/api/devices/${aDevice}`, ctx.tokenB, { name: 'hijacked' });
    const unknown = await send('PATCH', `/api/devices/${randomUUID()}`, ctx.tokenB, { name: 'hijacked' });
    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await theirs.text()).toBe(await unknown.text());

    const asA = await get('/api/devices', ctx.tokenA);
    const body = (await asA.json()) as { devices: Array<{ id: string; name: string }> };
    expect(body.devices.find((entry) => entry.id === aDevice)!.name).toBe('M5Stack Cardputer');
  });

  it('A-16 devices: DELETE on A device answers 404 identical to unknown; A device and socket stay live', async () => {
    const { userId: aId } = ctx.accountA;
    const issued = await pairing.issueCode(ctx.db, {
      model: 'M5Stack Cardputer',
      fwVersion: '0.9.0',
      claim: `claim-${randomUUID()}`,
      ip: '203.0.113.23',
    });
    const aDevice = await approvePairing(ctx.db, aId, issued.pairingId);

    const registry = getDeviceSessions();
    const live = { readyState: 1, close: vi.fn() };
    registry.register(live as unknown as WebSocket, { id: `iso-sess-${aDevice}`, stage: 'ready' }, aId, aDevice);
    try {
      const theirs = await send('DELETE', `/api/devices/${aDevice}`, ctx.tokenB, undefined);
      const unknown = await send('DELETE', `/api/devices/${randomUUID()}`, ctx.tokenB, undefined);
      expect(theirs.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await theirs.text()).toBe(await unknown.text());
      expect(live.close).not.toHaveBeenCalled();

      const asA = await get('/api/devices', ctx.tokenA);
      const ids = ((await asA.json()) as { devices: Array<{ id: string }> }).devices.map((entry) => entry.id);
      expect(ids).toContain(aDevice);
    } finally {
      registry.unregister({ id: `iso-sess-${aDevice}`, stage: 'ready' });
    }
  });

  it('S-1 a paired device list_conversations never includes another account rows', async () => {
    const aConv = await seedConversation(ctx.accountA.userId, 'A device list');
    await seedConversation(ctx.accountB.userId, 'B device list');
    const socket = makeSocket();
    const session = createSession(deviceAuthFor(ctx.accountB.userId));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(session.stage).toBe('ready');
    socket.send.mockClear();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('list_conversations'), vi.fn());
    const reply = lastSent(socket) as { payload: { conversations: Array<{ id: string }> } };
    expect(reply.payload.conversations.map((entry) => entry.id)).not.toContain(aConv.id);
  });

  it('S-2 a paired device welcome/pointer and select never cross accounts', async () => {
    const aConv = await seedConversation(ctx.accountA.userId, 'A pinned');
    await withUser(ctx.db, ctx.accountA.userId, (tx) => setActive(tx, ctx.accountA.userId, aConv.id, 'device'));
    const bConv = await seedConversation(ctx.accountB.userId, 'B pinned');
    await withUser(ctx.db, ctx.accountB.userId, (tx) => setActive(tx, ctx.accountB.userId, bConv.id, 'picker'));

    // B device hello: the welcome active_conversation is B's own pointer.
    const socket = makeSocket();
    const session = createSession(deviceAuthFor(ctx.accountB.userId));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    const welcome = lastSent(socket) as { payload: { active_conversation: { id: string } | null } };
    expect(welcome.payload.active_conversation?.id).toBe(bConv.id);
    expect(welcome.payload.active_conversation?.id).not.toBe(aConv.id);

    // B device select on A's conversation answers CONVERSATION_NOT_FOUND and
    // leaves B's selection unchanged.
    socket.send.mockClear();
    await handleControl(appDeps, 
      socket as unknown as WebSocket,
      session,
      control('select_conversation', { payload: { conversation_id: aConv.id } }),
      vi.fn(),
    );
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'CONVERSATION_NOT_FOUND' } });
    expect(session.activeConversationId).toBe(bConv.id);
    // B's pointer is untouched by the failed cross-account select.
    expect((await getActive(ctx.db, ctx.accountB.userId))?.conversationId).toBe(bConv.id);
  });

  it('S-3 device turn persistence lands only in the device owner account', async () => {
    const { userId: aId } = ctx.accountA;
    const { userId: bId } = ctx.accountB;
    const aConv = await seedConversation(ctx.accountA.userId, 'A owns', 2);
    const bConv = await seedConversation(ctx.accountB.userId, 'B owns', 1);

    // B's device pinned to A's conversation cannot append to it: persistence
    // falls back to a fresh B-owned conversation (conversationExists is false).
    const bTurn = await persistDeviceTurn(ctx.db, bId, aConv.id, 'b transcript', 'b reply');
    expect(bTurn.created).toBe(true);
    expect(bTurn.conversationId).not.toBe(aConv.id);
    expect((await getConversation(ctx.db, aId, aConv.id))!.messages).toHaveLength(2);
    const bDetail = (await getConversation(ctx.db, bId, bTurn.conversationId))!;
    expect(bDetail.messages.map((entry) => entry.origin)).toEqual(['device', 'device']);
    expect((await listConversations(ctx.db, aId)).map((entry) => entry.id)).not.toContain(bTurn.conversationId);

    // Symmetric: A's device pinned to B's conversation creates an A conversation.
    const aTurn = await persistDeviceTurn(ctx.db, aId, bConv.id, 'a transcript', 'a reply');
    expect(aTurn.created).toBe(true);
    expect(aTurn.conversationId).not.toBe(bConv.id);
    expect((await getConversation(ctx.db, bId, bConv.id))!.messages).toHaveLength(1);
    expect((await listConversations(ctx.db, bId)).map((entry) => entry.id)).not.toContain(aTurn.conversationId);
  });

  it('S-4 store: withUser as one account never sees another account active pointer', async () => {
    const { userId: aId } = ctx.accountA;
    const { userId: cId } = ctx.accountC;
    const aConv = await seedConversation(ctx.accountA.userId, 'A store pointer');
    await withUser(ctx.db, aId, (tx) => setActive(tx, aId, aConv.id, 'picker'));

    // A pristine account has no pointer row: getActive(C) is null even though
    // A's row exists (RLS hides A's user_state row entirely).
    expect(await getActive(ctx.db, cId)).toBeNull();

    // C sets its own pointer; A's row is untouched.
    const cConv = await seedConversation(ctx.accountC.userId, 'C store pointer');
    await withUser(ctx.db, cId, (tx) => setActive(tx, cId, cConv.id, 'web_text'));
    expect((await getActive(ctx.db, cId))?.conversationId).toBe(cConv.id);
    const aActive = (await getActive(ctx.db, aId))!;
    expect(aActive.conversationId).toBe(aConv.id);
    expect(aActive.surface).toBe('picker');
  });

  it('S-5 the guard role base connection is blind to every account table', async () => {
    if (mode !== 'bob_server') return;
    // With no withUser claims, bob_server (nobypassrls) reads zero rows across
    // every RLS-protected account table, exactly as production's unclaimed
    // connection would. pairing_requests has NO grants at all (server-only via
    // bob_private), so a direct read is refused outright rather than filtered.
    for (const table of ['conversations', 'messages', 'message_versions', 'devices', 'user_state']) {
      expect(await ctx.db.query(`SELECT 1 AS one FROM bob.${table}`)).toEqual([]);
    }
    await expect(ctx.db.query(`SELECT 1 AS one FROM bob.pairing_requests`)).rejects.toThrow();
  });
});