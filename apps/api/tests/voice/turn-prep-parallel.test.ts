/**
 * #898: context prep (resolveTurnMemory) must run in parallel with STT, not
 * serially before it. Voice first-audio latency: the agent's prep overlaps the
 * turn's anchor write (prepareTurn) -- memory retrieval and the capability
 * tools start while it is in flight; the history load and the Google tools,
 * which need the anchor, start once it settles. Uses plain fake deps (no DB); only context.ts's
 * resolveTurnMemory is mocked, as a manually controlled deferred promise, so
 * the test can prove deps.stt was reached while prep is still unsettled --
 * no wall-clock timing involved. TG-AGENT-HARNESS: the agent is a real
 * ToolLoopAgent from tests/support/agent-harness.ts, never a hand-written
 * stream/generate double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { Tool } from 'ai';
import type { bobAgent } from '@bob/ai';
import type { SessionDto } from '../../src/voice/protocol.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import { MIN_STT_PCM_BYTES } from '../../src/voice/audio/stt-tts.ts';
import type { TurnDeps } from '../../src/voice/turn/deps.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import type { TurnMemoryContext } from '../../src/voice/turn/context.ts';
import type { TurnCapabilities } from '../../src/voice/turn/tools.ts';
import type { ConversationScope } from '../../src/conversations/scope.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createAgentHarness, type ScriptStep } from '../support/agent-harness.ts';

vi.mock('../../src/voice/turn/context.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/voice/turn/context.ts')>()),
  resolveTurnMemory: vi.fn(),
  buildAgentMessages: vi.fn(),
  loadAgentHistory: vi.fn(),
}));
vi.mock('../../src/memory/retrieval.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/memory/retrieval.ts')>()),
  startMemoryRetrieval: vi.fn(),
  startMemoryPack: vi.fn(),
  startMemoryRecall: vi.fn(),
}));
vi.mock('../../src/voice/turn/tools.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/voice/turn/tools.ts')>()),
  buildTurnCapabilities: vi.fn(),
  googleTurnTools: vi.fn(),
}));
vi.mock('../../src/tools/policy.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tools/policy.ts')>()),
  prepareToolPolicyFilter: vi.fn(),
}));
// By default the preflight finds no marketing binding (null, set in beforeEach): no marketing tools.
vi.mock('../../src/bob-apps/marketing-turn.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/bob-apps/marketing-turn.ts')>()),
  preflightMarketingTurn: vi.fn(),
  marketingToolsForTurn: vi.fn(),
}));
import { preflightMarketingTurn, marketingToolsForTurn } from '../../src/bob-apps/marketing-turn.ts';
import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';

// A dev .env that carries OTLP settings makes the real traceSpan/withTraceContext
// take their network-bound path -- source of the original wall-clock flakiness.
// Forced synchronous here, as other turn tests already do (turn-stages.test.ts,
// http-diagnostics.test.ts).
vi.mock('@bob/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, run) => run()),
  withTraceContext: vi.fn((_attrs, fn: () => unknown) => fn()),
}));

import { buildAgentMessages, loadAgentHistory, resolveTurnMemory } from '../../src/voice/turn/context.ts';
import { startMemoryPack, startMemoryRecall, startMemoryRetrieval, type RetrievalResult } from '../../src/memory/retrieval.ts';
import { openSttStream, pushSttStream, abortSttStream } from '../../src/voice/turn/stream-stt.ts';
import type { TranscriptStream } from '@bob/ai';
import { buildTurnCapabilities, googleTurnTools } from '../../src/voice/turn/tools.ts';
import { generateReply, startEarlyPrep, takeEarlyPrep, type EarlyPrep } from '../../src/voice/turn/generate.ts';
import { handleControl } from '../../src/voice/session.ts';
import { V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { prepareToolPolicyFilter } from '../../src/tools/policy.ts';

/** A promise plus the callbacks that settle it, so a test can hold it open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Lets every pending microtask (and the current macrotask queue) drain. */
const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

type PrepResult = { memory: null; contextMs?: number };

/** One-step script: the turn's agent just answers in text, no tool call. */
const REPLY_STEPS: ScriptStep[] = [[{ type: 'text', text: 'reply text' }]];

/** A real ToolLoopAgent (tests/support/agent-harness.ts), not a hand-written
 *  stream/generate double (TG-AGENT-HARNESS). */
function replyAgent(): typeof bobAgent {
  return createAgentHarness(REPLY_STEPS).agent as unknown as typeof bobAgent;
}

/** A TurnDeps whose every seam fails loudly unless the test provides it. */
function fakeDeps(over: Partial<TurnDeps> = {}): TurnDeps {
  const unexpected = (name: string) => (): never => { throw new Error(`unexpected deps.${name}`); };
  return {
    getDb: unexpected('getDb') as TurnDeps['getDb'],
    deviceSessions: { flushPending: vi.fn() } as unknown as TurnDeps['deviceSessions'],
    timersChanged: unexpected('timersChanged') as TurnDeps['timersChanged'],
    embedder: unexpected('embedder') as TurnDeps['embedder'],
    stt: unexpected('stt') as TurnDeps['stt'],
    ttsPcm: vi.fn().mockResolvedValue({ pcm: Buffer.alloc(640), sourceRateHz: 16_000 }) as unknown as TurnDeps['ttsPcm'],
    ttsMp3: unexpected('ttsMp3') as TurnDeps['ttsMp3'],
    agent: { base: replyAgent, create: unexpected('agent.create') } as unknown as TurnDeps['agent'],
    accountEvents: unexpected('accountEvents') as TurnDeps['accountEvents'],
    ...over,
  };
}

function fakeSocket(): WebSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket;
}

/** An unpaired session with enough PCM to reach STT (>= MIN_STT_PCM_BYTES). */
function audioSession(): SessionDto {
  const session = createSession();
  session.stage = 'responding';
  session.turnRef = 'turn_1';
  session.audioChunks = [Buffer.alloc(MIN_STT_PCM_BYTES)];
  session.totalAudioBytes = MIN_STT_PCM_BYTES;
  return session;
}

const scope = (conversationId: string): ConversationScope => ({
  conversationId, spaceId: 'space_private', spaceKind: 'private', spaceName: null, spaceArchived: false, archivedAt: null, title: 'Chat',
});

const NO_RETRIEVAL = {
  memories: [], dueSoon: [], block: null, degraded: false, latencyMs: 0, sourceFullText: 0, sourceSemantic: 0, sourceBoth: 0,
};

function capabilities(over: Partial<TurnCapabilities> = {}): TurnCapabilities {
  return { capabilityTools: {}, lateTools: {}, spaceContext: null, scope: 'private', spaceMs: 1, game: null, ...over };
}

let journal: string[];

beforeEach(() => {
  vi.mocked(resolveTurnMemory).mockReset();
  journal = [];
  setJournalSink((line) => journal.push(line));
  vi.mocked(startMemoryRetrieval).mockReturnValue({ result: Promise.resolve(NO_RETRIEVAL) });
  vi.mocked(buildAgentMessages).mockImplementation(async (_deps, _session, text) => [{ role: 'user', content: text }]);
  vi.mocked(loadAgentHistory).mockResolvedValue([]);
  vi.mocked(startMemoryPack).mockReturnValue({ result: Promise.resolve(NO_RETRIEVAL) });
  vi.mocked(buildTurnCapabilities).mockResolvedValue(capabilities());
  vi.mocked(googleTurnTools).mockResolvedValue({});
  vi.mocked(prepareToolPolicyFilter).mockResolvedValue((tools) => tools);
  vi.mocked(preflightMarketingTurn).mockResolvedValue(null);
  vi.mocked(marketingToolsForTurn).mockResolvedValue({});
});
afterEach(() => {
  setJournalSink(null);
  vi.clearAllMocks();
});

describe('runTurn: context prep runs alongside STT, not before it (#898)', () => {
  it('calls deps.stt while context prep is still unsettled', async () => {
    const prep = deferred<PrepResult>();
    vi.mocked(resolveTurnMemory).mockReturnValue(prep.promise);
    const stt = vi.fn().mockResolvedValue({ text: 'hello there', model: 'stt-1', seconds: 1 });

    const pending = runTurn(fakeDeps({ stt }), fakeSocket(), audioSession(), 'turn_1');
    await flush();

    // Today's serial code awaits resolveTurnMemory before ever calling
    // deps.stt, so deps.stt is never reached while prep is held open -- this
    // fails on that code.
    expect(stt).toHaveBeenCalledTimes(1);

    prep.resolve({ memory: null, contextMs: 5 });
    await pending;
  });

  it('a context prep that rejects after the turn returns never becomes an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const prep = deferred<PrepResult>();
      vi.mocked(resolveTurnMemory).mockReturnValue(prep.promise);
      const stt = vi.fn().mockRejectedValue(new Error('stt boom'));

      await runTurn(fakeDeps({ stt }), fakeSocket(), audioSession(), 'turn_2');
      prep.reject(new Error('prep boom'));
      await flush();

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

function prepDeps(): TurnDeps {
  const create = (): unknown => createAgentHarness([[{ type: 'text', text: 'Sure thing.' }]]).agent;
  return {
    getDb: vi.fn(),
    embedder: vi.fn(() => ({ embed: vi.fn(), modelId: 'embed', dim: 3 })),
    agent: { base: create, create },
    // The real extension over the mocked marketing-turn module, wired as app-deps.ts does.
    appTurnTools: createAppTurnExtension(saveAppIdea),
  } as unknown as TurnDeps;
}

function pairedTurn(conversationId: string): { session: SessionDto; memory: TurnMemoryContext } {
  const session = createSession({ kind: 'device', userId: 'user_1', deviceId: 'device_1', name: 'Card' });
  session.activeConversationId = conversationId;
  const memory: TurnMemoryContext = {
    db: {} as Db, userId: 'user_1', memoryOn: true, timeZone: 'UTC', conversation: scope(conversationId),
  };
  return { session, memory };
}

/** The agent-completed journal line, parsed. */
function agentCompleted(): Record<string, unknown> {
  const line = journal.find((entry) => entry.includes('"event":"v2.turn_stage_agent_completed"'));
  expect(line).toBeDefined();
  return JSON.parse(line!) as Record<string, unknown>;
}

describe('generateReply: prep overlaps the anchor write', () => {
  it('starts independent history while capabilities remain pending', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    const pendingCapabilities = deferred<TurnCapabilities>();
    vi.mocked(buildTurnCapabilities).mockReturnValue(pendingCapabilities.promise);
    const pending = generateReply(prepDeps(), session, 'hello', 'turn_1', memory);
    try {
      await flush();
      expect(buildAgentMessages).toHaveBeenCalledTimes(1);
    } finally {
      pendingCapabilities.resolve(capabilities());
      await pending;
    }
  });

  it('with no early prep, the inline prep starts every read once prepare settles, each once, with the memory pack', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    const prepare = deferred<void>();

    const pending = generateReply(prepDeps(), session, 'what is on today', 'turn_1', memory, undefined, 5, undefined, prepare.promise);
    await flush();

    // The anchor write may create or move the conversation: nothing reads before it.
    expect(buildTurnCapabilities).not.toHaveBeenCalled();
    expect(buildAgentMessages).not.toHaveBeenCalled();
    expect(googleTurnTools).not.toHaveBeenCalled();

    memory.prepared = { conversationId: 'conv_aaaaaaaa', userMessageId: 'msg_u', replyMessageId: 'msg_r', scope: scope('conv_aaaaaaaa'), created: false, changedAt: 0 };
    prepare.resolve();
    const reply = await pending;

    expect(reply.text).toBe('Sure thing.');
    expect(buildAgentMessages).toHaveBeenCalledTimes(1);
    expect(googleTurnTools).toHaveBeenCalledTimes(1);
    expect(buildTurnCapabilities).toHaveBeenCalledTimes(1);
    // Recall is the memory pack: no query embed or search.
    expect(startMemoryPack).toHaveBeenCalledTimes(1);
    expect(startMemoryRetrieval).not.toHaveBeenCalled();
    const fields = agentCompleted();
    for (const key of ['prepare_ms', 'history_ms', 'capabilities_ms', 'google_ms', 'prep_ms']) {
      expect(typeof fields[key]).toBe('number');
    }
    expect(fields).not.toHaveProperty('retrieval_ms');
    expect(fields).not.toHaveProperty('prep_restarted');
    expect(fields.conversation_id).toBe('conv_aaaaaaaa');
    // Aggregates only: never the transcript or the reply.
    expect(journal.join('\n')).not.toContain('what is on today');
    expect(journal.join('\n')).not.toContain('Sure thing.');
  });

  it('when prepare moves the turn to another conversation, the one inline prep reads the new one and the turn answers there', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    const prepare = (async (): Promise<void> => {
      await flush();
      memory.conversation = scope('conv_bbbbbbbb');
      session.activeConversationId = 'conv_bbbbbbbb';
    })();
    const { deps, create } = recordingDeps();

    await generateReply(deps, session, 'hello', 'turn_2', memory, undefined, 5, undefined, prepare);

    // Read once, after the move: nothing is redone.
    expect(buildTurnCapabilities).toHaveBeenCalledTimes(1);
    expect(startMemoryPack).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0]![0] as { cacheKey?: string }).cacheKey).toBe('conv_bbbbbbbb');
    expect(agentCompleted()).toMatchObject({ conversation_id: 'conv_bbbbbbbb' });
    expect(agentCompleted()).not.toHaveProperty('prep_restarted');
  });

  it('with nothing pinned, the capability reads wait for prepare, which creates the conversation (and a new account\'s private space)', async () => {
    // Started alongside, the Space read's ensurePrivateSpace raced prepare's
    // own: one INSERT lost on the unique index, so turn 1 had no anchor (no
    // cache key) or no productivity tools.
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    session.activeConversationId = undefined;
    memory.conversation = null;
    const prepare = deferred<void>();

    const pending = generateReply(prepDeps(), session, 'hello', 'turn_4', memory, undefined, 5, undefined, prepare.promise);
    await flush();

    expect(buildTurnCapabilities).not.toHaveBeenCalled();
    expect(startMemoryPack).not.toHaveBeenCalled();

    memory.conversation = scope('conv_aaaaaaaa');
    session.activeConversationId = 'conv_aaaaaaaa';
    prepare.resolve();
    await pending;

    expect(buildTurnCapabilities).toHaveBeenCalledTimes(1);
    expect(startMemoryRetrieval).not.toHaveBeenCalled();
    expect(agentCompleted()).toMatchObject({ conversation_id: 'conv_aaaaaaaa' });
  });

  it('never builds the Google tools for an ACTIVE game', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    const game = { mode: 'active', tools: {} as Record<string, Tool> } as unknown as TurnCapabilities['game'];
    vi.mocked(buildTurnCapabilities).mockResolvedValue(capabilities({ game }));

    await generateReply(prepDeps(), session, 'next word', 'turn_3', memory, undefined, 5, undefined, Promise.resolve());

    expect(googleTurnTools).not.toHaveBeenCalled();
  });

  it('a capability build that fails while prepare is held degrades the turn, never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { session, memory } = pairedTurn('conv_aaaaaaaa');
      vi.mocked(buildTurnCapabilities).mockRejectedValue(new Error('spaces down'));
      const prepare = deferred<void>();
      const pending = generateReply(prepDeps(), session, 'hello', 'turn_4', memory, undefined, 5, undefined, prepare.promise);
      await flush();
      await flush();
      prepare.resolve();
      const reply = await pending;
      await flush();

      expect(reply.text).toBe('Sure thing.');
      expect(journal.join('\n')).toContain('v2.agent_tools_degraded');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

/** Every journal line, parsed, in order. */
const parsed = (): Array<Record<string, unknown>> => journal.map((line) => JSON.parse(line) as Record<string, unknown>);

describe('generateReply: v2.turn_stage_prep_* attributes prep_ms to its sub-stages (#1331)', () => {
  it('brackets the prep window and splits its critical path into waits that sum to prep_ms', async () => {
    // A fake clock: each stub settles after a known delay, so every expected
    // ms below is a worked example, not a recomputation.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => { setTimeout(() => resolve(value), ms); });
      const { session, memory } = pairedTurn('conv_aaaaaaaa');
      vi.mocked(buildTurnCapabilities).mockResolvedValue(capabilities({ spaceMs: 40, gameMs: 30 }));
      // No early prep: the anchor write (520 ms) is awaited, then the inline reads start together.
      const prepare = after(520, undefined).then(() => {
        memory.prepared = { conversationId: 'conv_aaaaaaaa', userMessageId: 'msg_u', replyMessageId: 'msg_r', scope: scope('conv_aaaaaaaa'), created: false, changedAt: 0 };
      });
      // History takes 300 ms on the critical path; the 50 ms policy read runs inside it.
      vi.mocked(buildAgentMessages).mockImplementation((_deps, _session, text) => after(300, [{ role: 'user' as const, content: text }]));
      vi.mocked(prepareToolPolicyFilter).mockImplementation(() => after(50, (tools: Record<string, Tool>) => tools));

      const pending = generateReply(prepDeps(), session, 'what is on today', 'turn_9', memory, undefined, 5, undefined, prepare);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    const entries = parsed();
    const at = (event: string): number => entries.findIndex((entry) => entry.event === event);
    expect(at('v2.turn_stage_prep_started')).toBeGreaterThanOrEqual(0);
    expect(at('v2.turn_stage_prep_started')).toBeLessThan(at('v2.turn_stage_prep_completed'));
    expect(at('v2.turn_stage_prep_completed')).toBeLessThan(at('v2.turn_stage_agent_started'));

    const started = entries.find((entry) => entry.event === 'v2.turn_stage_prep_started');
    expect(started).toMatchObject({ turn_id: 'turn_9', stage: 'prep', outcome: 'started', paired: true });
    expect(started).not.toHaveProperty('deferred_capabilities');

    const completed = entries.find((entry) => entry.event === 'v2.turn_stage_prep_completed') ?? {};
    expect(completed).toMatchObject({
      turn_id: 'turn_9', stage: 'prep', outcome: 'completed',
      prep_ms: 820,
      // Critical-path waits, in order: history, then nothing left to wait for
      // (the policy read settled inside it). The inline anchor wait is other_ms.
      history_ms: 300,
      retrieval_wait_ms: 0,
      google_wait_ms: 0,
      policy_ms: 0,
      build_ms: 0,
      other_ms: 520,
      // Each sub-stage's own duration, overlapping the waits above.
      prepare_ms: 520,
      context_ms: 5,
      space_ms: 40,
      game_ms: 30,
      prep_source: 'inline',
      snapshot_age_ms: 300,
    });
    for (const gone of ['capabilities_wait_ms', 'embed_ms', 'retrieval_ms', 'prep_restarted', 'deferred_capabilities']) expect(completed).not.toHaveProperty(gone);
    expect(completed.capabilities_ms).toEqual(expect.any(Number));
    expect(completed.google_ms).toEqual(expect.any(Number));
    // The same window the agent event reports as prep_ms.
    expect(agentCompleted().prep_ms).toBe(820);
    // Metadata only: never the transcript.
    expect(journal.join('\n')).not.toContain('what is on today');
  });

  it('an unpaired turn still brackets its prep, with no paired sub-stages', async () => {
    const session = createSession();
    await generateReply(prepDeps(), session, 'hello', 'turn_10', null, undefined, undefined, undefined, undefined);
    const entries = parsed();
    expect(entries.find((entry) => entry.event === 'v2.turn_stage_prep_started')).toMatchObject({ paired: false });
    const completed = entries.find((entry) => entry.event === 'v2.turn_stage_prep_completed');
    expect(completed).toMatchObject({ prep_ms: expect.any(Number), history_ms: expect.any(Number) });
    expect(completed).not.toHaveProperty('policy_ms');
  });
});

/** The prep_completed journal line, parsed. */
function prepCompleted(): Record<string, unknown> {
  const line = journal.find((entry) => entry.includes('"event":"v2.turn_stage_prep_completed"'));
  expect(line).toBeDefined();
  return JSON.parse(line!) as Record<string, unknown>;
}

/** prepDeps with agent.create recorded, so a test can read the memory context it got. */
function recordingDeps(): { deps: TurnDeps; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn((): unknown => createAgentHarness([[{ type: 'text', text: 'Sure thing.' }]]).agent);
  return { deps: { ...prepDeps(), agent: { base: create, create } } as unknown as TurnDeps, create };
}

describe('early prep: the transcript-free prep starts at turn_start, while the user speaks (Prep to 5 ms)', () => {
  it('a snapshot that settled during speech is reused: no re-reads, the memory pack instead of the query retrieval', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 7 });
    vi.mocked(loadAgentHistory).mockResolvedValue([{ role: 'assistant', content: 'earlier reply' }]);
    vi.mocked(startMemoryPack).mockReturnValue({ result: Promise.resolve({ ...NO_RETRIEVAL, block: '[pack block]' }) });
    const { deps, create } = recordingDeps();

    startEarlyPrep(deps, session, 'turn_e1');
    await flush();
    const early = takeEarlyPrep(session, 'turn_e1');
    expect(early).toBeDefined();
    expect(buildTurnCapabilities).toHaveBeenCalledTimes(1);
    expect(prepareToolPolicyFilter).toHaveBeenCalledTimes(1);
    expect(loadAgentHistory).toHaveBeenCalledTimes(1);
    expect(startMemoryPack).toHaveBeenCalledTimes(1);
    const { memory: ready } = await early!.context;
    expect(ready).toBe(memory);

    const reply = await generateReply(deps, session, 'next colour', 'turn_e1', memory, undefined, 7, undefined, Promise.resolve(), early);

    expect(reply.text).toBe('Sure thing.');
    // Nothing read again once the transcript is known.
    expect(buildTurnCapabilities).toHaveBeenCalledTimes(1);
    expect(prepareToolPolicyFilter).toHaveBeenCalledTimes(1);
    expect(buildAgentMessages).not.toHaveBeenCalled();
    const options = create.mock.calls[0]![0] as { memoryContext?: string; memoryTools?: Record<string, unknown> };
    expect(options.memoryContext).toContain('[pack block]');
    // The pack stands in for the query arm: no embed, no search; the memory tools stay.
    expect(startMemoryRetrieval).not.toHaveBeenCalled();
    expect(Object.keys(options.memoryTools ?? {}).length).toBeGreaterThan(0);
    const fields = prepCompleted();
    expect(fields.snapshot_age_ms).toEqual(expect.any(Number));
    expect(fields).toMatchObject({ memory_source: 'pack', prep_source: 'early', conversation_id: 'conv_aaaaaaaa' });
    for (const key of ['history_ms', 'retrieval_wait_ms', 'policy_ms', 'build_ms']) {
      expect(fields[key]).toEqual(expect.any(Number));
    }
    // Metadata only.
    expect(journal.join('\n')).not.toContain('next colour');
    expect(journal.join('\n')).not.toContain('pack block');
  });

  it('memory off at turn_start, on at turn_end: a stale scope, so one inline prep reads the memory pack (no query search)', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory: { ...memory, memoryOn: false }, contextMs: 7 });
    const { deps, create } = recordingDeps();
    startEarlyPrep(deps, session, 'turn_e2');
    await flush();
    const early = takeEarlyPrep(session, 'turn_e2');
    expect(startMemoryPack).not.toHaveBeenCalled();
    vi.mocked(startMemoryPack).mockReturnValue({ result: Promise.resolve({ ...NO_RETRIEVAL, block: '[pack block]' }) });

    await generateReply(deps, session, 'hello', 'turn_e2', memory, undefined, 7, undefined, Promise.resolve(), early);

    expect(startMemoryPack).toHaveBeenCalledTimes(1);
    expect(startMemoryRetrieval).not.toHaveBeenCalled();
    expect((create.mock.calls[0]![0] as { memoryContext?: string }).memoryContext).toContain('[pack block]');
    expect(prepCompleted()).toMatchObject({ memory_source: 'pack', prep_source: 'inline', conversation_id: 'conv_aaaaaaaa' });
  });

  it('an anchor write that lands the turn in another conversation runs no tool the model called on the old one', async () => {
    const { tool } = await import('ai');
    const { z } = await import('zod');
    const execute = vi.fn(async () => ({ ok: true }));
    vi.mocked(buildTurnCapabilities).mockResolvedValue(capabilities({ capabilityTools: { set_timer: tool({ description: 'set_timer', inputSchema: z.object({}), execute }) } }));
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 7 });
    const steps: ScriptStep[] = [[{ type: 'tool', name: 'set_timer' }], [{ type: 'text', text: 'Done.' }]];
    const create = (options: { filterTools: (tools: Record<string, Tool>) => Record<string, Tool>; capabilityTools?: Record<string, Tool> }): unknown =>
      createAgentHarness(steps, { tools: options.filterTools(options.capabilityTools ?? {}) }).agent;
    const deps = { ...prepDeps(), agent: { base: create, create } } as unknown as TurnDeps;
    startEarlyPrep(deps, session, 'turn_e3');
    await flush();
    const early = takeEarlyPrep(session, 'turn_e3')!;
    const prepare = (async (): Promise<void> => {
      await flush();
      memory.conversation = scope('conv_bbbbbbbb');
      session.activeConversationId = 'conv_bbbbbbbb';
    })();
    void prepare.then(early.openGate);

    const reply = await generateReply(deps, session, 'hello', 'turn_e3', memory, undefined, 7, undefined, prepare, early);

    expect(execute).not.toHaveBeenCalled();
    expect(reply.text).toBe('Done.');
    expect(prepCompleted()).toMatchObject({ prep_source: 'early' });
    // The turn's own conversation is where the write landed (runTurn saves the reply there).
    expect(session.activeConversationId).toBe('conv_bbbbbbbb');
  });

  it('a history read that settles after the anchor write started is not used (it may hold the new user message)', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 7 });
    const history = deferred<Array<{ role: 'assistant'; content: string }>>();
    vi.mocked(loadAgentHistory).mockReturnValue(history.promise);
    const { deps } = recordingDeps();
    startEarlyPrep(deps, session, 'turn_e4');
    await flush();
    const early = takeEarlyPrep(session, 'turn_e4')!;
    // runTurn seals the snapshot just before it starts the anchor write.
    early.sealed = true;
    history.resolve([{ role: 'assistant', content: 'earlier reply' }]);

    await generateReply(deps, session, 'hello', 'turn_e4', memory, undefined, 7, undefined, Promise.resolve(), early);

    expect(buildAgentMessages).toHaveBeenCalledTimes(1);
    expect(buildTurnCapabilities).toHaveBeenCalledTimes(1);
  });

  it('a snapshot belongs to its own turn only, and is taken once', () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 7 });
    startEarlyPrep(recordingDeps().deps, session, 'turn_e5');
    expect(takeEarlyPrep(session, 'turn_other')).toBeUndefined();
    startEarlyPrep(recordingDeps().deps, session, 'turn_e5');
    expect(takeEarlyPrep(session, 'turn_e5')).toBeDefined();
    expect(takeEarlyPrep(session, 'turn_e5')).toBeUndefined();
  });

  it('handleControl starts it, through the injected deps.turn.startEarlyPrep, when a paired turn_start is accepted', async () => {
    const { session } = pairedTurn('conv_aaaaaaaa');
    session.stage = 'ready';
    const startEarly = vi.fn();
    const turn = { ...recordingDeps().deps, startEarlyPrep: startEarly };
    const deps = {
      getDb: () => Promise.reject(new Error('no store')), deviceSessions: { flushPending: vi.fn() }, turn,
    } as unknown as Parameters<typeof handleControl>[0];
    const dto = { v: V2_VERSION, type: 'turn_start', id: 'test_ctrl_000001', turn_ref: 'turn_s1', payload: {} } as unknown as ClientControlDto;

    await handleControl(deps, fakeSocket(), session as never, dto, vi.fn());

    expect(session.stage).toBe('capturing');
    expect(startEarly).toHaveBeenCalledTimes(1);
    expect(startEarly).toHaveBeenCalledWith(session, 'turn_s1');
  });
});

describe('partial recall: the query search starts on the streaming STT hypothesis, never awaited', () => {
  /** A stream whose hypothesis the test sets. */
  function hypothesisStream(): TranscriptStream & { hypothesis: string } {
    return {
      model: 'test/stream-1', setupMs: 10, stats: { finals: 0, partials: 1, bytesRead: 0 }, hypothesis: '',
      push: vi.fn(), finish: vi.fn(async () => ({ text: 'x', model: 'test/stream-1' })), abort: vi.fn(),
    };
  }
  const TOP = { id: 'mem_top', kind: 'fact' as const, content: 'Has a dog called Biscuit.', confidence: 0.9, sensitive: false };
  const MATCH = {
    ...TOP, id: 'mem_q', content: 'Sister Maya, birthday in May.', conversationId: null, messageId: null,
    surface: 'web_text' as const, createdAt: 0, matchSource: 'both' as const, score: 1,
  };

  async function speak(session: SessionDto, stream: TranscriptStream & { hypothesis: string }, deps: TurnDeps, words: string): Promise<void> {
    openSttStream(session, () => stream);
    startEarlyPrep(deps, session, 'turn_p1');
    await flush();
    stream.hypothesis = words;
    pushSttStream(session, new Uint8Array(320));
  }

  afterEach(() => { vi.mocked(startMemoryRecall).mockReset(); });

  it('a recall that settled before generate is merged into the pack: memory_source pack+partial', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 7 });
    vi.mocked(startMemoryPack).mockReturnValue({ result: Promise.resolve({ ...NO_RETRIEVAL, block: '[pack block]', top: [TOP] }) });
    vi.mocked(startMemoryRecall).mockReturnValue({ result: Promise.resolve({ ...NO_RETRIEVAL, memories: [MATCH] }) });
    const { deps, create } = recordingDeps();
    const stream = hypothesisStream();

    await speak(session, stream, deps, 'when is my sister');
    await flush();
    abortSttStream(session);
    const early = takeEarlyPrep(session, 'turn_p1');
    await generateReply(deps, session, 'when is my sister birthday', 'turn_p1', memory, undefined, 7, undefined, Promise.resolve(), early);

    expect(startMemoryRecall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startMemoryRecall).mock.calls[0]![2]).toBe('when is my sister');
    const context = (create.mock.calls[0]![0] as { memoryContext?: string }).memoryContext;
    expect(context).toContain('Sister Maya, birthday in May.');
    expect(context).toContain('Has a dog called Biscuit.');
    const fields = prepCompleted();
    expect(fields).toMatchObject({ memory_source: 'pack+partial', partial_recall_ready: true });
    expect(fields.partial_recall_ms).toEqual(expect.any(Number));
    const all = journal.join('\n');
    expect(all).not.toContain('sister');
    expect(all).not.toContain('Maya');
  });

  it('a recall still running at generate is not awaited: the pack alone, partial_recall_ready false', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 7 });
    vi.mocked(startMemoryPack).mockReturnValue({ result: Promise.resolve({ ...NO_RETRIEVAL, block: '[pack block]', top: [TOP] }) });
    const pending = deferred<RetrievalResult>();
    vi.mocked(startMemoryRecall).mockReturnValue({ result: pending.promise });
    const { deps, create } = recordingDeps();

    await speak(session, hypothesisStream(), deps, 'when is my sister');
    abortSttStream(session);
    const early = takeEarlyPrep(session, 'turn_p1');
    await generateReply(deps, session, 'when is my sister birthday', 'turn_p1', memory, undefined, 7, undefined, Promise.resolve(), early);

    expect((create.mock.calls[0]![0] as { memoryContext?: string }).memoryContext).toContain('[pack block]');
    const fields = prepCompleted();
    expect(fields).toMatchObject({ memory_source: 'pack', partial_recall_ready: false });
    expect(fields.partial_recall_ms).toBeUndefined();
    pending.resolve({ ...NO_RETRIEVAL, memories: [MATCH] });
  });

  it('a recall that found nothing new keeps memory_source pack', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 7 });
    vi.mocked(startMemoryPack).mockReturnValue({ result: Promise.resolve({ ...NO_RETRIEVAL, block: '[pack block]', top: [TOP] }) });
    vi.mocked(startMemoryRecall).mockReturnValue({ result: Promise.resolve({ ...NO_RETRIEVAL, memories: [{ ...MATCH, id: TOP.id }] }) });
    const { deps } = recordingDeps();

    await speak(session, hypothesisStream(), deps, 'tell me about my dog');
    await flush();
    abortSttStream(session);
    await generateReply(deps, session, 'tell me about my dog', 'turn_p1', memory, undefined, 7, undefined, Promise.resolve(), takeEarlyPrep(session, 'turn_p1'));

    expect(prepCompleted()).toMatchObject({ memory_source: 'pack', partial_recall_ready: true });
  });

  it('an ACTIVE game starts no recall: its turn gets no memory block', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 7 });
    const game = { mode: 'active', tools: {} } as unknown as TurnCapabilities['game'];
    vi.mocked(buildTurnCapabilities).mockResolvedValue(capabilities({ game }));
    const { deps } = recordingDeps();

    await speak(session, hypothesisStream(), deps, 'is it a big cat');
    await flush();
    abortSttStream(session);

    expect(startMemoryRecall).not.toHaveBeenCalled();
  });

  it('a hypothesis under the word floor starts no recall (a false wake never embeds)', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 7 });
    const { deps } = recordingDeps();

    await speak(session, hypothesisStream(), deps, 'hey bob');
    await flush();
    abortSttStream(session);

    expect(startMemoryRecall).not.toHaveBeenCalled();
    expect(takeEarlyPrep(session, 'turn_p1')?.recall).toBeUndefined();
  });
});

describe('generateReply: the one-step game context', () => {
  it('reaches the agent and is counted in v2.agent_tools context_chars', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    const oneStep = { context: '[One step game context]', stopWhen: (() => true) as never, prepareStep: (() => undefined) as never };
    const game = { mode: 'active', tools: {} as Record<string, Tool>, oneStep } as unknown as TurnCapabilities['game'];
    vi.mocked(buildTurnCapabilities).mockResolvedValue(capabilities({ game }));
    const { deps, create } = recordingDeps();

    await generateReply(deps, session, 'red', 'turn_g1', memory, undefined, 5, undefined, Promise.resolve());

    const options = create.mock.calls[0]![0] as { memoryContext?: string; stopWhen?: unknown; prepareStep?: unknown };
    expect(options.memoryContext).toBe(oneStep.context);
    expect(options.stopWhen).toBe(oneStep.stopWhen);
    expect(options.prepareStep).toBe(oneStep.prepareStep);
    const tools = parsed().find((entry) => entry.event === 'v2.agent_tools');
    expect(tools?.context_chars).toBe(oneStep.context.length);
  });
});

describe('generateReply: the app extension lookup is a named prep wait (spec 015 FR-003)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a 200 ms app preflight journals app_tools_wait_ms, not other_ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    memory.prepared = { conversationId: 'conv_aaaaaaaa', userMessageId: 'msg_u', replyMessageId: 'msg_r', scope: scope('conv_aaaaaaaa'), created: false, changedAt: 0 };
    vi.mocked(preflightMarketingTurn).mockImplementationOnce(() => new Promise((resolve) => { setTimeout(() => resolve(null), 200); }));

    const pending = generateReply(prepDeps(), session, 'hello', 'turn_m1', memory, undefined, 5, undefined, Promise.resolve());
    await vi.advanceTimersByTimeAsync(250);
    await pending;

    expect(preflightMarketingTurn).toHaveBeenCalledTimes(1);
    const fields = prepCompleted();
    expect(fields.app_tools_wait_ms).toBeGreaterThanOrEqual(190);
    expect(fields.app_tools_ms).toBeGreaterThanOrEqual(190);
    expect(fields.other_ms).toBeLessThan(20);
  });
});

describe('characterization: device tool order stays byte-identical (spec 015 U1)', () => {
  async function offeredKeys(binding: { installationId: string; mode: 'run' } | null): Promise<string[]> {
    const { tool } = await import('ai');
    const { z } = await import('zod');
    const { createBobAgent } = await import('@bob/ai');
    const named = (...names: string[]): Record<string, Tool> => Object.fromEntries(names.map((name) => [name, tool({ description: name, inputSchema: z.object({}), execute: async () => ({ ok: true }) })]));
    vi.mocked(buildTurnCapabilities).mockResolvedValue(capabilities({ capabilityTools: named('set_timer', 'list_tasks', 'create_task'), lateTools: named('set_volume') }));
    vi.mocked(googleTurnTools).mockResolvedValue(named('gmail_search'));
    vi.mocked(preflightMarketingTurn).mockResolvedValue(binding);
    vi.mocked(marketingToolsForTurn).mockResolvedValue(named('marketing_context', 'save_draft', 'create_campaign'));
    const keys: string[][] = [];
    const create = (options: Parameters<typeof createBobAgent>[0]): unknown => {
      const agent = createBobAgent(options);
      keys.push([...Object.keys(options?.capabilityTools ?? {}), '|', ...Object.keys(agent.tools)]);
      return agent;
    };
    const deps = { ...prepDeps(), agent: { base: create, create } } as unknown as TurnDeps;
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    memory.prepared = { conversationId: 'conv_aaaaaaaa', userMessageId: 'msg_u', replyMessageId: 'msg_r', scope: scope('conv_aaaaaaaa'), created: false, changedAt: 0 };
    await generateReply(deps, session, 'hello', 'turn_c1', memory, undefined, 5, undefined, Promise.resolve()).catch(() => undefined);
    return keys[0] ?? [];
  }

  it('an owner turn offers the app tools after Google and before the timeline, in this order', async () => {
    expect(await offeredKeys({ installationId: 'inst_1', mode: 'run' })).toEqual([
      'set_timer', 'list_tasks', 'create_task', 'gmail_search', 'marketing_context', 'save_draft', 'create_campaign', 'list_timeline', '|',
      'currentDateTime', 'set_timer', 'list_tasks', 'create_task', 'gmail_search', 'list_timeline', 'remember', 'forget', 'list_actions', 'complete_action', 'set_volume', 'productivity_agent', 'marketing_agent', 'health_agent',
    ]);
  });

  it('a non-owner turn offers no app tools, in this order', async () => {
    expect(await offeredKeys(null)).toEqual([
      'set_timer', 'list_tasks', 'create_task', 'gmail_search', 'list_timeline', '|',
      'currentDateTime', 'set_timer', 'list_tasks', 'create_task', 'gmail_search', 'list_timeline', 'remember', 'forget', 'list_actions', 'complete_action', 'set_volume', 'productivity_agent', 'health_agent',
    ]);
  });
});

describe('generateReply: the app extension starts with Google (spec 015 U1)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('with the extension and Google each taking 300 ms, the device prep window stays under 350 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => { setTimeout(() => resolve(value), ms); });
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    memory.prepared = { conversationId: 'conv_aaaaaaaa', userMessageId: 'msg_u', replyMessageId: 'msg_r', scope: scope('conv_aaaaaaaa'), created: false, changedAt: 0 };
    // The history read the app lookup used to queue behind (it started only after it).
    vi.mocked(buildAgentMessages).mockImplementation((_deps, _session, text) => after(200, [{ role: 'user' as const, content: text }]));
    vi.mocked(googleTurnTools).mockImplementation(() => after(300, {}));
    vi.mocked(preflightMarketingTurn).mockImplementation(() => after(300, { installationId: 'inst_1', mode: 'run' as const }));

    const pending = generateReply(prepDeps(), session, 'hello', 'turn_p1', memory, undefined, 5, undefined, Promise.resolve());
    await vi.advanceTimersByTimeAsync(700);
    await pending;

    expect(googleTurnTools).toHaveBeenCalledTimes(1);
    expect(preflightMarketingTurn).toHaveBeenCalledTimes(1);
    const fields = prepCompleted();
    expect(fields.prep_ms).toBeGreaterThanOrEqual(300);
    expect(fields.prep_ms).toBeLessThan(350);
  });
});

describe('one device prep path: the model does not wait for the anchor write (SIMPLIFY-U2A)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => { setTimeout(() => resolve(value), ms); });
  const prepared = (memory: TurnMemoryContext, conversationId: string): void => {
    memory.prepared = { conversationId, userMessageId: 'msg_u', replyMessageId: 'msg_r', scope: scope(conversationId), created: false, changedAt: 0 };
  };

  /** Deps whose agent runs `steps` on the turn's own filtered tools, so a gated tool really waits. */
  function toolDeps(steps: ScriptStep[]): { deps: TurnDeps; calls: () => number } {
    let harness: ReturnType<typeof createAgentHarness> | undefined;
    const create = (options: { filterTools: (tools: Record<string, Tool>) => Record<string, Tool>; capabilityTools?: Record<string, Tool> }): unknown => {
      harness = createAgentHarness(steps, { tools: options.filterTools(options.capabilityTools ?? {}) });
      return harness.agent;
    };
    return { deps: { ...prepDeps(), agent: { base: create, create } } as unknown as TurnDeps, calls: () => harness?.calls() ?? 0 };
  }

  /** An early prep that settled while the user spoke (600 ms of speech), sealed as runTurn seals it. */
  async function spokenEarly(deps: TurnDeps, session: SessionDto, memory: TurnMemoryContext, turnRef: string): Promise<EarlyPrep> {
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 7 });
    startEarlyPrep(deps, session, turnRef);
    await vi.advanceTimersByTimeAsync(600);
    const early = takeEarlyPrep(session, turnRef)!;
    early.sealed = true;
    return early;
  }

  it('with the early prep settled, the model starts at once: prepare (150 ms) and Google (500 ms) do not hold it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    vi.mocked(googleTurnTools).mockImplementation(() => after(500, {}));
    const { deps, calls } = toolDeps(REPLY_STEPS);
    const early = await spokenEarly(deps, session, memory, 'turn_u1');
    const prepare = after(150, undefined).then(() => { prepared(memory, 'conv_aaaaaaaa'); });

    const pending = generateReply(deps, session, 'hello', 'turn_u1', memory, undefined, 7, undefined, prepare, early);
    await vi.advanceTimersByTimeAsync(5);

    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect((await pending).text).toBe('reply text');
  });

  // A bound app's tools are built against the committed message (marketing writes its selection keyed by it), so an
  // owner's model waits for the anchor; a non-owner's does not.
  it.each([
    ['a non-owner starts the model within 5 ms', null, 1],
    ['a bound-app owner starts the model only once the anchor write (150 ms) settled', { installationId: 'inst_1', mode: 'run' as const }, 0],
  ])('%s', async (_name, binding, callsAt5ms) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.mocked(preflightMarketingTurn).mockResolvedValue(binding);
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    const { deps, calls } = toolDeps(REPLY_STEPS);
    const early = await spokenEarly(deps, session, memory, 'turn_u6');
    const prepare = after(150, undefined).then(() => { prepared(memory, 'conv_aaaaaaaa'); });
    void prepare.then(early.openGate);

    const pending = generateReply(deps, session, 'hello', 'turn_u6', memory, undefined, 7, undefined, prepare, early);
    await vi.advanceTimersByTimeAsync(5);
    expect(calls()).toBe(callsAt5ms);
    await vi.advanceTimersByTimeAsync(150);

    expect(calls()).toBe(1);
    expect((await pending).text).toBe('reply text');
    if (binding !== null) {
      expect(marketingToolsForTurn).toHaveBeenCalledTimes(1);
      expect(prepCompleted().app_tools_wait_ms).toBeGreaterThanOrEqual(140);
    }
  });

  /** The model asks for set_timer while the anchor write is still running. */
  async function toolBeforePrepare(abortFirst: boolean): Promise<{ execute: ReturnType<typeof vi.fn>; pending: Promise<unknown> }> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { tool } = await import('ai');
    const { z } = await import('zod');
    const execute = vi.fn(async () => ({ ok: true }));
    vi.mocked(buildTurnCapabilities).mockResolvedValue(capabilities({ capabilityTools: { set_timer: tool({ description: 'set_timer', inputSchema: z.object({}), execute }) } }));
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    const { deps, calls } = toolDeps([[{ type: 'tool', name: 'set_timer' }], [{ type: 'text', text: 'Done.' }]]);
    const early = await spokenEarly(deps, session, memory, 'turn_u2');
    const write = deferred<void>();
    const controller = new AbortController();
    const pending = generateReply(deps, session, 'set a timer', 'turn_u2', memory, controller.signal, 7, undefined, write.promise, early);
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(5);
    // The model already asked for the tool; the tool waits for the anchor.
    expect(calls()).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    if (abortFirst) {
      controller.abort();
      early.closeGate();
    }
    prepared(memory, 'conv_aaaaaaaa');
    write.resolve();
    early.openGate();
    await vi.advanceTimersByTimeAsync(5);
    return { execute, pending };
  }

  it('a tool called before prepare settles runs only after it, exactly once', async () => {
    const { execute, pending } = await toolBeforePrepare(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await pending).toMatchObject({ text: 'Done.' });
  });

  it('a tool called before prepare settles never runs once the turn is aborted first', async () => {
    const { execute } = await toolBeforePrepare(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('nothing pinned (no early prep): prepare is awaited, then one inline prep runs on the conversation it created', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    session.activeConversationId = undefined;
    memory.conversation = null;
    const write = deferred<void>();
    const { deps, create } = recordingDeps();
    const pending = generateReply(deps, session, 'hello', 'turn_u3', memory, undefined, 5, undefined, write.promise);
    await flush();
    expect(buildTurnCapabilities).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    memory.conversation = scope('conv_aaaaaaaa');
    session.activeConversationId = 'conv_aaaaaaaa';
    prepared(memory, 'conv_aaaaaaaa');
    write.resolve();
    await pending;

    expect(buildTurnCapabilities).toHaveBeenCalledTimes(1);
    expect(startMemoryPack).toHaveBeenCalledTimes(1);
    expect(startMemoryRetrieval).not.toHaveBeenCalled();
    expect(prepCompleted()).toMatchObject({ prep_source: 'inline', conversation_id: 'conv_aaaaaaaa' });
  });

  it('a scope that changed since turn_start runs exactly one inline prep', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    const { deps } = recordingDeps();
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 7 });
    startEarlyPrep(deps, session, 'turn_u4');
    await flush();
    const early = takeEarlyPrep(session, 'turn_u4');
    memory.conversation = { ...scope('conv_aaaaaaaa'), spaceName: 'Renamed' };

    await generateReply(deps, session, 'hello', 'turn_u4', memory, undefined, 7, undefined, Promise.resolve(), early);

    expect(buildTurnCapabilities).toHaveBeenCalledTimes(2);
    expect(startMemoryPack).toHaveBeenCalledTimes(2);
    expect(startMemoryRetrieval).not.toHaveBeenCalled();
    expect(prepCompleted()).toMatchObject({ prep_source: 'inline', conversation_id: 'conv_aaaaaaaa' });
  });

  it('a normal early turn journals prep_source early and its snapshot age', async () => {
    const { session, memory } = pairedTurn('conv_aaaaaaaa');
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 7 });
    const { deps } = recordingDeps();
    startEarlyPrep(deps, session, 'turn_u5');
    await flush();

    await generateReply(deps, session, 'hello', 'turn_u5', memory, undefined, 7, undefined, Promise.resolve(), takeEarlyPrep(session, 'turn_u5'));

    const fields = prepCompleted();
    expect(fields.prep_source).toBe('early');
    expect(fields.snapshot_age_ms).toBeGreaterThanOrEqual(0);
  });
});
