/**
 * Cross-interface journal-vocabulary test (SC-002, task T022): proves that a
 * Cardputer-origin turn failure and a web-origin voice failure at the SAME
 * stage (STT throwing) journal the SAME event name and the SAME
 * stage/outcome/kind naming, differing only in the `interface` field.
 *
 * Approach: both real adapters are driven end-to-end -- runTurn for the
 * Cardputer turn (audio.ts / @bob/ai mocked, exactly as turn.test.ts does)
 * and webVoice for the web voice request (transcribeAudio rejected, as
 * web-voice.test.ts does). The shared logger is mocked so every journal(event,
 * fields) call through core/turn-journal.ts is captured. The same thrown Error
 * drives both paths, so classifyFailure (core/turn-core.ts) must yield the same
 * kind/error_name for both; the assertions then prove the two journal events
 * are identical except for interface, and that neither carries the error's
 * message text (Principle II).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import { createSession } from '../../src/voice/session-handlers.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { closeDb, setSharedDb } from '../../src/platform/db/db.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { webVoice } from '../../src/voice/http.ts';
import { journal } from '../../src/platform/logger.ts';
import { isEmptyTurn, transcribePcm } from '../../src/voice/audio/stt-tts.ts';
import { transcribeAudio } from '@bob/ai';
import type { SessionDto } from '../../src/voice/protocol.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());

vi.mock('../../src/voice/audio/stt-tts.ts', () => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(),
  isTooShortTurn: vi.fn(),
  transcribePcm: vi.fn(),
  synthesizePcm: vi.fn(),
  synthesizeMp3: vi.fn(),
  downlinkFrames: vi.fn(),
  downlinkMp3Frames: vi.fn(),
}));

// Union of every @bob/ai export the two adapters and Core touch under test:
// turn.ts (bobAgent, BOB_SYSTEM_TEST_MODE, debugLog, isFrameDebugEnabled),
// web-voice.ts (transcribeAudio, synthesizeSpeech, capSpeechInput), web-schemas.ts
// (audioFormatSchema), and core/turn-core.ts's classifyFailure (isProviderError,
// providerErrorStatus). The provider predicates mirror the real ones so Core's
// classification is exercised, not bypassed.
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
  bobAgent: { generate: vi.fn() },
  BOB_SYSTEM_TEST_MODE: false,
  AI_STUB_MODE: false,
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
  transcribeAudio: vi.fn(),
  synthesizeSpeech: vi.fn(),
  capSpeechInput: vi.fn((text: string) => text),
  isProviderError: (error: unknown) =>
    error instanceof Error && (/fetch failed|timeout/i.test(error.message) || /^Gateway/.test(error.name)),
  providerErrorStatus: () => undefined,
}) ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

function fakeSocket(readyState = 1): WebSocket {
  return { readyState, send: vi.fn() } as unknown as WebSocket;
}

function respondingSession(): SessionDto {
  const session = createSession();
  session.stage = 'responding';
  session.turnRef = 'turn_abc123';
  return session;
}

function response() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    type(value: string) { this.headers['content-type'] = value; return this; },
    set(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
    end(body?: unknown) { this.body = body; },
  };
}

type JournalCall = [string, Record<string, unknown>];

/** The captured `v2.turn_stage_stt_failed` journal call for one interface. */
function sttFailedCall(iface: 'cardputer' | 'web'): JournalCall | undefined {
  return vi.mocked(journal).mock.calls.find(
    (call) => call[0] === 'v2.turn_stage_stt_failed' && call[1]?.interface === iface,
  ) as JournalCall | undefined;
}

// The turn paths under test record a turn metric through getDb(), so the file
// shares one real test database with getDb(); without it, getDb() falls back.
let pg: TestDb;
beforeAll(async () => {
  pg = await createTestDb();
  setSharedDb(Promise.resolve(asDb(pg)));
});
afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('cross-interface journal vocabulary (T022)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('journals the same stt-failed shape for cardputer and web, differing only by interface', async () => {
    // The SAME thrown error drives both paths so classifyFailure must agree.
    const boom = new Error('TOP SECRET MESSAGE PAYLOAD');

    // (a) Cardputer turn whose STT throws -- same setup as turn.test.ts.
    const cardputerSession = respondingSession();
    cardputerSession.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(transcribePcm).mockRejectedValue(boom);
    await runTurn(appDeps.turn, fakeSocket(), cardputerSession, 'turn_abc123');

    // (b) Web voice request whose STT throws -- same setup as web-voice.test.ts.
    vi.mocked(transcribeAudio).mockRejectedValue(boom);
    await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, response() as never);

    const cardputer = sttFailedCall('cardputer');
    const web = sttFailedCall('web');
    expect(cardputer).toBeDefined();
    expect(web).toBeDefined();

    // Same event name.
    expect(cardputer![0]).toBe('v2.turn_stage_stt_failed');
    expect(web![0]).toBe('v2.turn_stage_stt_failed');

    // Same stage / outcome / kind / error_name naming for the same error.
    for (const key of ['stage', 'outcome', 'kind', 'error_name'] as const) {
      expect(web![1][key]).toBe(cardputer![1][key]);
    }
    expect(cardputer![1]).toMatchObject({
      stage: 'stt',
      outcome: 'failed',
      kind: 'internal',
      error_name: 'Error',
    });

    // Differ only in the interface field.
    expect(cardputer![1].interface).toBe('cardputer');
    expect(web![1].interface).toBe('web');

    // Principle II: neither event's fields carry the thrown error's message.
    expect(JSON.stringify(cardputer![1])).not.toContain('TOP SECRET');
    expect(JSON.stringify(cardputer![1])).not.toContain('MESSAGE');
    expect(JSON.stringify(web![1])).not.toContain('TOP SECRET');
    expect(JSON.stringify(web![1])).not.toContain('MESSAGE');
  });
});