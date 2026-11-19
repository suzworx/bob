/**
 * test:db suite (010, T019): device-to-web memory parity end to end (US4-1,
 * SC-003, SC-005, FR-013). Runs ONLY under `npm run test:db` against the LOCAL
 * Supabase stack, where the `vector` extension and the memory schema exist. It drives the REAL server over
 * a REAL loopback WebSocket with a simulated Cardputer (helpers/sim-device.ts),
 * exactly like e2e-device-flow.test.ts, but with memory on: the marked
 * migration is applied, `memoryAvailable()` is true, and the real extraction
 * worker, real hybrid retrieval, and real bob.memories rows are exercised.
 *
 * Provider-free: the extractor and embedder are deterministic fakes (the same
 * approach as the other memory db tests), and the speech stages use the
 * system-test stubs. The agent is faked through the same seam the T012 tests
 * use -- `createBobAgent` captures its opts -- so the retrieved memory block
 * is observable on both the device and web turn paths. AI_STUB_MODE is forced
 * false in the mock so POST /api/chat runs its real retrieval path.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SimDevice, type SimControlDto } from '../helpers/sim-device.ts';
import { MIN_STT_PCM_BYTES } from '../../src/voice/audio/stt-tts.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, withUser } from '../../src/platform/db/db.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { setActive } from '../../src/conversations/active.ts';
import { listMemories } from '../../src/memory/store.ts';
import { messageId, V2_VERSION, MP3_16K_MONO_FORMAT, type AudioFrameDto } from '../../src/voice/protocol.ts';
import type { MemoryExtractionWorker } from '../../src/memory/extract.ts';
import { serverPasswordAt, setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

/** Deterministic 1536-dim near-0.5 vector: any two are cosine-close, so the
 *  semantic arm of match_memories returns the stored rows for a fake query
 *  embedding. Lives in the hoisted state so the embedder mock can use it. */
const state = vi.hoisted(() => {
  const DIMS = 1536;
  const vec = (seed: number): number[] => {
    const values: number[] = new Array(DIMS);
    for (let i = 0; i < DIMS; i += 1) {
      values[i] = 0.5 + Math.sin(seed * 7919 + i * 12.9898) * 0.01;
    }
    return values;
  };
  /** A deterministic RIFF/WAVE PCM16 mono 24 kHz 1 s clip, the same shape the
   *  system-test TTS stub produces (@bob/ai tools.ts systemTestWav). */
  const systemTestWav = (): Buffer => {
    const sampleRate = 24_000;
    const dataSize = sampleRate * 2;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataSize, 40);
    const data = Buffer.alloc(dataSize);
    const phase = (2 * Math.PI * 440) / sampleRate;
    for (let i = 0; i < dataSize / 2; i += 1) {
      data.writeInt16LE(Math.round(8000 * Math.sin(phase * i)), i * 2);
    }
    return Buffer.concat([header, data]);
  };
  return {
    DIMS,
    vec,
    systemTestWav,
    REPLY: 'understood.',
    TRANSCRIPT: 'my favorite color is teal',
    WEB_FACT: 'I prefer chai over coffee',
    memoryOn: true,
    agentOpts: [] as Array<Record<string, unknown>>,
  };
});

// @bob/ai is the module the turn paths import for the agent and the speech
// stage. AI_STUB_MODE is forced false so POST /api/chat runs its REAL retrieval
// path (the system-test early return would skip it entirely); the speech stage
// still uses the system-test stubs (canned transcript, deterministic WAV) and
// the agent is a fake with the same generate/stream shapes as the T012 tests.

// The runtime guard is toggled by the SC-005 test: the same seam the T012 tests
// use to flip memory availability without restarting the server.
vi.mock('../../src/memory/available.ts', () => ({
  memoryAvailable: vi.fn(() => Promise.resolve(state.memoryOn)),
  resetMemoryAvailability: vi.fn(),
}));

// The server builds its extraction worker with createEmbedder/createMemoryExtractor
// and retrieval with createEmbedder; both are swapped for deterministic fakes so
// the suite needs no provider (the pattern of memory-extract.db.test.ts).

// Deterministic extractor: one durable fact drawn from the user text, so a
// device turn's fact is extractable without an LLM (FR-002 off-path). The real
// exports stay: the worker imports findDuplicate from here too (#489).

// The T012 seam: createBobAgent captures its opts, so the retrieved memory
// block (memoryContext) is observable on both turn paths.
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  AI_STUB_MODE: false,
  audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
  bobAgent: {
    generate: vi.fn(async () => ({ text: state.REPLY, toolCalls: [], modelId: 'm', usage: {} })),
    stream: vi.fn(async () => streamReply(state.REPLY)),
  },
  synthesizeSpeech: vi.fn(async () => ({
    audio: state.systemTestWav().toString('base64'),
    format: 'wav',
    contentType: 'audio/wav',
  })),
  transcribeAudio: vi.fn(async () => ({
    text: process.env.BOB_SYSTEM_TEST_TRANSCRIPT ?? 'system test transcript',
    model: 'system-test-transcriber',
  })),
  BOB_STT_LANGUAGE: 'en',
  capSpeechInput: (text: string): string => text,
  isProviderError: () => false,
  providerErrorStatus: () => undefined,
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
  flushTelemetry: vi.fn(async () => undefined),
  isDebugEnabled: () => false,
  logAgentConfig: vi.fn(),
  onTelemetryError: vi.fn(),
  setDebugSink: vi.fn(),
}) ) as Factory),
    ((() => ({
  EMBEDDING_MODEL_ID: 'text-embedding-3-small',
  EMBEDDING_DIM: state.DIMS,
  createEmbedder: () => {
    let seed = 1;
    return {
      modelId: 'text-embedding-3-small',
      dim: state.DIMS,
      embed: async () => state.vec(seed++),
      embedMany: async (texts: string[]) => texts.map((text: string) => state.vec(seed++ + text.length)),
    };
  },
}) ) as Factory),
    ((async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  createMemoryExtractor: () => async (input: { userText: string }) => ({
    ops: [{ op: 'add', kind: 'fact', content: `the user ${input.userText}`, confidence: 0.9 }],
    dropped: { secret: 0, sensitive: 0 },
  }),
}) ) as Factory),
    ((() => ({
  createBobAgent: vi.fn((opts: unknown) => {
    state.agentOpts.push(opts as Record<string, unknown>);
    return {
      generate: vi.fn(async () => ({ text: state.REPLY, toolCalls: [], modelId: 'm', usage: {} })),
      stream: vi.fn(async () => streamReply(state.REPLY)),
    };
  }),
}) ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

/** A UIMessageStream of one text reply (start/text-start/delta/text-end/finish). */
function streamReply(text: string): { stream: ReadableStream } {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'start', messageId: 'a' });
        controller.enqueue({ type: 'text-start', id: 't', text: '' });
        controller.enqueue({ type: 'text-delta', id: 't', text });
        controller.enqueue({ type: 'text-end', id: 't' });
        controller.enqueue({ type: 'finish', finishReason: 'stop' });
        controller.close();
      },
    }),
  };
}

const TRANSCRIPT = state.TRANSCRIPT;
const WEB_FACT = state.WEB_FACT;
const REPLY = state.REPLY;
const DEVICE_SECRET = 'e2e-memory-secret';
const TTS_SECONDS = '1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const shell = process.platform === 'win32';

/** Counts `event` occurrences across the captured journal. */
function countJournal(event: string): number {
  return journalLines.reduce((count, line) => (JSON.parse(line).event === event ? count + 1 : count), 0);
}

/** Waits until at least `minCount` occurrences of `event` exist. */
function waitForJournalCount(event: string, minCount: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (countJournal(event) >= minCount) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for ${minCount} occurrences of '${event}'`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function wsUrl(): string {
  return `ws://127.0.0.1:${port}/v2/cardputer`;
}

function webHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function controlDto(
  type: string,
  payload: Record<string, unknown> = {},
  extra: { turn_ref?: string; seq?: number } = {},
): SimControlDto {
  return { v: V2_VERSION, type, id: messageId(type), ...extra, payload };
}

/** Non-empty PCM16 16 kHz mono sine as uplink OLX2 frames with contiguous seq. */
function sinePcmFrames(frameBytes: number, frameCount: number): AudioFrameDto[] {
  const frames: AudioFrameDto[] = [];
  const samplesPerFrame = frameBytes / 2;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const payload = Buffer.alloc(frameBytes);
    for (let sample = 0; sample < samplesPerFrame; sample += 1) {
      const phase = frameIndex * samplesPerFrame + sample;
      payload.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * phase) / 16_000)), sample * 2);
    }
    frames.push({
      header: {
        magic: 'OLX2',
        version: 1,
        kind: 'audio_up',
        formatId: 1,
        channels: 1,
        turnHandle: 1,
        sequence: frameIndex,
        payloadBytes: frameBytes,
      },
      payload,
    });
  }
  return frames;
}

/** Parses `npx supabase status -o env` output: `KEY="value"` lines only. */
function parseStatusEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)="([^"]*)"$/);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

/** The local stack's env values (never printed). */
function statusEnv(): Record<string, string> {
  const result = spawnSync(npx, ['supabase', 'status', '-o', 'env'], { cwd: ROOT, encoding: 'utf8', shell });
  if (result.error || result.status !== 0) {
    throw new Error('e2e-memory-parity: the local Supabase stack is not running (start with `npm run dev:offline`).');
  }
  return parseStatusEnv(result.stdout ?? '');
}

/** Median of a numeric array (mid-point average for even lengths). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Runs one voice turn on an already-welcomed socket; returns the
 *  end-of-speech-to-reply latency in ms (turn_end sent -> playback_start). */
async function runTimedTurn(device: SimDevice, turnRef: string): Promise<number> {
  device.reset();
  const completedBefore = countJournal('v2.turn_completed');
  device.sendControl(controlDto('turn_start', {}, { turn_ref: turnRef }));
  // Longer than the CP-SRV-SHORT floor: a turn under MIN_STT_PCM_BYTES (300 ms)
  // is dropped before STT, so no fact reaches the agent or the extractor (#435).
  const frames = sinePcmFrames(320, Math.ceil(MIN_STT_PCM_BYTES / 320) + 10);
  for (const frame of frames) device.sendAudioFrame(frame);
  const sentAt = Date.now();
  device.sendControl(controlDto('turn_end', {}, { turn_ref: turnRef, seq: frames.length - 1 }));
  await Promise.all([device.waitFor('playback_start', 30000), device.waitFor('playback_end', 30000)]);
  await waitForJournalCount('v2.turn_completed', completedBefore + 1);
  const start = device.controlEvents().find((entry) => entry.type === 'playback_start');
  if (!start) throw new Error('playback_start never arrived');
  return start.receivedAt - sentAt;
}

// --- shared suite state (helpers above reference these; set in beforeAll) ---
let port: number;
let baseUrl = '';
let worker: MemoryExtractionWorker;
let env: MemoryTestDb;
let server: Server;
let aToken = '';
let bToken = '';
let bDeviceToken = '';
let superSql: ReturnType<typeof postgres>;
let aDevice: SimDevice;
const journalLines: string[] = [];

/** Mints a JWT for `userId` via the loopback system-test issuer and makes its
 *  session active (auth.sessions row) so requireActiveSession routes pass. */
async function mintActiveWebToken(userId: string): Promise<string> {
  const issued = await fetch(`${baseUrl}/api/test-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  expect(issued.status).toBe(200);
  const { token } = (await issued.json()) as { token: string };
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {
    session_id: string;
  };
  await superSql.unsafe('insert into auth.sessions (id, user_id) values ($1, $2) on conflict (id) do nothing', [
    payload.session_id,
    userId,
  ]);
  return token;
}

/** Runs the full pairing flow for account B and returns its olxd_ device token. */
async function pairDevice(): Promise<string> {
  const unpaired = new SimDevice(wsUrl());
  expect((await unpaired.open()).connected).toBe(true);
  unpaired.sendControl(controlDto('hello', { format_id: MP3_16K_MONO_FORMAT }));
  const required = await unpaired.waitFor('pairing_required', 30000);
  expect(required.payload.reason).toBe('none');

  unpaired.sendControl(
    controlDto('pair_request', {
      model: 'M5Stack Cardputer',
      fw_version: '0.9.0',
      claim: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    }),
  );
  const pairCode = await unpaired.waitFor('pair_code', 30000);
  const userCode = pairCode.payload.user_code as string;
  const pairingId = pairCode.payload.pairing_id as string;

  const lookup = await fetch(`${baseUrl}/api/pair/lookup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...webHeaders(bToken) },
    body: JSON.stringify({ user_code: userCode }),
  });
  expect(lookup.status).toBe(200);

  const approve = await fetch(`${baseUrl}/api/pair/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...webHeaders(bToken) },
    body: JSON.stringify({ pairing_id: pairingId, name: 'B card' }),
  });
  expect(approve.status).toBe(200);

  const paired = await unpaired.waitFor('paired', 3000);
  const token = (paired.payload as { device_token: string }).device_token;
  expect(token).toMatch(/^olxd_[A-Za-z0-9_-]{43}$/);
  unpaired.close();
  return token;
}

/** Opens an already-paired device and waits for welcome (any auth kind). */
async function openDevice(device: SimDevice): Promise<void> {
  expect((await device.open()).connected).toBe(true);
  device.sendControl(controlDto('hello', { format_id: MP3_16K_MONO_FORMAT }));
  await device.waitFor('welcome', 30000);
}

describe('device-to-web memory parity (test:db)', () => {
  beforeAll(async () => {
    // 1. Bring the local stack up and create two throwaway accounts.
    env = await setupMemoryTestDb();

    // 2. The server connects as bob_server to the SAME local database; the
    //    per-machine password comes from data/offline.env, read through the
    //    harness's race-free reader (never a half-written line).
    const stackEnv = statusEnv();
    const bobUrl = new URL(stackEnv.DB_URL!);
    bobUrl.username = 'bob_server';
    bobUrl.password = await serverPasswordAt();
    process.env.BOB_DATABASE_URL = bobUrl.toString();

    // 3. Server env: system-test issuer (web tokens), legacy device account A,
    //    and the canned speech transcript/stub length.
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    process.env.DEVICE_SHARED_SECRET = DEVICE_SECRET;
    process.env.BOB_LEGACY_DEVICE_OWNER = env.a.userId;
    process.env.BOB_SYSTEM_TEST_TRANSCRIPT = TRANSCRIPT;
    process.env.BOB_SYSTEM_TEST_TTS_SECONDS = TTS_SECONDS;
    setJournalSink((line) => journalLines.push(line));

    // 4. Superuser handle for auth.sessions inserts (requireActiveSession).
    superSql = postgres(stackEnv.DB_URL!, { max: 2 });

    // 5. Seed an active conversation for BOTH accounts so every device turn
    //    has a pinned conversation and the memory context resolves from turn
    //    one (turn.ts resolves memory only when activeConversationId is set).
    for (const account of [env.a, env.b]) {
      await withUser(env.db, account.userId, async (tx) => {
        const conversation = await createConversation(tx, account.userId, 'seed');
        await setActive(tx, account.userId, conversation.id, 'web_text');
      });
    }

    // 6. Start the real server on a loopback port.
    const { createV2Server } = await import('../../src/server.ts');
    const created = await createV2Server();
    server = created.server;
    worker = created.memoryWorker;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 7. Web tokens with active sessions for both accounts.
    aToken = await mintActiveWebToken(env.a.userId);
    bToken = await mintActiveWebToken(env.b.userId);

    // 8. Account A's legacy device (shared secret) and account B's paired one.
    bDeviceToken = await pairDevice();
    aDevice = new SimDevice(wsUrl(), { auth: DEVICE_SECRET });
    await openDevice(aDevice);
  }, 120000);

  afterAll(async () => {
    aDevice?.close();
    setJournalSink(null);
    await worker?.stop().catch(() => undefined);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb().catch(() => undefined);
    await superSql?.end().catch(() => undefined);
    await env?.cleanup().catch(() => undefined);
    delete process.env.BOB_DATABASE_URL;
    delete process.env.BOB_SYSTEM_TEST;
    delete process.env.BOB_V2_HOST;
    delete process.env.DEVICE_SHARED_SECRET;
    delete process.env.BOB_LEGACY_DEVICE_OWNER;
    delete process.env.BOB_SYSTEM_TEST_TRANSCRIPT;
    delete process.env.BOB_SYSTEM_TEST_TTS_SECONDS;
  });

  it('US4-1: a fact spoken on the device is recalled on the web with surface device', async () => {
    // The device turn carries the durable fact (the canned transcript F1).
    state.agentOpts.length = 0;
    await runTimedTurn(aDevice, messageId('turn'));

    // Extraction runs off the reply path (debounced per account); wait for it.
    await worker.idle();

    // The memory row landed with the device as its origin surface.
    const { memories } = await listMemories(env.db, env.a.userId, { q: 'teal', currentOnly: true });
    expect(memories.some((memory) => memory.surface === 'device' && memory.content.includes('teal'))).toBe(true);

    // A web /api/chat turn for the SAME account retrieves it: the block that
    // reaches the agent (createBobAgent memoryContext, the T012 seam)
    // contains the fact.
    state.agentOpts.length = 0;
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...webHeaders(aToken) },
      body: JSON.stringify({
        message: { id: messageId('msg'), role: 'user', parts: [{ type: 'text', text: 'what color do I like most?' }] },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(state.agentOpts.length).toBeGreaterThan(0);
    expect(String(state.agentOpts[0]?.memoryContext ?? '')).toContain('teal');
  }, 60000);

  it('US4-1 (reverse): a fact stated on the web is recalled in a device turn', async () => {
    // State a NEW fact on the web (no conversation id: a fresh conversation).
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...webHeaders(aToken) },
      body: JSON.stringify({
        message: { id: messageId('msg'), role: 'user', parts: [{ type: 'text', text: WEB_FACT }] },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    await worker.idle();

    // The web-stated fact was extracted with the web surface.
    const { memories } = await listMemories(env.db, env.a.userId, { q: 'chai', currentOnly: true });
    expect(memories.some((memory) => memory.surface === 'web_text' && memory.content.includes('chai'))).toBe(true);

    // A later device turn retrieves it into the agent block.
    state.agentOpts.length = 0;
    await runTimedTurn(aDevice, messageId('turn'));
    expect(state.agentOpts.length).toBeGreaterThan(0);
    expect(String(state.agentOpts[0]?.memoryContext ?? '')).toContain('chai');
  }, 60000);

  it('SC-003: account B\'s device retrieves none of account A\'s memories', async () => {
    state.agentOpts.length = 0;
    const bDevice = new SimDevice(wsUrl(), { auth: bDeviceToken });
    await openDevice(bDevice);
    await runTimedTurn(bDevice, messageId('turn'));

    // B's retrieval ran (memory on) but its block carries none of A's facts:
    // A's device-spoken 'teal' and web-stated 'chai' memories are A-only (RLS on user_id).
    expect(state.agentOpts.length).toBeGreaterThan(0);
    const block = String(state.agentOpts[0]?.memoryContext ?? '');
    expect(block).not.toContain('teal');
    expect(block).not.toContain('chai');
    bDevice.close();
  }, 60000);

  it('FR-013/SC-006: the journal carries no memory content, transcript, or assistant text', () => {
    // The expected metadata events are present across the run.
    expect(countJournal('v2.memory_extracted')).toBeGreaterThanOrEqual(2);
    expect(countJournal('v2.memory_retrieved')).toBeGreaterThanOrEqual(3);
    expect(countJournal('v2.turn_completed')).toBeGreaterThanOrEqual(3);
    // But no memory text, transcript, or assistant reply ever appears.
    const forbidden = ['favorite color', 'chai', TRANSCRIPT, WEB_FACT, REPLY];
    for (const line of journalLines) {
      for (const token of forbidden) {
        expect(line).not.toContain(token);
      }
    }
  }, 60000);

  // A timing budget, not a correctness check: stdout alone can push the delta
  // past 20 ms, so a shared CI runner would flake on it. Local smoke check only
  // until it is measured on the real path (docs/testing/db-suite.md).
  it.skipIf(Boolean(process.env.CI))('SC-005: memory on adds no more than 20 ms to the median end-of-speech-to-reply', async () => {
    const turnCount = 6;
    state.memoryOn = true;
    await worker.idle();
    const enabled: number[] = [];
    // Each arm drains the extraction worker between turns: spoken turns are
    // seconds apart, so the previous turn's off-path extraction must not share
    // the local database with the next timed turn (#435).
    for (let i = 0; i < turnCount; i += 1) {
      enabled.push(await runTimedTurn(aDevice, messageId('turn')));
      await worker.idle();
    }

    state.memoryOn = false;
    await worker.idle();
    const disabled: number[] = [];
    for (let i = 0; i < turnCount; i += 1) {
      disabled.push(await runTimedTurn(aDevice, messageId('turn')));
      await worker.idle();
    }

    const enabledMedian = median(enabled);
    const disabledMedian = median(disabled);
    console.log(
      `[S10-T019] SC-005 median end-of-speech-to-reply: enabled=${enabledMedian} ms, disabled=${disabledMedian} ms`,
    );
    expect(enabledMedian - disabledMedian).toBeLessThanOrEqual(20);
  }, 120000);
});