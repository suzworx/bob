// #327: a web settings change made while the Cardputer is offline wins on
// reconnect. Real PATCH over HTTP and real session.ts hello/device_state over
// Postgres (createTestDb); the device is a fake socket in the real registry.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocket } from 'ws';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pairing from '../../src/devices/pairing-service.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { getDeviceSettings } from '../../src/devices/settings-store.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createDevicesRouter } from '../../src/devices/http.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
type Device = { socket: { readyState: number; send: ReturnType<typeof vi.fn> }; session: DeviceSession };
type Sent = { type: string; payload: Record<string, unknown> };
const BATTERY = { battery_pct: 60, charging: false, fw_version: '2.5.0' };

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
let journal: string[] = [];

const control = (type: string, payload: Record<string, unknown> = {}): ClientControlDto =>
  ({ v: V2_VERSION, type, id: 'test_ctrl_000001', payload }) as unknown as ClientControlDto;
const sent = (device: Device): Sent[] => device.socket.send.mock.calls.map((call) => JSON.parse(call[0] as string) as Sent);
const pushes = (device: Device): Sent[] => sent(device).filter((dto) => dto.type === 'device_control');
const synced = (): Array<Record<string, unknown>> => journal
  .map((line) => JSON.parse(line) as Record<string, unknown>)
  .filter((entry) => entry.event === 'v2.device_settings_synced');
const changed = (): Array<Record<string, unknown>> => journal
  .map((line) => JSON.parse(line) as Record<string, unknown>)
  .filter((entry) => entry.event === 'v2.device_settings_changed');

async function listedRow(token: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}/api/devices`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { devices: unknown[] }).devices[0];
}

async function owner(): Promise<{ userId: string; token: string; deviceId: string }> {
  const account = await addAccount(pg);
  const issued = await pairing.issueCode(db, { model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.91' });
  const deviceId = await pairing.approve(db, account.userId, issued.pairingId, 'Desk');
  return { userId: account.userId, token: await signToken({ userId: account.userId, sessionId: account.sessionId }), deviceId };
}

async function patch(token: string, deviceId: string, body: unknown): Promise<{ delivered: boolean }> {
  const res = await fetch(`${baseUrl}/api/devices/${deviceId}/settings`, {
    method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { delivered: boolean };
}

async function connect(userId: string, deviceId: string): Promise<Device> {
  const device: Device = { socket: { readyState: 1, send: vi.fn() }, session: createSession({ kind: 'device', userId, deviceId, name: 'Desk' }) };
  await handleControl(appDeps, device.socket as unknown as WebSocket, device.session, control('hello', { format_id: 2 }), vi.fn());
  return device;
}

const report = (device: Device, settings: Record<string, unknown>): Promise<void> =>
  handleControl(appDeps, device.socket as unknown as WebSocket, device.session, control('device_state', { ...settings, ...BATTERY }), vi.fn());
const stored = async (userId: string, deviceId: string): Promise<unknown> => getDeviceSettings(db, userId, deviceId);

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api/devices', createDevicesRouter({
    getDb: () => Promise.resolve(db), requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
    events: pairing.getAccountEvents(), deviceSessions: getDeviceSessions(),
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  journal = [];
  setJournalSink((line) => journal.push(line));
  getDeviceSessions().clear();
});
afterAll(async () => {
  setJournalSink(null);
  getDeviceSessions().clear();
  server.close();
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('settings sync on reconnect (#327)', () => {
  it('pushes an offline web change after welcome and clears it once the device reports it', async () => {
    const { userId, token, deviceId } = await owner();
    expect(await patch(token, deviceId, { volume: 2, dnd: true })).toMatchObject({ delivered: false });
    expect(await stored(userId, deviceId)).toMatchObject({ volume: 2, dnd: true, pendingPush: true });
    const device = await connect(userId, deviceId);
    expect(sent(device).map((dto) => dto.type).slice(0, 2)).toEqual(['welcome', 'device_control']);
    expect(pushes(device)[0]!.payload).toEqual({ volume: 2, muted: false, mode: 'ptt', dnd: true });
    await report(device, { volume: 2, muted: false, mode: 'ptt', dnd: true });
    expect(await stored(userId, deviceId)).toMatchObject({ volume: 2, muted: false, mode: 'ptt', dnd: true, pendingPush: false });
    expect(pushes(device)).toHaveLength(1);
    expect(synced()).toEqual([expect.objectContaining({ direction: 'to_device' })]);
  });

  it('stores the device report when nothing is pending, so key changes made offline survive', async () => {
    const { userId, deviceId } = await owner();
    const first = await connect(userId, deviceId);
    await report(first, { volume: 6, muted: false, mode: 'ptt', dnd: false });
    getDeviceSessions().unregister(first.session);
    const device = await connect(userId, deviceId);
    expect(pushes(device)).toEqual([]);
    await report(device, { volume: 9, muted: true, mode: 'wake', dnd: false });
    expect(await stored(userId, deviceId)).toMatchObject({ volume: 9, muted: true, mode: 'wake', pendingPush: false });
    expect(synced().at(-1)).toMatchObject({ direction: 'from_device' });
  });

  it('keeps the pending values when the device reports its own first, and pushes once more only', async () => {
    const { userId, token, deviceId } = await owner();
    await patch(token, deviceId, { mode: 'announce_only' });
    const device = await connect(userId, deviceId);
    await report(device, { volume: 6, muted: false, mode: 'wake', dnd: false });
    expect(await stored(userId, deviceId)).toMatchObject({ mode: 'announce_only', pendingPush: true });
    expect(pushes(device)).toHaveLength(2);
    await report(device, { volume: 6, muted: false, mode: 'announce_only', dnd: false });
    expect(await stored(userId, deviceId)).toMatchObject({ mode: 'announce_only', pendingPush: false });
  });

  it('accepts a differing report after the one re-push: the device wins and pending clears', async () => {
    const { userId, token, deviceId } = await owner();
    await patch(token, deviceId, { mode: 'announce_only' });
    const device = await connect(userId, deviceId);
    await report(device, { volume: 6, muted: false, mode: 'wake', dnd: false });
    const events: string[] = [];
    const unsubscribe = pairing.getAccountEvents().subscribe(userId, (event) => events.push(event.type));
    await report(device, { volume: 7, muted: false, mode: 'wake', dnd: false });
    unsubscribe();
    expect(await stored(userId, deviceId)).toMatchObject({ volume: 7, mode: 'wake', pendingPush: false });
    expect(pushes(device)).toHaveLength(2);
    expect(events).toContain('device.changed');
    expect(synced().at(-1)).toMatchObject({ direction: 'device_override' });
  });

  it('a key change on the device after a pending web change shows the device value on the web', async () => {
    const { userId, token, deviceId } = await owner();
    const device = await connect(userId, deviceId);
    await report(device, { volume: 6, muted: false, mode: 'ptt', dnd: false });
    await patch(token, deviceId, { volume: 2 });
    await report(device, { volume: 8, muted: false, mode: 'ptt', dnd: false });
    const row = await listedRow(token);
    expect(row).toMatchObject({ settings: { volume: 8, muted: false, mode: 'ptt', dnd: false }, pending: false });
  });

  it('journals ack_ms when the device confirms a pending push', async () => {
    const { userId, token, deviceId } = await owner();
    await patch(token, deviceId, { volume: 3 });
    const device = await connect(userId, deviceId);
    await report(device, { volume: 3, muted: false, mode: 'ptt', dnd: false });
    const [event] = synced();
    expect(event).toMatchObject({ direction: 'to_device' });
    expect(typeof event!.ack_ms).toBe('number');
    expect(event!.ack_ms as number).toBeGreaterThanOrEqual(0);
  });

  it('journals device-side changes by field name only, and nothing when the report matches', async () => {
    const { userId, deviceId } = await owner();
    const device = await connect(userId, deviceId);
    await report(device, { volume: 6, muted: false, mode: 'ptt', dnd: false });
    expect(changed()).toEqual([]);
    await report(device, { volume: 9, muted: false, mode: 'wake', dnd: false });
    expect(changed()).toEqual([expect.objectContaining({ source: 'device', fields: 'mode,volume' })]);
    expect(Object.keys(changed()[0]!).filter((key) => ['volume', 'mode', 'settings'].includes(key))).toEqual([]);
  });

  it('lets the last of two offline PATCHes win on reconnect', async () => {
    const { userId, token, deviceId } = await owner();
    await patch(token, deviceId, { volume: 3 });
    await patch(token, deviceId, { volume: 8, mode: 'wake' });
    const device = await connect(userId, deviceId);
    expect(pushes(device).map((dto) => dto.payload)).toEqual([{ volume: 8, muted: false, mode: 'wake', dnd: false }]);
  });

  it('pushes a PATCH to a connected device at once and keeps it pending until the device reports it', async () => {
    const { userId, token, deviceId } = await owner();
    const device = await connect(userId, deviceId);
    await report(device, { volume: 6, muted: false, mode: 'ptt', dnd: false });
    expect(await patch(token, deviceId, { volume: 4 })).toMatchObject({ delivered: true, pending: true });
    expect(pushes(device).map((dto) => dto.payload)).toEqual([{ volume: 4 }]);
    expect(await stored(userId, deviceId)).toMatchObject({ volume: 4, pendingPush: true });
    await report(device, { volume: 4, muted: false, mode: 'ptt', dnd: false });
    expect(await stored(userId, deviceId)).toMatchObject({ volume: 4, pendingPush: false });
    expect(synced().at(-1)).toMatchObject({ direction: 'to_device' });
  });

  it('journals the sync direction and never a settings value', async () => {
    const { userId, token, deviceId } = await owner();
    await patch(token, deviceId, { volume: 1, muted: true });
    const device = await connect(userId, deviceId);
    await report(device, { volume: 1, muted: true, mode: 'ptt', dnd: false });
    const events = synced();
    expect(events).toHaveLength(1);
    for (const event of events) {
      expect(Object.keys(event).filter((key) => ['volume', 'muted', 'mode', 'dnd', 'settings'].includes(key))).toEqual([]);
    }
  });
});

// #389: ring firmware always reports ring_seconds and ring_sound; older
// firmware reports neither and must never be sent them.
describe('ring settings sync (#389)', () => {
  const RING = { volume: 6, muted: false, mode: 'ptt', dnd: false, ring_seconds: 30, ring_sound: 'classic' };
  const OLD = { volume: 6, muted: false, mode: 'ptt', dnd: false };

  it('stores a ring report and GET shows the ring settings as supported', async () => {
    const { userId, token, deviceId } = await owner();
    expect(await listedRow(token)).toMatchObject({
      settings: { ring_seconds: 30, ring_sound: 'classic' }, ring_settings_supported: false,
    });
    const device = await connect(userId, deviceId);
    await report(device, { ...RING, ring_seconds: 45, ring_sound: 'pulse' });
    expect(await stored(userId, deviceId)).toMatchObject({ ring_seconds: 45, ring_sound: 'pulse', ringReported: true });
    expect(await listedRow(token)).toMatchObject({
      settings: { ring_seconds: 45, ring_sound: 'pulse' }, ring_settings_supported: true,
    });
    expect(changed().at(-1)).toMatchObject({ source: 'device', fields: 'ring_seconds,ring_sound' });
  });

  it('an offline ring change applies on reconnect and clears once the device reports it', async () => {
    const { userId, token, deviceId } = await owner();
    const first = await connect(userId, deviceId);
    await report(first, RING);
    getDeviceSessions().unregister(first.session);
    expect(await patch(token, deviceId, { ring_seconds: 60 })).toMatchObject({ delivered: false });
    const device = await connect(userId, deviceId);
    expect(pushes(device).map((dto) => dto.payload)).toEqual([
      { volume: 6, muted: false, mode: 'ptt', dnd: false, ring_seconds: 60, ring_sound: 'classic' },
    ]);
    await report(device, { ...RING, ring_seconds: 60 });
    expect(await stored(userId, deviceId)).toMatchObject({ ring_seconds: 60, pendingPush: false });
    expect(synced().at(-1)).toMatchObject({ direction: 'to_device' });
  });

  it('a ring change to a connected ring device is pushed at once', async () => {
    const { userId, token, deviceId } = await owner();
    const device = await connect(userId, deviceId);
    await report(device, RING);
    expect(await patch(token, deviceId, { ring_seconds: 60, ring_sound: 'chime' })).toMatchObject({ delivered: true, pending: true });
    expect(pushes(device).map((dto) => dto.payload)).toEqual([{ ring_seconds: 60, ring_sound: 'chime' }]);
    await report(device, { ...RING, ring_seconds: 60, ring_sound: 'chime' });
    expect(await stored(userId, deviceId)).toMatchObject({ ring_seconds: 60, ring_sound: 'chime', pendingPush: false });
  });

  it('never pushes ring keys to older firmware, and its report clears a pending change without them', async () => {
    const { userId, token, deviceId } = await owner();
    const first = await connect(userId, deviceId);
    await report(first, OLD);
    getDeviceSessions().unregister(first.session);
    await patch(token, deviceId, { volume: 2 });
    const device = await connect(userId, deviceId);
    expect(pushes(device).map((dto) => dto.payload)).toEqual([{ volume: 2, muted: false, mode: 'ptt', dnd: false }]);
    await report(device, { ...OLD, volume: 1 });
    expect(pushes(device).map((dto) => dto.payload).at(-1)).toEqual({ volume: 2, muted: false, mode: 'ptt', dnd: false });
    await report(device, { ...OLD, volume: 2 });
    expect(await stored(userId, deviceId)).toMatchObject({
      volume: 2, ring_seconds: 30, ring_sound: 'classic', ringReported: false, pendingPush: false,
    });
    expect(await listedRow(token)).toMatchObject({ ring_settings_supported: false });
  });

  it('a report without ring keys keeps the stored ring settings and support', async () => {
    const { userId, token, deviceId } = await owner();
    const device = await connect(userId, deviceId);
    await report(device, { ...RING, ring_seconds: 90 });
    await report(device, { ...OLD, volume: 3 });
    expect(await stored(userId, deviceId)).toMatchObject({ volume: 3, ring_seconds: 90, ringReported: true });
    expect(await listedRow(token)).toMatchObject({ ring_settings_supported: true });
  });
});

describe('wake word sync (cap wake_word)', () => {
  const OLD = { volume: 6, muted: false, mode: 'ptt', dnd: false };

  async function connectCaps(userId: string, deviceId: string, caps: string[]): Promise<Device> {
    const device: Device = { socket: { readyState: 1, send: vi.fn() }, session: createSession({ kind: 'device', userId, deviceId, name: 'Bob2' }) };
    await handleControl(appDeps, device.socket as unknown as WebSocket, device.session, control('hello', { format_id: 2, caps }), vi.fn());
    return device;
  }

  it('stores the reported wake word and GET shows it as supported', async () => {
    const { userId, token, deviceId } = await owner();
    const device = await connectCaps(userId, deviceId, ['device_control', 'wake_word']);
    expect(await listedRow(token)).toMatchObject({ settings: { wake_word: 'bob' }, wake_word_supported: true });
    await report(device, { ...OLD, wake_word: 'bob' });
    getDeviceSessions().unregister(device.session);
    expect(await stored(userId, deviceId)).toMatchObject({ wake_word: 'bob', wakeWordReported: true });
    expect(await listedRow(token)).toMatchObject({ settings: { wake_word: 'bob' }, wake_word_supported: true });
    expect(changed().at(-1)).toMatchObject({ fields: 'wake_word' });
  });

  it('an offline wake word change applies on reconnect, wake_word last, and clears once the device reports it', async () => {
    const { userId, token, deviceId } = await owner();
    const first = await connectCaps(userId, deviceId, ['device_control', 'wake_word']);
    await report(first, { ...OLD, wake_word: 'bob' });
    getDeviceSessions().unregister(first.session);
    expect(await patch(token, deviceId, { wake_word: 'bob' })).toMatchObject({ delivered: false });
    const device = await connectCaps(userId, deviceId, ['device_control', 'wake_word']);
    expect(pushes(device).map((dto) => Object.keys(dto.payload).at(-1))).toEqual(['wake_word']);
    expect(pushes(device)[0]!.payload).toMatchObject({ volume: 6, wake_word: 'bob' });
    await report(device, { ...OLD, wake_word: 'bob' });
    getDeviceSessions().unregister(device.session);
    expect(await stored(userId, deviceId)).toMatchObject({ wake_word: 'bob', pendingPush: false });
    expect(synced().at(-1)).toMatchObject({ direction: 'to_device' });
  });

  it('a reconnect without the cap gets the pending settings without wake_word', async () => {
    const { userId, token, deviceId } = await owner();
    const first = await connectCaps(userId, deviceId, ['device_control', 'wake_word']);
    await report(first, { ...OLD, wake_word: 'bob' });
    getDeviceSessions().unregister(first.session);
    await patch(token, deviceId, { wake_word: 'bob' });
    const device = await connect(userId, deviceId);
    getDeviceSessions().unregister(device.session);
    expect(pushes(device).map((dto) => dto.payload)).toEqual([{ volume: 6, muted: false, mode: 'ptt', dnd: false }]);
  });

  // #1228: Bob2 (a Waveshare paired as "M5Stack Cardputer") was pushed wake_word
  // 'bob' on connect. Only a web pick is ever sent; a default is display only.
  const BOARD = 'waveshare-s3-185c';
  const WAKE_CAPS = ['device_control', 'wake_word'];
  const wakePushes = (device: Device): unknown[] => pushes(device).filter((dto) => 'wake_word' in dto.payload);

  async function connectBoard(userId: string, deviceId: string, board: string): Promise<Device> {
    const device: Device = { socket: { readyState: 1, send: vi.fn() }, session: createSession({ kind: 'device', userId, deviceId, name: 'Bob2' }) };
    await handleControl(appDeps, device.socket as unknown as WebSocket, device.session, control('hello', { format_id: 2, caps: WAKE_CAPS, board }), vi.fn());
    return device;
  }

  it('a device with no stored wake word gets none in device_control; its report is the truth', async () => {
    const { userId, token, deviceId } = await owner();
    await patch(token, deviceId, { volume: 3 });
    const device = await connectBoard(userId, deviceId, BOARD);
    expect(pushes(device).map((dto) => dto.payload)).toEqual([{ volume: 3, muted: false, mode: 'ptt', dnd: false }]);
    expect(await listedRow(token)).toMatchObject({ model: 'Bob (Waveshare 1.85C)', settings: { wake_word: 'bob' } });
    await report(device, { ...OLD, volume: 3, wake_word: 'bob' });
    expect(await stored(userId, deviceId)).toMatchObject({ wake_word: 'bob', pendingPush: false, wakeWordPending: false });
    expect(synced().at(-1)).toMatchObject({ direction: 'to_device' });
    getDeviceSessions().unregister(device.session);
    expect(wakePushes(device)).toEqual([]);
  });

  it('a reported wake word is never pushed back with a later offline change', async () => {
    const { userId, token, deviceId } = await owner();
    const first = await connectBoard(userId, deviceId, BOARD);
    await report(first, { ...OLD, wake_word: 'bob' });
    getDeviceSessions().unregister(first.session);
    await patch(token, deviceId, { volume: 4 });
    const device = await connectBoard(userId, deviceId, BOARD);
    getDeviceSessions().unregister(device.session);
    expect(pushes(device).map((dto) => dto.payload)).toEqual([{ volume: 4, muted: false, mode: 'ptt', dnd: false }]);
  });

  it('a user-set wake word is sent once, confirmed, and never sent again', async () => {
    const { userId, token, deviceId } = await owner();
    const device = await connectBoard(userId, deviceId, BOARD);
    await report(device, { ...OLD, wake_word: 'bob' });
    expect(await patch(token, deviceId, { wake_word: 'bob' })).toMatchObject({ delivered: true });
    expect(pushes(device).map((dto) => dto.payload)).toEqual([{ wake_word: 'bob' }]);
    expect(await stored(userId, deviceId)).toMatchObject({ wake_word: 'bob', wakeWordPending: true });
    await report(device, { ...OLD, wake_word: 'bob' });
    expect(await stored(userId, deviceId)).toMatchObject({ wake_word: 'bob', pendingPush: false, wakeWordPending: false });
    getDeviceSessions().unregister(device.session);
    await patch(token, deviceId, { volume: 2 });
    const again = await connectBoard(userId, deviceId, BOARD);
    getDeviceSessions().unregister(again.session);
    expect(wakePushes(device)).toHaveLength(1);
    expect(wakePushes(again)).toEqual([]);
  });
});
