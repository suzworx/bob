// Device settings on the web (#327, #314/#330 web parts): GET /api/devices
// carries each device's stored settings and live state, and PATCH
// /api/devices/:id/settings stores, pushes device_control to a connected
// device, and publishes device.changed. Real HTTP over Postgres; the registry is
// the real one with a fake socket.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocket } from 'ws';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pairing from '../../src/devices/pairing-service.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { getDeviceSettings, setDeviceSettings } from '../../src/devices/settings-store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createDevicesRouter } from '../../src/devices/http.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { rememberSocketCaps } from '../../src/voice/device-caps.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

describe('device settings API (#327)', () => {
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
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api/devices', createDevicesRouter({
      getDb: () => Promise.resolve(db),
      requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
      events: getAccountEvents(),
      deviceSessions: getDeviceSessions(),
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setJournalSink(null);
    getDeviceSessions().clear();
    server.close();
    await closeTestDb(pg);
  });

  async function owner(): Promise<{ userId: string; token: string; deviceId: string }> {
    const account = await addAccount(pg);
    const issued = await pairing.issueCode(db, {
      model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.90',
    });
    const deviceId = await pairing.approve(db, account.userId, issued.pairingId, 'Desk');
    return { userId: account.userId, token: await signToken({ userId: account.userId, sessionId: account.sessionId }), deviceId };
  }

  function patch(token: string, deviceId: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/devices/${deviceId}/settings`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function listed(token: string): Promise<Array<{ id: string; settings: unknown; live: unknown }>> {
    const res = await fetch(`${baseUrl}/api/devices`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { devices: Array<{ id: string; settings: unknown; live: unknown }> }).devices;
  }

  function connect(userId: string, deviceId: string): { send: ReturnType<typeof vi.fn>; stop: () => void } {
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const session = {
      id: `sess-${deviceId}`, stage: 'ready' as const,
      deviceState: { volume: 6, muted: false, mode: 'ptt' as const, dnd: false, battery_pct: 81, charging: true, fw_version: '1.4.0' },
    };
    getDeviceSessions().register(socket as unknown as WebSocket, session, userId, deviceId);
    return { send: socket.send, stop: () => getDeviceSessions().unregister(session) };
  }

  it('GET carries default settings and an offline live state, then the live report', async () => {
    const { userId, token, deviceId } = await owner();
    const [offline] = await listed(token);
    expect(offline).toMatchObject({
      id: deviceId,
      settings: { volume: 6, muted: false, mode: 'ptt', dnd: false, ring_seconds: 30, ring_sound: 'classic' },
      live: { connected: false, battery_pct: null, charging: null, fw_version: null },
    });
    const device = connect(userId, deviceId);
    const [online] = await listed(token);
    device.stop();
    expect(online!.live).toEqual({ connected: true, battery_pct: 81, charging: true, fw_version: '1.4.0' });
  });

  it('PATCH own connected device stores, pushes device_control, publishes device.changed', async () => {
    const { userId, token, deviceId } = await owner();
    const device = connect(userId, deviceId);
    const events: AccountEvent[] = [];
    const unsubscribe = getAccountEvents().subscribe(userId, (event) => events.push(event));
    const start = journalLines.length;
    const res = await patch(token, deviceId, { volume: 3, mode: 'announce_only' });
    unsubscribe();
    device.stop();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: deviceId,
      settings: { volume: 3, muted: false, mode: 'announce_only', dnd: false, ring_seconds: 30, ring_sound: 'classic', wake_word: 'bob' },
      delivered: true,
      pending: true,
    });
    // Sent is not applied: only the device's matching device_state clears it.
    expect(await getDeviceSettings(db, userId, deviceId)).toMatchObject({ volume: 3, mode: 'announce_only', pendingPush: true });
    const [row] = await listed(token);
    expect(row).toMatchObject({ pending: true });
    expect(device.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(device.send.mock.calls[0]![0] as string)).toMatchObject({
      type: 'device_control', payload: { volume: 3, mode: 'announce_only' },
    });
    expect(events).toEqual([{ type: 'device.changed', device_id: deviceId }]);
    const logged = journalLines.slice(start).map((line) => JSON.parse(line) as { event: string; fields?: string });
    expect(logged).toContainEqual(expect.objectContaining({ event: 'v2.device_settings_changed', fields: 'mode,volume' }));
  });

  it('PATCH an offline device stores without a push and GET shows the stored value', async () => {
    const { userId, token, deviceId } = await owner();
    const events: AccountEvent[] = [];
    const unsubscribe = getAccountEvents().subscribe(userId, (event) => events.push(event));
    const res = await patch(token, deviceId, { dnd: true, muted: true });
    unsubscribe();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { delivered: boolean }).delivered).toBe(false);
    expect(events).toEqual([{ type: 'device.changed', device_id: deviceId }]);
    const [row] = await listed(token);
    expect(row!.settings).toEqual({ volume: 6, muted: true, mode: 'ptt', dnd: true, ring_seconds: 30, ring_sound: 'classic', wake_word: 'bob' });
  });

  it('PATCH another account\'s device answers the unknown 404 body; nothing stored or pushed', async () => {
    const mine = await owner();
    const theirs = await owner();
    const device = connect(theirs.userId, theirs.deviceId);
    const foreign = await patch(mine.token, theirs.deviceId, { volume: 1 });
    const unknown = await patch(mine.token, randomUUID(), { volume: 1 });
    device.stop();
    expect([foreign.status, unknown.status]).toEqual([404, 404]);
    const body = await unknown.text();
    expect(body).toBe('{"error":{"code":"not_found"}}');
    expect(await foreign.text()).toBe(body);
    expect(device.send).not.toHaveBeenCalled();
    expect(await getDeviceSettings(db, theirs.userId, theirs.deviceId)).toBeNull();
  });

  it('PATCH with a bad body answers 400 with the field paths; nothing stored or pushed', async () => {
    const { userId, token, deviceId } = await owner();
    const device = connect(userId, deviceId);
    const cases: Array<[unknown, string[]]> = [
      [{ volume: 11 }, ['volume']],
      [{ volume: -1 }, ['volume']],
      [{ volume: 2.5 }, ['volume']],
      [{ mode: 'loud' }, ['mode']],
      [{ muted: 'yes' }, ['muted']],
      [{ volume: 3, brightness: 2 }, ['brightness']],
      [{}, []],
    ];
    for (const [body, fields] of cases) {
      const res = await patch(token, deviceId, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 'invalid_request', fields } });
    }
    device.stop();
    expect(device.send).not.toHaveBeenCalled();
    expect(await getDeviceSettings(db, userId, deviceId)).toBeNull();
  });

  it('concurrent PATCHes of different fields all survive (no lost update)', async () => {
    const { userId, token, deviceId } = await owner();
    const results = await Promise.all([
      patch(token, deviceId, { volume: 2 }),
      patch(token, deviceId, { muted: true }),
      patch(token, deviceId, { mode: 'wake' }),
      patch(token, deviceId, { dnd: true }),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    expect(await getDeviceSettings(db, userId, deviceId)).toMatchObject({ volume: 2, muted: true, mode: 'wake', dnd: true, pendingPush: true });
  });

  it('PATCH stores the change as pending before it pushes device_control', async () => {
    const { userId, token, deviceId } = await owner();
    const device = connect(userId, deviceId);
    const seenAtPush: Array<Promise<unknown>> = [];
    device.send.mockImplementation(() => { seenAtPush.push(getDeviceSettings(db, userId, deviceId)); });
    const res = await patch(token, deviceId, { volume: 9 });
    device.stop();
    expect(res.status).toBe(200);
    expect(seenAtPush).toHaveLength(1);
    expect(await seenAtPush[0]).toMatchObject({ volume: 9, pendingPush: true });
  });

  it('GET marks the controls unsupported until the device has ever reported device_state', async () => {
    const { userId, token, deviceId } = await owner();
    expect((await listed(token))[0]).toMatchObject({ pending: false, settings_supported: false });
    await patch(token, deviceId, { volume: 4 });
    expect((await listed(token))[0]).toMatchObject({ pending: true, settings_supported: false });
    await setDeviceSettings(db, userId, deviceId, { volume: 4, muted: false, mode: 'ptt', dnd: false }, { keepPending: false });
    // Offline now, but it has reported once: supported, and the report cleared pending.
    expect((await listed(token))[0]).toMatchObject({ pending: false, settings_supported: true });
  });

  it('GET marks a connected device that reported a firmware version as supported', async () => {
    const { userId, token, deviceId } = await owner();
    const device = connect(userId, deviceId);
    const [row] = await listed(token);
    device.stop();
    expect(row).toMatchObject({ settings_supported: true });
  });

  // #389: timer ring length and sound.
  const OLD_REPORT = { volume: 6, muted: false, mode: 'ptt' as const, dnd: false };
  const RING_REPORT = { ...OLD_REPORT, ring_seconds: 30, ring_sound: 'classic' as const };

  it.each([
    ['ring_seconds 9', { ring_seconds: 9 }, 'ring_seconds'],
    ['ring_seconds 121', { ring_seconds: 121 }, 'ring_seconds'],
    ['fractional ring_seconds', { ring_seconds: 30.5 }, 'ring_seconds'],
    ['ring_seconds as a string', { ring_seconds: '60' }, 'ring_seconds'],
    ['an unknown ring_sound', { ring_sound: 'siren' }, 'ring_sound'],
  ])('PATCH with %s answers 400 and nothing changes (#389)', async (_label, body, field) => {
    const { userId, token, deviceId } = await owner();
    await setDeviceSettings(db, userId, deviceId, RING_REPORT, { keepPending: false });
    const device = connect(userId, deviceId);
    const res = await patch(token, deviceId, body);
    device.stop();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'invalid_request', fields: [field] } });
    expect(await getDeviceSettings(db, userId, deviceId)).toMatchObject({ ring_seconds: 30, ring_sound: 'classic', pendingPush: false });
    expect(device.send).not.toHaveBeenCalled();
  });

  it('PATCH accepts the ring bounds 10 and 120 and every sound for ring firmware (#389)', async () => {
    const { userId, token, deviceId } = await owner();
    await setDeviceSettings(db, userId, deviceId, RING_REPORT, { keepPending: false });
    for (const body of [{ ring_seconds: 10 }, { ring_seconds: 120, ring_sound: 'chime' }, { ring_sound: 'pulse' }]) {
      expect((await patch(token, deviceId, body)).status).toBe(200);
    }
    expect(await getDeviceSettings(db, userId, deviceId)).toMatchObject({ ring_seconds: 120, ring_sound: 'pulse', pendingPush: true });
    expect((await listed(token))[0]).toMatchObject({ settings: { ring_seconds: 120, ring_sound: 'pulse' }, ring_settings_supported: true });
  });

  it('PATCH a ring change for firmware without ring support answers 409 and nothing changes (#389)', async () => {
    const { userId, token, deviceId } = await owner();
    const never = await patch(token, deviceId, { ring_seconds: 60 });
    expect(never.status).toBe(409);
    expect(await never.json()).toEqual({ error: { code: 'ring_unsupported' } });
    expect(await getDeviceSettings(db, userId, deviceId)).toBeNull();
    await setDeviceSettings(db, userId, deviceId, OLD_REPORT, { keepPending: false });
    const device = connect(userId, deviceId);
    const old = await patch(token, deviceId, { volume: 2, ring_sound: 'chime' });
    device.stop();
    expect(old.status).toBe(409);
    expect(await getDeviceSettings(db, userId, deviceId)).toMatchObject({ volume: 6, ring_sound: 'classic', pendingPush: false });
    expect(device.send).not.toHaveBeenCalled();
    expect((await listed(token))[0]).toMatchObject({ settings_supported: true, ring_settings_supported: false });
  });

  it('PATCH a ring change to another account\'s device is the unknown 404, not 409 (#389)', async () => {
    const mine = await owner();
    const theirs = await owner();
    const res = await patch(mine.token, theirs.deviceId, { ring_seconds: 60 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found' } });
  });

  describe('wake word', () => {
    async function ownerOf(model: string): Promise<{ userId: string; token: string; deviceId: string }> {
      const account = await addAccount(pg);
      const issued = await pairing.issueCode(db, {
        model, fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.91',
      });
      const deviceId = await pairing.approve(db, account.userId, issued.pairingId, 'Bob2');
      return { userId: account.userId, token: await signToken({ userId: account.userId, sessionId: account.sessionId }), deviceId };
    }

    function connectWithCaps(userId: string, deviceId: string, caps: string[]): { send: ReturnType<typeof vi.fn>; stop: () => void } {
      const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
      rememberSocketCaps(socket as unknown as WebSocket, caps);
      const session = { id: `sess-wake-${deviceId}`, stage: 'ready' as const };
      getDeviceSessions().register(socket as unknown as WebSocket, session, userId, deviceId);
      return { send: socket.send, stop: () => getDeviceSessions().unregister(session) };
    }

    it('a Cardputer defaults to bob and is unsupported until it reports one', async () => {
      const { token } = await owner();
      const [row] = await listed(token);
      expect(row).toMatchObject({ model: 'M5Stack Cardputer', settings: { wake_word: 'bob' }, wake_word_supported: false });
    });

    it('a Waveshare device is listed as Bob and defaults to bob', async () => {
      const { token } = await ownerOf('Waveshare ESP32-S3 Round');
      expect((await listed(token))[0]).toMatchObject({ model: 'Bob (Waveshare 1.85C)', settings: { wake_word: 'bob' } });
    });

    it('PATCH wake_word answers 409 for firmware that never reported one nor advertised the cap; nothing written', async () => {
      const { userId, token, deviceId } = await owner();
      const device = connect(userId, deviceId);
      const res = await patch(token, deviceId, { wake_word: 'bob' });
      device.stop();
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: { code: 'wake_word_unsupported' } });
      expect(await getDeviceSettings(db, userId, deviceId)).toBeNull();
      expect(device.send).not.toHaveBeenCalled();
    });

    it('PATCH wake_word to a device with cap wake_word pushes it last in device_control and GET shows it', async () => {
      const { userId, token, deviceId } = await owner();
      const device = connectWithCaps(userId, deviceId, ['device_control', 'wake_word']);
      const before = (await listed(token))[0];
      const res = await patch(token, deviceId, { volume: 4, wake_word: 'bob' });
      const [row] = await listed(token);
      device.stop();
      expect(before).toMatchObject({ wake_word_supported: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ settings: { volume: 4, wake_word: 'bob' }, delivered: true, pending: true });
      const sent = device.send.mock.calls[0]![0] as string;
      expect(JSON.parse(sent)).toMatchObject({ type: 'device_control', payload: { volume: 4, wake_word: 'bob' } });
      expect(Object.keys((JSON.parse(sent) as { payload: object }).payload)).toEqual(['volume', 'wake_word']);
      expect(row).toMatchObject({ settings: { wake_word: 'bob' }, pending: true, wake_word_supported: true });
      expect(await getDeviceSettings(db, userId, deviceId)).toMatchObject({ wake_word: 'bob', pendingPush: true });
    });

    it('a device that reported its wake word stays supported offline; a socket without the cap never gets the key', async () => {
      const { userId, token, deviceId } = await owner();
      const reported = await setDeviceSettings(db, userId, deviceId, { ...OLD_REPORT, wake_word: 'bob' }, { keepPending: false });
      expect(reported).toMatchObject({ settings: { wake_word: 'bob' }, changed: ['wake_word'] });
      expect((await listed(token))[0]).toMatchObject({ settings: { wake_word: 'bob' }, wake_word_supported: true });
      // A report without the key keeps the stored wake word.
      await setDeviceSettings(db, userId, deviceId, OLD_REPORT, { keepPending: false });
      expect(await getDeviceSettings(db, userId, deviceId)).toMatchObject({ wake_word: 'bob', wakeWordReported: true });
      const device = connectWithCaps(userId, deviceId, ['device_control']);
      const both = await patch(token, deviceId, { volume: 2, wake_word: 'bob' });
      const only = await patch(token, deviceId, { wake_word: 'bob' });
      device.stop();
      expect([both.status, only.status]).toEqual([200, 200]);
      expect(((await only.json()) as { delivered: boolean }).delivered).toBe(false);
      expect(device.send).toHaveBeenCalledTimes(1);
      expect((JSON.parse(device.send.mock.calls[0]![0] as string) as { payload: object }).payload).toEqual({ volume: 2 });
    });
  });
});
