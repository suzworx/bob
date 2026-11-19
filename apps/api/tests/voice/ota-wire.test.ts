/** Epic #343 OTA wire (OTA-4B): hello fields, welcome.update_offer, check_update, ota_progress, against tests/fixtures/ota-wire.json. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

const mocks = vi.hoisted(() => ({
  offerOnHello: vi.fn(), currentOffer: vi.fn(), recordOtaStart: vi.fn(), journal: vi.fn(),
  getActive: vi.fn(), getActiveSpace: vi.fn(), listPendingTimers: vi.fn(),
}));
vi.mock('../../src/firmware/device-offer.ts', () => ({
  offerOnHello: mocks.offerOnHello, currentOffer: mocks.currentOffer, recordOtaStart: mocks.recordOtaStart,
}));
vi.mock('../../src/platform/logger.ts', async (original) => ({ ...(await original<object>()), ...(await import('../helpers/journal-mock.ts')).loggerMock(mocks.journal) }));
vi.mock('../../src/timers/store.ts', async (original) => ({
  ...(await original<object>()), listPendingTimers: mocks.listPendingTimers,
}));
vi.mock('../../src/conversations/active.ts', async (original) => ({ ...(await original<object>()), getActive: mocks.getActive }));
vi.mock('../../src/spaces/active.ts', async (original) => ({
  ...(await original<object>()), getActiveSpace: mocks.getActiveSpace,
}));

import { createAppDeps } from '../../src/app-deps.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { ClientControlDtoSchema, otaOfferWire, ServerControlDtoSchema } from '../../src/voice/protocol.ts';
import { handleControl } from '../../src/voice/session.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';

const fixtures = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/ota-wire.json'), 'utf8')) as Record<string, { id: string; payload: Record<string, unknown> }>;
const fixture = (name: string): { id: string; payload: Record<string, unknown> } => fixtures[name]!;
const appDeps = createAppDeps();
const fakeDb: Db = { query: async <T>(): Promise<T[]> => [], tx: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(fakeDb) };
const deviceAuth = { kind: 'device' as const, userId: '22222222-2222-4222-8222-222222222222', deviceId: '11111111-1111-4111-8111-111111111111', name: 'Test Card' };
const offer = { ...(fixture('update_offer').payload as object), notes: 'Faster wake word' } as Parameters<typeof otaOfferWire>[0];

const closeListeners: (() => void)[] = [];
const makeSocket = () => ({ readyState: 1, send: vi.fn(), once: (event: string, fn: () => void) => { if (event === 'close') closeListeners.push(fn); } });
type FakeSocket = ReturnType<typeof makeSocket>;
const sent = (socket: FakeSocket): { type: string; payload: Record<string, unknown> }[] =>
  socket.send.mock.calls.map((call) => JSON.parse(call[0] as string));
const send = (socket: FakeSocket, session: DeviceSession, name: string): Promise<void> =>
  handleControl(appDeps, socket as unknown as WebSocket, session, ClientControlDtoSchema.parse(fixture(name)), vi.fn());
async function helloWith(name: string, auth: DeviceSession['auth'] = deviceAuth): Promise<{ socket: FakeSocket; session: DeviceSession }> {
  const socket = makeSocket();
  const session = createSession(auth);
  await send(socket, session, name);
  return { socket, session };
}

describe('OTA wire', () => {
  beforeAll(() => setSharedDb(Promise.resolve(fakeDb)));
  beforeEach(() => {
    mocks.getActive.mockResolvedValue(null); mocks.getActiveSpace.mockResolvedValue(null); mocks.listPendingTimers.mockResolvedValue([]);
  });
  afterEach(() => {
    closeListeners.splice(0).forEach((fn) => fn());
    getDeviceSessions().clear();
    vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks();
  });

  it('every fixture parses under its schema, and the unknown keys of a new message are stripped', () => {
    for (const name of ['hello', 'hello_bad_ota_fields', 'check_update', 'ota_progress_start', 'ota_progress_failed']) {
      expect(ClientControlDtoSchema.safeParse(fixture(name)).success, name).toBe(true);
    }
    for (const name of ['update_offer', 'update_offer_none', 'welcome_update_offer']) {
      expect(ServerControlDtoSchema.safeParse(fixture(name)).success, name).toBe(true);
    }
    const parsed = ClientControlDtoSchema.parse({ ...fixture('check_update'), payload: { extra: 1 } });
    expect(parsed.payload).toEqual({});
  });

  it('a hello with bad board, last_ota and ota_slot stands with them absent', () => {
    const parsed = ClientControlDtoSchema.parse(fixture('hello_bad_ota_fields'));
    expect(parsed.payload).toEqual({ format_id: 2, fw_version: '0.3.0', caps: ['ota'] });
  });

  it('puts the offer in welcome (fixture bytes) and hands the hello report to the firmware module', async () => {
    mocks.offerOnHello.mockResolvedValue({ ...offer, notes: null, mandatory: true, apply_after_s: 0 });
    const { socket } = await helloWith('hello');
    const welcome = sent(socket).find((m) => m.type === 'welcome')!;
    expect(welcome.payload.update_offer).toEqual(fixture('welcome_update_offer').payload.update_offer);
    expect(Object.keys(welcome.payload.update_offer as object)).toEqual(Object.keys(fixture('welcome_update_offer').payload.update_offer as object));
    expect(mocks.offerOnHello).toHaveBeenCalledWith(expect.anything(), deviceAuth.deviceId, {
      version: '0.3.0', board: 'cardputer', lastOta: { result: 'rolled_back', to: '0.4.0', reason: 'boot_loop' },
    });
  });

  it('a device without cap ota is neither offered nor recorded', async () => {
    mocks.offerOnHello.mockResolvedValue(offer);
    const old = makeSocket();
    await handleControl(appDeps, old as unknown as WebSocket, createSession(deviceAuth),
      ClientControlDtoSchema.parse({ ...fixture('hello'), payload: { format_id: 2, fw_version: '0.3.0', caps: ['reply_text'] } }), vi.fn());
    expect(mocks.offerOnHello).not.toHaveBeenCalled();
    expect(sent(old)[0]!.payload).not.toHaveProperty('update_offer');
  });

  it('an OTA error never costs the hello: welcome without an offer and a v2.ota.error', async () => {
    mocks.offerOnHello.mockRejectedValue(new Error('db down'));
    const { socket } = await helloWith('hello');
    expect(sent(socket).map((m) => m.type)).toEqual(['welcome']);
    expect(sent(socket)[0]!.payload).not.toHaveProperty('update_offer');
    expect(mocks.journal).toHaveBeenCalledWith('v2.ota.error', expect.objectContaining({ reason: 'hello_failed' }));
  });

  it('check_update answers update_offer or offer null, and a repeat within a minute gets the same answer', async () => {
    mocks.offerOnHello.mockResolvedValue(null);
    const { socket, session } = await helloWith('hello');
    socket.send.mockClear();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mocks.currentOffer.mockResolvedValueOnce(offer).mockResolvedValue(null);
    await send(socket, session, 'check_update');
    now.mockReturnValue(1_030_000);
    await send(socket, session, 'check_update');
    expect(mocks.currentOffer).toHaveBeenCalledTimes(1);
    expect(sent(socket).map((m) => m.payload)).toEqual([fixture('update_offer').payload, fixture('update_offer').payload]);
    now.mockReturnValue(1_061_000);
    await send(socket, session, 'check_update');
    expect(sent(socket)[2]).toMatchObject({ type: 'update_offer', payload: fixture('update_offer_none').payload });
  });

  it('a device below BOB_MIN_FW_VERSION can still check and report progress', async () => {
    vi.stubEnv('BOB_MIN_FW_VERSION', '9.0.0');
    mocks.offerOnHello.mockResolvedValue(null);
    mocks.currentOffer.mockResolvedValue(offer);
    const { socket, session } = await helloWith('hello');
    expect(session.updateRequired).toBe(true);
    await send(socket, session, 'check_update');
    await send(socket, session, 'ota_progress_start');
    expect(sent(socket).map((m) => m.type)).toEqual(['welcome', 'update_required', 'update_offer']);
    expect(mocks.recordOtaStart).toHaveBeenCalledWith(expect.anything(), deviceAuth.deviceId, '0.3.0', '0.4.0');
  });

  it('only ota_progress start is recorded', async () => {
    mocks.offerOnHello.mockResolvedValue(null);
    const { socket, session } = await helloWith('hello');
    await send(socket, session, 'ota_progress_failed');
    expect(mocks.recordOtaStart).not.toHaveBeenCalled();
    await send(socket, session, 'ota_progress_start');
    expect(mocks.recordOtaStart).toHaveBeenCalledTimes(1);
  });

  it('otaOfferWire omits empty notes, clips long ones and keeps the contract key order', () => {
    expect(otaOfferWire({ ...offer, notes: null })).not.toHaveProperty('notes');
    expect(otaOfferWire({ ...offer, notes: 'x'.repeat(120) }).notes).toHaveLength(80);
    expect(Object.keys(otaOfferWire({ ...offer, notes: 'n' }))).toEqual(
      ['version', 'size', 'sha256', 'key_id', 'mandatory', 'apply_after_s', 'notes'],
    );
  });
});
