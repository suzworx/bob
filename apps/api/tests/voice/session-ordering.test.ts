// CP-SRV-ORDER: every message of one socket is handled in arrival order, over
// a REAL loopback WebSocket to the REAL server. HIL run 9624: GO pressed right
// after a cancel sent turn_start + audio_up while the cancelled turn was still
// unwinding, and the frames drew a burst of SEQUENCE_GAP. The agent and the
// STT/TTS adapters are faked; nothing reaches a provider.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// `hang` makes the next agent call wait until aborted (then unwind slowly);
// `mp3Bytes` sizes the reply audio, so a big one is still streaming when the
// cancel lands. The shared and the per-turn agent are both this fake.
const { ctl, generate } = vi.hoisted(() => {
  const state = { hang: false, mp3Bytes: 2048, aborted: [] as boolean[] };
  const fake = (call: { abortSignal?: AbortSignal }): Promise<unknown> => {
    if (!state.hang) return Promise.resolve({ text: 'A short reply.', toolCalls: [] });
    state.hang = false;
    return new Promise((_, reject) => {
      call.abortSignal?.addEventListener('abort', () => {
        state.aborted.push(true);
        setTimeout(() => reject(new Error('aborted')), 50);
      });
    });
  };
  return { ctl: state, generate: fake };
});
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  AI_STUB_MODE: false,
  bobAgent: { generate },
}) ) as Factory),
    ((async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  bobAgent: { generate },
  createBobAgent: vi.fn(() => ({ generate })),
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
  transcribePcm: async () => ({ text: 'tell me a story', model: 'stt', seconds: 1 }),
  synthesizeMp3: async () => ({ mp3: Buffer.alloc(ctl.mp3Bytes) }),
}));
vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: async () => false, resetMemoryAvailability: () => undefined }));

import { SimDevice, type SimControlDto } from '../helpers/sim-device.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb } from '../../src/platform/db/db.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { PCM16_16K_MONO_FORMAT, MP3_16K_MONO_FORMAT, V2_VERSION, messageId } from '../../src/voice/protocol.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const SECRET = 'session-ordering-secret';
let pg: TestDb;
let server: Server;
let device: SimDevice;
const journal: string[] = [];

const dto = (type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): SimControlDto =>
  ({ v: V2_VERSION, type, id: messageId(type), ...extra, payload }) as SimControlDto;
const sendFrame = (sequence: number): void => {
  const payload = Buffer.alloc(320, sequence + 1);
  device.sendAudioFrame({
    header: { magic: 'OLX2', version: V2_VERSION, kind: 'audio_up', formatId: PCM16_16K_MONO_FORMAT, channels: 1, turnHandle: 1, sequence, payloadBytes: payload.length },
    payload,
  });
};
const journaled = (event: string): number => journal.filter((line) => line.includes(`"event":"${event}"`)).length;

beforeAll(async () => {
  process.env.BOB_V2_HOST = '127.0.0.1';
  process.env.DEVICE_SHARED_SECRET = SECRET;
  setJournalSink((line) => journal.push(line));
  pg = await createTestDb();
  const db = asDb(pg);
  process.env.BOB_LEGACY_DEVICE_OWNER = (await addAccount(pg)).userId;
  setSharedDb(Promise.resolve(db));
  const { createV2Server } = await import('../../src/server.ts');
  server = (await createV2Server()).server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  device = new SimDevice(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v2/cardputer`, { auth: SECRET });
  expect((await device.open()).connected).toBe(true);
  device.sendControl(dto('hello', { format_id: MP3_16K_MONO_FORMAT }));
  await device.waitFor('welcome', 15000);
}, 30000);

afterAll(async () => {
  device?.close();
  setJournalSink(null);
  getDeviceSessions().clear();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
  delete process.env.BOB_V2_HOST;
  delete process.env.DEVICE_SHARED_SECRET;
  delete process.env.BOB_LEGACY_DEVICE_OWNER;
});

describe('session message ordering', () => {
  it.each([
    { stage: 'agent', hang: true, mp3Bytes: 2048, ready: 'v2.turn_stage_agent_started' },
    { stage: 'stream', hang: false, mp3Bytes: 400_000, ready: 'v2.downlink_started' },
  ])('cancel mid-$stage + an immediate turn_start and audio_up: no SEQUENCE_GAP, every frame in order', async ({ stage, hang, mp3Bytes, ready }) => {
    device.reset();
    Object.assign(ctl, { hang, mp3Bytes });
    const before = { ready: journaled(ready), cancelled: journaled('v2.turn_cancelled'), completed: journaled('v2.turn_completed') };
    device.sendControl(dto('turn_start', {}, { turn_ref: `turn_old_${stage}` }));
    sendFrame(0);
    device.sendControl(dto('turn_end', {}, { turn_ref: `turn_old_${stage}`, seq: 0 }));
    await expect.poll(() => journaled(ready), { timeout: 10000 }).toBe(before.ready + 1);

    // GO right after the cancel: all of it goes out back to back, no waiting.
    ctl.mp3Bytes = 2048;
    device.sendControl(dto('cancel'));
    device.sendControl(dto('turn_start', {}, { turn_ref: `turn_new_${stage}` }));
    for (let sequence = 0; sequence < 10; sequence += 1) sendFrame(sequence);
    device.sendControl(dto('turn_end', {}, { turn_ref: `turn_new_${stage}`, seq: 9 }));

    await expect.poll(() => device.controlEvents().some((e) => e.type === 'playback_end' && e.turn_ref === `turn_new_${stage}`), { timeout: 15000 }).toBe(true);
    const events = device.controlEvents();
    expect(events.filter((event) => event.type === 'error').map((event) => event.payload)).toEqual([]);
    expect(events.filter((event) => event.type === 'ack' && event.turn_ref === `turn_new_${stage}`)).toHaveLength(10);
    if (hang) expect(ctl.aborted).toHaveLength(1);
    await expect.poll(() => journaled('v2.turn_completed')).toBe(before.completed + 1);
    expect(journaled('v2.turn_cancelled')).toBe(before.cancelled + 1);
    expect(journal.join('\n')).toContain('"frames":10');
    expect(journal.join('\n')).not.toContain('SEQUENCE_GAP');
  }, 30000);
});
