/**
 * PR3-SPEC (#1365): the speculative reply. At the server's end of turn the model starts on the stable
 * hypothesis; a matching final commits it (its text streams to the device at once), anything else aborts it.
 * Real runTurn + generateReply on a real ToolLoopAgent (agent-harness); STT, TTS, the store and the
 * context reads are fakes. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { bobAgent } from '@bob/ai';
import { MP3_16K_MONO_FORMAT, type SessionDto } from '../../src/voice/protocol.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import { MIN_STT_PCM_BYTES } from '../../src/voice/audio/stt-tts.ts';
import type { TurnDeps } from '../../src/voice/turn/deps.ts';
import type { TurnMemoryContext } from '../../src/voice/turn/context.ts';
import type { TurnCapabilities } from '../../src/voice/turn/tools.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createAgentHarness, words, type ScriptStep } from '../support/agent-harness.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';


vi.mock('../../src/voice/turn/context.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/voice/turn/context.ts')>()),
  resolveTurnMemory: vi.fn(), buildAgentMessages: vi.fn(), loadAgentHistory: vi.fn(),
}));
vi.mock('../../src/memory/retrieval.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/memory/retrieval.ts')>()),
  startMemoryRetrieval: vi.fn(), startMemoryPack: vi.fn(), startMemoryRecall: vi.fn(),
}));
vi.mock('../../src/voice/turn/tools.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/voice/turn/tools.ts')>()),
  buildTurnCapabilities: vi.fn(), googleTurnTools: vi.fn(),
}));
vi.mock('../../src/tools/policy.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tools/policy.ts')>()),
  prepareToolPolicyFilter: vi.fn(),
}));
vi.mock('../../src/bob-apps/marketing-turn.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/bob-apps/marketing-turn.ts')>()),
  preflightMarketingTurn: vi.fn(async () => null), marketingToolsForTurn: vi.fn(async () => ({})),
}));
vi.mock('../../src/voice/turn/persist.ts', () => ({
  prepareTurn: vi.fn(async () => undefined), persistTurn: vi.fn(async () => undefined), releaseTurn: vi.fn(async () => undefined),
}));
vi.mock('../../src/voice/turn/generate.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/voice/turn/generate.ts')>();
  return { ...actual, generateReply: vi.fn(actual.generateReply) };
});
vi.mock('@bob/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, run) => run()),
  withTraceContext: vi.fn((_attrs, fn: () => unknown) => fn()),
}));

import { buildAgentMessages, loadAgentHistory, resolveTurnMemory } from '../../src/voice/turn/context.ts';
import { startMemoryPack, startMemoryRetrieval } from '../../src/memory/retrieval.ts';
import { buildTurnCapabilities, googleTurnTools } from '../../src/voice/turn/tools.ts';
import { prepareToolPolicyFilter } from '../../src/tools/policy.ts';
import { preflightMarketingTurn, marketingToolsForTurn } from '../../src/bob-apps/marketing-turn.ts';
import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { persistTurn } from '../../src/voice/turn/persist.ts';
import { startEarlyPrep } from '../../src/voice/turn/generate.ts';
import { onSpeculationEvent } from '../../src/voice/turn/speculate.ts';
import { recordServerEndOfTurn, recordTurnEnd } from '../../src/voice/turn/stream-stt.ts';

const REF = 'turn_spec_1';
/** The ms stamp at which the server sent end_of_turn in the lag cases; turn_end is stamped relative to it. */
const SENT_AT = 1_000;
const HYPOTHESIS = 'What time is it?';
const FINAL = 'what time is it';
const REPLY = 'It is half past three. Anything else?';
/** The fake model's delay before its first token, and the device's silence wait before turn_end. */
const MODEL_MS = 200;
const SILENCE_MS = 320;
const NO_RETRIEVAL = {
  memories: [], dueSoon: [], block: null, degraded: false, latencyMs: 0, sourceFullText: 0, sourceSemantic: 0, sourceBoth: 0,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** An MP3 of `bytes` that opens with a parseable MPEG1 Layer III header. */
function mp3Of(bytes: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE((((0x7ff << 21) | (3 << 19) | (1 << 17) | (1 << 16) | (5 << 12) | (3 << 6)) >>> 0), 0);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, bytes - 4))]);
}

interface Sent { at: number; type: string }
function recordingSocket(): { socket: WebSocket; sent: Sent[] } {
  const sent: Sent[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn((data: Buffer | string) => {
      sent.push({ at: Date.now(), type: typeof data === 'string' ? (JSON.parse(data) as { type: string }).type : 'audio_down' });
    }),
  };
  return { socket: socket as unknown as WebSocket, sent };
}

const scope = {
  conversationId: 'conv_aaaaaaaa', spaceId: 'space_private', spaceKind: 'private' as const, spaceName: null, spaceArchived: false, archivedAt: null, title: 'Chat',
};
const memory: TurnMemoryContext = { db: {} as Db, userId: 'user_1', memoryOn: true, timeZone: 'UTC', conversation: scope };

function pairedSession(): SessionDto {
  const session = createSession({ kind: 'device', userId: 'user_1', deviceId: 'device_1', name: 'Card' });
  Object.assign(session, {
    stage: 'responding', turnRef: REF, formatId: MP3_16K_MONO_FORMAT, activeConversationId: 'conv_aaaaaaaa',
    audioChunks: [Buffer.alloc(MIN_STT_PCM_BYTES)], totalAudioBytes: MIN_STT_PCM_BYTES, turnAbort: new AbortController(),
  });
  return session;
}

/** What the fake agents saw: one entry per agent built (one model run each). */
interface Fakes { deps: TurnDeps; aborts: Array<AbortSignal | undefined>; toolRuns: string[]; models: () => number }

/** A TurnDeps whose agent is a real ToolLoopAgent per run; `steps(n)` scripts run n; filterTools is applied to the fake tools as the real agent would. */
function fakeDeps(steps: (run: number) => ScriptStep[], finalText = FINAL): Fakes {
  const aborts: Array<AbortSignal | undefined> = [];
  const toolRuns: string[] = [];
  const clock = tool({ description: 'The time.', inputSchema: z.object({}), execute: async () => { toolRuns.push('clock'); return { time: '3:30' }; } });
  let runs = 0;
  const create = (options: { filterTools?: (tools: ToolSet) => ToolSet; capabilityTools?: ToolSet }): typeof bobAgent => {
    const harness = createAgentHarness(steps(runs), { tools: (options.filterTools ?? ((tools) => tools))({ clock, ...options.capabilityTools }) });
    runs += 1;
    const agent = harness.agent;
    const stream = agent.stream.bind(agent);
    const generate = agent.generate.bind(agent);
    agent.stream = ((call: { abortSignal?: AbortSignal }) => { aborts.push(call.abortSignal); return stream(call as never); }) as typeof agent.stream;
    agent.generate = ((call: { abortSignal?: AbortSignal }) => { aborts.push(call.abortSignal); return generate(call as never); }) as typeof agent.generate;
    return agent as unknown as typeof bobAgent;
  };
  const unexpected = (name: string) => (): never => { throw new Error(`unexpected deps.${name}`); };
  const deps = {
    getDb: unexpected('getDb'),
    deviceSessions: { flushPending: vi.fn(), sendScene: vi.fn() },
    embedder: vi.fn(() => ({ embed: vi.fn(), modelId: 'embed', dim: 3 })),
    stt: vi.fn(async () => ({ text: finalText, model: 'stt-1', seconds: 1 })),
    ttsPcm: vi.fn(async () => ({ pcm: Buffer.alloc(640), sourceRateHz: 16_000 })),
    ttsMp3: vi.fn(async (text: string) => { await sleep(20); return { mp3: mp3Of(text.length * 40) }; }),
    agent: { base: create, create },
    // The real extension over the mocked marketing-turn functions, wired as app-deps.ts does.
    appTurnTools: createAppTurnExtension(saveAppIdea),
  } as unknown as TurnDeps;
  return { deps, aborts, toolRuns, models: () => runs };
}

let lines: Array<Record<string, unknown>>;
const capabilities = (over: Partial<TurnCapabilities> = {}): TurnCapabilities =>
  ({ capabilityTools: {}, lateTools: {}, spaceContext: null, scope: 'private', spaceMs: 1, game: null, ...over });

beforeEach(() => {
  lines = [];
  setJournalSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  vi.mocked(resolveTurnMemory).mockResolvedValue({ memory, contextMs: 5 });
  vi.mocked(buildAgentMessages).mockImplementation(async (_deps, _session, text) => [{ role: 'user', content: text }]);
  vi.mocked(loadAgentHistory).mockResolvedValue([]);
  vi.mocked(startMemoryPack).mockReturnValue({ result: Promise.resolve(NO_RETRIEVAL) });
  vi.mocked(startMemoryRetrieval).mockReturnValue({ result: Promise.resolve(NO_RETRIEVAL) });
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

const answer = (): ScriptStep[] => [[{ type: 'delay', ms: MODEL_MS }, ...words(REPLY)]];
/** The speculative end of turn for the stable hypothesis. */
const endOf = (fakes: Fakes, hypothesis = HYPOTHESIS) => (session: SessionDto): void => { onSpeculationEvent(fakes.deps, session, REF, 'end', hypothesis); };
const event = (name: string): Record<string, unknown> | undefined => lines.find((line) => line.event === name);
const completed = (): Record<string, unknown> => event('v2.turn_completed') ?? {};

interface Driven { sent: Sent[]; session: SessionDto; firstAudioMs: number }

/** One turn: turn_start's early prep, `during` (the end-of-turn events), the device's silence wait, then turn_end -> runTurn. */
async function drive(fakes: Fakes, during: (session: SessionDto) => void | Promise<void>, session = pairedSession()): Promise<Driven> {
  lines.length = 0;
  startEarlyPrep(fakes.deps, session, REF);
  await flush();
  await during(session);
  await sleep(SILENCE_MS);
  const { socket, sent } = recordingSocket();
  await runTurn(fakes.deps, socket, session, REF);
  return { sent, session, firstAudioMs: Number(completed().first_audio_ms) };
}

describe('speculative reply: commit on a matching final', () => {
  it('starts the model before turn_end, commits on the final, and the first audio comes sooner by about the model delay', async () => {
    const speculated = fakeDeps(answer);
    const withSpec = await drive(speculated, endOf(speculated));
    expect(speculated.models()).toBe(1);
    expect(completed()).toMatchObject({ speculation: 'used', eot_source: 'device' });
    expect(completed().saved_ms as number).toBeGreaterThan(0);
    expect(completed()).not.toHaveProperty('speculation_reason');
    const stages = lines.filter((line) => line.stage === 'agent' || line.stage === 'prep');
    expect(stages.length).toBe(4);
    expect(stages.every((line) => line.speculative === true)).toBe(true);
    expect(withSpec.sent.filter((item) => item.type === 'reply_text')).toHaveLength(1);
    expect(withSpec.session.messages.at(-1)).toEqual({ role: 'assistant', content: REPLY });

    const plain = fakeDeps(answer);
    const without = await drive(plain, () => undefined);
    expect(completed()).toMatchObject({ speculation: 'none', speculation_reason: 'no_end_of_turn', eot_source: 'device' });
    expect(without.session.messages.at(-1)).toEqual({ role: 'assistant', content: REPLY });
    const gained = without.firstAudioMs - withSpec.firstAudioMs;
    console.info(`PR3-SPEC measured: first_audio ${without.firstAudioMs} ms -> ${withSpec.firstAudioMs} ms, gained ${gained} ms (model delay ${MODEL_MS} ms)`);
    expect(withSpec.firstAudioMs).toBeLessThan(without.firstAudioMs);
  });

  it('a final that differs discards the run (mismatch): aborted, no text or audio from it, its tool never ran, the model ran twice', async () => {
    const fakes = fakeDeps((run) => (run === 0
      ? [[{ type: 'delay', ms: 30 }, { type: 'text', text: 'Old reply.' }, { type: 'tool', name: 'clock' }], words('Old reply done.')]
      : answer()), 'what time was it');
    const driven = await drive(fakes, endOf(fakes));
    expect(fakes.models()).toBe(2);
    expect(fakes.aborts).toHaveLength(2);
    expect(fakes.aborts[0]?.aborted).toBe(true);
    expect(fakes.aborts[1]?.aborted).toBe(false);
    expect(fakes.toolRuns).toEqual([]);
    expect(completed()).toMatchObject({ speculation: 'discarded', speculation_reason: 'mismatch' });
    expect(driven.sent.filter((item) => item.type === 'reply_text')).toHaveLength(1);
    expect(vi.mocked(fakes.deps.ttsMp3).mock.calls.map(([text]) => text).join(' ')).not.toContain('Old');
    expect(driven.session.messages.at(-1)).toEqual({ role: 'assistant', content: REPLY });
  });
});

import { takeSpeculation } from '../../src/voice/turn/speculate.ts';

/** turn_start's early prep and the end-of-turn event sender for one session (no turn_end yet). */
async function listening(fakes: Fakes, session = pairedSession()) {
  startEarlyPrep(fakes.deps, session, REF);
  await flush();
  return { session, ev: (name: 'end' | 'resume' | 'drop', hypothesis = HYPOTHESIS): void => { onSpeculationEvent(fakes.deps, session, REF, name, hypothesis); } };
}

describe('speculative reply: discard', () => {
  it('resume discards the run (kept_talking); a second end runs again; a same-text end keeps it; a third run is refused (limit)', async () => {
    const fakes = fakeDeps(answer);
    const { session, ev } = await listening(fakes);
    ev('end');
    await sleep(60);
    ev('resume');
    expect(fakes.aborts[0]?.aborted).toBe(true);
    ev('end', 'What time is it? Thanks.');
    await sleep(60);
    ev('end', 'what time is it thanks');
    expect(fakes.models()).toBe(2);
    expect(fakes.aborts[1]?.aborted).toBe(false);
    ev('end', 'What is the date?');
    await sleep(60);
    expect(fakes.models()).toBe(2);
    expect(fakes.aborts[1]?.aborted).toBe(true);
    const speculation = takeSpeculation(session, REF);
    expect(speculation.live).toBe(false);
    expect(speculation.outcome()).toEqual({ speculation: 'discarded', speculation_reason: 'limit' });
  });

  it('an end for a turn with nothing pinned is not eligible: no model run', async () => {
    const fakes = fakeDeps(answer);
    const session = pairedSession();
    session.activeConversationId = undefined;
    const { ev } = await listening(fakes, session);
    ev('end');
    await sleep(40);
    expect(fakes.models()).toBe(0);
    expect(takeSpeculation(session, REF).outcome()).toEqual({ speculation: 'none', speculation_reason: 'not_eligible' });
  });

  it('a drop (cancel) before turn_end aborts the run; nothing is sent to the device or persisted', async () => {
    const fakes = fakeDeps(answer);
    const driven = await drive(fakes, async (session) => {
      onSpeculationEvent(fakes.deps, session, REF, 'end', HYPOTHESIS);
      await sleep(60);
      session.turnAbort?.abort();
      onSpeculationEvent(fakes.deps, session, REF, 'drop', HYPOTHESIS);
    });
    expect(fakes.aborts[0]?.aborted).toBe(true);
    expect(driven.sent.map((item) => item.type).filter((type) => type !== 'status')).toEqual([]);
    expect(persistTurn).not.toHaveBeenCalled();
    expect(fakes.deps.ttsMp3).not.toHaveBeenCalled();
    expect(driven.session.messages).toEqual([]);
    const { session, ev } = await listening(fakeDeps(answer));
    ev('end');
    await sleep(40);
    ev('drop');
    expect(takeSpeculation(session, REF).outcome()).toEqual({ speculation: 'discarded', speculation_reason: 'aborted' });
  });
});

describe('speculative reply: games, eot_source, journal', () => {
  it('an ACTIVE game turn is batch; its game tool waits for the commit and runs once', async () => {
    const game = { mode: 'active', tools: {} } as unknown as TurnCapabilities['game'];
    vi.mocked(buildTurnCapabilities).mockResolvedValue(capabilities({ game }));
    const fakes = fakeDeps(() => [[{ type: 'tool', name: 'clock' }], words('Nice guess.')], 'what time is it');
    const driven = await drive(fakes, async (session) => {
      endOf(fakes)(session);
      await sleep(150);
      expect(fakes.models()).toBe(1);
      expect(fakes.toolRuns).toEqual([]);
    });
    expect(fakes.toolRuns).toEqual(['clock']);
    expect(fakes.models()).toBe(1);
    expect(completed()).toMatchObject({ speculation: 'used' });
    expect(completed()).not.toHaveProperty('streamed');
    expect(driven.sent.filter((item) => item.type === 'reply_text')).toHaveLength(1);
    expect(driven.session.messages.at(-1)).toEqual({ role: 'assistant', content: 'Nice guess.' });
  });

  it('eot_source is device without a server end of turn and server with one', async () => {
    const device = fakeDeps(answer);
    await drive(device, endOf(device));
    expect(completed().eot_source).toBe('device');
    // Fixed stamps, no wall clock: the server sent end_of_turn at SENT_AT and turn_end came 150 ms later (inside 400 ms).
    const server = fakeDeps(answer);
    await drive(server, (session) => {
      recordServerEndOfTurn(session, REF, SENT_AT);
      recordTurnEnd(session, REF, SENT_AT + 150);
      endOf(server)(session);
    });
    expect(completed()).toMatchObject({ eot_source: 'server', eot_basis: 'order', eot_lag_ms: 150, speculation: 'used' });
  });

  it('eot_source is device when turn_end came 1000 ms after the server sent end_of_turn (outside 400 ms)', async () => {
    const late = fakeDeps(answer);
    await drive(late, (session) => {
      recordServerEndOfTurn(session, REF, SENT_AT);
      recordTurnEnd(session, REF, SENT_AT + 1000);
    });
    expect(completed()).toMatchObject({ eot_source: 'device', eot_basis: 'order', eot_lag_ms: 1000 });
  });

  it('the journal holds no hypothesis, transcript or reply text, for a used or a discarded run', async () => {
    const used = fakeDeps(answer);
    await drive(used, endOf(used));
    const mismatch = fakeDeps((run) => (run === 0 ? [words('Old reply text.')] : answer()), 'what time was it');
    const all: string[] = [JSON.stringify(lines)];
    await drive(mismatch, endOf(mismatch));
    all.push(JSON.stringify(lines));
    for (const secret of ['time is it', 'time was it', 'What time', 'half past', 'Anything else', 'Old reply']) {
      for (const text of all) expect(text).not.toContain(secret);
    }
    expect(completed()).toMatchObject({ speculation: 'discarded', speculation_reason: 'mismatch' });
  });
});

import { generateReply } from '../../src/voice/turn/generate.ts';

describe('speculative reply: the early snapshot is required, and a stale run never ends a newer one', () => {
  it('an early prep with no snapshot ends the run not_eligible: no store read by it, the agent runs once, on the final', async () => {
    const fakes = fakeDeps(answer);
    vi.mocked(resolveTurnMemory).mockResolvedValue({ memory: { ...memory, conversation: null }, contextMs: 5 });
    const driven = await drive(fakes, endOf(fakes));
    expect(buildAgentMessages).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildAgentMessages).mock.calls[0]?.[2]).toBe(FINAL);
    expect(fakes.models()).toBe(1);
    expect(completed()).toMatchObject({ speculation: 'discarded', speculation_reason: 'not_eligible' });
    expect(driven.session.messages.at(-1)).toEqual({ role: 'assistant', content: REPLY });
  });

  it('kept_talking: a resume with no second end, then a matching final, runs the agent twice and reports the discard', async () => {
    const fakes = fakeDeps(answer);
    const driven = await drive(fakes, async (session) => {
      endOf(fakes)(session);
      await sleep(60);
      onSpeculationEvent(fakes.deps, session, REF, 'resume', HYPOTHESIS);
    });
    expect(fakes.aborts[0]?.aborted).toBe(true);
    expect(fakes.models()).toBe(2);
    expect(completed()).toMatchObject({ speculation: 'discarded', speculation_reason: 'kept_talking' });
    expect(driven.session.messages.at(-1)).toEqual({ role: 'assistant', content: REPLY });
  });

  it('a superseded run that rejects late with a plain error does not discard the newer live run, which commits', async () => {
    const fakes = fakeDeps(answer, 'what is the date');
    let rejectOld!: (reason: unknown) => void;
    const oldReply = new Promise<never>((_resolve, reject) => { rejectOld = reject; });
    vi.mocked(generateReply).mockImplementationOnce(() => oldReply as never);
    const driven = await drive(fakes, async (session) => {
      onSpeculationEvent(fakes.deps, session, REF, 'end', HYPOTHESIS);
      await sleep(30);
      onSpeculationEvent(fakes.deps, session, REF, 'end', 'What is the date?');
      await sleep(30);
      rejectOld(new Error('aborted'));
      await flush();
    });
    expect(completed()).toMatchObject({ speculation: 'used' });
    expect(fakes.models()).toBe(1);
    expect(driven.session.messages.at(-1)).toEqual({ role: 'assistant', content: REPLY });
  });
});

import { newGameTurnState, type GameTurnState } from '../../src/voice/game-tools.ts';

describe('speculative reply: the game guard waits for the commit and keeps its own state (c2 B1)', () => {
  /** Every capabilities build gets its own game turn state, so a test sees whose state a run touched. */
  function gameTurns(): GameTurnState[] {
    const turns: GameTurnState[] = [];
    vi.mocked(buildTurnCapabilities).mockImplementation(async () => {
      const turn: GameTurnState = {
        ...newGameTurnState(), preview: { clock: 'It is half past three.' },
        run: vi.fn(async () => 'It is half past three.'), advance: vi.fn(async () => null),
      };
      turns.push(turn);
      const oneStep = { context: '[One step game]', stopWhen: (() => true) as never, prepareStep: (() => undefined) as never };
      return capabilities({ game: { mode: 'active', tools: {}, turn, oneStep } as unknown as TurnCapabilities['game'] });
    });
    return turns;
  }

  it('a speculative game run that finishes before turn_end moves nothing; a mismatching final leaves the state to the real run', async () => {
    const turns = gameTurns();
    const fakes = fakeDeps(answer, 'what time was it');
    await drive(fakes, async (session) => {
      endOf(fakes)(session);
      await sleep(MODEL_MS + 150);
      expect(fakes.models()).toBe(1);
    });
    // The snapshot's capabilities, and the speculative run's own.
    expect(turns).toHaveLength(2);
    expect(turns[1]!.run).not.toHaveBeenCalled();
    expect(turns[1]!.advance).not.toHaveBeenCalled();
    expect(turns[0]!.run).toHaveBeenCalledTimes(1);
    expect(completed()).toMatchObject({ speculation: 'discarded', speculation_reason: 'mismatch' });
  });

  it('a matching final runs the guard once, after the commit, on the speculative run\'s own state', async () => {
    const turns = gameTurns();
    const fakes = fakeDeps(answer, 'what time is it');
    await drive(fakes, async (session) => {
      endOf(fakes)(session);
      await sleep(MODEL_MS + 150);
      expect(turns.every((turn) => vi.mocked(turn.run!).mock.calls.length === 0)).toBe(true);
    });
    expect(turns).toHaveLength(2);
    expect(turns[1]!.run).toHaveBeenCalledTimes(1);
    expect(turns[0]!.run).not.toHaveBeenCalled();
    expect(completed()).toMatchObject({ speculation: 'used' });
  });
});

describe('speculative reply: a committed run that turns out ineligible falls back (c2 B3)', () => {
  it('an early context that resolves after turn_end: not_eligible, one real agent run, the turn completes', async () => {
    let release!: (value: { memory: TurnMemoryContext; contextMs: number }) => void;
    vi.mocked(resolveTurnMemory).mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const fakes = fakeDeps(answer);
    const driven = await drive(fakes, (session) => {
      endOf(fakes)(session);
      setTimeout(() => { release({ memory, contextMs: 5 }); }, SILENCE_MS + 60);
    });
    expect(fakes.models()).toBe(1);
    expect(completed()).toMatchObject({ speculation: 'discarded', speculation_reason: 'not_eligible' });
    expect(lines.some((line) => line.event === 'v2.turn_failed')).toBe(false);
    expect(driven.session.messages.at(-1)).toEqual({ role: 'assistant', content: REPLY });
  });
});

import { PCM16_16K_MONO_FORMAT } from '../../src/voice/protocol.ts';
import { prepareTurn } from '../../src/voice/turn/persist.ts';

describe('speculative reply: a private turn that could get Google tools speculates on a lazily resolved anchor (#1378)', () => {
  interface FakeContext { messageId?: string; anchor?: () => Promise<{ conversationId: string; messageId: string }> }
  /** A googleTools dep that behaves like production for both forms. Eager: tools only when the message id is the turn's
   *  prepared anchor. Deferred: tools at once; execute resolves the anchor and records the resolved message id. */
  const calendarTools = (executed: string[], anchorCalls: string[]) => async (context: FakeContext) => {
    const resolve = context.anchor;
    const anchor = resolve === undefined ? undefined : () => { anchorCalls.push('anchor'); return resolve(); };
    if (anchor === undefined && context.messageId !== memory.prepared?.userMessageId) return {};
    return {
      calendar_list: tool({ description: 'The calendar.', inputSchema: z.object({}), execute: async () => {
        executed.push(anchor === undefined ? context.messageId ?? '' : (await anchor()).messageId);
        return { events: [] };
      } }),
    };
  };
  /** The anchor write, as prepareTurn does it: sets the real prepared ids. */
  const anchorOnce = (conversationId = 'conv_aaaaaaaa'): void => {
    vi.mocked(prepareTurn).mockImplementationOnce(async (_session, _text, mem) => {
      if (mem) mem.prepared = { conversationId, userMessageId: 'msg_real_user', replyMessageId: 'msg_real_reply', scope, created: false, changedAt: 0 };
    });
  };
  const wire = async (fakes: Fakes, executed: string[], anchorCalls: string[], preparedConversationId?: string): Promise<void> => {
    Object.assign(fakes.deps, { googleTools: calendarTools(executed, anchorCalls) as never });
    const actual = await vi.importActual<typeof import('../../src/voice/turn/tools.ts')>('../../src/voice/turn/tools.ts');
    vi.mocked(googleTurnTools).mockImplementation(actual.googleTurnTools);
    anchorOnce(preparedConversationId);
  };
  it('a committed run whose prepare moved the turn to another conversation: the anchor rejects, nothing executes, the turn completes', async () => {
    const executed: string[] = [];
    const anchorCalls: string[] = [];
    const fakes = fakeDeps(() => [[{ type: 'tool', name: 'calendar_list' }], words('Nothing today.')], 'what time is it');
    await wire(fakes, executed, anchorCalls, 'conv_bbbbbbbb');
    try {
      await drive(fakes, endOf(fakes));
      expect(completed()).toMatchObject({ speculation: 'used' });
      expect(anchorCalls).toEqual(['anchor']);
      expect(executed).toEqual([]);
      expect(lines.some((line) => line.event === 'v2.turn_failed')).toBe(false);
    } finally {
      delete memory.prepared;
    }
  });
  it('with the Google runtime wired the run speculates and commits: the tool resolves the real anchor', async () => {
    const executed: string[] = [];
    const fakes = fakeDeps(() => [[{ type: 'tool', name: 'calendar_list' }], words('Nothing today.')], 'what time is it');
    await wire(fakes, executed, []);
    try {
      await drive(fakes, endOf(fakes));
      expect(completed()).toMatchObject({ speculation: 'used' });
      expect(fakes.models()).toBe(1);
      expect(executed).toEqual(['msg_real_user']);
    } finally {
      delete memory.prepared;
    }
  });

  it('a mismatching final discards the speculative run: its tool never executed and its anchor was never called', async () => {
    const executed: string[] = [];
    const anchorCalls: string[] = [];
    const fakes = fakeDeps(() => [[{ type: 'tool', name: 'calendar_list' }], words('Nothing today.')], 'what is the date');
    await wire(fakes, executed, anchorCalls);
    try {
      await drive(fakes, endOf(fakes));
      expect(completed()).toMatchObject({ speculation: 'discarded' });
      expect(fakes.models()).toBe(2);
      expect(executed).toEqual(['msg_real_user']);
      // The discarded run never resolved its anchor; the real run's early-prep Google tools resolve theirs once, on execute.
      expect(anchorCalls).toEqual(['anchor']);
    } finally {
      delete memory.prepared;
    }
  });

  it('without the Google runtime the turn speculates as before', async () => {
    const fakes = fakeDeps(answer);
    await drive(fakes, endOf(fakes));
    expect(completed()).toMatchObject({ speculation: 'used' });
    expect(fakes.models()).toBe(1);
  });
});

describe('speculative reply: PCM devices, and cancel after a commit (c2 N5, N10)', () => {
  it('a PCM device\'s speculative run is batch like its real one: nothing streamed, spoken by batch TTS', async () => {
    const fakes = fakeDeps(answer);
    const session = pairedSession();
    session.formatId = PCM16_16K_MONO_FORMAT;
    const driven = await drive(fakes, endOf(fakes), session);
    expect(completed()).toMatchObject({ speculation: 'used' });
    const agentDone = lines.find((line) => line.stage === 'agent' && line.outcome === 'completed');
    expect(agentDone).toMatchObject({ speculative: true });
    expect(agentDone).not.toHaveProperty('streamed');
    expect(fakes.deps.ttsPcm).toHaveBeenCalled();
    expect(fakes.deps.ttsMp3).not.toHaveBeenCalled();
    expect(driven.sent.filter((item) => item.type === 'reply_text')).toHaveLength(1);
  });

  it('a cancel after the commit aborts the committed run\'s model call, and the cancel journal carries the outcome', async () => {
    const fakes = fakeDeps(() => [[{ type: 'delay', ms: 700 }, ...words(REPLY)]]);
    const session = pairedSession();
    setTimeout(() => { session.turnAbort?.abort(); }, SILENCE_MS + 150);
    const driven = await drive(fakes, endOf(fakes), session);
    expect(fakes.models()).toBe(1);
    expect(fakes.aborts[0]?.aborted).toBe(true);
    expect(driven.sent.map((item) => item.type)).not.toContain('audio_down');
    expect(event('v2.turn_cancelled')).toMatchObject({ speculation: 'used' });
    expect(persistTurn).not.toHaveBeenCalled();
  });
});

import { sincePrevTurnMs } from '../../src/voice/turn-core.ts';

describe('speculative reply: since_prev_turn_ms stays a normal turn\'s (c3 N1)', () => {
  /** The last agent-completed line: a discarded run that finished early journals its own first. */
  const agentDone = (): Record<string, unknown> | undefined => lines.filter((line) => line.stage === 'agent' && line.outcome === 'completed').at(-1);

  it('the committed run\'s agent journal carries the gap to the previous turn', async () => {
    sincePrevTurnMs('conv_aaaaaaaa', Date.now() - 5_000);
    const fakes = fakeDeps(answer);
    await drive(fakes, endOf(fakes));
    expect(completed()).toMatchObject({ speculation: 'used' });
    expect(agentDone()).toMatchObject({ speculative: true });
    expect(agentDone()?.since_prev_turn_ms as number).toBeGreaterThanOrEqual(5_000);
  });

  it('a discarded run does not disturb it: the real run still sees the gap to the previous turn', async () => {
    sincePrevTurnMs('conv_aaaaaaaa', Date.now() - 5_000);
    const fakes = fakeDeps(answer, 'what time was it');
    await drive(fakes, endOf(fakes));
    expect(completed()).toMatchObject({ speculation: 'discarded', speculation_reason: 'mismatch' });
    expect(agentDone()?.since_prev_turn_ms as number).toBeGreaterThanOrEqual(5_000);
  });
});

describe('speculative reply: the tryCommit seam (SIMPLIFY-U9A)', () => {
  it('a mismatched final makes tryCommit resolve undefined, and the turn journals discarded/mismatch', async () => {
    const fakes = fakeDeps(answer);
    const { session, ev } = await listening(fakes);
    ev('end');
    await sleep(60);
    const speculation = takeSpeculation(session, REF);
    await expect(speculation.tryCommit('what time was it', undefined, undefined, Promise.resolve())).resolves.toBeUndefined();
    expect(fakes.aborts[0]?.aborted).toBe(true);
    expect(speculation.outcome()).toEqual({ speculation: 'discarded', speculation_reason: 'mismatch' });

    const turn = fakeDeps(answer, 'what time was it');
    await drive(turn, endOf(turn));
    expect(completed()).toMatchObject({ speculation: 'discarded', speculation_reason: 'mismatch' });
  });
});

describe('speculative Marketing: committed anchors only', () => {
  const binding = { installationId: 'installation_local', mode: 'run' as const };
  const prepared = { conversationId: scope.conversationId, userMessageId: 'msg_marketing_committed', replyMessageId: 'msg_marketing_reply', scope, created: false, changedAt: 0 };

  beforeEach(() => { delete memory.prepared; });
  afterEach(() => { delete memory.prepared; });

  async function started(): Promise<{ fakes: Fakes; session: SessionDto; executed: string[] }> {
    const executed: string[] = [];
    vi.mocked(preflightMarketingTurn).mockResolvedValue(binding);
    vi.mocked(marketingToolsForTurn).mockImplementation(async (_db, _user, _binding, _conversation, anchor) => ({
      save_draft: tool({ description: 'Save a draft.', inputSchema: z.object({}), execute: async () => {
        executed.push(anchor ?? 'missing'); return { ok: true };
      } }),
    }));
    const fakes = fakeDeps(() => [[{ type: 'tool', name: 'save_draft' }], words('Saved.')]);
    const session = pairedSession();
    startEarlyPrep(fakes.deps, session, REF);
    await flush();
    onSpeculationEvent(fakes.deps, session, REF, 'end', HYPOTHESIS);
    await flush();
    return { fakes, session, executed };
  }

  it('waits before the factory and model, then offers Marketing with the real committed user anchor', async () => {
    const { fakes, session, executed } = await started();
    expect(marketingToolsForTurn).not.toHaveBeenCalled();
    expect(fakes.models()).toBe(0);
    const speculation = takeSpeculation(session, REF);
    memory.prepared = prepared;
    await speculation.commit(undefined, undefined, Promise.resolve());
    expect(marketingToolsForTurn).toHaveBeenCalledWith(memory.db, memory.userId, binding, scope.conversationId, prepared.userMessageId);
    expect(fakes.models()).toBe(1);
    expect(executed).toEqual([prepared.userMessageId]);
    expect(speculation.outcome()).toMatchObject({ speculation: 'used' });
  });

  it('a discarded Marketing run never constructs a tool map or executes a write', async () => {
    const { fakes, session, executed } = await started();
    takeSpeculation(session, REF).discard('mismatch');
    await flush();
    expect(marketingToolsForTurn).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
    expect(fakes.models()).toBe(0);
  });

  it('an aborted commit never constructs a tool map or executes a write', async () => {
    const { fakes, session, executed } = await started();
    const controller = new AbortController();
    controller.abort(); memory.prepared = prepared;
    await expect(takeSpeculation(session, REF).commit(undefined, controller.signal, Promise.resolve())).rejects.toThrow();
    expect(marketingToolsForTurn).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
    expect(fakes.models()).toBe(0);
  });

  it('an active game neither resolves Marketing nor waits for its commit before starting the model', async () => {
    vi.mocked(preflightMarketingTurn).mockResolvedValue(binding);
    vi.mocked(buildTurnCapabilities).mockResolvedValue(capabilities({ game: { mode: 'active', tools: {}, turn: newGameTurnState() } }));
    const fakes = fakeDeps(() => [words('Ready.')]);
    const session = pairedSession();
    startEarlyPrep(fakes.deps, session, REF); await flush();
    onSpeculationEvent(fakes.deps, session, REF, 'end', HYPOTHESIS); await flush();
    expect(preflightMarketingTurn).not.toHaveBeenCalled();
    expect(marketingToolsForTurn).not.toHaveBeenCalled();
    expect(fakes.models()).toBe(1);
    const speculation = takeSpeculation(session, REF);
    await speculation.commit();
  });
});
