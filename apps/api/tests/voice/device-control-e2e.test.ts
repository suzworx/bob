// Epic #311 end to end over a REAL loopback WebSocket to the REAL server
// (helpers/sim-device.ts): "turn it up" by voice pushes device_control before
// the reply plays, and a fired timer rings the device until it acks. The AI and
// the STT/TTS adapters are faked (no provider calls); everything else is real.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Tool } from 'ai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  AI_STUB_MODE: false,
}) ) as Factory),
    ((async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  // The model "decides" to call set_volume, then answers.
  createBobAgent: vi.fn((opts: { capabilityTools?: Record<string, Tool>; lateTools?: Record<string, Tool> }) => ({
    generate: async () => {
      const result = await { ...opts.capabilityTools, ...opts.lateTools }.set_volume!.execute!({ delta: 3 } as never, {} as never);
      return { text: `Done. ${(result as { message: string }).message}`, toolCalls: [] };
    },
  })),
}) ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});
vi.mock('../../src/voice/audio/stt-tts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/voice/audio/stt-tts.ts')>()),
  isEmptyTurn: () => false,
  isTooShortTurn: () => false,
  transcribePcm: async () => ({ text: 'turn it up', model: 'stt', seconds: 1 }),
  synthesizeMp3: async () => ({ mp3: Buffer.alloc(2048) }),
}));
vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: async () => true, resetMemoryAvailability: () => undefined }));
vi.mock('../../src/memory/retrieval.ts', () => ({ startMemoryRetrieval: () => ({ result: Promise.resolve({ block: null }) }) }));

import { SimDevice, type SimControlDto } from '../helpers/sim-device.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createTimer } from '../../src/timers/store.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { PCM16_16K_MONO_FORMAT, MP3_16K_MONO_FORMAT, V2_VERSION, messageId } from '../../src/voice/protocol.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const SECRET = 'e2e-device-control-secret';
const STATE = { volume: 5, muted: false, mode: 'ptt', dnd: false, battery_pct: 90, charging: true, fw_version: '2.5.0' };
let pg: TestDb;
let db: Db;
let userId: string;
let server: Server;
let device: SimDevice;
const journal: string[] = [];

const dto = (type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): SimControlDto =>
  ({ v: V2_VERSION, type, id: messageId(type), ...extra, payload }) as SimControlDto;

beforeAll(async () => {
  process.env.BOB_V2_HOST = '127.0.0.1';
  process.env.DEVICE_SHARED_SECRET = SECRET;
  setJournalSink((line) => journal.push(line));
  pg = await createTestDb();
  db = asDb(pg);
  userId = (await addAccount(pg)).userId;
  process.env.BOB_LEGACY_DEVICE_OWNER = userId;
  setSharedDb(Promise.resolve(db));
  const { createV2Server } = await import('../../src/server.ts');
  ({ server } = await createV2Server());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  device = new SimDevice(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v2/cardputer`, { auth: SECRET });
  expect((await device.open()).connected).toBe(true);
  device.sendControl(dto('hello', { format_id: MP3_16K_MONO_FORMAT }));
  await device.waitFor('welcome', 15000);
  device.sendControl(dto('device_state', STATE));
}, 30000);

afterAll(async () => {
  device?.close();
  setJournalSink(null);
  getDeviceSessions().clear();
  // server.close() also drains the memory extraction worker before it calls back.
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
  delete process.env.BOB_V2_HOST;
  delete process.env.DEVICE_SHARED_SECRET;
  delete process.env.BOB_LEGACY_DEVICE_OWNER;
});

describe('device control e2e', () => {
  it('volume by voice: device_control {volume 8} arrives before playback_start, and the reply says so', async () => {
    device.reset();
    device.sendControl(dto('turn_start', {}, { turn_ref: 'turn_e2e_vol1' }));
    const payload = Buffer.alloc(320, 7);
    device.sendAudioFrame({
      header: { magic: 'OLX2', version: V2_VERSION, kind: 'audio_up', formatId: PCM16_16K_MONO_FORMAT, channels: 1, turnHandle: 1, sequence: 0, payloadBytes: payload.length },
      payload,
    });
    device.sendControl(dto('turn_end', {}, { turn_ref: 'turn_e2e_vol1', seq: 0 }));
    await device.waitFor('playback_end', 15000);
    const order = device.controlEvents().map((event) => event.type);
    expect(order.indexOf('device_control')).toBeGreaterThan(-1);
    expect(order.indexOf('device_control')).toBeLessThan(order.indexOf('playback_start'));
    expect(order.indexOf('reply_text')).toBeLessThan(order.indexOf('playback_start'));
    expect(device.controlEvents().find((e) => e.type === 'device_control')!.payload).toEqual({ volume: 8, muted: false });
    expect(device.controlEvents().find((e) => e.type === 'reply_text')!.payload).toEqual({ heard: 'turn it up', reply: 'Done. Volume 8.' });
    // The device applies it and answers with a fresh device_state.
    device.sendControl(dto('device_state', { ...STATE, volume: 8 }));
    await expect.poll(() => getDeviceSessions().forAccount(userId)[0]?.session.deviceState?.volume).toBe(8);
    expect(journal.join('\n')).not.toContain('turn it up');
  }, 30000);

  it('a fired timer rings the device, and announce_ack clears it', async () => {
    device.reset();
    const { startDeviceScheduler } = await import('../../src/workflows/workflow-timer-ring.ts');
    const timer = await createTimer(db, userId, { durationMs: 1_000, label: 'Tea', now: Date.now() - 10_000 });
    const scheduler = await startDeviceScheduler(appDeps);
    try {
      const ring = await device.waitFor('announce', 10000);
      expect(ring.payload).toMatchObject({ announce_id: `tm_${timer.id}`, kind: 'timer', title: 'Tea', ring: true });
      device.sendControl(dto('announce_ack', { announce_id: ring.payload.announce_id as string, action: 'dismissed' }));
      await expect.poll(() => getDeviceSessions().pendingAnnouncements(userId)).toEqual([]);
    } finally {
      scheduler?.stop();
    }
  }, 30000);
});
