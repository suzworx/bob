// The id model on real spans and journal lines: user, conversation, client session, and how the
// conversation was resolved (explicit > client > device > active > none). Real telemetry pipeline,
// in-memory exporter; the active-pointer read is a stub (no database).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { exportedAttributes as span, otlpSpans } from '../support/memory-otlp.ts';

vi.mock('@opentelemetry/exporter-trace-otlp-proto', async () => ({
  OTLPTraceExporter: (await import('../support/memory-otlp.ts')).MemoryOtlpTraceExporter,
}));

import { flushTelemetry, initTelemetry, toSpanAttrs, traceSpan } from '@bob/ai';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { httpDiagnostics } from '../../src/platform/observability/http-diagnostics.ts';
import { createHttpRouteInventory } from '../../src/platform/observability/http-route-inventory.ts';
import { setActiveConversationReader } from '../../src/platform/observability/conversation-correlation.ts';
import { primeActiveConversation } from '../../src/platform/observability/active-conversation.ts';
import { setJournalSink, journal } from '../../src/platform/logger.ts';
import { traceWebTurn } from '../../src/conversations/chat-stream.ts';
import { deviceCorrelation } from '../../src/voice/socket-diagnostics.ts';
import type { SessionDto } from '../../src/voice/protocol.ts';
import { createEmailNotificationHandler } from '../../src/notifications/email.ts';
import { deliverThrough } from '../../src/notifications/notify.ts';
import type { Db } from '../../src/platform/db/db.ts';
import type { StoredOutboxRow } from '../../src/platform/outbox/store.ts';

const CONV = (n: string): string => `conv_${n.repeat(32)}`;
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const lines: Array<Record<string, unknown>> = [];
let handlerStarted: () => void = () => undefined;
let server: Server;
let url: string;

beforeAll(async () => {
  initTelemetry();
  const app = express();
  app.use(httpDiagnostics(createHttpRouteInventory(app)));
  app.use('/api', createJwtWebAuthGuard(async (token) => ({ userId: token, sessionId: 'supabase', exp: 1 })));
  const handler: express.RequestHandler = async (_request, response) => {
    await traceSpan('handler-child', {}, () => journal('v2.test_handled'));
    response.end();
  };
  app.get('/api/tasks', handler);
  app.post('/api/threads/:id/invocations', handler);
  app.get('/api/slow', async (_request, response) => {
    handlerStarted();
    await new Promise((resolve) => setTimeout(resolve, 30));
    response.end();
  });
  app.get('/api/conversations/:id/messages', handler);
  app.get('/health', (_request, response) => { response.end(); });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setJournalSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
});
afterAll(async () => {
  setJournalSink(null);
  setActiveConversationReader(undefined);
  await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
});
beforeEach(() => { otlpSpans.reset(); lines.length = 0; setActiveConversationReader(undefined); });

async function get(path: string, user: string | null, headers: Record<string, string> = {}): Promise<void> {
  await (await fetch(`${url}${path}`, { headers: { ...(user ? { authorization: `Bearer ${user}` } : {}), ...headers } })).text();
  await flushTelemetry();
}
const exportedSpans = (): Array<{ name: string; attributes: Record<string, unknown> }> => otlpSpans.getFinishedSpans();
const ids = (name: string): Record<string, unknown> => {
  const a = span(name);
  return { user: a['user.id'], session: a['session.id'], conversation: a['bob.conversation.id'], source: a['bob.conversation.source'] };
};

describe('web request correlation', () => {
  it('a) explicit: the route conversation wins over the header and the pointer', async () => {
    setActiveConversationReader(async () => CONV('c'));
    await get(`/api/conversations/${CONV('a')}/messages`, 'user-1', { 'X-Bob-Conversation': CONV('b'), 'X-Bob-Client-Session': SESSION_A });
    expect(ids('http GET /api/conversations/:id/messages')).toEqual({ user: 'user-1', session: SESSION_A, conversation: CONV('a'), source: 'explicit' });
    expect(ids('handler-child')).toEqual(ids('http GET /api/conversations/:id/messages'));
  });

  it('b) client: the header, on both names, journal included', async () => {
    await get('/api/tasks', 'user-1', { 'X-Bob-Conversation': CONV('b'), 'X-Bob-Client-Session': SESSION_A });
    expect(ids('http GET /api/tasks')).toEqual({ user: 'user-1', session: SESSION_A, conversation: CONV('b'), source: 'client' });
    expect(span('handler-child')['gen_ai.conversation.id']).toBe(CONV('b'));
    expect(lines.find((l) => l.event === 'v2.test_handled')).toMatchObject({
      user_id: 'user-1', conversation_id: CONV('b'), conversation_source: 'client', session_id: SESSION_A,
    });
  });

  it('d) active: the user pointer when there is no header; an invalid header and session are ignored', async () => {
    setActiveConversationReader(async (user) => (user === 'user-1' ? CONV('d') : null));
    await get('/api/tasks', 'user-1', { 'X-Bob-Conversation': 'garbage', 'X-Bob-Client-Session': 'not-a-uuid' });
    expect(ids('http GET /api/tasks')).toEqual({ user: 'user-1', session: undefined, conversation: CONV('d'), source: 'active' });
  });

  it('e) none: unauthenticated requests carry neither user nor a conversation, but keep the client session', async () => {
    await get('/api/tasks', null, { 'X-Bob-Conversation': CONV('b'), 'X-Bob-Client-Session': SESSION_A });
    expect(ids('http GET /api/tasks')).toEqual({ user: undefined, session: SESSION_A, conversation: 'none', source: 'none' });
    expect(lines.find((l) => l.event === 'v2.auth_rejected')).toMatchObject({ conversation_id: 'none', conversation_source: 'none' });
  });

  it('the request path never waits for the active pointer: the root is stamped when the read resolves, if it is still open', async () => {
    let release: (ref: string) => void = () => undefined;
    setActiveConversationReader(() => new Promise<string>((resolve) => { release = resolve; }));
    let readSettledAtHandlerStart = true;
    handlerStarted = () => { readSettledAtHandlerStart = false; release(CONV('d')); };
    await get('/api/slow', 'user-1');
    handlerStarted = () => undefined;
    expect(readSettledAtHandlerStart).toBe(false);
    expect(ids('http GET /api/slow')).toMatchObject({ user: 'user-1', conversation: CONV('d'), source: 'active' });
  });

  it('a workflow route keeps the guard\'s user on its completion span', async () => {
    await (await fetch(`${url}/api/threads/${CONV('a')}/invocations`, { method: 'POST', headers: { authorization: 'Bearer user-1' } })).text();
    await flushTelemetry();
    expect(ids('http POST /api/threads/:id/invocations')).toMatchObject({ user: 'user-1' });
  });

  it('a pointer read or write primes the cache: later spans for the user need no query', async () => {
    const read = vi.fn(async () => CONV('z'));
    setActiveConversationReader(read);
    primeActiveConversation('user-9', CONV('1'));
    await traceSpan('background', { userId: 'user-9', detached: true }, () => undefined);
    await flushTelemetry();
    expect(ids('background')).toMatchObject({ user: 'user-9', conversation: CONV('1'), source: 'active' });
    expect(read).not.toHaveBeenCalled();
  });

  it('two users in one shared thread share the conversation id but not user.id or session.id', async () => {
    for (const [user, session] of [['user-1', SESSION_A], ['user-2', SESSION_B]]) {
      await get(`/api/conversations/${CONV('a')}/messages`, user!, { 'X-Bob-Client-Session': session! });
    }
    const roots = exportedSpans().filter((s) => s.name === 'http GET /api/conversations/:id/messages').map((s) => s.attributes);
    expect(roots.map((a) => a['bob.conversation.id'])).toEqual([CONV('a'), CONV('a')]);
    expect(roots.map((a) => a['user.id'])).toEqual(['user-1', 'user-2']);
    expect(roots.map((a) => a['session.id'])).toEqual([SESSION_A, SESSION_B]);
  });
});

describe('web turn and device turn on one conversation', () => {
  it('share both conversation names and differ in session.id', async () => {
    await traceWebTurn(CONV('a'), 'user-1', 'turn-web', () => undefined);
    const session = { id: 'session_dev1', activeConversationId: CONV('a') } as unknown as SessionDto;
    await traceSpan('device-turn', toSpanAttrs({ surface: 'device', turnId: 'turn-dev', ...deviceCorrelation(session, 'user-1') }), () => undefined);
    await flushTelemetry();
    const web = span('web-chat-turn');
    const device = span('device-turn');
    expect([web['bob.conversation.id'], web['gen_ai.conversation.id']]).toEqual([CONV('a'), CONV('a')]);
    expect([device['bob.conversation.id'], device['gen_ai.conversation.id']]).toEqual([CONV('a'), CONV('a')]);
    expect([web['bob.conversation.source'], device['bob.conversation.source']]).toEqual(['explicit', 'device']);
    expect(web['session.id']).not.toBe(device['session.id']);
    expect(device['session.id']).toBe('session_dev1');
  });
});

describe('background work', () => {
  it('d) a reminder fanout for a user carries that user\'s active conversation, source active', async () => {
    setActiveConversationReader(async () => CONV('e'));
    await traceSpan('notifications-enqueued', { userId: 'user-1', metadata: { count: '1' } }, () => journal('v2.notifications_enqueued'));
    await flushTelemetry();
    expect(ids('notifications-enqueued')).toMatchObject({ user: 'user-1', conversation: CONV('e'), source: 'active' });
    expect(lines.find((l) => l.event === 'v2.notifications_enqueued')).toMatchObject({ user_id: 'user-1', conversation_id: CONV('e'), conversation_source: 'active' });
  });

  it('e) an outbox tick (system work) carries none', async () => {
    await traceSpan('outbox.poll-summary', { detached: true, metadata: { outcome: 'idle' } }, () => journal('v2.outbox_tick'));
    await flushTelemetry();
    expect(ids('outbox.poll-summary')).toMatchObject({ user: undefined, conversation: 'none', source: 'none' });
    expect(lines.find((l) => l.event === 'v2.outbox_tick')).toMatchObject({ conversation_id: 'none', conversation_source: 'none' });
  });
});

describe('user-scoped background work resolves the user\'s active conversation', () => {
  const USER = '33333333-3333-4333-8333-333333333333';
  const active = { user: USER, conversation: CONV('f'), source: 'active' };

  it('notification delivery for one recipient (no acting user) carries source active', async () => {
    setActiveConversationReader(async () => CONV('f'));
    const channel = { id: 'inbox' as const, send: async () => ({ status: 'delivered' as const, enqueued: 1, muted: 0 }) };
    await deliverThrough([channel], { type: 'reminder', threadId: null, rows: [{ recipientUserId: USER, type: 'reminder' }] as never });
    await flushTelemetry();
    expect(ids('notification-deliver')).toMatchObject(active);
  });

  it('notification email for a recipient carries source active; a malformed key stays none', async () => {
    setActiveConversationReader(async () => CONV('f'));
    // Every effect is already sent: the handler stops at its first lookup, inside the recipient's context.
    const db = { query: async () => [{ sent: true }], tx: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db) } as unknown as Db;
    const handler = createEmailNotificationHandler({ db, configured: () => true });
    const row = (effectKey: string): StoredOutboxRow => ({ effectKey, createdAt: Date.now() }) as StoredOutboxRow;
    await handler(row(`email:${USER}:assignment:task:1`), new AbortController().signal);
    await handler(row('garbage'), new AbortController().signal);
    await flushTelemetry();
    const mail = exportedSpans().filter((s) => s.name === 'email-notification').map((s) => s.attributes);
    expect(mail[0]).toMatchObject({ 'user.id': USER, 'bob.conversation.id': CONV('f'), 'bob.conversation.source': 'active' });
    expect(mail[1]).toMatchObject({ 'bob.conversation.id': 'none', 'bob.conversation.source': 'none' });
    expect(mail[1]).not.toHaveProperty('user.id');
  });
});

describe('device messages with no known conversation', () => {
  const session = { id: 'session_dev2' } as unknown as SessionDto;
  const spanFor = async (userId?: string): Promise<Record<string, unknown>> => {
    otlpSpans.reset();
    await traceSpan('ws.control.hello', toSpanAttrs({ surface: 'device', ...deviceCorrelation(session, userId) }), () => undefined);
    await flushTelemetry();
    return span('ws.control.hello');
  };

  it('a paired device falls back to the user\'s active conversation (active)', async () => {
    setActiveConversationReader(async () => CONV('9'));
    expect(await spanFor('user-1')).toMatchObject({ 'user.id': 'user-1', 'session.id': 'session_dev2', 'bob.conversation.id': CONV('9'), 'bob.conversation.source': 'active' });
  });

  it('an unpaired device is none', async () => {
    setActiveConversationReader(async () => CONV('9'));
    const attrs = await spanFor();
    expect(attrs).toMatchObject({ 'bob.conversation.id': 'none', 'bob.conversation.source': 'none', 'session.id': 'session_dev2' });
    expect(attrs).not.toHaveProperty('user.id');
  });
});
