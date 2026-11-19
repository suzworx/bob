import { debugLog, BOB_AGENT_INSTRUCTIONS, toTraceAttrs, withTraceContext } from '@bob/ai';
import { type SessionDto } from '../protocol.ts';
import { moduleJournal } from '../../platform/logger.ts';
import { sessionBoard } from '../session-board.ts';
import { deviceCorrelation } from '../socket-diagnostics.ts';
import {
  agentActionOutcome,
  deviceToolParts,
  agentSectionSizes,
  agentUsageFields,
  MAX_HISTORY_MESSAGES,
  type AgentActionOutcome,
  sincePrevTurnMs,
  trimHistory,
  type AgentSectionSizes,
} from '../turn-core.ts';
import { journalTurnStage } from '../turn-journal.ts';
import { type GameTurnState } from '../game-tools.ts';
import type { ModelMessage, Tool } from 'ai';
import type { ChatMessage } from '../protocol.ts';
import { buildAgentMessages, type TurnMemoryContext } from './context.ts';
import type { TurnDeps } from './deps.ts';
import { buildTurnCapabilities } from './tools.ts';
import { type AgentImpl } from '../agent-port.ts';
import { runAgent, StreamedAgentResult, canStream, streamAgent } from './agent.ts';
import { started, timed } from '../../turn/prep-kit.ts';
import { loadPrep, offeredTools, peekSincePrevTurnMs, prepScopeKey, SpeculationIneligibleError } from '../../turn/device-prep.ts';
import { packedMemory, type EarlyPrep } from '../../turn/early-prep.ts';
import { voiceAgent } from '../../turn/policy.ts';
import { buildDeviceAgent } from '../../turn/device-agent.ts';
import { guardDeviceReply, holdOnceGameOpens } from '../../turn/game-turn.ts';

// The early prep and speculative eligibility live in turn/; speculate.ts and workflow-voice-turn.ts import them from here.
export { peekEarlyPrep, startEarlyPrep, takeEarlyPrep, type EarlyPrep } from '../../turn/early-prep.ts';
export { SpeculationIneligibleError };

const journal = moduleJournal('voice');

/** Timings and usage of one agent run, as the `completed` journal reports them (counts and ms only). */
export interface ReplyMetrics {
  prepMs: number;
  modelMs: number;
  usage: ReturnType<typeof agentUsageFields>;
}

/** The agent's final reply text, and whether it was streamed to `onText`. */
export interface GeneratedReply {
  text: string;
  streamed: boolean;
  metrics?: ReplyMetrics;
  /** Whether the run's tool actions worked (counts and an enum only). */
  actions: AgentActionOutcome;
  /** The guarded rest of a streamed reply, held once a game opened. */
  heldTail?: string;
  /** The tool calls the run finished, as stored UI parts, saved with the reply. */
  toolParts: Array<Record<string, unknown>>;
  /** A speculative run's history for `session.messages`, which the caller writes on commit. */
  keptHistory?: ChatMessage[];
}

/** A history message's size in characters: its text, or its parts as JSON. */
function messageChars(message: ModelMessage): number {
  return typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length;
}

/** The in-memory fallback history keeps the words of each turn only: a tool
 *  call and its result are replayed from the store, never from session memory. */
function textTurns(messages: ModelMessage[]): ChatMessage[] {
  const turns: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const content = typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    if (content !== '') turns.push({ role: message.role, content });
  }
  return turns;
}

/** What a speculative reply is held to until its commit. */
export interface ReplyOptions {
  /** The run may still be discarded: its journal stages say so and `session.messages` is left to the caller (`keptHistory`). */
  speculative?: boolean;
  /** Every tool that executes waits for this first; it rejects on discard, so a gated tool never runs uncommitted. */
  toolGate?: Promise<void>;
}

/** Runs the agent on the store-backed history (or in-memory fallback) and returns the reply.
 *  With `onText` the reply is streamed into it, unless a game is ACTIVE
 *  in this conversation (its guard needs the whole reply before any is spoken).
 *  `prepare` is the turn's anchor write (prepareTurn), still in flight. With the turn's early prep on the scope it was
 *  read for, the model starts without waiting for it: each tool waits for the write instead (the early gate).
 *  Otherwise the write is awaited (it may create or move the conversation), then one inline loadPrep runs. */
export async function generateReply(
  deps: TurnDeps,
  session: SessionDto,
  transcriptText: string,
  turnRef: string,
  memory: TurnMemoryContext | null,
  signal?: AbortSignal,
  contextMs?: number,
  onText?: (delta: string) => void,
  prepare?: Promise<void>,
  early?: EarlyPrep,
  options?: ReplyOptions,
): Promise<GeneratedReply> {
  const startedAt = Date.now();
  const speculative = options?.speculative === true ? { speculative: true } : {};
  let spaceMs: number | undefined;
  let gameMs: number | undefined;
  // The prep window's critical path, wait by wait (ms only): with other_ms
  // they sum to prep_ms, unlike the overlapping per-step `timings`.
  const waits: Record<string, number> = {};
  let sections: AgentSectionSizes = agentSectionSizes({ tools: {}, instructions: BOB_AGENT_INSTRUCTIONS });
  let agent: AgentImpl;
  // Per-step prep timings for the completed journal: ms only. prepare_ms is the anchor write's own, set when it settles.
  const timings: Record<string, number> = {};
  if (prepare !== undefined) timed(timings, 'prepare_ms', prepare).catch(() => undefined);
  journalTurnStage({
    interface: 'cardputer', turnId: turnRef, stage: 'prep', outcome: 'started',
    fields: { board: sessionBoard(session), paired: memory !== null, conversation_id: session.activeConversationId, ...speculative },
  });
  // Read while the user spoke; only on the scope it was read for.
  let prep = early === undefined ? null : await early.snapshot;
  if (prep?.scopeKey !== prepScopeKey(session, memory)) prep = null;
  // The early history, unless it may hold this turn's anchor (read after the write began); an inline one always.
  const usableHistory = (): Promise<ModelMessage[]> | null =>
    (prep !== null && (prep.source === 'inline' || prep.history.beforeSeal === true || early?.sealed !== true) ? prep.history.result : null);
  // A speculative run never reads the store (the anchor runTurn writes may be there once the final lands): with no usable
  // early history it ends here, before any prep work starts.
  if (options?.speculative === true && usableHistory() === null) throw new SpeculationIneligibleError();
  // Its own capabilities and Google/app tools (on its commit gate) go with a discarded run; history, pack, policy stay shared.
  if (options?.speculative === true && prep !== null && memory !== null) {
    const own: Record<string, number> = {};
    const capabilities = started(() => timed(own, 'capabilities_ms', buildTurnCapabilities(deps, session, memory)));
    prep = { ...prep, capabilities, timings: own, ...offeredTools(deps, memory, capabilities, own, options.toolGate, signal) };
  }
  if (prep === null && memory !== null) {
    // No usable early prep: the anchor write may create or move the conversation, so the inline prep reads after it.
    await prepare;
    prep = loadPrep(deps, session, memory, undefined, 'inline', { transcriptText, signal });
  }
  // An early turn's model starts before the anchor write settles: each tool waits for it (runTurn opens the gate), and
  // never runs once the turn is cancelled, or if the write landed the turn in another conversation.
  const startConversation = session.activeConversationId;
  const toolGate = options?.toolGate ?? (prep?.source === 'early' && early !== undefined
    ? started(() => early.gate.then(() => { if (session.activeConversationId !== startConversation) throw new Error('turn_scope_moved'); }))
    : undefined);
  // Read after any awaited prepare, which may have moved the turn to a new conversation.
  // A speculative run only reads it: the record stays the previous turn's until the commit stamps it (speculate.ts).
  const sincePrevTurn = options?.speculative === true ? peekSincePrevTurnMs(session.activeConversationId) : sincePrevTurnMs(session.activeConversationId);
  const historyStartedAt = Date.now();
  const ready = usableHistory();
  if (ready === null) await prepare;
  const messages = ready === null
    ? await buildAgentMessages(deps, session, transcriptText, memory)
    : prep?.source === 'inline' ? await ready : [...await ready, { role: 'user' as const, content: transcriptText }];
  // A speculative run's history must have settled before the seal, else it may hold the anchor (the early context resolved late).
  if (options?.speculative === true && prep?.history.beforeSeal !== true) throw new SpeculationIneligibleError();
  timings.history_ms = Date.now() - historyStartedAt;
  // The tools actually offered this turn, journaled by name only.
  let offeredToolMap: Record<string, Tool> = {};
  let toolScope: 'private' | 'space' = 'private';
  let gameTurn: GameTurnState | null = null;
  let gameActive = false;
  let memorySource: 'pack' | 'pack+partial' | undefined;
  let partialRecall: { partial_recall_ready: boolean; partial_recall_ms?: number } | undefined;
  if (memory !== null && prep !== null) {
    // A pack failure or timeout must never fail or delay the turn; on rejection the block is simply omitted.
    const packed = prep.pack === null ? null : await packedMemory(prep.pack, prep.source, early, waits);
    memorySource = packed?.memorySource;
    partialRecall = packed?.partialRecall;
    ({ agent, offeredToolMap, sections, toolScope, gameTurn, gameActive, spaceMs, gameMs } = await buildDeviceAgent({
      deps, session, turnRef, memory, prep, block: packed?.block ?? null, toolGate, signal, waits, speculative, journal,
    }));
  } else {
    // Missing account/storage context cannot establish any tool policy.
    agent = voiceAgent(deps, session);
  }
  // Prep_ms attributed: the critical-path waits (history_ms is on it
  // too) plus other_ms sum to prep_ms; the rest, prepare_ms included, are each
  // sub-stage's own ms, overlapping them. Ms and flags only.
  const prepEndedAt = Date.now();
  const prepMs = prepEndedAt - startedAt;
  const attributed = timings.history_ms + Object.values(waits).reduce((total, ms) => total + ms, 0);
  journalTurnStage({
    interface: 'cardputer', turnId: turnRef, stage: 'prep', outcome: 'completed',
    fields: {
      board: sessionBoard(session),
      prep_ms: prepMs,
      ...(timings.prepare_ms !== undefined ? { prepare_ms: timings.prepare_ms } : {}),
      history_ms: timings.history_ms,
      ...waits,
      other_ms: Math.max(0, prepMs - attributed),
      ...(contextMs !== undefined ? { context_ms: contextMs } : {}),
      ...prep?.timings,
      ...(spaceMs !== undefined ? { space_ms: spaceMs } : {}),
      ...(gameMs !== undefined ? { game_ms: gameMs } : {}),
      // Which prep the turn ran on, and how old it was at the model start (its start -> now).
      ...(prep !== null ? { prep_source: prep.source, snapshot_age_ms: prepEndedAt - prep.startedAt } : {}),
      ...(memorySource !== undefined ? { memory_source: memorySource } : {}),
      ...partialRecall,
      conversation_id: session.activeConversationId,
      ...speculative,
    },
  });
  // Scope only, never the Space id or name; sizes and counts, never text.
  const history = messages.slice(0, -1);
  journal('v2.agent_tools', {
    interface: 'cardputer',
    board: sessionBoard(session),
    turn_id: turnRef,
    tools: Object.keys(offeredToolMap).join(','),
    scope: toolScope,
    conversation_id: session.activeConversationId,
    ...sections,
    history_messages: history.length,
    history_chars: history.reduce((total, message) => total + messageChars(message), 0),
    history_attachment_bytes: 0,
    ...speculative,
  });
  journalTurnStage({
    interface: 'cardputer', turnId: turnRef, stage: 'agent', outcome: 'started',
    fields: { board: sessionBoard(session), messages: messages.length, conversation_id: session.activeConversationId, ...speculative },
  });
  // Prep_ms is start -> model call (prepare, history, retrieval, Space,
  // Google, wiring; the per-step ms in `timings` overlap, so they do not sum
  // to it); model_ms is the model call itself; duration_ms stays their sum.
  const modelStartedAt = Date.now();
  // Decided before the model runs; a game tool that
  // opens a game mid-turn flips gameTurn.gameTurn, and the rest is then held.
  const streamed = onText !== undefined && !gameActive && canStream(agent);
  const hold = holdOnceGameOpens(gameTurn);
  // One trace per turn; session.id is the client (socket) session, the conversation is its own id.
  // Unpaired turns have no memory (no user); the wrapper drops undefined.
  const result: StreamedAgentResult = await withTraceContext(
    toTraceAttrs({
      surface: 'device',
      turnId: turnRef,
      ...deviceCorrelation(session, memory?.userId),
      metadata: { interface: 'cardputer', board: sessionBoard(session) },
    }),
    () => (streamed
      ? streamAgent(messages, agent, onText, signal, hold)
      : runAgent(messages, agent, signal)),
  );
  const finishedAt = Date.now();
  const actions = agentActionOutcome(result);
  journalTurnStage({
    interface: 'cardputer', turnId: turnRef, stage: 'agent', outcome: 'completed',
    fields: {
      board: sessionBoard(session),
      duration_ms: finishedAt - startedAt,
      prep_ms: modelStartedAt - startedAt,
      model_ms: finishedAt - modelStartedAt,
      ...(contextMs !== undefined ? { context_ms: contextMs } : {}),
      ...(spaceMs !== undefined ? { space_ms: spaceMs } : {}),
      ...prep?.timings,
      ...timings,
      ...(sincePrevTurn !== undefined ? { since_prev_turn_ms: sincePrevTurn } : {}),
      ...agentUsageFields(result),
      tool_failures: actions.tool_failures,
      ...(result.stub ? { stub: true } : {}),
      ...(streamed ? { streamed: true } : {}),
      reply_chars: result.text.length,
      conversation_id: session.activeConversationId,
      ...speculative,
    },
  });
  debugLog('turn.agent_reply', {
    session: session.id,
    text: result.text,
    reply_chars: result.text.length,
    model: result.response?.modelId,
    usage: result.totalUsage ?? result.usage,
    finish_reason: result.finishReason,
    // Full call detail: arguments and results, not just a count.
    tool_calls: result.toolCalls,
    tool_results: (result as { toolResults?: unknown }).toolResults,
    // The conversation as actually sent to the model, so a wrong-language or
    // off-topic reply can be traced back to the history that produced it.
    messages,
    message_count: messages.length,
    duration_ms: Date.now() - startedAt,
  });
  // The in-memory history (the store-unavailable fallback) is trimmed with
  // offset 0: it only ever loses whole chunks from its front, so its start
  // stays chunk-aligned. A game reply is guarded before TTS, reply_text and the
  // save; a streamed reply whose game opened mid-turn guards only the held rest.
  // The guard runs game tools and moves the round on: it waits for the tool gate first (the anchor write, or a speculative commit).
  const guarded = gameTurn === null ? null : await guardDeviceReply(result, gameTurn, toolGate, journal);
  const heldTail = guarded?.heldTail;
  const replyText = guarded?.replyText ?? result.text;
  const kept = [...textTurns(messages), { role: 'assistant' as const, content: replyText }];
  const keptHistory = trimHistory(kept, MAX_HISTORY_MESSAGES, 0);
  if (options?.speculative !== true) session.messages = keptHistory;
  const metrics: ReplyMetrics = { prepMs: modelStartedAt - startedAt, modelMs: finishedAt - modelStartedAt, usage: agentUsageFields(result) };
  return {
    text: replyText, streamed, metrics, actions, toolParts: deviceToolParts(result.steps ?? []),
    ...(heldTail !== undefined ? { heldTail } : {}),
    ...(options?.speculative === true ? { keptHistory } : {}),
  };
}