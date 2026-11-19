// Account event stream tests (T029, contracts/account-events.md E-01..E-08,
// E-10, E-14..E-16). A real HTTP server over Postgres exercises the JWT guard,
// requireActiveSession, and the /api/events SSE router fed by the shared
// AccountEvents bus. E-04..E-08 publish through the same paths the real routes
// use (the web-conversations routes are mounted too, so activate and rename go
// through HTTP); the turn/chat routes cannot run in system-test mode, so their
// events are published directly in the exact shapes they emit.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountEventSchema, type AccountEvent } from '../../src/account/events-bus.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createConversation } from '../../src/conversations/store.ts';
import {
  activateConversationRoute,
  deleteConversationRoute,
  renameConversationRoute,
} from '../../src/conversations/http.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createWebEventsRouter } from '../../src/account/events-http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb, withAdminAuth } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const CONV_ID = 'conv_9f2b2e7c1a4d3e9a5b0c1d2e3f4a5b6c7d';
const MSG_ID = 'msg_0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const DEVICE_ID = '0c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const SPACE_ID = '1d2e3f4a-5b6c-7d8e-9f0a-1b2c3d4e5f6a';
const NOW = 1_756_100_000_000;

interface SseEvent {
  event: string;
  id: string;
  data: unknown;
}

type SseChunk = { kind: 'event'; event: SseEvent } | { kind: 'comment'; text: string };

/** Parses an SSE body into event and comment chunks as they arrive. */
async function* sseChunks(response: Response, signal: AbortSignal): AsyncGenerator<SseChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const lines = block.split('\n');
        if (lines.length > 0 && lines.every((line) => line.startsWith(':'))) {
          yield { kind: 'comment', text: lines.join('\n') };
        } else {
          let event = '';
          let id = '';
          const data: string[] = [];
          for (const line of lines) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('id:')) id = line.slice(3).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          yield { kind: 'event', event: { event, id, data: data.length ? JSON.parse(data.join('\n')) : undefined } };
        }
        sep = buffer.indexOf('\n\n');
      }
    }
  } catch {
    // Aborted by the caller; the stream is closed.
  } finally {
    reader.releaseLock();
  }
}

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
const journalLines: string[] = [];

const guardRole = process.env.BOB_TEST_GUARD_ROLE === '1';

/** Guard-mode-safe auth setup: auth.users/sessions are not writable as
 *  bob_server (no grant on the auth schema), so run as the connecting
 *  superuser and restore the production role (store-conversations-pg pattern). */
async function asSuperuser<T>(fn: () => Promise<T>): Promise<T> {
  if (guardRole) await pg.exec('reset role');
  try {
    return await fn();
  } finally {
    if (guardRole) await pg.exec('set role bob_server');
  }
}

async function addAccountSafe(options: Parameters<typeof addAccount>[1] = {}): Promise<TestAccount> {
  return asSuperuser(() => addAccount(pg, options));
}

function tokenFor(account: TestAccount): Promise<string> {
  return signToken({ userId: account.userId, sessionId: account.sessionId });
}

/** Opens the SSE stream for a bearer token; abort() closes it. */
async function openEvents(token: string): Promise<{
  response: Response;
  chunks: AsyncGenerator<SseChunk>;
  abort: () => void;
}> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  return { response, chunks: sseChunks(response, controller.signal), abort: () => controller.abort() };
}

function delay(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
}

/** The next event frame (skipping comments), or null on timeout/close. */
async function nextEvent(chunks: AsyncGenerator<SseChunk>, timeoutMs = 3000): Promise<SseEvent | null> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const outcome = await Promise.race([chunks.next(), delay(remaining)]);
    if (outcome === 'timeout') return null;
    if (outcome.done) return null;
    if (outcome.value.kind === 'event') return outcome.value.event;
  }
}

/** The next comment chunk (ignoring events), or null on timeout/close. */
async function nextComment(chunks: AsyncGenerator<SseChunk>, timeoutMs = 3000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const outcome = await Promise.race([chunks.next(), delay(remaining)]);
    if (outcome === 'timeout') return null;
    if (outcome.done) return null;
    if (outcome.value.kind === 'comment') return outcome.value.text;
  }
}

describe('GET /api/events (contracts/account-events.md E-01..E-08, E-10, E-14..E-16)', () => {
  beforeAll(async () => {
    setJournalSink((line: string) => journalLines.push(line));
    pg = await createTestDb();
    if (guardRole) await pg.exec('set role bob_server');
    db = asDb(pg);
    setSharedDb(Promise.resolve(db));

    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    // Real conversation routes so activate/rename/delete publish onto the same
    // bus the events router subscribes to.
    app.patch('/api/conversations/:id', renameConversationRoute(appDeps));
    app.delete('/api/conversations/:id', deleteConversationRoute(appDeps));
    app.post('/api/conversations/:id/activate', activateConversationRoute(appDeps));
    // 30 ms heartbeat for the E-03 test; the comment lines are ignored by the
    // event reads in every other test.
    app.use(
      '/api/events',
      createWebEventsRouter({ getDb: () => Promise.resolve(db), events: getAccountEvents(), heartbeatMs: 30 }),
    );
    // The same router with a heartbeat far past any test window, so the
    // first-byte test cannot be satisfied by a : ping.
    app.use(
      '/api/events-quiet',
      createWebEventsRouter({ getDb: () => Promise.resolve(db), events: getAccountEvents(), heartbeatMs: 600_000 }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30000);

  afterAll(async () => {
    setJournalSink(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb().catch(() => undefined);
    await closeTestDb(pg).catch(() => undefined);
  });

  it('E-01: without a bearer token the stream answers 401 missing_token', async () => {
    const response = await fetch(`${baseUrl}/api/events`);
    expect(response.status).toBe(401);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'missing_token' },
    });
  });

  it('E-02: a valid JWT whose session is inactive is refused 401 invalid_token (requireActiveSession)', async () => {
    const account = await addAccountSafe();
    const token = await tokenFor(account);
    await withAdminAuth(pg, (admin) => admin.endSession(account.sessionId));
    const response = await fetch(`${baseUrl}/api/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'invalid_token' },
    });
  });

  it('E-03: the stream opens with SSE headers and emits a : ping comment', async () => {
    const account = await addAccountSafe();
    const { response, chunks, abort } = await openEvents(await tokenFor(account));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    expect(await nextComment(chunks, 2000)).toBe(': open');
    const comment = await nextComment(chunks, 2000);
    expect(comment).not.toBeNull();
    expect(comment).toContain(': ping');
    abort();
  });

  it('closes an admitted stream on the next heartbeat after its session is revoked', async () => {
    const account = await addAccountSafe();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const { chunks, abort } = await openEvents(await tokenFor(account));
    try {
      expect(await nextComment(chunks, 2000)).toBe(': open');
      const callback = intervals.mock.calls.find(call => call[1] === 30)?.[0];
      if (typeof callback !== 'function') throw new Error('missing heartbeat callback');
      await withAdminAuth(pg, auth => auth.endSession(account.sessionId));
      // Invoke the registered heartbeat directly: no elapsed-time sleep.
      await callback();
      let next = await chunks.next();
      while (!next.done) next = await chunks.next();
      expect(next.done).toBe(true);
    } finally {
      intervals.mockRestore();
      abort();
    }
  });

  it('closes within the eligibility deadline when the database stalls and consumes late rejection', async () => {
    const account = await addAccountSafe();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const unsubscribe = vi.fn();
    const subscribe = vi.spyOn(getAccountEvents(), 'subscribe').mockReturnValue(unsubscribe);
    const { chunks, abort } = await openEvents(await tokenFor(account));
    expect(await nextComment(chunks, 2000)).toBe(': open');
    const callback = intervals.mock.calls.find(call => call[1] === 30)?.[0];
    if (typeof callback !== 'function') throw new Error('missing heartbeat callback');
    let rejectQuery: ((error: Error) => void) | undefined;
    const query = vi.spyOn(db, 'tx').mockImplementation(() => new Promise((_resolve, reject) => { rejectQuery = reject; }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The route's own deadline, not vi.getTimerCount(): the fakes are global, so a
    // timer the live server or the db pool sets meanwhile counted too (flaky on #1312).
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const clears = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const pending = callback();
      const deadline = timeouts.mock.results[timeouts.mock.calls.findIndex(call => call[1] === 5_000)]?.value;
      expect(deadline).toBeDefined();
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await chunks.next()).done).toBe(true);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(clears).toHaveBeenCalledWith(deadline);
      rejectQuery?.(new Error('late query failure'));
      await pending;
    } finally {
      timeouts.mockRestore();
      clears.mockRestore();
      vi.useRealTimers();
      query.mockRestore();
      subscribe.mockRestore();
      intervals.mockRestore();
      abort();
    }
  });

  it('SSE-FIRST-BYTE: the first body bytes arrive before any event or heartbeat', async () => {
    const account = await addAccountSafe();
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events-quiet`, {
      headers: { authorization: `Bearer ${await tokenFor(account)}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    // No event is published and the heartbeat is 10 min out, so only the
    // open comment can be read here; a proxy passes it through at once.
    const reader = response.body!.getReader();
    const first = await Promise.race([reader.read(), delay(1000)]);
    expect(first).not.toBe('timeout');
    const { done, value } = first as ReadableStreamReadResult<Uint8Array>;
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toBe(': open\n\n');
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it('E-04: a web turn publishes message.appended with conversation_id + message_id, no text', async () => {
    const account = await addAccountSafe();
    const { chunks, abort } = await openEvents(await tokenFor(account));
    const event: AccountEvent = { type: 'message.appended', conversation_id: CONV_ID, message_id: MSG_ID, updated_at: NOW };
    getAccountEvents().publish(account.userId, event);

    const frame = await nextEvent(chunks);
    expect(frame).not.toBeNull();
    expect(frame!.event).toBe('message.appended');
    expect(frame!.data).toEqual(event);
    abort();
  });

  it('E-05: a device turn publishes message.appended with the same shape', async () => {
    const account = await addAccountSafe();
    const { chunks, abort } = await openEvents(await tokenFor(account));
    const deviceMsgId = 'msg_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e';
    const event: AccountEvent = { type: 'message.appended', conversation_id: CONV_ID, message_id: deviceMsgId, updated_at: NOW };
    getAccountEvents().publish(account.userId, event);

    const frame = await nextEvent(chunks);
    expect(frame).not.toBeNull();
    expect(frame!.event).toBe('message.appended');
    expect(frame!.data).toEqual(event);
    abort();
  });

  it('E-06: conversation created (direct) and renamed (HTTP) both publish conversation.updated', async () => {
    const account = await addAccountSafe();
    const token = await tokenFor(account);
    const { chunks, abort } = await openEvents(token);

    const created: AccountEvent = { type: 'conversation.updated', conversation_id: CONV_ID, updated_at: NOW };
    getAccountEvents().publish(account.userId, created);
    const createdFrame = await nextEvent(chunks);
    expect(createdFrame!.event).toBe('conversation.updated');
    expect(createdFrame!.data).toEqual(created);

    const conversation = await createConversation(db, account.userId, 'rename me');
    const response = await fetch(`${baseUrl}/api/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' }),
    });
    expect(response.status).toBe(200);

    const renamedFrame = await nextEvent(chunks);
    expect(renamedFrame!.event).toBe('conversation.updated');
    expect((renamedFrame!.data as { conversation_id: string }).conversation_id).toBe(conversation.id);
    abort();
  });

  it('E-07: deleting a conversation publishes conversation.deleted', async () => {
    const account = await addAccountSafe();
    const token = await tokenFor(account);
    const { chunks, abort } = await openEvents(token);
    const conversation = await createConversation(db, account.userId, 'doomed');

    const response = await fetch(`${baseUrl}/api/conversations/${conversation.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(204);

    const frame = await nextEvent(chunks);
    expect(frame).not.toBeNull();
    expect(frame!.event).toBe('conversation.deleted');
    expect((frame!.data as { conversation_id: string }).conversation_id).toBe(conversation.id);
    abort();
  });

  it('E-08: pointer changes publish active.changed with every surface', async () => {
    const account = await addAccountSafe();
    const token = await tokenFor(account);
    const { chunks, abort } = await openEvents(token);
    const conversation = await createConversation(db, account.userId, 'pointer');

    // web_text, web_voice, device, picker are published directly in the exact
    // shapes web-chat, web-voice, turn.ts, and session.ts emit.
    const surfaces: AccountEvent[] = [
      { type: 'active.changed', conversation_id: conversation.id, title: 'pointer', surface: 'web_text', changed_at: NOW },
      { type: 'active.changed', conversation_id: conversation.id, title: 'pointer', surface: 'web_voice', changed_at: NOW },
      { type: 'active.changed', conversation_id: conversation.id, title: 'pointer', surface: 'device', changed_at: NOW },
      { type: 'active.changed', conversation_id: conversation.id, title: 'pointer', surface: 'picker', changed_at: NOW },
    ];
    for (const event of surfaces) getAccountEvents().publish(account.userId, event);

    // activate goes through the real route.
    const activate = await fetch(`${baseUrl}/api/conversations/${conversation.id}/activate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(activate.status).toBe(200);

    const expectedSurfaces = ['web_text', 'web_voice', 'device', 'picker', 'activate'];
    for (const surface of expectedSurfaces) {
      const frame = await nextEvent(chunks);
      expect(frame).not.toBeNull();
      expect(frame!.event).toBe('active.changed');
      const data = frame!.data as { conversation_id: string; title: string; surface: string };
      expect(data.conversation_id).toBe(conversation.id);
      expect(data.surface).toBe(surface);
    }
    abort();
  });

  it('#900: active.changed carries an optional device_id unchanged when set, absent otherwise', async () => {
    const account = await addAccountSafe();
    const { chunks, abort } = await openEvents(await tokenFor(account));

    const withDevice: AccountEvent = {
      type: 'active.changed', conversation_id: CONV_ID, title: 'pointer', surface: 'device', changed_at: NOW, device_id: DEVICE_ID,
    };
    getAccountEvents().publish(account.userId, withDevice);
    const withFrame = await nextEvent(chunks);
    expect(withFrame?.event).toBe('active.changed');
    expect(withFrame?.data).toEqual(withDevice);

    const withoutDevice: AccountEvent = {
      type: 'active.changed', conversation_id: CONV_ID, title: 'pointer', surface: 'web_text', changed_at: NOW,
    };
    getAccountEvents().publish(account.userId, withoutDevice);
    const withoutFrame = await nextEvent(chunks);
    expect(withoutFrame?.event).toBe('active.changed');
    expect(withoutFrame?.data).toEqual(withoutDevice);
    expect(withoutFrame?.data).not.toHaveProperty('device_id');

    abort();
  });

  it('#900: active_space.changed carries an optional device_id unchanged when set, absent otherwise', async () => {
    const account = await addAccountSafe();
    const { chunks, abort } = await openEvents(await tokenFor(account));

    const withDevice: AccountEvent = {
      type: 'active_space.changed', space_id: SPACE_ID, name: 'Kitchen', surface: 'device', changed_at: NOW, device_id: DEVICE_ID,
    };
    getAccountEvents().publish(account.userId, withDevice);
    const withFrame = await nextEvent(chunks);
    expect(withFrame?.event).toBe('active_space.changed');
    expect(withFrame?.data).toEqual(withDevice);

    const withoutDevice: AccountEvent = {
      type: 'active_space.changed', space_id: null, name: null, surface: 'web', changed_at: NOW,
    };
    getAccountEvents().publish(account.userId, withoutDevice);
    const withoutFrame = await nextEvent(chunks);
    expect(withoutFrame?.event).toBe('active_space.changed');
    expect(withoutFrame?.data).toEqual(withoutDevice);
    expect(withoutFrame?.data).not.toHaveProperty('device_id');

    abort();
  });

  it('two-account isolation: account B events never reach account A\'s stream', async () => {
    const accountA = await addAccountSafe();
    const accountB = await addAccountSafe();
    const { chunks: chunksA, abort: abortA } = await openEvents(await tokenFor(accountA));
    const { chunks: chunksB, abort: abortB } = await openEvents(await tokenFor(accountB));

    getAccountEvents().publish(accountB.userId, {
      type: 'message.appended',
      conversation_id: CONV_ID,
      message_id: MSG_ID,
      updated_at: NOW,
    });
    // B receives it.
    const bFrame = await nextEvent(chunksB);
    expect(bFrame?.event).toBe('message.appended');
    // A receives nothing within the window.
    expect(await nextEvent(chunksA, 400)).toBeNull();
    abortA();
    abortB();
  });

  it('E-10: the stream closes when the token exp passes, with no error frame', async () => {
    const account = await addAccountSafe();
    // A token that is valid now but expires ~2 s out.
    const token = await signToken({ userId: account.userId, sessionId: account.sessionId, expiresInSeconds: 2 });
    const { chunks, abort } = await openEvents(token);

    const result = await Promise.race([
      (async (): Promise<string> => {
        for await (const chunk of chunks) {
          if (chunk.kind === 'event') throw new Error(`unexpected event frame: ${chunk.event.event}`);
        }
        return 'closed';
      })(),
      delay(10_000).then(() => 'timeout'),
    ]);
    expect(result).toBe('closed');
    abort();
  });

  it('E-14: reconnect delivers only events after the reconnect (no replay)', async () => {
    const account = await addAccountSafe();
    const token = await tokenFor(account);

    const first = await openEvents(token);
    getAccountEvents().publish(account.userId, {
      type: 'message.appended',
      conversation_id: CONV_ID,
      message_id: MSG_ID,
      updated_at: NOW,
    });
    const firstFrame = await nextEvent(first.chunks);
    expect(firstFrame?.event).toBe('message.appended');
    first.abort();

    const second = await openEvents(token);
    getAccountEvents().publish(account.userId, {
      type: 'conversation.updated',
      conversation_id: CONV_ID,
      updated_at: NOW,
    });
    const secondFrame = await nextEvent(second.chunks);
    expect(secondFrame).not.toBeNull();
    expect(secondFrame!.event).toBe('conversation.updated');
    // The earlier message.appended is not re-delivered.
    expect(await nextEvent(second.chunks, 300)).toBeNull();
    second.abort();
  });

  it('E-15: framing — event:/id:/data: lines parse and each data validates against its schema', async () => {
    const account = await addAccountSafe();
    const { chunks, abort } = await openEvents(await tokenFor(account));
    const payloads: AccountEvent[] = [
      { type: 'message.appended', conversation_id: CONV_ID, message_id: MSG_ID, updated_at: NOW },
      { type: 'conversation.updated', conversation_id: CONV_ID, updated_at: NOW },
      { type: 'conversation.deleted', conversation_id: CONV_ID, updated_at: NOW },
      { type: 'active.changed', conversation_id: CONV_ID, title: 'framed', surface: 'picker', changed_at: NOW },
      { type: 'device.changed', device_id: DEVICE_ID },
    ];
    for (const payload of payloads) getAccountEvents().publish(account.userId, payload);

    for (let index = 0; index < payloads.length; index += 1) {
      const frame = await nextEvent(chunks);
      expect(frame).not.toBeNull();
      expect(frame!.event).toBe(payloads[index]!.type);
      expect(frame!.id).toBe(String(index + 1));
      expect(AccountEventSchema.safeParse(frame!.data).success).toBe(true);
      expect(frame!.data).toEqual(payloads[index]);
    }
    abort();
  });

  it('E-16: a full run\'s journal carries no title, transcript, or email from any event payload', async () => {
    const account = await addAccountSafe();
    const token = await tokenFor(account);
    const secretTitle = 'journal-secret-title-xyz';
    const { chunks, abort } = await openEvents(token);

    const conversation = await createConversation(db, account.userId, secretTitle);
    const activate = await fetch(`${baseUrl}/api/conversations/${conversation.id}/activate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(activate.status).toBe(200);
    const activeFrame = await nextEvent(chunks);
    expect(activeFrame?.event).toBe('active.changed');

    const remove = await fetch(`${baseUrl}/api/conversations/${conversation.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(remove.status).toBe(204);
    await nextEvent(chunks); // conversation.deleted
    await nextEvent(chunks); // active.changed null form

    abort();
    const logged = journalLines.map((line) => JSON.parse(line) as { event: string; [key: string]: unknown });
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(secretTitle);
    expect(JSON.stringify(logged)).not.toContain('transcript');
    expect(JSON.stringify(logged)).not.toContain('@');
    expect(JSON.stringify(logged)).not.toContain('eyJ');
  });
});