/**
 * GAME-TOOL-GATE-WEB (escaped-defects.md defect 8, web side): a web chat turn
 * picks its tools before the model runs. In a PAUSED game the memory tools are
 * offered; once the model calls resume_game they must refuse (S3: an active
 * game offers no memory tool), exactly as the device turn does. Real store,
 * real resolveGameScope, a real-SDK harness agent (tests/support/agent-harness.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolLoopAgent } from 'ai';
import type { CreateBobAgentOptions } from '@bob/ai/testing';
import type { ScriptStep } from '../support/agent-harness.ts';

const state = vi.hoisted(() => ({ steps: [] as ScriptStep[], offered: [] as string[], remember: { calls: 0 } }));

vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => true) }));
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: null, memories: [], dueSoon: [], degraded: false, latencyMs: 1, sourceFullText: 0, sourceSemantic: 0, sourceBoth: 0 }) })),
}));
vi.mock('../../src/memory/callbacks.ts', () => ({ createMemoryCallbacks: vi.fn(() => ({})) }));
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
    audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
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
    createBobAgent: vi.fn((opts: CreateBobAgentOptions): ToolLoopAgent => {
      const tools = { ...opts.memoryTools, ...opts.capabilityTools, ...opts.lateTools };
      state.offered = Object.keys(tools);
      return createAgentHarness(state.steps, { tools }).agent;
    }),
  };
}) as Factory,
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});
vi.mock('../../src/spaces/store.ts', () => ({ ensurePrivateSpace: vi.fn(async () => ({ id: 'space_private_1' })) }));
vi.mock('../../src/spaces/active.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/spaces/active.ts')>();
  return { ...actual, getActiveSpace: vi.fn(async () => null) };
});

import { tool } from 'ai';
import { webChat } from '../../src/conversations/chat-http.ts';
import { CLOSED_IN_GAME } from '../../src/voice/game-tools.ts';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { seedGameState, SEED_GAME, type GameStateName } from '../support/game-states.ts';
import { words } from '../support/agent-harness.ts';
import type { GameDefinition } from '@bob/ai/testing';
import { registerGame, unregisterGame } from '@bob/ai/testing';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const toy: GameDefinition<{ n: number }> = {
  id: SEED_GAME, bands: ['little', 'kid', 'grown'], minPlayers: 1, maxPlayers: 6,
  init: () => ({ n: 1 }),
  view: (s) => ({ game: SEED_GAME, title: 'Toy', status: 'prompt', line1: `Pick ${s.n}`, scores: [] }),
  tools: () => ({ toy_score: tool({ description: 'Score.', inputSchema: z.object({}).strict(), execute: async () => ({ ok: true, say: 'Nice one!' }) }) }),
};

const RESUME: ScriptStep = [{ type: 'tool', name: 'resume_game' }];
const REMEMBER: ScriptStep = [{ type: 'tool', name: 'remember', input: { text: 'likes riddles' } }];

const worker = { enqueue: vi.fn(), scanUnprocessed: vi.fn(async () => 0), idle: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };

let pg: TestDb;
let db: Db;

/** Runs one web turn in `seed` and returns the outputs its tools streamed, by tool name. */
async function webTurn(seed: GameStateName, steps: ScriptStep[]): Promise<Record<string, unknown[]>> {
  state.steps = steps;
  const { userId, conversationId } = await seedGameState(pg, db, seed, Date.now());
  const written: string[] = [];
  const res = { statusCode: 200, writableEnded: false, status() { return this; }, setHeader: vi.fn(),
    write: vi.fn((chunk: Buffer | string) => { written.push(String(chunk)); return true; }),
    end() { this.writableEnded = true; }, json: vi.fn(), on() { return this; } };
  await webChat(appDeps)({ body: { id: conversationId, message: { id: `msg-${conversationId}`, role: 'user', parts: [{ type: 'text', text: 'remember I like riddles' }] } },
    on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, res as never);
  const parts = written.join('').split('\n\n').filter((event) => event.startsWith('data: {'))
    .map((event) => JSON.parse(event.slice(6)) as { type: string; toolCallId?: string; toolName?: string; output?: unknown });
  const names = new Map(parts.filter((part) => part.toolName !== undefined).map((part) => [part.toolCallId, part.toolName!]));
  const outputs: Record<string, unknown[]> = {};
  for (const part of parts.filter((p) => p.type === 'tool-output-available')) {
    (outputs[names.get(part.toolCallId) ?? '?'] ??= []).push(part.output);
  }
  return outputs;
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
  appDeps.memoryWorker = worker;
  registerGame(toy, { title: 'Toy', pitch: 'A toy game.', cues: ['Toy says'], advance: 'toy_score' });
});
afterAll(async () => {
  unregisterGame(SEED_GAME);
  await closeTestDb(pg).catch(() => undefined);
});
afterEach(() => { state.remember.calls = 0; });

describe('a paused game resumed inside a web chat turn', () => {
  it('withholds personal timeline during an active game', async () => {
    await webTurn('active', [words('Your turn!')]);
    expect(state.offered).not.toContain('list_timeline');
    expect(state.offered).toContain('stop_game');
  });

  it('closes a previously offered timeline tool when the game resumes', async () => {
    const outputs = await webTurn('resumed', [RESUME, [{ type: 'tool', name: 'list_timeline', input: { day: '2026-10-23', timeZone: 'UTC' } }], words('Your turn!')]);
    expect(state.offered).toContain('list_timeline');
    expect(outputs.list_timeline).toEqual([CLOSED_IN_GAME]);
  });
  it('a memory tool offered before resume_game refuses once the game is open', async () => {
    const outputs = await webTurn('resumed', [RESUME, REMEMBER, words('Your turn!')]);
    expect(outputs.resume_game).toHaveLength(1);
    expect(state.remember.calls).toBe(0);
    expect(outputs.remember).toEqual([CLOSED_IN_GAME]);
  });

  it('with no game opened the same memory tool runs', async () => {
    const outputs = await webTurn('paused', [REMEMBER, words('Got it.')]);
    expect(state.remember.calls).toBe(1);
    expect(outputs.remember).toEqual([{ stored: true }]);
  });
});
