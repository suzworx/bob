/**
 * GAME-RESUME-STREAM (escaped-defects.md defect 8): an MP3 device turn in a
 * PAUSED game streams, because the stream decision is made before the model
 * runs. When the model calls resume_game, nothing after it may reach the
 * device without the kids filter (S8) and cue guard (S1). Real store, real
 * resolveGameScope, a real-SDK harness agent (tests/support/agent-harness.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolLoopAgent } from 'ai';
import type { WebSocket } from 'ws';
import type { CreateBobAgentOptions } from '@bob/ai/testing';
import type { ScriptStep } from '../support/agent-harness.ts';


const state = vi.hoisted(() => ({ steps: [] as ScriptStep[], remember: { calls: 0 }, marketing: { calls: 0 } }));

vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => true) }));
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: null, memories: [], dueSoon: [], degraded: false, latencyMs: 1, sourceFullText: 0, sourceSemantic: 0, sourceBoth: 0 }) })),
}));
vi.mock('../../src/memory/callbacks.ts', () => ({ createMemoryCallbacks: vi.fn(() => ({})) }));
vi.mock('../../src/voice/turn/tools.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/voice/turn/tools.ts')>();
  const { tool } = await import('ai');
  return { ...actual, appTurnTools: vi.fn(async () => ({ save_draft: tool({
    description: 'Save a draft.', inputSchema: z.object({}), execute: async () => { state.marketing.calls += 1; return { ok: true }; },
  }) })) };
});
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  const original = await importOriginal<typeof import('@bob/ai')>();
  type Factory = (orig: typeof importOriginal) => unknown;
  const factories: Factory[] = [
    (async (importOriginal) => {
  const { createAgentHarness } = await import('../support/agent-harness.ts');
  return {
    AI_STUB_MODE: false,
    MAX_TTS_INPUT_CHARS: 700,
    bobAgent: createAgentHarness([[{ type: 'error', message: 'the singleton agent ran: the turn degraded' }]]).agent,
    isProviderError: () => false,
    providerErrorStatus: () => undefined,
    debugLog: vi.fn(),
    isFrameDebugEnabled: () => false,
  };
}) as Factory,
    (async (importOriginal) => {
  const { tool } = await import('ai');
  const execute = async (): Promise<{ stored: boolean }> => { state.remember.calls += 1; return { stored: true }; };
  return { createMemoryTools: vi.fn(() => ({ remember: tool({ description: 'Remember.', inputSchema: z.object({}).passthrough(), execute }) })) };
}) as Factory,
    (async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/ai')>();
  const { createAgentHarness } = await import('../support/agent-harness.ts');
  return {
    ...actual,
    /** The real-SDK agent over the tools the turn offered, running the case's script. */
    createBobAgent: vi.fn((opts: CreateBobAgentOptions): ToolLoopAgent =>
      createAgentHarness(state.steps, { tools: { ...opts.memoryTools, ...opts.capabilityTools, ...opts.lateTools } }).agent),
  };
}) as Factory,
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});
vi.mock('../../src/spaces/active.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/spaces/active.ts')>();
  return { ...actual, getActiveSpace: vi.fn(async () => null) };
});
vi.mock('../../src/voice/audio/stt-tts.ts', async (importOriginal) => ({
  createReplySplitter: (await importOriginal<typeof import('../../src/voice/audio/stt-tts.ts')>()).createReplySplitter,
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: () => false,
  transcribePcm: vi.fn(async () => ({ text: "let's keep playing", model: 'stt', seconds: 1 })),
  synthesizePcm: vi.fn(async () => ({ pcm: Buffer.alloc(3200), sourceRateHz: 44100 })),
  synthesizeMp3: vi.fn(async () => ({ mp3: Buffer.alloc(1024) })),
  downlinkFrames: vi.fn(() => [Buffer.alloc(340)]),
  downlinkMp3Frames: vi.fn(() => [Buffer.alloc(340)]),
}));
vi.mock('../../src/voice/cardputer-conversation.ts', () => ({
  loadCardputerHistory: vi.fn(async () => []),
  persistDeviceTurn: vi.fn(async () => ({ conversationId: 'c', created: false, title: 't', userMessageId: 'm', changedAt: 1 })),
}));

import { tool } from 'ai';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { synthesizeMp3 } from '../../src/voice/audio/stt-tts.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { MP3_16K_MONO_FORMAT } from '../../src/voice/protocol.ts';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { seedGameState, SEED_GAME, type GameStateName } from '../support/game-states.ts';
import { words } from '../support/agent-harness.ts';
import type { GameDefinition } from '@bob/ai/testing';
import { registerGame, unregisterGame } from '@bob/ai/testing';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
/** Per toy_score run: whether its previewed line was already sent to TTS when the tool ran (the model step is still running). */
const scoredSpoken: boolean[] = [];
const toy: GameDefinition<{ n: number }> = {
  id: SEED_GAME, bands: ['little', 'kid', 'grown'], minPlayers: 1, maxPlayers: 6,
  init: () => ({ n: 1 }),
  view: (s) => ({ game: SEED_GAME, title: 'Toy', status: 'prompt', line1: `Pick ${s.n}`, scores: [] }),
  preview: () => ({ toy_score: 'Nice one!' }),
  tools: () => ({
    toy_score: tool({
      description: 'Score.',
      inputSchema: z.object({}).strict(),
      execute: async () => {
        scoredSpoken.push(vi.mocked(synthesizeMp3).mock.calls.some(([text]) => text === 'Nice one!'));
        return { ok: true, say: 'Nice one!' };
      },
    }),
  }),
};

/** Fails the kids filter (S8) only; fails the cue guard (S1) only. */
const URL_REPLY = 'Sure, the recipe is at www.example.com.';
const CUE_REPLY = 'Toy says, clap!';
const RESUME: ScriptStep = [{ type: 'tool', name: 'resume_game' }];

/** What one device turn put on the wire and into TTS. */
interface DeviceTurn { frames: string[]; reply: string; tts: string[]; completed: Record<string, unknown> }

let pg: TestDb;
let db: Db;

async function deviceTurn(seed: GameStateName, steps: ScriptStep[]): Promise<DeviceTurn> {
  state.steps = steps;
  const { userId, conversationId } = await seedGameState(pg, db, seed, Date.now());
  const session = createSession({ kind: 'device', userId, deviceId: 'dev', name: 'cardputer' }) as DeviceSession;
  Object.assign(session, { stage: 'responding', turnRef: 'turn_dev', activeConversationId: conversationId, formatId: MP3_16K_MONO_FORMAT, audioChunks: [Buffer.alloc(320)] });
  const sent: unknown[] = [];
  const socket = { readyState: 1, send: vi.fn((data: unknown) => sent.push(data)) } as unknown as WebSocket;
  const lines: string[] = [];
  vi.mocked(synthesizeMp3).mockClear();
  setJournalSink((line) => lines.push(line));
  await runTurn(appDeps.turn, socket, session, 'turn_dev', { enqueue: vi.fn(), scanUnprocessed: vi.fn(async () => 0), idle: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) })
    .finally(() => setJournalSink(null));
  const dtos = sent.map((data) => (typeof data === 'string' ? JSON.parse(data) as { type: string; payload: { reply?: string } } : null));
  const texts = dtos.filter((dto) => dto?.type === 'reply_text');
  expect(texts).toHaveLength(1);
  const completed = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === 'v2.turn_completed');
  expect(completed).toHaveLength(1);
  return {
    frames: dtos.map((dto) => dto?.type ?? 'audio_down'),
    reply: texts[0]!.payload.reply!,
    tts: vi.mocked(synthesizeMp3).mock.calls.map(([text]) => String(text)),
    completed: completed[0]!,
  };
}

/** One playback_start before any audio, one playback_end after all of it. */
function expectValidPlayback(frames: string[]): void {
  const played = frames.filter((type) => type === 'playback_start' || type === 'playback_end' || type === 'audio_down');
  expect(played[0]).toBe('playback_start');
  expect(played.at(-1)).toBe('playback_end');
  expect(played.filter((type) => type === 'playback_start')).toHaveLength(1);
  expect(played.filter((type) => type === 'playback_end')).toHaveLength(1);
  expect(played.filter((type) => type === 'audio_down').length).toBeGreaterThan(0);
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
  registerGame(toy, { title: 'Toy', pitch: 'A toy game.', cues: ['Toy says'], advance: 'toy_score' });
});
afterAll(async () => {
  unregisterGame(SEED_GAME);
  await closeTestDb(pg).catch(() => undefined);
});
afterEach(() => { state.remember.calls = 0; state.marketing.calls = 0; scoredSpoken.length = 0; });

describe('a paused game resumed inside a streamed device turn', () => {
  it.each([['kids filter', URL_REPLY], ['cue guard', CUE_REPLY]])('the %s changes the reply before any of it is spoken', async (_guard, reply) => {
    const turn = await deviceTurn('resumed', [RESUME, words(reply)]);
    expect(turn.reply).not.toBe(reply);
    expect(turn.reply).not.toContain(reply.slice(0, 8));
    expect(turn.tts.join(' ')).toBe(turn.reply);
    expect(turn.completed.streamed).toBeUndefined();
    expectValidPlayback(turn.frames);
    // The batch path: the screen's copy goes out before the audio starts.
    expect(turn.frames.indexOf('reply_text')).toBeLessThan(turn.frames.indexOf('playback_start'));
  });

  it('text said before resume_game streams; the rest is guarded into the same playback', async () => {
    const turn = await deviceTurn('resumed', [[...words('Okay, back to the game.'), ...RESUME], words(URL_REPLY)]);
    expect(turn.completed.streamed).toBe(true);
    expect(turn.tts[0]).toBe('Okay, back to the game.');
    expect(turn.reply.startsWith('Okay, back to the game. ')).toBe(true);
    expect(turn.reply).not.toContain('www.example.com');
    expect(turn.tts.some((text) => text.includes('www.example.com'))).toBe(false);
    expect(turn.tts.join(' ')).toBe(turn.reply);
    expectValidPlayback(turn.frames);
  });

  it('a memory tool offered before resume_game refuses once the game is open', async () => {
    const turn = await deviceTurn('resumed', [RESUME, [{ type: 'tool', name: 'remember' }], words('Your turn!')]);
    expect(state.remember.calls).toBe(0);
    expectValidPlayback(turn.frames);
  });

  it('Marketing works before resume_game and refuses the same offered tool once the game opens', async () => {
    const save: ScriptStep = [{ type: 'tool', name: 'save_draft' }];
    const turn = await deviceTurn('resumed', [save, RESUME, save, words('Your turn!')]);
    expect(state.marketing.calls).toBe(1);
    expectValidPlayback(turn.frames);
  });

  it('a non-game tool call between sentences still streams the whole reply', async () => {
    const turn = await deviceTurn('paused', [[...words('Let me check.'), { type: 'tool', name: 'lookup' }], words('It is sunny.')]);
    expect(turn.completed.streamed).toBe(true);
    expect(turn.reply).toBe('Let me check. It is sunny.');
    expect(turn.tts).toEqual(['Let me check.', 'It is sunny.']);
    expectValidPlayback(turn.frames);
  });
});

describe("an active game's previewed line", () => {
  it('is synthesized while the model runs, and the reply that speaks it adds no second call', async () => {
    // The silent tool call, then the model's empty turn after its result: the reply is the previewed line.
    const turn = await deviceTurn('active', [[{ type: 'tool', name: 'toy_score' }], []]);
    expect(scoredSpoken).toEqual([true]);
    expect(turn.reply).toBe('Nice one!');
    expect(turn.tts.filter((text) => text === 'Nice one!')).toHaveLength(1);
    expectValidPlayback(turn.frames);
  });
});
