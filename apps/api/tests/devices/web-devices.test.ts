// Devices API tests (T033, contracts/pairing-and-devices-api.md D-17..D-25,
// D-27 and contracts/account-events.md E-09; D-21's credential-refused half and
// D-26 are the e2e revoke cases in e2e-device-flow.test.ts). A real HTTP server
// over Postgres exercises the JWT guard, requireActiveSession, and the
// /api/devices router; the device-session registry is the real one with a fake
// socket registered for the revoke-close assertions (D-21).
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocket } from 'ws';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pairing from '../../src/devices/pairing-service.ts';
import type { PairingPush, WaitingSocket } from '../../src/devices/pairing-service.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { StoreError, withUser, type Db } from '../../src/platform/db/db.ts';
import { revokeDevice, touchDevice } from '../../src/devices/pairing-store.ts';
import { createConversation, deleteConversation } from '../../src/conversations/store.ts';
import { getActive, setActive } from '../../src/conversations/active.ts';
import { archiveThread, createThread } from '../../src/conversations/thread-store.ts';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createDevicesRouter } from '../../src/devices/http.ts';
import { createWebEventsRouter } from '../../src/account/events-http.ts';
import { addMember, archiveSpace, createSpace } from '../../src/spaces/store.ts';
import { getActiveSpace, setActiveSpace } from '../../src/spaces/active.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { openSse, waitForEvent } from '../support/sse.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
  withAdminAuth,
  withUserRaw,
} from '../support/test-db.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fakeSocket(claim: string): WaitingSocket & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    claim,
    sent,
    send: (push: PairingPush): void => {
      sent.push(push);
    },
    close: (): void => {},
  };
}

/** A fake ws socket the device-session registry can hand to closeDevice. */
function fakeWsSocket(): { readyState: number; close: ReturnType<typeof vi.fn> } {
  return { readyState: 1, close: vi.fn() };
}

describe('devices API (contracts/pairing-and-devices-api.md D-17..D-25, D-27; E-09)', () => {
  let pg: TestDb;
  let db: Db;
  let server: Server;
  let baseUrl: string;
  const journalLines: string[] = [];

  beforeAll(async () => {
    setJournalSink((line: string) => journalLines.push(line));
    pg = await createTestDb();
    db = asDb(pg);
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use(
      '/api/devices',
      createDevicesRouter({
        getDb: () => Promise.resolve(db),
        requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
        events: getAccountEvents(),
        deviceSessions: getDeviceSessions(),
      }),
    );
    app.use('/api/events', createWebEventsRouter({ getDb: () => Promise.resolve(db), events: getAccountEvents() }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    setJournalSink(null);
    getDeviceSessions().clear();
    server.close();
    await closeTestDb(pg);
  });

  async function tokenFor(account: TestAccount): Promise<string> {
    return signToken({ userId: account.userId, sessionId: account.sessionId });
  }

  async function freshAccount(): Promise<{ account: TestAccount; token: string }> {
    const account = await addAccount(pg);
    return { account, token: await tokenFor(account) };
  }

  async function get(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  async function send(method: string, path: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Approves a fresh pairing for the account; returns the device id. */
  async function pairDevice(userId: string, name = 'Kitchen'): Promise<string> {
    const issued = await pairing.issueCode(db, {
      model: 'M5Stack Cardputer',
      fwVersion: '0.9.0',
      claim: `claim-${randomUUID()}`,
      ip: '203.0.113.77',
    });
    return pairing.approve(db, userId, issued.pairingId, name);
  }

  async function listIds(token: string): Promise<{
    devices: Array<{
      id: string;
      name: string;
      model: string;
      paired_at: number;
      last_seen_at: number | null;
      connected: boolean;
    }>;
    active_conversation: { id: string; title: string } | null;
  }> {
    const res = await get('/api/devices', token);
    expect(res.status).toBe(200);
    return (await res.json()) as {
      devices: Array<{
        id: string;
        name: string;
        model: string;
        paired_at: number;
        last_seen_at: number | null;
        connected: boolean;
      }>;
      active_conversation: { id: string; title: string } | null;
    };
  }

  it('D-17: GET lists the account\'s own devices only, paired_at descending', async () => {
    const { account, token } = await freshAccount();
    const other = await freshAccount();
    const aId = await pairDevice(account.userId, 'first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const bId = await pairDevice(account.userId, 'second');
    await pairDevice(other.account.userId, 'theirs');

    const body = await listIds(token);
    expect(body.devices.map((entry) => entry.id)).toEqual([bId, aId]);
    expect(body.devices[0]!.paired_at).toBeGreaterThan(body.devices[1]!.paired_at);
    // The other account's device never appears (FR-008).
    expect(body.devices.some((entry) => entry.name === 'theirs')).toBe(false);
    for (const entry of body.devices) {
      expect(entry.id).toMatch(UUID_RE);
      expect(entry.model).toBe('M5Stack Cardputer');
    }
  });

  it('D-18: GET with no devices answers 200 { devices: [] }, never 404', async () => {
    const { token } = await freshAccount();
    const res = await get('/api/devices', token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ devices: [], active_conversation: null, active_space: null });
  });

  it('D-19: PATCH rename answers 200 { id, name }, trims, and 400 on empty/oversized', async () => {
    const { account, token } = await freshAccount();
    const deviceId = await pairDevice(account.userId, 'Original');

    const renamed = await send('PATCH', `/api/devices/${deviceId}`, token, { name: '  Living Room  ' });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ id: deviceId, name: 'Living Room' });

    const empty = await send('PATCH', `/api/devices/${deviceId}`, token, { name: '   ' });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: { code: 'invalid_request' } });

    const oversized = await send('PATCH', `/api/devices/${deviceId}`, token, { name: 'x'.repeat(41) });
    expect(oversized.status).toBe(400);

    const nonString = await send('PATCH', `/api/devices/${deviceId}`, token, { name: 42 });
    expect(nonString.status).toBe(400);

    const unknown = await send('PATCH', `/api/devices/${randomUUID()}`, token, { name: 'Who' });
    expect(unknown.status).toBe(404);
  });

  it('D-20: PATCH another account\'s device answers 404 identical to unknown; A name unchanged', async () => {
    const { account: a, token: tokenA } = await freshAccount();
    const { token: tokenB } = await freshAccount();
    const aId = await pairDevice(a.userId, 'A name');

    const theirs = await send('PATCH', `/api/devices/${aId}`, tokenB, { name: 'hijacked' });
    const unknown = await send('PATCH', `/api/devices/${randomUUID()}`, tokenB, { name: 'hijacked' });
    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await theirs.text()).toBe(await unknown.text());
    expect((await listIds(tokenA)).devices.find((entry) => entry.id === aId)!.name).toBe('A name');
  });

  it('PATCH on a revoked device answers 404 identical to unknown', async () => {
    const { account, token } = await freshAccount();
    const deviceId = await pairDevice(account.userId, 'Doomed');
    await revokeDevice(db, account.userId, deviceId);

    const revoked = await send('PATCH', `/api/devices/${deviceId}`, token, { name: 'too late' });
    const unknown = await send('PATCH', `/api/devices/${randomUUID()}`, token, { name: 'too late' });
    expect(revoked.status).toBe(404);
    expect(unknown.status).toBe(404);
    const revokedBody = await revoked.text();
    expect(await unknown.text()).toBe(revokedBody);
    expect(revokedBody).toBe('{"error":{"code":"not_found"}}');
  });

  it('D-21: DELETE revokes (row and hash kept), closes the live socket with 4003', async () => {
    const { account, token } = await freshAccount();
    const claim = `claim-${randomUUID()}`;
    const issued = await pairing.issueCode(db, {
      model: 'M5Stack Cardputer',
      fwVersion: '0.9.0',
      claim,
      ip: '203.0.113.78',
    });
    const socket = fakeSocket(claim);
    pairing.registerWaiting(issued.pairingId, socket);
    const deviceId = await pairing.approve(db, account.userId, issued.pairingId, 'Live Card');
    const delivered = socket.sent[0] as Extract<PairingPush, { kind: 'paired' }>;
    expect(delivered.deviceToken.startsWith('olxd_')).toBe(true);

    // The real registry maps this device id to a live socket.
    const registry = getDeviceSessions();
    const live = fakeWsSocket();
    registry.register(live as unknown as WebSocket, { id: `sess-${deviceId}`, stage: 'ready' }, account.userId, deviceId);

    const res = await send('DELETE', `/api/devices/${deviceId}`, token, undefined);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(live.close).toHaveBeenCalledWith(4003, 'revoked');

    // The row and credential hash are kept; revoked_at is set (D-21). Read as
    // the device's own account: devices_select is auth.uid() = user_id, and
    // revocation does not change ownership, so the account still sees it.
    const row = await withUserRaw(pg, account.userId, (tx) =>
      tx.query<{ revoked_at: string | null; token_hash: Uint8Array | null }>(
        'select revoked_at, token_hash from bob.devices where id = $1',
        [deviceId],
      ),
    );
    expect(row.rows[0]!.revoked_at).not.toBeNull();
    expect(row.rows[0]!.token_hash).not.toBeNull();

    // The revoked device no longer lists (D-27's non-revoked filter).
    expect((await listIds(token)).devices).toHaveLength(0);

    registry.unregister({ id: `sess-${deviceId}`, stage: 'ready' });
  });

  it('D-22: DELETE another account\'s device answers 404 identical to unknown', async () => {
    const { account: a, token: tokenA } = await freshAccount();
    const { token: tokenB } = await freshAccount();
    const aId = await pairDevice(a.userId, 'A device');

    const theirs = await send('DELETE', `/api/devices/${aId}`, tokenB, undefined);
    const unknown = await send('DELETE', `/api/devices/${randomUUID()}`, tokenB, undefined);
    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    const theirsBody = await theirs.text();
    expect(await unknown.text()).toBe(theirsBody);
    expect(theirsBody).toBe('{"error":{"code":"not_found"}}');
    // A's device still lists and is not revoked.
    expect((await listIds(tokenA)).devices.map((entry) => entry.id)).toContain(aId);
  });

  it('D-23: DELETE of an already-revoked or unknown device answers 404', async () => {
    const { account, token } = await freshAccount();
    const deviceId = await pairDevice(account.userId, 'Doomed');
    await revokeDevice(db, account.userId, deviceId);

    const again = await send('DELETE', `/api/devices/${deviceId}`, token, undefined);
    expect(again.status).toBe(404);
    const unknown = await send('DELETE', `/api/devices/${randomUUID()}`, token, undefined);
    expect(unknown.status).toBe(404);
    expect(await again.text()).toBe(await unknown.text());
  });

  it('D-24: DELETE with an inactive session answers 401 invalid_token (requireActiveSession)', async () => {
    const account = await addAccount(pg);
    const token = await tokenFor(account);
    const deviceId = await pairDevice(account.userId, 'Ghost');
    await withAdminAuth(pg, (admin) => admin.endSession(account.sessionId));

    const res = await send('DELETE', `/api/devices/${deviceId}`, token, undefined);
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'invalid_token' },
    });
  });

  it('DELETE on a store error answers 500 store_error and never closes, publishes, or journals a revoke', async () => {
    const account = await addAccount(pg);
    const token = await tokenFor(account);
    const closeDevice = vi.fn();
    const publish = vi.fn();
    const boom = new StoreError('store down');
    const stubDb = {
      query: async (): Promise<never> => {
        throw boom;
      },
      tx: async <T>(): Promise<T> => {
        throw boom;
      },
    } as unknown as Db;

    const stubApp = express();
    stubApp.use(express.json());
    stubApp.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    stubApp.use(
      '/api/devices',
      createDevicesRouter({
        getDb: () => Promise.resolve(stubDb),
        requireActiveSession: async (_request, _response, next) => {
          next();
        },
        events: { publish },
        deviceSessions: {
          announceToDevice: () => 'no_device' as const, closeDevice, forDevice: () => undefined, sendDeviceControl: () => 0,
        },
      }),
    );
    const stubServer = await new Promise<Server>((resolve) => {
      const s = stubApp.listen(0, () => resolve(s));
    });
    const stubBase = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`;
    try {
      const start = journalLines.length;
      const res = await fetch(`${stubBase}/api/devices/${randomUUID()}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: 'store_error' } });
      // The handler must return on the error: a device that was never revoked
      // is neither closed, reported, nor journalled, and no 204 follows the 500.
      expect(closeDevice).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      const revokedLines = journalLines
        .slice(start)
        .map((line) => (JSON.parse(line) as { event: string }).event);
      expect(revokedLines).not.toContain('v2.device_revoked');
    } finally {
      await new Promise<void>((resolve) => stubServer.close(() => resolve()));
    }
  });

  it('D-25: the pair/devices journal carries no code, token, or email (SC-008, R15)', async () => {
    const { account, token } = await freshAccount();
    const start = journalLines.length;
    const secretName = 'journal-secret-device-xyz';
    const deviceId = await pairDevice(account.userId, secretName);
    await send('PATCH', `/api/devices/${deviceId}`, token, { name: 'Renamed' });
    await send('DELETE', `/api/devices/${deviceId}`, token, undefined);

    const logged = journalLines.slice(start);
    expect(logged.length).toBeGreaterThan(0);
    const joined = logged.join('\n');
    expect(joined).not.toContain('olxd_');
    expect(joined).not.toContain('@');
    expect(joined).not.toContain('eyJ');
    expect(joined).not.toContain(secretName);
    expect(joined).not.toContain(account.userId);
    const events = logged.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toContain('v2.device_revoked');
  });

  it('D-27: GET lists non-revoked only; an approved device that never connected shows last_seen_at null', async () => {
    const { account, token } = await freshAccount();
    const seenId = await pairDevice(account.userId, 'Seen');
    await touchDevice(db, seenId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const unseenId = await pairDevice(account.userId, 'Unseen');
    const revokedId = await pairDevice(account.userId, 'Revoked');
    await revokeDevice(db, account.userId, revokedId);

    const body = await listIds(token);
    const ids = body.devices.map((entry) => entry.id);
    expect(ids).toContain(seenId);
    expect(ids).toContain(unseenId);
    expect(ids).not.toContain(revokedId);
    const unseen = body.devices.find((entry) => entry.id === unseenId)!;
    const seen = body.devices.find((entry) => entry.id === seenId)!;
    expect(unseen.last_seen_at).toBeNull();
    expect(seen.last_seen_at).toBeTypeOf('number');
  });

  it('E-09: rename and revoke publish device.changed with the uuid device_id', async () => {
    const { account, token } = await freshAccount();
    const deviceId = await pairDevice(account.userId, 'Event card');
    const received: AccountEvent[] = [];
    const unsubscribe = getAccountEvents().subscribe(account.userId, (event) => {
      received.push(event);
    });

    const rename = await send('PATCH', `/api/devices/${deviceId}`, token, { name: 'Event card 2' });
    expect(rename.status).toBe(200);
    const revoke = await send('DELETE', `/api/devices/${deviceId}`, token, undefined);
    expect(revoke.status).toBe(204);

    unsubscribe();
    const changed = received.filter((event) => event.type === 'device.changed');
    expect(changed).toEqual([
      { type: 'device.changed', device_id: deviceId },
      { type: 'device.changed', device_id: deviceId },
    ]);
    expect(changed.every((event) => UUID_RE.test(event.device_id))).toBe(true);
  });

  it('D-28: connected reflects a live registration and clears on unregister', async () => {
    const { account, token } = await freshAccount();
    const deviceId = await pairDevice(account.userId, 'Watched');

    const before = await listIds(token);
    expect(before.devices.find((entry) => entry.id === deviceId)!.connected).toBe(false);

    const registry = getDeviceSessions();
    const fakeWs = fakeWsSocket();
    const session = { id: `sess-${deviceId}`, stage: 'ready' as const };
    registry.register(fakeWs as unknown as WebSocket, session, account.userId, deviceId);

    const during = await listIds(token);
    expect(during.devices.find((entry) => entry.id === deviceId)!.connected).toBe(true);

    registry.unregister(session);

    const after = await listIds(token);
    expect(after.devices.find((entry) => entry.id === deviceId)!.connected).toBe(false);
  });

  it('D-29: active_conversation follows the account pointer and clears when it is deleted', async () => {
    const { account, token } = await freshAccount();
    const { token: otherToken } = await freshAccount();

    expect((await listIds(token)).active_conversation).toBeNull();

    const conversation = await createConversation(db, account.userId, 'Follow me');
    await withUser(db, account.userId, (tx) => setActive(tx, account.userId, conversation.id, 'activate'));

    const active = await listIds(token);
    expect(active.active_conversation).toEqual({ id: conversation.id, title: 'Follow me' });
    // A second account's pointer is untouched by the first's activate.
    expect((await listIds(otherToken)).active_conversation).toBeNull();

    await deleteConversation(db, account.userId, conversation.id);
    expect((await listIds(token)).active_conversation).toBeNull();
  });

  describe('active Space (#301)', () => {
    async function activeSpaceOf(token: string): Promise<unknown> {
      const res = await get('/api/devices', token);
      expect(res.status).toBe(200);
      return ((await res.json()) as { active_space: unknown }).active_space;
    }

    function collect(userId: string): { events: AccountEvent[]; stop: () => void } {
      const events: AccountEvent[] = [];
      const stop = getAccountEvents().subscribe(userId, (event) => events.push(event));
      return { events, stop };
    }

    it('GET includes active_space, and a stale one reads null and publishes the clear', async () => {
      const { account, token } = await freshAccount();
      expect(await activeSpaceOf(token)).toBeNull();
      const space = await createSpace(db, account.userId, { kind: 'group', name: 'Garden' });
      await withUser(db, account.userId, (tx) => setActiveSpace(tx, account.userId, space.id, 'device'));
      expect(await activeSpaceOf(token)).toEqual({ id: space.id, name: 'Garden' });

      await archiveSpace(db, account.userId, space.id);
      const { events, stop } = collect(account.userId);
      expect(await activeSpaceOf(token)).toBeNull();
      stop();
      expect(events).toEqual([
        expect.objectContaining({ type: 'active_space.changed', space_id: null, name: null, surface: 'web' }),
      ]);
    });

    it('PUT selects a Space: 200 with the acknowledged pointer, publishes, and GET follows', async () => {
      const { account, token } = await freshAccount();
      const space = await createSpace(db, account.userId, { kind: 'group', name: 'Workshop' });
      const { events, stop } = collect(account.userId);
      const res = await send('PUT', '/api/devices/active-space', token, { space_id: space.id });
      stop();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ active_space: { id: space.id, name: 'Workshop' } });
      expect(events).toEqual([
        {
          type: 'active_space.changed',
          space_id: space.id,
          name: 'Workshop',
          surface: 'web',
          changed_at: expect.any(Number) as number,
        },
      ]);
      expect(await activeSpaceOf(token)).toEqual({ id: space.id, name: 'Workshop' });
    });

    it('PUT a foreign or archived Space answers the unknown 404 body and leaves the pointer', async () => {
      const { account, token } = await freshAccount();
      const other = await freshAccount();
      const mine = await createSpace(db, account.userId, { kind: 'group', name: 'Mine' });
      const theirs = await createSpace(db, other.account.userId, { kind: 'group', name: 'Theirs' });
      const archived = await createSpace(db, account.userId, { kind: 'group', name: 'Old' });
      await archiveSpace(db, account.userId, archived.id);
      await send('PUT', '/api/devices/active-space', token, { space_id: mine.id });

      const { events, stop } = collect(account.userId);
      const foreign = await send('PUT', '/api/devices/active-space', token, { space_id: theirs.id });
      const unknown = await send('PUT', '/api/devices/active-space', token, { space_id: randomUUID() });
      const old = await send('PUT', '/api/devices/active-space', token, { space_id: archived.id });
      stop();
      expect([foreign.status, unknown.status, old.status]).toEqual([404, 404, 404]);
      const body = await unknown.text();
      expect(body).toBe('{"error":{"code":"not_found"}}');
      expect(await foreign.text()).toBe(body);
      expect(await old.text()).toBe(body);
      expect(events).toEqual([]);
      expect(await activeSpaceOf(token)).toEqual({ id: mine.id, name: 'Mine' });
    });

    it('PUT null clears the pointer and publishes the null state; a bad body is 400', async () => {
      const { account, token } = await freshAccount();
      const space = await createSpace(db, account.userId, { kind: 'group', name: 'Clear me' });
      await send('PUT', '/api/devices/active-space', token, { space_id: space.id });
      const { events, stop } = collect(account.userId);
      const res = await send('PUT', '/api/devices/active-space', token, { space_id: null });
      stop();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ active_space: null });
      expect(events).toEqual([expect.objectContaining({ type: 'active_space.changed', space_id: null, name: null })]);
      expect((await getActiveSpace(db, account.userId))?.spaceId).toBeNull();

      for (const bad of [{}, { space_id: 'not-a-uuid' }, { space_id: space.id, name: 'x' }]) {
        expect((await send('PUT', '/api/devices/active-space', token, bad)).status).toBe(400);
      }
    });

    it('the account SSE stream carries active_space.changed', async () => {
      const { account, token } = await freshAccount();
      const space = await createSpace(db, account.userId, { kind: 'group', name: 'Streamed' });
      const { response, events, abort } = await openSse(baseUrl, token);
      expect(response.status).toBe(200);
      await send('PUT', '/api/devices/active-space', token, { space_id: space.id });
      const frame = await waitForEvent(events, 'active_space.changed');
      abort();
      expect(frame).not.toBeNull();
      expect(frame!.data).toMatchObject({ space_id: space.id, name: 'Streamed' });
    });

    it('a member is listed for the selection: PUT accepts a Space the caller joined', async () => {
      const owner = await freshAccount();
      const { account, token } = await freshAccount();
      const space = await createSpace(db, owner.account.userId, { kind: 'group', name: 'Shared' });
      await addMember(db, owner.account.userId, space.id, account.userId, 'member');
      const res = await send('PUT', '/api/devices/active-space', token, { space_id: space.id });
      expect(res.status).toBe(200);
    });

    /** GET /api/devices rows, typed for the #900 per-device pointer fields. */
    async function deviceRows(token: string): Promise<Array<{ id: string; active_space_id: string | null }>> {
      const body = (await (await get('/api/devices', token)).json()) as {
        devices: Array<{ id: string; active_space_id: string | null }>;
      };
      return body.devices;
    }

    it('#900: PUT with device_id moves only that device\'s own pointer; GET reflects each one', async () => {
      const { account, token } = await freshAccount();
      const aId = await pairDevice(account.userId, 'Desk');
      const bId = await pairDevice(account.userId, 'Garage');
      const registry = getDeviceSessions();
      const socketA = { readyState: 1, send: vi.fn(), close: vi.fn() };
      const socketB = { readyState: 1, send: vi.fn(), close: vi.fn() };
      registry.register(socketA as unknown as WebSocket, { id: `sess-${aId}`, stage: 'ready' }, account.userId, aId);
      registry.register(socketB as unknown as WebSocket, { id: `sess-${bId}`, stage: 'ready' }, account.userId, bId);
      const spaceX = await createSpace(db, account.userId, { kind: 'group', name: 'Space X' });
      const spaceY = await createSpace(db, account.userId, { kind: 'group', name: 'Space Y' });

      expect((await send('PUT', '/api/devices/active-space', token, { space_id: spaceX.id, device_id: aId })).status).toBe(200);
      expect((await send('PUT', '/api/devices/active-space', token, { space_id: spaceY.id, device_id: bId })).status).toBe(200);
      // B's write never moved A's own pointer; #900 MD-FIX: a device_id PUT no
      // longer moves the account pointer either -- only that device's own.
      let rows = await deviceRows(token);
      expect(rows.find((row) => row.id === aId)?.active_space_id).toBe(spaceX.id);
      expect(rows.find((row) => row.id === bId)?.active_space_id).toBe(spaceY.id);

      expect((await send('PUT', '/api/devices/active-space', token, { space_id: null })).status).toBe(200);
      rows = await deviceRows(token);
      for (const row of rows) expect(row.active_space_id).toBeNull();

      registry.unregister({ id: `sess-${aId}`, stage: 'ready' });
      registry.unregister({ id: `sess-${bId}`, stage: 'ready' });
    });

    it('#900 MD-FIX (nit 2): PUT active-space without device_id also clears a device\'s own conversation pointer', async () => {
      const { account, token } = await freshAccount();
      const deviceId = await pairDevice(account.userId, 'Desk');
      const conversation = await createConversation(db, account.userId, 'Desk convo');
      // moveAccount false: ONLY the device's own pointer names this
      // conversation, so the account pointer (null) and the device's own
      // (set) stay distinguishable through the fallback in getActive.
      await withUser(db, account.userId, (tx) => setActive(tx, account.userId, conversation.id, 'device', { deviceId, moveAccount: false }));
      expect((await getActive(db, account.userId, { deviceId }))?.conversationId).toBe(conversation.id);
      expect(await getActive(db, account.userId)).toBeNull();

      const space = await createSpace(db, account.userId, { kind: 'group', name: 'Shared' });
      expect((await send('PUT', '/api/devices/active-space', token, { space_id: space.id })).status).toBe(200);

      // The device's own pointer is gone; it now falls back to the (still
      // absent) account pointer rather than reporting its old conversation.
      expect(await getActive(db, account.userId, { deviceId })).toBeNull();
    });

    it('#900: PUT active-space with a foreign device_id answers 404 and writes nothing', async () => {
      const { account, token } = await freshAccount();
      const other = await freshAccount();
      const theirDeviceId = await pairDevice(other.account.userId, 'Theirs');
      const space = await createSpace(db, account.userId, { kind: 'group', name: 'Mine' });
      const res = await send('PUT', '/api/devices/active-space', token, { space_id: space.id, device_id: theirDeviceId });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'not_found' } });
      expect(await getActiveSpace(db, account.userId)).toBeNull();
    });

    it("MD-NOTIFY: PUT with device_id that clears that device's stale pointer notifies only that device", async () => {
      const { account, token } = await freshAccount();
      const dId = await pairDevice(account.userId, 'Desk');
      const eId = await pairDevice(account.userId, 'Garage');
      const registry = getDeviceSessions();
      const sessionD = { id: `sess-${dId}`, stage: 'ready' as const };
      const sessionE = { id: `sess-${eId}`, stage: 'ready' as const };
      try {
        const socketD = { readyState: 1, send: vi.fn(), close: vi.fn() };
        const socketE = { readyState: 1, send: vi.fn(), close: vi.fn() };
        registry.register(socketD as unknown as WebSocket, sessionD, account.userId, dId);
        registry.register(socketE as unknown as WebSocket, sessionE, account.userId, eId);

        const spaceOld = await createSpace(db, account.userId, { kind: 'group', name: 'Old' });
        const spaceNew = await createSpace(db, account.userId, { kind: 'group', name: 'New' });
        const thread = await createThread(db, account.userId, { spaceId: spaceOld.id, title: 'Stale thread' });
        // D's own pointer names the thread; archiving it makes D's OWN pointer
        // stale (the account's pointer is never touched by either step).
        await withUser(db, account.userId, (tx) => setActive(tx, account.userId, threadRef(thread.id), 'device', { deviceId: dId, moveAccount: false }));
        await archiveThread(db, account.userId, thread.id);

        const res = await send('PUT', '/api/devices/active-space', token, { space_id: spaceNew.id, device_id: dId });
        expect(res.status).toBe(200);
        await registry.flushDeliveries();

        expect(socketE.send).not.toHaveBeenCalled();
        // D also hears its own active_space move (pre-existing #900 behavior);
        // the point under test is the active_conversation clear alongside it.
        const pushedToD = socketD.send.mock.calls.map((call) => JSON.parse(String(call[0])) as { type: string; payload: unknown });
        expect(pushedToD).toContainEqual(expect.objectContaining({ type: 'active_conversation', payload: { id: null, title: null } }));
      } finally {
        registry.unregister(sessionD);
        registry.unregister(sessionE);
      }
    });

    it('MD-NOTIFY: a device space switch with no own conversation pointer stops following the account thread from the other space', async () => {
      const { account, token } = await freshAccount();
      const deviceId = await pairDevice(account.userId, 'Desk');
      const spaceOld = await createSpace(db, account.userId, { kind: 'group', name: 'Old' });
      const spaceNew = await createSpace(db, account.userId, { kind: 'group', name: 'New' });
      const thread = await createThread(db, account.userId, { spaceId: spaceOld.id, title: 'Old thread' });
      await withUser(db, account.userId, (tx) => setActive(tx, account.userId, threadRef(thread.id), 'web_text'));
      expect((await getActive(db, account.userId, { deviceId }))?.conversationId).toBe(threadRef(thread.id));

      const res = await send('PUT', '/api/devices/active-space', token, { space_id: spaceNew.id, device_id: deviceId });
      expect(res.status).toBe(200);

      // The device decoupled from the account's (other-space) thread; the
      // account's own pointer is untouched -- only the device moved.
      expect((await getActive(db, account.userId, { deviceId }))?.conversationId).toBeNull();
      expect((await getActive(db, account.userId))?.conversationId).toBe(threadRef(thread.id));
    });
  });
});