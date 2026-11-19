// Epic #311 (#314/#330): device_state over the device wire -- accepted in any
// paired stage, kept on the session, persisted per device, seeding the next
// hello -- and the device_control round trip through the registry.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import * as pairing from '../../src/devices/pairing-service.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { getAccountTimeZone, getDeviceSettings, patchDeviceSettings, setDeviceSettings } from '../../src/devices/settings-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
interface FakeSocket { readyState: number; send: ReturnType<typeof vi.fn> }
type Sent = { type: string; payload: Record<string, unknown> };
const STATE = { volume: 4, muted: false, mode: 'wake', dnd: true, battery_pct: 57, charging: false, fw_version: '2.5.0' };

let pg: TestDb;
let db: Db;
let journal: string[];

const control = (type: string, payload: Record<string, unknown> = {}): ClientControlDto =>
  ({ v: V2_VERSION, type, id: 'test_ctrl_000001', payload }) as unknown as ClientControlDto;
const sent = (socket: FakeSocket): Sent[] => socket.send.mock.calls.map((call) => JSON.parse(call[0] as string) as Sent);

async function pairDevice(userId: string): Promise<string> {
  const issued = await pairing.issueCode(db, { model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.7' });
  return pairing.approve(db, userId, issued.pairingId, 'Kitchen');
}

async function connect(userId: string, deviceId: string): Promise<{ socket: FakeSocket; session: DeviceSession }> {
  const socket: FakeSocket = { readyState: 1, send: vi.fn() };
  const session = createSession({ kind: 'device', userId, deviceId, name: 'Kitchen' });
  await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { format_id: 2 }), vi.fn());
  return { socket, session };
}

const run = (socket: FakeSocket, session: DeviceSession, dto: ClientControlDto): Promise<void> =>
  handleControl(appDeps, socket as unknown as WebSocket, session, dto, vi.fn());

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
});
beforeEach(() => {
  journal = [];
  setJournalSink((line) => journal.push(line));
  getDeviceSessions().clear();
});
afterEach(() => setJournalSink(null));
afterAll(async () => {
  getDeviceSessions().clear();
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('device_state', () => {
  it('is kept on the session and the registry, persisted, and announced to the web as device.changed', async () => {
    const { userId } = await addAccount(pg);
    const deviceId = await pairDevice(userId);
    const events: AccountEvent[] = [];
    const off = pairing.getAccountEvents().subscribe(userId, (event) => events.push(event));
    const { socket, session } = await connect(userId, deviceId);
    session.stage = 'responding'; // any paired stage: a volume key mid-playback
    await run(socket, session, control('device_state', STATE));
    off();

    expect(session.deviceState).toEqual(STATE);
    expect(getDeviceSessions().deviceStateFor(deviceId)).toEqual(STATE);
    expect(await getDeviceSettings(db, userId, deviceId)).toMatchObject({ volume: 4, muted: false, mode: 'wake', dnd: true });
    expect(events).toContainEqual({ type: 'device.changed', device_id: deviceId });
    expect(sent(socket).filter((dto) => dto.type === 'error')).toEqual([]);
    expect(journal.join('\n')).toContain('"event":"v2.device_state"');
  });

  it('seeds the next hello from the stored settings', async () => {
    const { userId } = await addAccount(pg);
    const deviceId = await pairDevice(userId);
    await setDeviceSettings(db, userId, deviceId, { volume: 9, muted: true, mode: 'announce_only', dnd: false }, { keepPending: false });
    const { session } = await connect(userId, deviceId);
    expect(session.deviceState).toEqual({ volume: 9, muted: true, mode: 'announce_only', dnd: false });
  });

  it('is refused before hello (STATE_VIOLATION) and on an unpaired socket (UNPAIRED)', async () => {
    const socket = { readyState: 1, send: vi.fn(), once: vi.fn(), close: vi.fn() };
    const early = createSession({ kind: 'device', userId: randomUUID(), deviceId: randomUUID(), name: 'x' });
    await run(socket, early, control('device_state', STATE));
    const unpaired = createSession({ kind: 'unpaired', reason: 'none' } as never);
    unpaired.stage = 'ready';
    await run(socket, unpaired, control('device_state', STATE));
    expect(sent(socket).map((dto) => dto.payload.code)).toEqual(['STATE_VIOLATION', 'UNPAIRED']);
    expect(early.deviceState).toBeUndefined();
  });

  it('never stores settings for a device of another account', async () => {
    const owner = await addAccount(pg);
    const other = await addAccount(pg);
    const deviceId = await pairDevice(owner.userId);
    await expect(setDeviceSettings(db, other.userId, deviceId, { volume: 1, muted: false, mode: 'ptt', dnd: false }, { keepPending: false })).rejects.toThrow();
    expect(await patchDeviceSettings(db, other.userId, deviceId, { volume: 1 })).toBeNull();
    expect(await getDeviceSettings(db, other.userId, deviceId)).toBeNull();
    expect(await getDeviceSettings(db, owner.userId, deviceId)).toBeNull();
  });

  it('reads the caller\'s own time zone through the definer (null when unset)', async () => {
    const { userId } = await addAccount(pg);
    expect(await getAccountTimeZone(db, userId)).toBeNull();
  });
});

describe('device_control round trip', () => {
  it('reaches the device at once, even mid-turn, and the device\'s answer is persisted', async () => {
    const { userId } = await addAccount(pg);
    const deviceId = await pairDevice(userId);
    const { socket, session } = await connect(userId, deviceId);
    session.stage = 'responding';
    expect(getDeviceSessions().sendDeviceControl(userId, deviceId, { mode: 'ptt', volume: 2 })).toBe(1);
    expect(sent(socket).at(-1)).toMatchObject({ type: 'device_control', payload: { volume: 2, mode: 'ptt' } });
    await run(socket, session, control('device_state', { ...STATE, volume: 2, mode: 'ptt' }));
    expect(await getDeviceSettings(db, userId, deviceId)).toMatchObject({ volume: 2, mode: 'ptt' });
  });

  it('is not delivered to another account or to a disconnected device', async () => {
    const owner = await addAccount(pg);
    const other = await addAccount(pg);
    const deviceId = await pairDevice(owner.userId);
    expect(getDeviceSessions().sendDeviceControl(owner.userId, deviceId, { volume: 3 })).toBe(0);
    const { socket } = await connect(owner.userId, deviceId);
    expect(getDeviceSessions().sendDeviceControl(other.userId, deviceId, { volume: 3 })).toBe(0);
    expect(sent(socket).some((dto) => dto.type === 'device_control')).toBe(false);
    expect(journal.join('\n')).toContain('v2.device_control_undelivered');
  });
});
