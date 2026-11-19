/**
 * TG-GAME-MODES (test-strategy.md §3, escaped-defects.md defects 2 and 5): one
 * row per game state, every column asserted on the real store, the real
 * resolveGameScope and both turn surfaces. A new game or mode is one new row
 * (and, for a new state, one entry in tests/support/game-states.ts SEEDS).
 * Default suite: a per-file database, a real-SDK harness agent
 * (tests/support/agent-harness.ts), injected fakes, no model, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolLoopAgent } from 'ai';
import type { WebSocket } from 'ws';
import { type CreateBobAgentOptions, ENGINE_TOOL_NAMES, gameErrOf, type GameDefinition, registerGame, unregisterGame, type GameMeta } from '@bob/ai/testing';
import type { ScriptStep } from '../support/agent-harness.ts';


const state = vi.hoisted(() => ({
  agentOpts: [] as CreateBobAgentOptions[],
  action: null as string | null,
  reply: 'reply',
}));

vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => true) }));
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: '[BOB MEMORY] lives on Oak Street', memories: [], dueSoon: [], degraded: false, latencyMs: 1, sourceFullText: 0, sourceSemantic: 0, sourceBoth: 0 }) })),
}));
vi.mock('../../src/memory/callbacks.ts', () => ({ createMemoryCallbacks: vi.fn(() => ({})) }));
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((async (importOriginal) => {
  const { createAgentHarness } = await import('../support/agent-harness.ts');
  return {
    AI_STUB_MODE: false,
    MAX_TTS_INPUT_CHARS: 700,
    audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
    // The shared singleton only runs on an unpaired or degraded turn: here it fails loudly.
    bobAgent: createAgentHarness([[{ type: 'error', message: 'the singleton agent ran: the turn degraded' }]]).agent,
    isProviderError: () => false,
    providerErrorStatus: () => undefined,
    debugLog: vi.fn(),
    isFrameDebugEnabled: () => false,
  };
} ) as Factory),
    ((() => ({ createMemoryTools: vi.fn(() => ({ remember: {}, forget: {}, list_actions: {}, complete_action: {} })) }) ) as Factory),
    ((async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/ai')>();
  const { createAgentHarness, words } = await import('../support/agent-harness.ts');
  return {
    ...actual,
    /** The real-SDK agent over the game tools the turn offered: the row's tool call (resume_game, stop_game), then the reply. */
    createBobAgent: vi.fn((opts: CreateBobAgentOptions): ToolLoopAgent => {
      state.agentOpts.push(opts);
      const tools = { ...opts.capabilityTools, ...opts.lateTools };
      const steps: ScriptStep[] = [words(state.reply)];
      if (state.action !== null) {
        if (tools[state.action] === undefined) throw new Error(`${state.action} not offered`);
        steps.unshift([{ type: 'tool', name: state.action }]);
      }
      return createAgentHarness(steps, { tools }).agent;
    }),
  };
} ) as Factory),
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
  // The real sentence splitter: without it every streamed device turn failed unseen.
  createReplySplitter: (await importOriginal<typeof import('../../src/voice/audio/stt-tts.ts')>()).createReplySplitter,
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: () => false,
  transcribePcm: vi.fn(async () => ({ text: 'remind me to buy milk', model: 'stt', seconds: 1 })),
  synthesizePcm: vi.fn(async () => ({ pcm: Buffer.alloc(3200), sourceRateHz: 44100 })),
  synthesizeMp3: vi.fn(async () => ({ mp3: Buffer.alloc(1024) })),
  downlinkFrames: vi.fn(() => [Buffer.alloc(340)]),
  // One frame per synthesis, so a streamed reply really starts playing.
  downlinkMp3Frames: vi.fn(() => [Buffer.alloc(340)]),
}));
vi.mock('../../src/voice/cardputer-conversation.ts', () => ({
  loadCardputerHistory: vi.fn(async () => []),
  persistDeviceTurn: vi.fn(async () => ({ conversationId: 'c', created: false, title: 't', userMessageId: 'm', changedAt: 1 })),
}));

import { tool } from 'ai';
import { webChat } from '../../src/conversations/chat-http.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { synthesizeMp3 } from '../../src/voice/audio/stt-tts.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { MP3_16K_MONO_FORMAT } from '../../src/voice/protocol.ts';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { getConversation } from '../../src/conversations/store.ts';
import { guardGameReply, rememberedEndedCount, resolveGameScope } from '../../src/voice/game-tools.ts';
import { isGameTurnInStore } from '../../src/memory/extract.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { GAME_STATE_NAMES, resetRecentlyEnded, seedGameState, SEED_GAME, type GameStateName, type SeededState } from '../support/game-states.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const toy: GameDefinition<{ n: number }> = {
  id: SEED_GAME, bands: ['little', 'kid', 'grown'], minPlayers: 1, maxPlayers: 6,
  init: () => ({ n: 1 }),
  view: (s) => ({ game: SEED_GAME, title: 'Toy', status: 'prompt', line1: `Pick ${s.n}`, scores: [] }),
  tools: (cb) => ({
    toy_score: tool({
      description: 'Score.', inputSchema: z.object({}).strict(),
      execute: async () => {
        try { return { ok: (await cb.current()) !== null, say: 'Nice one!' }; } catch (error) { return gameErrOf(error); }
      },
    }),
  }),
};
/** Title 'Toy' and cue 'Toy says': the title alone must never count as an off-script cue. */
const TOY_META: GameMeta = { title: 'Toy', pitch: 'A toy game.', cues: ['Toy says'], advance: 'toy_score' };

/** Fails the kids filter (S8) only; fails the cue guard (S1) only. */
const URL_REPLY = 'Sure, the recipe is at www.example.com';
const CUE_REPLY = 'Toy says, clap!';

/** One game state and everything a turn in it must do. */
interface Row {
  state: GameStateName;
  /** S8 and S1 guard the turn's reply (scope turn state after the row's action). */
  kids: boolean; cues: boolean;
  /** Device: reply text reached the sentence stream (v2.turn_completed streamed).
   *  Held: the web reader and every device TTS input see only checked text. */
  streamed: boolean; held: boolean;
  /** Memory tools offered; the web turn reaches extraction (enqueued and not inside a game). */
  memoryTools: boolean; extracted: boolean;
  /** The game keys the device turn offers. */
  tools: string[];
  /** recentlyEnded after the device turn; every row starts with one stale entry. */
  ended: number;
}

const NONE = ['list_games', 'start_game'];
const PAUSED = ['list_games', 'resume_game', 'start_game', 'stop_game'];
const ACTIVE = [...ENGINE_TOOL_NAMES, 'toy_score'].sort();
const off = { kids: false, cues: false, streamed: true, held: false, memoryTools: true, extracted: true } as const;
const inGame = { kids: true, cues: true, streamed: false, held: true, memoryTools: false, extracted: false } as const;

const ROWS: Row[] = [
  { state: 'none', ...off, tools: NONE, ended: 1 },
  { state: 'active', ...inGame, tools: ACTIVE, ended: 1 },
  // Paused a minute ago: normal conversation, but still inside S3c's window, so not extracted.
  { state: 'paused', ...off, extracted: false, tools: PAUSED, ended: 1 },
  { state: 'paused_idle', ...off, tools: PAUSED, ended: 1 },
  // resume_game in the turn: guarded and held from then on, on both surfaces. Memory
  // tools were offered before the model ran; they refuse once the game opens.
  { state: 'resumed', ...inGame, memoryTools: true, tools: PAUSED, ended: 1 },
  // stop_game in the turn: the stale entry goes, this game's comes.
  { state: 'stopped', ...inGame, tools: ACTIVE, ended: 1 },
  { state: 'ended', ...off, tools: ['list_games', 'play_again', 'start_game'], ended: 1 },
  { state: 'ended_stale', ...off, tools: NONE, ended: 1 },
];

const worker = { enqueue: vi.fn(), scanUnprocessed: vi.fn(async () => 0), idle: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };

function deviceSession(userId: string, conversationId: string): DeviceSession {
  const session = createSession({ kind: 'device', userId, deviceId: 'dev', name: 'cardputer' });
  Object.assign(session, { stage: 'responding', turnRef: 'turn_dev', activeConversationId: conversationId, formatId: MP3_16K_MONO_FORMAT, audioChunks: [Buffer.alloc(320)] });
  return session;
}

/** Runs one web turn and returns what the reader was streamed. */
async function webTurn(userId: string, conversationId: string): Promise<string> {
  const written: string[] = [];
  const res = { statusCode: 200, writableEnded: false, status() { return this; }, setHeader: vi.fn(),
    write: vi.fn((chunk: Buffer | string) => { written.push(String(chunk)); return true; }),
    end() { this.writableEnded = true; }, json: vi.fn(), on() { return this; } };
  await webChat(appDeps)({ body: { id: conversationId, message: { id: `msg-${conversationId}`, role: 'user', parts: [{ type: 'text', text: 'remind me to buy milk' }] } },
    on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, res as never);
  return written.join('');
}

let pg: TestDb;
let db: Db;

/** Whether the real scope's turn state, after the row's action, rewrites `reply`. */
async function guards(seeded: SeededState, reply: string): Promise<boolean> {
  const scope = await resolveGameScope(db, seeded.userId, { conversationId: seeded.conversationId, deviceId: null, timeZone: 'UTC' });
  if (seeded.action !== null) await (scope.tools[seeded.action]!.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, { toolCallId: 'probe', messages: [] });
  return (await guardGameReply(reply, scope.turn, vi.fn())) !== reply;
}

/** Seeds `row.state` once per probe (each probe changes its game) and measures every column. */
async function measure(row: Row): Promise<Row> {
  const kids = await guards(await seedGameState(pg, db, row.state, Date.now()), URL_REPLY);
  const cues = await guards(await seedGameState(pg, db, row.state, Date.now()), CUE_REPLY);
  state.reply = URL_REPLY;

  resetRecentlyEnded(Date.now());
  const device = await seedGameState(pg, db, row.state, Date.now());
  state.action = device.action;
  const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  const lines: string[] = [];
  vi.mocked(synthesizeMp3).mockClear();
  setJournalSink((line) => lines.push(line));
  await runTurn(appDeps.turn, socket, deviceSession(device.userId, device.conversationId), 'turn_dev', worker).finally(() => setJournalSink(null));
  const completed = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === 'v2.turn_completed');
  if (completed.length !== 1) throw new Error(`the device turn journalled ${completed.length} v2.turn_completed`);
  const spoken = vi.mocked(synthesizeMp3).mock.calls.map(([text]) => String(text));
  const ended = rememberedEndedCount();
  const opts = state.agentOpts[0]!;
  const offered = [...Object.keys(opts.capabilityTools ?? {}), ...Object.keys(opts.lateTools ?? {})];
  if (row.state === 'active') expect(offered).not.toContain('list_timeline');
  const tools = [...new Set(offered.filter((key) => (ACTIVE as string[]).includes(key)))].sort();

  const web = await seedGameState(pg, db, row.state, Date.now());
  state.action = web.action;
  worker.enqueue.mockClear();
  const body = await webTurn(web.userId, web.conversationId);
  const messages = (await getConversation(db, web.userId, web.conversationId))!.messages.filter((m) => m.role === 'user');
  const inStore = await isGameTurnInStore(db, web.userId,
    { messageId: messages.at(-1)!.id, conversationId: web.conversationId, surface: 'web_text', userText: '', assistantText: '' });
  return {
    state: row.state, kids, cues, streamed: completed[0]!.streamed === true,
    held: !body.includes('www.example.com') && spoken.length > 0 && !spoken.some((text) => text.includes('www.example.com')),
    memoryTools: opts.memoryTools !== undefined, extracted: worker.enqueue.mock.calls.length > 0 && !inStore, tools, ended,
  };
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
  appDeps.memoryWorker = worker;
  registerGame(toy, TOY_META);
});
afterAll(async () => {
  unregisterGame(SEED_GAME);
  await closeTestDb(pg).catch(() => undefined);
});
afterEach(() => {
  state.agentOpts.length = 0;
  state.action = null;
});

describe('every game state, every column', () => {
  it('has one row per seeded state', () => {
    expect(ROWS.map((row) => row.state).sort()).toEqual([...GAME_STATE_NAMES].sort());
  });

  it.each(ROWS)('$state', async (row) => {
    expect(await measure(row)).toEqual(row);
  });
});
