/**
 * CP-SRV-SHORT: a clip too short to transcribe, or one the STT provider
 * rejects with a 4xx, ends like an empty turn ("I did not hear anything"),
 * never with an INTERNAL error. Uses the real audio byte helpers and the real
 * provider-error predicates; only the provider calls are mocked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  GatewayFailedDependencyError,
  GatewayInternalServerError,
  GatewayInvalidRequestError,
  GatewayModelNotFoundError,
} from '@ai-sdk/gateway';
import { NoTranscriptGeneratedError } from 'ai';
import type { SessionDto } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { closeDb, setSharedDb } from '../../src/platform/db/db.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';


vi.mock('../../src/voice/audio/stt-tts.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/voice/audio/stt-tts.ts')>();
  return {
    ...actual,
    transcribePcm: vi.fn(),
    synthesizePcm: vi.fn(),
    synthesizeMp3: vi.fn(),
    downlinkFrames: vi.fn(),
    downlinkMp3Frames: vi.fn(),
  };
});


vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((async (importOriginal) => {
  const errors = await importOriginal<typeof import('@bob/ai')>();
  return {
    bobAgent: { generate: vi.fn() },
    BOB_SYSTEM_TEST_MODE: false,
    AI_STUB_MODE: false,
    isProviderError: errors.isProviderError,
    providerErrorStatus: errors.providerErrorStatus,
    debugLog: vi.fn(),
    isFrameDebugEnabled: () => false,
  };
} ) as Factory),
    ((async (importOriginal) => {
  const { bobAgent: mockAgent } = await importOriginal<typeof import('@bob/ai')>();
  return {
    createBobAgent: vi.fn(() => mockAgent),
    bobAgent: mockAgent,
    assistantAgent: mockAgent,
    chatModel: {},
    gateway: Object.assign(vi.fn(() => ({})), { embeddingModel: vi.fn(() => ({})) }),
    logAgentConfig: vi.fn(),
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

import { MIN_STT_PCM_BYTES, downlinkFrames, synthesizeMp3, synthesizePcm, transcribePcm } from '../../src/voice/audio/stt-tts.ts';
import { bobAgent, BOB_TTS_VOICE } from '@bob/ai';

import { createAppDeps } from '../../src/app-deps.ts';
// Deterministic regardless of the ambient BOB_TTS_CACHE (#909: the dev .env
// is no longer loaded under vitest anyway; this stub is belt and braces).
// createAppDeps() reads it once, synchronously, to decide the TTS cache
// wiring -- so the stub must bracket exactly this call, not a beforeEach.
vi.stubEnv('BOB_TTS_CACHE', '');
const appDeps = createAppDeps();
vi.unstubAllEnvs();
const EMPTY_REPLY = 'I did not hear anything. Please try again.';

function fakeSocket(): WebSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket;
}

function respondingSession(pcmBytes: number): SessionDto {
  const session = createSession();
  session.stage = 'responding';
  session.turnRef = 'turn_short1';
  session.audioChunks = [Buffer.alloc(pcmBytes)];
  session.totalAudioBytes = pcmBytes;
  return session;
}

function sentText(socket: WebSocket): string[] {
  return vi.mocked(socket.send).mock.calls
    .map((call) => call[0])
    .filter((frame): frame is string => typeof frame === 'string');
}

// The turn paths under test record a turn metric through getDb(), so the file
// shares one real test database with getDb(). Those writes are fire-and-forget
// and these turns end fast; closeTestDb waits for the ones still in flight.
let pg: TestDb;
beforeAll(async () => {
  pg = await createTestDb();
  setSharedDb(Promise.resolve(asDb(pg)));
});
afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('runTurn with too-short or provider-rejected audio', () => {
  const journals: string[] = [];
  let socket: WebSocket;

  beforeEach(() => {
    journals.length = 0;
    setJournalSink((line) => journals.push(line));
    socket = fakeSocket();
    vi.mocked(transcribePcm).mockResolvedValue({ text: 'user said this', model: 'stt-1', seconds: 1 });
    vi.mocked(bobAgent.generate).mockResolvedValue({
      text: 'reply text', toolCalls: [], modelId: 'model-x',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never);
    vi.mocked(synthesizePcm).mockResolvedValue({ pcm: Buffer.alloc(3200), sourceRateHz: 16000 });
    vi.mocked(downlinkFrames).mockReturnValue([Buffer.alloc(340)]);
  });

  afterEach(() => {
    setJournalSink(null);
    vi.clearAllMocks();
  });

  it('sets the minimum at 300 ms of PCM16 16 kHz mono', () => {
    expect(MIN_STT_PCM_BYTES).toBe(9_600);
  });

  it('a 320-byte (10 ms) turn never calls STT and gets the empty-turn reply, no error', async () => {
    await runTurn(appDeps.turn, socket, respondingSession(320), 'turn_short1');

    expect(transcribePcm).not.toHaveBeenCalled();
    expect(bobAgent.generate).not.toHaveBeenCalled();
    expect(synthesizePcm).toHaveBeenCalledWith(EMPTY_REPLY, undefined, BOB_TTS_VOICE);
    const sent = sentText(socket);
    expect(sent.some((line) => line.includes('"type":"reply_text"') && line.includes(EMPTY_REPLY))).toBe(true);
    expect(sent.some((line) => line.includes('"type":"error"'))).toBe(false);
    const journalText = journals.join('\n');
    const tooShort = journals.find((line) => line.includes('v2.turn_too_short'));
    expect(tooShort).toContain('"pcm_bytes":320');
    expect(tooShort).toContain('"turn_id":"turn_short1"');
    expect(journalText).toContain('v2.turn_completed');
    expect(journalText).not.toContain('v2.turn_failed');
  });

  it('a turn just under the minimum is still too short', async () => {
    await runTurn(appDeps.turn, socket, respondingSession(MIN_STT_PCM_BYTES - 2), 'turn_short1');
    expect(transcribePcm).not.toHaveBeenCalled();
  });

  it('a turn at the minimum goes to STT', async () => {
    await runTurn(appDeps.turn, socket, respondingSession(MIN_STT_PCM_BYTES), 'turn_short1');
    expect(transcribePcm).toHaveBeenCalledTimes(1);
    expect(journals.join('\n')).not.toContain('v2.turn_too_short');
  });

  function wakeSession(pcm: Buffer): SessionDto {
    const session = respondingSession(pcm.length);
    session.audioChunks = [pcm];
    session.deviceState = { volume: 10, muted: false, mode: 'wake', dnd: false };
    return session;
  }

  function quietVoice(dc = 0): Buffer {
    const pcm = Buffer.alloc(32_000);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(dc + Math.round(32 * Math.sin(2 * Math.PI * 220 * i / 16_000)), i * 2);
    return pcm;
  }

  function expectQuietEnd(session: SessionDto): void {
    expect(bobAgent.generate).not.toHaveBeenCalled();
    expect(synthesizePcm).not.toHaveBeenCalled();
    expect(synthesizeMp3).not.toHaveBeenCalled();
    const sent = sentText(socket);
    expect(sent.some((line) => line.includes('"type":"reply_text"') && line.includes('"heard":""') && line.includes('"reply":""'))).toBe(true);
    expect(sent.some((line) => line.includes('"type":"status"') && line.includes('"stage":"idle"'))).toBe(true);
    expect(sent.some((line) => line.includes('"type":"playback_start"'))).toBe(false);
    expect(session.stage).toBe('ready');
    expect(session.turnRef).toBeUndefined();
    expect(session.audioChunks).toEqual([]);
    expect(session.messages).toEqual([]);
  }

  it.each(['silence', 'dc', 'click', 'empty', 'short'] as const)('wake-mode %s ends quietly without STT, agent or TTS', async (kind) => {
    const pcm = Buffer.alloc(kind === 'empty' ? 0 : kind === 'short' ? 320 : 32_000);
    if (kind === 'dc') for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(8000, i);
    if (kind === 'click') pcm.writeInt16LE(32000, 1600);
    const session = wakeSession(pcm);
    await runTurn(appDeps.turn, socket, session, 'turn_short1');
    expect(transcribePcm).not.toHaveBeenCalled();
    expectQuietEnd(session);
  });

  it('wake-mode empty STT ends quietly and clears the turn', async () => {
    vi.mocked(transcribePcm).mockResolvedValue({ text: '  ', model: 'stt-1', seconds: 1 });
    const session = wakeSession(quietVoice());
    await runTurn(appDeps.turn, socket, session, 'turn_short1');
    expect(transcribePcm).toHaveBeenCalledTimes(1);
    expectQuietEnd(session);
  });

  it('wake-mode provider no-transcript rejection sends no MP3 and clears the turn', async () => {
    vi.mocked(transcribePcm).mockRejectedValue(new NoTranscriptGeneratedError({ responses: [] }));
    const session = wakeSession(quietVoice());
    session.formatId = 2;
    await runTurn(appDeps.turn, socket, session, 'turn_short1');
    expect(transcribePcm).toHaveBeenCalledTimes(1);
    expectQuietEnd(session);
  });

  it.each([0, 8000])('quiet AC input with DC offset %i still reaches STT and the agent', async (dc) => {
    await runTurn(appDeps.turn, socket, wakeSession(quietVoice(dc)), 'turn_short1');
    expect(transcribePcm).toHaveBeenCalledTimes(1);
    expect(bobAgent.generate).toHaveBeenCalledTimes(1);
    expect(synthesizePcm).toHaveBeenCalledTimes(1);
  });

  async function expectDidntHear(error: unknown): Promise<void> {
    vi.mocked(transcribePcm).mockRejectedValue(error);
    const socket = fakeSocket();
    journals.length = 0;
    vi.mocked(synthesizePcm).mockClear();
    await runTurn(appDeps.turn, socket, respondingSession(32_000), 'turn_short1');
    expect(bobAgent.generate).not.toHaveBeenCalled();
    expect(synthesizePcm).toHaveBeenCalledWith(EMPTY_REPLY, undefined, BOB_TTS_VOICE);
    const sent = sentText(socket);
    expect(sent.some((line) => line.includes('"type":"reply_text"') && line.includes(EMPTY_REPLY))).toBe(true);
    expect(sent.some((line) => line.includes('"type":"error"'))).toBe(false);
    expect(journals.join('\n')).not.toContain('v2.turn_failed');
  }

  async function expectErrorPath(error: unknown): Promise<void> {
    vi.mocked(transcribePcm).mockRejectedValue(error);
    const socket = fakeSocket();
    journals.length = 0;
    vi.mocked(synthesizePcm).mockClear();
    await runTurn(appDeps.turn, socket, respondingSession(32_000), 'turn_short1');
    expect(synthesizePcm).not.toHaveBeenCalled();
    expect(sentText(socket).at(-1)).toContain('"code":"INTERNAL"');
    expect(journals.join('\n')).toContain('v2.turn_failed');
    expect(journals.join('\n')).not.toContain('v2.turn_stt_rejected');
  }

  it('an STT provider 400 gets the empty-turn reply, journaled as v2.turn_stt_rejected', async () => {
    await expectDidntHear(new GatewayInternalServerError({ statusCode: 400 }));
    const rejected = journals.find((line) => line.includes('v2.turn_stt_rejected'));
    expect(rejected).toContain('"upstream_status":400');
    expect(rejected).toContain('"kind":"upstream_error"');
    expect(rejected).toContain('"turn_id":"turn_short1"');
    expect(journals.join('\n')).toContain('v2.turn_stage_stt_failed');
  });

  it.each([413, 415, 422])('an STT provider %i (refused our audio) gets the empty-turn reply', async (statusCode) => {
    await expectDidntHear(new GatewayInternalServerError({ statusCode }));
  });

  it('a typed GatewayInvalidRequestError 400 (kind invalid_input) gets the empty-turn reply', async () => {
    await expectDidntHear(new GatewayInvalidRequestError({ statusCode: 400 }));
    expect(journals.find((line) => line.includes('v2.turn_stt_rejected'))).toContain('"kind":"invalid_input"');
  });

  it.each([401, 403, 404, 408, 424, 429, 500, 503])('an STT provider %i keeps the INTERNAL error path', async (statusCode) => {
    await expectErrorPath(new GatewayInternalServerError({ statusCode }));
  });

  it('a wrong model id (GatewayModelNotFoundError 404) fails loudly', async () => {
    await expectErrorPath(new GatewayModelNotFoundError({ statusCode: 404, modelId: 'nope' }));
  });

  it('a failed dependency (GatewayFailedDependencyError 424) fails loudly', async () => {
    await expectErrorPath(new GatewayFailedDependencyError({ statusCode: 424 }));
  });

  it('a timeout or a status-less error keeps the INTERNAL error path', async () => {
    await expectErrorPath(Object.assign(new Error('late'), { name: 'TimeoutError' }));
    await expectErrorPath(new Error('boom'));
  });

  it('a provider NoTranscriptGeneratedError gets the empty-turn reply, no INTERNAL error (#898)', async () => {
    await expectDidntHear(new NoTranscriptGeneratedError({ responses: [] }));
    // log-reference.md's stt_completed fields (model, seconds) still apply:
    // no SttResult came back, so the configured model and the clip's own
    // length stand in.
    const completed = journals.find((line) => line.includes('v2.turn_stage_stt_completed'));
    expect(completed).toContain('"model"');
    expect(completed).toContain('"seconds"');
  });
});
