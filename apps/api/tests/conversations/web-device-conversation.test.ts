// PUT /api/devices/active-conversation (#492, docs/design/device-conversation.md):
// "Use on Cardputer" and "New conversation on Cardputer" move the account's
// conversation and space pointers together, scoped to the caller. A paired but
// offline Cardputer gets them pending (202) and in its next welcome (#668 U2);
// no paired Cardputer is a 409. Real HTTP over Postgres, the real
// device-session registry with a fake socket that records what it is pushed.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocket } from 'ws';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pairing from '../../src/devices/pairing-service.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { getActive } from '../../src/conversations/active.ts';
import { getActiveSpace } from '../../src/spaces/active.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { archiveThread, createThread } from '../../src/conversations/thread-store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createDevicesRouter } from '../../src/devices/http.ts';
import { getActiveRoute } from '../../src/conversations/http.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const PATH = '/api/devices/active-conversation';

describe('PUT /api/devices/active-conversation (#492)', () => {
  let pg: TestDb;
  let db: Db;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    setSharedDb(Promise.resolve(db));
    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.get('/api/active', getActiveRoute(appDeps));
    app.use('/api/devices', createDevicesRouter({
      getDb: () => Promise.resolve(db),
      requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
      events: getAccountEvents(),
      deviceSessions: getDeviceSessions(),
    }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    getDeviceSessions().clear();
    server.close();
    await closeTestDb(pg);
  });

  /** A fresh account, its token, and (unless `paired` is false) a paired
   *  Cardputer, registered as connected unless `connected` is false, whose
   *  pushes land in `pushed`. */
  async function account(connected = true, paired = true): Promise<{
    userId: string; token: string; deviceId: string; pushed: Array<{ type: string; payload: unknown }>;
  }> {
    const created = await addAccount(pg);
    const token = await signToken({ userId: created.userId, sessionId: created.sessionId });
    const pushed: Array<{ type: string; payload: unknown }> = [];
    if (!paired) return { userId: created.userId, token, deviceId: '', pushed };
    const issued = await pairing.issueCode(db, {
      model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.9',
    });
    const deviceId = await pairing.approve(db, created.userId, issued.pairingId, 'Desk');
    if (connected) {
      const socket = { readyState: 1, close: (): void => {}, send: (raw: string): void => { pushed.push(JSON.parse(raw)); } };
      getDeviceSessions().register(socket as unknown as WebSocket, { id: `sess-${deviceId}`, stage: 'ready' }, created.userId, deviceId);
    }
    return { userId: created.userId, token, deviceId, pushed };
  }

  /** Pairs and (unless `connected` is false) registers a SECOND device on an
   *  existing account, so device-scoped tests (#900) can tell one Cardputer's
   *  push and pointer apart from another's. */
  async function secondDevice(userId: string, connected = true): Promise<{
    deviceId: string; pushed: Array<{ type: string; payload: unknown }>;
  }> {
    const issued = await pairing.issueCode(db, {
      model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.10',
    });
    const deviceId = await pairing.approve(db, userId, issued.pairingId, 'Garage');
    const pushed: Array<{ type: string; payload: unknown }> = [];
    if (connected) {
      const socket = { readyState: 1, close: (): void => {}, send: (raw: string): void => { pushed.push(JSON.parse(raw)); } };
      getDeviceSessions().register(socket as unknown as WebSocket, { id: `sess-${deviceId}`, stage: 'ready' }, userId, deviceId);
    }
    return { deviceId, pushed };
  }

  /** The device reconnects: a real hello on a fresh session; returns its welcome payload. */
  async function reconnect(userId: string, deviceId: string): Promise<Record<string, unknown>> {
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const session = createSession({ kind: 'device', userId, deviceId, name: 'Desk' });
    const hello = { v: V2_VERSION, type: 'hello', id: 'test_ctrl_000001', payload: { format_id: 1 } } as unknown as ClientControlDto;
    await handleControl(appDeps, socket as unknown as WebSocket, session, hello, vi.fn());
    const sent = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as { type: string; payload: Record<string, unknown> });
    getDeviceSessions().unregister(session);
    return sent.find((dto) => dto.type === 'welcome')!.payload;
  }

  async function put(token: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${PATH}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function collect(userId: string): { events: AccountEvent[]; stop: () => void } {
    const events: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(userId, (event) => events.push(event));
    return { events, stop };
  }

  it('Use on Cardputer: points at the conversation in the main space, publishes and pushes both', async () => {
    const me = await account();
    const conversation = await createConversation(db, me.userId, 'Groceries');
    const { events, stop } = collect(me.userId);
    const res = await put(me.token, { conversation_id: conversation.id, space_id: null });
    stop();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active_conversation: { id: conversation.id, title: 'Groceries' }, active_space: null });
    expect((await getActive(db, me.userId))?.conversationId).toBe(conversation.id);
    expect(events.map((event) => event.type)).toEqual(['active_space.changed', 'active.changed']);
    expect(events[1]).toMatchObject({ conversation_id: conversation.id, title: 'Groceries', surface: 'activate' });
    expect(me.pushed.map((dto) => dto.type)).toEqual(['active_space', 'active_conversation']);
    expect(me.pushed[1]!.payload).toEqual({ id: conversation.id, title: 'Groceries' });
  });

  it('New conversation on Cardputer in a space: clears the conversation and sets the space', async () => {
    const me = await account();
    const conversation = await createConversation(db, me.userId, 'Old');
    await put(me.token, { conversation_id: conversation.id, space_id: null });
    const space = await createSpace(db, me.userId, { kind: 'group', name: 'Garden' });
    const res = await put(me.token, { conversation_id: null, space_id: space.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active_conversation: null, active_space: { id: space.id, name: 'Garden' } });
    expect((await getActive(db, me.userId))?.conversationId).toBeNull();
    expect((await getActiveSpace(db, me.userId))?.spaceId).toBe(space.id);
    expect(me.pushed.at(-1)).toMatchObject({ type: 'active_conversation', payload: { id: null, title: null } });
  });

  it("answers 404 for another account's conversation or space, and writes nothing", async () => {
    const me = await account();
    const other = await account(false);
    const theirs = await createConversation(db, other.userId, 'Private');
    const theirSpace = await createSpace(db, other.userId, { kind: 'group', name: 'Theirs' });
    const byConversation = await put(me.token, { conversation_id: theirs.id, space_id: null });
    expect(byConversation.status).toBe(404);
    expect(await byConversation.json()).toEqual({ error: { code: 'not_found' } });
    const bySpace = await put(me.token, { conversation_id: null, space_id: theirSpace.id });
    expect(bySpace.status).toBe(404);
    expect(await getActive(db, me.userId)).toBeNull();
    expect(await getActive(db, other.userId)).toBeNull();
    expect(me.pushed).toEqual([]);
  });

  it('offline Cardputer: stores the pointer, answers 202 pending, and the next welcome carries it', async () => {
    const me = await account(false);
    const conversation = await createConversation(db, me.userId, 'Offline');
    const { events, stop } = collect(me.userId);
    const res = await put(me.token, { conversation_id: conversation.id, space_id: null });
    stop();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'pending' });
    expect((await getActive(db, me.userId))?.conversationId).toBe(conversation.id);
    expect(events.map((event) => event.type)).toEqual(['active_space.changed', 'active.changed']);
    const welcome = await reconnect(me.userId, me.deviceId);
    expect(welcome.active_conversation).toEqual({ id: conversation.id, title: 'Offline' });
  });

  it('answers 409 no_device when the account has no paired Cardputer, and writes nothing', async () => {
    const me = await account(false, false);
    const conversation = await createConversation(db, me.userId, 'Nowhere');
    const res = await put(me.token, { conversation_id: conversation.id, space_id: null });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'no_device' } });
    expect(await getActive(db, me.userId)).toBeNull();
  });

  it('accepts an optional device_id (#900), 2xx exactly like a body without it', async () => {
    const me = await account();
    const withoutId = await createConversation(db, me.userId, 'No device id');
    const withId = await createConversation(db, me.userId, 'With device id');
    const base = await put(me.token, { conversation_id: withoutId.id, space_id: null });
    expect(base.status).toBe(200);
    const res = await put(me.token, { conversation_id: withId.id, space_id: null, device_id: me.deviceId });
    expect(res.status).toBe(base.status);
    expect(await res.json()).toEqual({ active_conversation: { id: withId.id, title: 'With device id' }, active_space: null });
  });

  it('#900: a device_id PUT moves only that device, leaving another device\'s own pointer untouched', async () => {
    const me = await account();
    const other = await secondDevice(me.userId);
    const forOther = await createConversation(db, me.userId, 'For the garage');
    const otherPut = await put(me.token, { conversation_id: forOther.id, space_id: null, device_id: other.deviceId });
    expect(otherPut.status).toBe(200);
    expect(other.pushed.at(-1)).toMatchObject({ type: 'active_conversation', payload: { id: forOther.id, title: 'For the garage' } });
    me.pushed.length = 0;
    other.pushed.length = 0;

    const forMine = await createConversation(db, me.userId, 'For the desk');
    const res = await put(me.token, { conversation_id: forMine.id, space_id: null, device_id: me.deviceId });
    expect(res.status).toBe(200);
    // Only the Desk device's socket saw this push; the Garage device's did not.
    expect(me.pushed.at(-1)).toMatchObject({ type: 'active_conversation', payload: { id: forMine.id, title: 'For the desk' } });
    expect(other.pushed).toEqual([]);

    const devices = (await (await fetch(`${baseUrl}/api/devices`, {
      headers: { authorization: `Bearer ${me.token}` },
    })).json()) as { devices: Array<{ id: string; active_conversation_id: string | null }> };
    expect(devices.devices.find((d) => d.id === me.deviceId)?.active_conversation_id).toBe(forMine.id);
    expect(devices.devices.find((d) => d.id === other.deviceId)?.active_conversation_id).toBe(forOther.id);
  });

  it('#900: a PUT without device_id clears every device\'s own pointer', async () => {
    const me = await account();
    const other = await secondDevice(me.userId);
    await put(me.token, { conversation_id: (await createConversation(db, me.userId, 'Desk one')).id, space_id: null, device_id: me.deviceId });
    await put(me.token, { conversation_id: (await createConversation(db, me.userId, 'Garage one')).id, space_id: null, device_id: other.deviceId });

    const shared = await createConversation(db, me.userId, 'Everyone');
    const res = await put(me.token, { conversation_id: shared.id, space_id: null });
    expect(res.status).toBe(200);

    const devices = (await (await fetch(`${baseUrl}/api/devices`, {
      headers: { authorization: `Bearer ${me.token}` },
    })).json()) as {
      devices: Array<{ id: string; active_conversation_id: string | null }>;
      active_conversation: { id: string; title: string } | null;
    };
    expect(devices.active_conversation).toEqual({ id: shared.id, title: 'Everyone' });
    for (const row of devices.devices) expect(row.active_conversation_id).toBe(shared.id);
  });

  it('#900 MD-FIX: a device_id PUT never moves the account pointer, and leaves another device untouched', async () => {
    const me = await account();
    const other = await secondDevice(me.userId);
    const accountConv = await createConversation(db, me.userId, 'Account pointer');
    await put(me.token, { conversation_id: accountConv.id, space_id: null });
    const accountBefore = await getActive(db, me.userId);

    const forOther = await createConversation(db, me.userId, 'For the garage');
    const res = await put(me.token, { conversation_id: forOther.id, space_id: null, device_id: other.deviceId });
    expect(res.status).toBe(200);

    expect(await getActive(db, me.userId)).toEqual(accountBefore);
    expect((await getActive(db, me.userId, { deviceId: me.deviceId }))?.conversationId).toBe(accountConv.id);
    expect((await getActive(db, me.userId, { deviceId: other.deviceId }))?.conversationId).toBe(forOther.id);
  });

  it('#900 MD-FIX: a PUT without device_id notifies every connected device of both pointer kinds', async () => {
    const me = await account();
    const other = await secondDevice(me.userId);
    const space = await createSpace(db, me.userId, { kind: 'group', name: 'Office' });
    await put(me.token, { conversation_id: (await createConversation(db, me.userId, 'Desk one')).id, space_id: space.id, device_id: me.deviceId });
    await put(me.token, { conversation_id: (await createConversation(db, me.userId, 'Garage one')).id, space_id: null, device_id: other.deviceId });
    me.pushed.length = 0;
    other.pushed.length = 0;

    const shared = await createConversation(db, me.userId, 'Everyone');
    const res = await put(me.token, { conversation_id: shared.id, space_id: null });
    expect(res.status).toBe(200);

    for (const pushed of [me.pushed, other.pushed]) {
      expect(pushed.map((dto) => dto.type)).toContain('active_conversation');
      expect(pushed.at(-1)).toMatchObject({ type: 'active_conversation', payload: { id: shared.id, title: 'Everyone' } });
    }
    expect((await getActiveSpace(db, me.userId, me.deviceId))?.spaceId).toBeNull();
    expect((await getActive(db, me.userId, { deviceId: other.deviceId }))?.conversationId).toBe(shared.id);
  });

  it("#900: a foreign account's device_id answers 404 and writes nothing", async () => {
    const me = await account();
    const theirs = await account();
    const conversation = await createConversation(db, me.userId, 'Mine');
    const res = await put(me.token, { conversation_id: conversation.id, space_id: null, device_id: theirs.deviceId });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found' } });
    expect(await getActive(db, me.userId)).toBeNull();
    expect(theirs.pushed).toEqual([]);
  });

  it('refuses a malformed body (400) and a missing token (401)', async () => {
    const me = await account();
    expect((await put(me.token, { conversation_id: null })).status).toBe(400);
    expect((await put(me.token, { conversation_id: null, space_id: 'not-a-uuid' })).status).toBe(400);
    expect((await put(me.token, { conversation_id: null, space_id: null, extra: 1 })).status).toBe(400);
    const anonymous = await fetch(`${baseUrl}${PATH}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"conversation_id":null,"space_id":null}',
    });
    expect(anonymous.status).toBe(401);
  });

  describe('a space thread (#565 D8)', () => {
    async function get(token: string, path: string): Promise<Response> {
      return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    }

    async function spaceThread(userId: string, title = 'Planting'): Promise<{ spaceId: string; threadId: string; ref: string }> {
      const space = await createSpace(db, userId, { kind: 'group', name: 'Garden' });
      const thread = await createThread(db, userId, { spaceId: space.id, title });
      return { spaceId: space.id, threadId: thread.id, ref: `thr_${thread.id}` };
    }

    it('points the Cardputer at the thread and its space, publishes both, and GET /api/active returns the ref', async () => {
      const me = await account();
      const { spaceId, threadId, ref } = await spaceThread(me.userId);
      const { events, stop } = collect(me.userId);
      const res = await put(me.token, { conversation_id: null, space_id: spaceId, thread_id: threadId });
      stop();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        active_conversation: { id: ref, title: 'Planting' }, active_space: { id: spaceId, name: 'Garden' },
      });
      expect(events.map((event) => event.type)).toEqual(['active_space.changed', 'active.changed']);
      expect(events[1]).toMatchObject({ conversation_id: ref, title: 'Planting', surface: 'activate' });
      expect(await (await get(me.token, '/api/active')).json()).toMatchObject({
        active: { conversation_id: ref, title: 'Planting', surface: 'activate' },
      });
      const devices = (await (await get(me.token, '/api/devices')).json()) as Record<string, unknown>;
      expect(devices.active_conversation).toEqual({ id: ref, title: 'Planting' });
    });

    it("answers one 404 body for a non-member's thread and an unknown one, and writes nothing", async () => {
      const me = await account();
      const other = await account(false);
      const theirs = await spaceThread(other.userId);
      const byTheirs = await put(me.token, { conversation_id: null, space_id: theirs.spaceId, thread_id: theirs.threadId });
      const byUnknown = await put(me.token, { conversation_id: null, space_id: theirs.spaceId, thread_id: randomUUID() });
      expect(byTheirs.status).toBe(404);
      expect(byUnknown.status).toBe(404);
      expect(await byTheirs.json()).toEqual(await byUnknown.json());
      expect(await getActive(db, me.userId)).toBeNull();
      expect(await getActiveSpace(db, me.userId)).toBeNull();
    });

    it("refuses (400) a space_id other than the thread's, a conversation_id beside it, and writes nothing", async () => {
      const me = await account();
      const { spaceId, threadId } = await spaceThread(me.userId);
      const elsewhere = await createSpace(db, me.userId, { kind: 'group', name: 'Kitchen' });
      const mismatched = await put(me.token, { conversation_id: null, space_id: elsewhere.id, thread_id: threadId });
      expect(mismatched.status).toBe(400);
      expect(await mismatched.json()).toEqual({ error: { code: 'invalid_request' } });
      const conversation = await createConversation(db, me.userId, 'Both');
      expect((await put(me.token, { conversation_id: conversation.id, space_id: spaceId, thread_id: threadId })).status).toBe(400);
      expect((await put(me.token, { conversation_id: null, space_id: null, thread_id: threadId })).status).toBe(400);
      expect(await getActive(db, me.userId)).toBeNull();
      expect(await getActiveSpace(db, me.userId)).toBeNull();
    });

    it('offline Cardputer: a thread is stored pending and the next welcome carries it and its space', async () => {
      const me = await account(false);
      const { spaceId, threadId, ref } = await spaceThread(me.userId);
      const res = await put(me.token, { conversation_id: null, space_id: spaceId, thread_id: threadId });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: 'pending' });
      const welcome = await reconnect(me.userId, me.deviceId);
      expect(welcome.active_conversation).toEqual({ id: ref, title: 'Planting' });
      expect(welcome.active_space).toEqual({ id: spaceId, name: 'Garden' });
    });

    it('answers 409 no_device for a thread when the account has no paired Cardputer, and writes nothing', async () => {
      const me = await account(false, false);
      const { spaceId, threadId } = await spaceThread(me.userId);
      const res = await put(me.token, { conversation_id: null, space_id: spaceId, thread_id: threadId });
      expect(res.status).toBe(409);
      expect(await getActive(db, me.userId)).toBeNull();
    });

    it('moving the active space elsewhere clears the thread pointer and publishes it; the same space keeps it', async () => {
      const me = await account();
      const { spaceId, threadId, ref } = await spaceThread(me.userId);
      await put(me.token, { conversation_id: null, space_id: spaceId, thread_id: threadId });
      const same = collect(me.userId);
      await fetch(`${baseUrl}/api/devices/active-space`, {
        method: 'PUT', headers: { authorization: `Bearer ${me.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ space_id: spaceId }),
      });
      same.stop();
      expect(same.events.map((event) => event.type)).toEqual(['active_space.changed']);
      expect((await getActive(db, me.userId))?.conversationId).toBe(ref);
      const moved = collect(me.userId);
      const res = await fetch(`${baseUrl}/api/devices/active-space`, {
        method: 'PUT', headers: { authorization: `Bearer ${me.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ space_id: null }),
      });
      moved.stop();
      expect(res.status).toBe(200);
      expect(moved.events[1]).toMatchObject({ type: 'active.changed', conversation_id: null, title: null });
      expect(await getActive(db, me.userId)).toMatchObject({ conversationId: null, cleared: false });
    });

    it('GET /api/active and GET /api/devices publish the clear when the thread went stale', async () => {
      for (const path of ['/api/active', '/api/devices']) {
        const me = await account();
        const { spaceId, threadId } = await spaceThread(me.userId);
        await put(me.token, { conversation_id: null, space_id: spaceId, thread_id: threadId });
        await archiveThread(db, me.userId, threadId);
        const { events, stop } = collect(me.userId);
        const res = await get(me.token, path);
        stop();
        expect(res.status).toBe(200);
        expect(events).toEqual([expect.objectContaining({ type: 'active.changed', conversation_id: null, title: null })]);
      }
    });
  });
});
