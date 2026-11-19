/**
 * TG-AGENT-HARNESS: invariants of a paired device turn in the PRODUCTION
 * shape (tests/support/paired-turn.ts): a real store, memory on, the real
 * game scope, the real turn pipeline and a real-SDK agent. Escaped defects 1
 * and 2 (docs/testing/escaped-defects.md) each break one of these.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolLoopAgent } from 'ai';
import { countMessages } from '../../src/conversations/store.ts';
import { memoryAvailable } from '../../src/memory/available.ts';
import { listUnextracted } from '../../src/memory/extract-queue.ts';
import { sessionUserId } from '../../src/voice/session-handlers.ts';
import { withUser } from '../../src/platform/db/db.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { createThread } from '../../src/conversations/thread-store.ts';
import { getConversationScope } from '../../src/conversations/scope.ts';
import { type CreateBobAgentOptions } from '@bob/ai/testing';

const slot = vi.hoisted(() => ({ build: null as null | ((opts: CreateBobAgentOptions) => ToolLoopAgent) }));

vi.mock('../../src/voice/audio/stt-tts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/voice/audio/stt-tts.ts')>()),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: vi.fn(() => false),
  transcribePcm: vi.fn(),
  synthesizeMp3: vi.fn(),
  synthesizePcm: vi.fn(),
}));
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/ai')>();
  const { createAgentHarness } = await import('../support/agent-harness.ts');
  // The shared singleton only runs on an unpaired or degraded turn: here it fails loudly.
  const singleton = createAgentHarness([[{ type: 'error', message: 'the singleton agent ran: the paired turn degraded' }]]).agent;
  return {
    ...actual,
    bobAgent: singleton,
    assistantAgent: singleton,
    createBobAgent: (opts: CreateBobAgentOptions): ToolLoopAgent => {
      if (slot.build === null) throw new Error('paired turn: no agent builder');
      return slot.build(opts);
    },
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});
// Memory on, as on every production paired turn; retrieval has no embedding provider here.
vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => true) }));
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: '[BOB MEMORY] likes rain', memories: [], dueSoon: [], degraded: false, latencyMs: 1, sourceFullText: 0, sourceSemantic: 0, sourceBoth: 0 }) })),
}));

import { words, type ScriptStep } from '../support/agent-harness.ts';
import {
  closePairedStore, openPairedStore, pairedAgent, pairedSession, runPairedTurn, stubSpeech,
  type GameMode, type PairedStore, type PairedTurnRun,
} from '../support/paired-turn.ts';

slot.build = pairedAgent;

it.each(['archived', 'unknown', 'shared', 'active-game'] as const)('never constructs Google tools for a %s device context', async (mode) => {
  const session = await pairedSession(store, mode === 'active-game' ? 'active' : 'none');
  const userId = sessionUserId(session);
  if (!userId) throw new Error('missing actor');
  if (mode === 'unknown') session.activeConversationId = 'cnv_missing';
  if (mode === 'archived') await withUser(store.db, userId, (tx) => tx.query('update bob.conversations set archived_at=now() where id=$1', [session.activeConversationId]));
  if (mode === 'shared') {
    const space = await createSpace(store.db, userId, { name: 'Shared' });
    const thread = await createThread(store.db, userId, { spaceId: space.id, title: 'Shared' });
    session.activeConversationId = `thr_${thread.id}`;
    expect((await getConversationScope(store.db, userId, session.activeConversationId))?.spaceKind).toBe('group');
  }
  const googleTools = vi.fn(async () => ({}));
  const run = await runPairedTurn(store, session, [[...words('Hello there.')]], googleTools);
  expect(googleTools).not.toHaveBeenCalled();
  expect(run.harness).not.toBeNull();
});

it('passes the persisted private device anchor to configured Google tools with memory off', async () => {
  const session = await pairedSession(store, 'none');
  session.activeConversationId = undefined;
  vi.mocked(memoryAvailable).mockResolvedValueOnce(false);
  const googleTools = vi.fn(async () => ({}));
  await runPairedTurn(store, session, [[...words('Hello there.')]], googleTools);
  expect(googleTools).toHaveBeenCalledWith(expect.objectContaining({
    userId: session.auth?.kind === 'device' ? session.auth.userId : '',
    conversationId: session.activeConversationId,
    messageId: expect.stringMatching(/^msg_/),
    allowNewOperations: true,
  }));
});

it('stores the first private user anchor before the agent runs even with automatic memory disabled', async () => {
  try {
    const session = await pairedSession(store, 'none');
    session.activeConversationId = undefined;
    vi.mocked(memoryAvailable).mockResolvedValueOnce(false);
    stubSpeech('first private turn');
    let anchorCount: Promise<number> | undefined;
    slot.build = (opts) => {
      if (session.activeConversationId) anchorCount = countMessages(store.db, session.auth?.kind === 'device' ? session.auth.userId : '', session.activeConversationId);
      return pairedAgent(opts);
    };
    const run = await runPairedTurn(store, session, [[...words('Hello there.')]]);
    expect(await anchorCount).toBe(1);
    expect(run.messages).toBe(2);
    const prompt = run.harness?.model.doStreamCalls[0]?.prompt ?? [];
    expect(JSON.stringify(prompt).split('first private turn')).toHaveLength(2);
  } finally { slot.build = pairedAgent; stubSpeech('what is the weather'); }
});

/** One step: sentence 1 (closed by the next word), a pause long enough to speak it, then the rest. */
const SLOW_REPLY: ScriptStep[] = [[...words('It is sunny today. Take'), { type: 'delay', ms: 300 }, ...words(' a light jacket.')]];
/** Audio starts on sentence 1, then the model fails. */
const FAILS_AFTER_AUDIO: ScriptStep[] = [[...words('It is sunny today. Take'), { type: 'delay', ms: 300 }, { type: 'error', message: 'model broke' }]];

let store: PairedStore;

beforeAll(async () => {
  store = await openPairedStore();
  stubSpeech('what is the weather');
});
afterAll(async () => {
  await closePairedStore(store);
});

async function turn(mode: GameMode, steps: ScriptStep[]): Promise<PairedTurnRun> {
  return runPairedTurn(store, await pairedSession(store, mode), steps);
}

/** ms from the first audio frame to the end of the agent's last step (> 0: audio came first). */
function audioLead(run: PairedTurnRun): number {
  const audio = run.frames.find((frame) => frame.type === 'audio_down');
  const lastEnd = run.harness?.timeline.filter((mark) => mark.event === 'end').at(-1);
  if (audio === undefined || lastEnd === undefined) throw new Error('the turn sent no audio or the agent never finished');
  return lastEnd.at - audio.at;
}

function completed(run: PairedTurnRun): Record<string, unknown> | undefined {
  return run.events.find((entry) => entry.event === 'v2.turn_completed');
}

describe('paired device turn invariants (production shape)', () => {
  it('releases a prepared user hold on agent failure without inventing an assistant', async () => {
    const session = await pairedSession(store, 'none');
    const userId = sessionUserId(session);
    if (!userId) throw new Error('missing owner');
    const run = await runPairedTurn(store, session, [[{ type: 'error', message: 'failed before output' }]]);
    expect(run.messages).toBe(1);
    expect(await listUnextracted(store.db, userId, 10)).toMatchObject([{ assistantText: '' }]);
  });
  it.each(['none', 'paused'] as const)('with game %s the reply streams: first audio before the agent\'s last step ends', async (mode) => {
    const run = await turn(mode, SLOW_REPLY);
    expect(run.harness).not.toBeNull();
    expect(audioLead(run)).toBeGreaterThan(100);
    expect(completed(run)).toMatchObject({ streamed: true });
    expect(run.frames.filter((frame) => frame.type === 'playback_end')).toHaveLength(1);
    expect(run.frames.some((frame) => frame.type === 'error')).toBe(false);
    expect(run.messages).toBe(2);
  });

  it('with an active game the reply does not stream: the guard sees the whole reply first', async () => {
    const run = await turn('active', SLOW_REPLY);
    expect(run.harness!.model.doStreamCalls).toHaveLength(0);
    expect(audioLead(run)).toBeLessThan(0);
    expect(completed(run)).not.toHaveProperty('streamed');
    expect(run.frames.some((frame) => frame.type === 'error')).toBe(false);
  });

  it('a model error after audio started sends no error INTERNAL: playback ends cleanly', async () => {
    const run = await turn('none', FAILS_AFTER_AUDIO);
    const types = run.frames.map((frame) => frame.type);
    expect(types).toContain('audio_down');
    expect(run.frames.filter((frame) => frame.type === 'error' && frame.code === 'INTERNAL')).toEqual([]);
    expect(types.filter((type) => type === 'playback_end')).toHaveLength(1);
    expect(run.events.find((entry) => entry.event === 'v2.turn_failed')).toMatchObject({ stage: 'agent' });
  });
});
