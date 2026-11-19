/**
 * Device prep: one paired device turn's reads (loadPrep), every one started at once, and what the model start may use.
 * Trigger: voice/turn/generate.ts generateReply (inline) and turn/early-prep.ts startEarlyPrep (at turn_start).
 * Steps: start the capabilities (game scope + Space), the tool policy, the history, the memory pack and, beside the
 *   game, the Google and app tools (turn/early-prep.ts merges the pack with a settled partial recall).
 * Outcome: a TurnPrep keyed by its scope (prepScopeKey). It defines SpeculationIneligibleError, which generate.ts throws
 *   when a speculative run has no usable early history.
 * Journal: none (generate.ts journals the prep's timings).
 */
import type { ModelMessage, Tool } from 'ai';
import { startMemoryPack, type RetrievalResult } from '../memory/retrieval.ts';
import type { SessionDto } from '../voice/protocol.ts';
import { sincePrevTurnMs } from '../voice/turn-core.ts';
import { buildAgentMessages, loadAgentHistory, personalMemoryTurn, type TurnMemoryContext } from '../voice/turn/context.ts';
import type { TurnDeps } from '../voice/turn/deps.ts';
import { appTurnTools, buildTurnCapabilities, googleTurnTools, type TurnCapabilities } from '../voice/turn/tools.ts';
import { started, timed } from './prep-kit.ts';
import { turnPolicyFilter } from './policy.ts';

/** The scope fields the turn's prep decisions read (memory on or off, game,
 *  Space): a prep read on another scope is stale, and the turn preps inline
 *  instead. Ids and enums, never journaled. */
export function prepScopeKey(session: SessionDto, memory: TurnMemoryContext | null): string {
  const scope = memory?.conversation ?? null;
  return JSON.stringify([
    session.activeConversationId ?? null, memory?.memoryOn ?? null,
    scope === null ? null : [scope.conversationId, scope.spaceId, scope.spaceKind, scope.spaceName, scope.spaceArchived, scope.archivedAt],
  ]);
}

/** One turn's prep (loadPrep): every read started at once, each promise marked handled when it starts. */
export interface TurnPrep {
  /** `early`: started at turn_start while the user spoke; `inline`: started once the anchor write settled. */
  source: 'early' | 'inline';
  /** prepScopeKey when it started: any other scope at model start preps inline instead. */
  scopeKey: string;
  startedAt: number;
  capabilities: Promise<TurnCapabilities>;
  policy: Promise<(tools: Record<string, Tool>) => Record<string, Tool>>;
  /** Early: the history without the transcript, `beforeSeal` once it settled before the anchor write started.
   *  Inline: the agent messages, the transcript included. */
  history: { result: Promise<ModelMessage[]>; beforeSeal?: boolean };
  /** The memory pack (standing facts, due soon; no embed); null unless the turn reads personal memory. */
  pack: Promise<RetrievalResult> | null;
  /** The Google and app tools; {} in an ACTIVE game. */
  google: Promise<Record<string, Tool>>;
  appTools: Promise<Record<string, Tool>>;
  /** Each step's own ms once settled: capabilities_ms, google_ms, app_tools_ms. */
  timings: Record<string, number>;
}

/** The ms since the previous turn, for a speculative run that may be discarded. sincePrevTurnMs always stamps `now`, so
 *  this stamps, then writes the previous stamp (now - gap) back: net no change, and the commit stamps the real turn.
 *  Known gap: on a conversation's first turn there is no previous stamp to restore, so a discarded run leaves its stamp
 *  and the real turn then reports a small since_prev_turn_ms where it would have reported none. */
export function peekSincePrevTurnMs(conversationId: string | undefined): number | undefined {
  const now = Date.now();
  const gap = sincePrevTurnMs(conversationId, now);
  if (gap !== undefined) sincePrevTurnMs(conversationId, now - gap);
  return gap;
}

/** Starts a paired turn's prep, every step at once: the capabilities (game scope + Space), the tool policy, the history,
 *  the memory pack (personal-memory turns only; a pair or group conversation gets no memory block or tools), and the
 *  Google and app tools, which wait only for the game scope (never offered in an ACTIVE game). With `gate` (an early
 *  prep) those two take a lazy anchor that `gate` resolves once the anchor write settles; without it the turn is already
 *  prepared. `transcriptText` (inline) makes the history the agent messages; `signal` cancels the Google and app calls. */
export function loadPrep(
  deps: TurnDeps, session: SessionDto, memory: TurnMemoryContext, gate: Promise<void> | undefined, source: TurnPrep['source'],
  turn: { transcriptText?: string; signal?: AbortSignal },
): TurnPrep {
  const timings: Record<string, number> = {};
  const conversationId = memory.conversation?.conversationId ?? memory.prepared?.conversationId;
  const capabilities = started(() => timed(timings, 'capabilities_ms', buildTurnCapabilities(deps, session, memory)));
  const policy = started(() => capabilities.then((built) => turnPolicyFilter(memory, conversationId, built)));
  const history = {
    result: started(() => (turn.transcriptText === undefined ? loadAgentHistory(deps, session, memory) : buildAgentMessages(deps, session, turn.transcriptText, memory))),
  };
  const pack = personalMemoryTurn(session, memory) ? started(() => startMemoryPack(memory.db, memory.userId, { embedder: deps.embedder() }).result) : null;
  return {
    source, scopeKey: prepScopeKey(session, memory), startedAt: Date.now(), capabilities, policy, history, pack, timings,
    ...offeredTools(deps, memory, capabilities, timings, gate, turn.signal),
  };
}

/** The Google and app tools, started together once the game scope is read: never offered in an ACTIVE game. */
export function offeredTools(
  deps: TurnDeps, memory: TurnMemoryContext, capabilities: Promise<TurnCapabilities>, timings: Record<string, number>,
  gate: Promise<void> | undefined, signal?: AbortSignal,
): Pick<TurnPrep, 'google' | 'appTools'> {
  const besideGame = (key: 'google_ms' | 'app_tools_ms', build: () => Promise<Record<string, Tool>>): Promise<Record<string, Tool>> => started(() => capabilities.then(
    (built) => (built.game?.mode === 'active' ? {} : timed(timings, key, build())),
    () => ({}),
  ));
  return {
    google: besideGame('google_ms', () => googleTurnTools(deps, memory, signal, gate)),
    appTools: besideGame('app_tools_ms', () => appTurnTools(deps, memory, signal, gate)),
  };
}

/** A speculative reply with no usable early history: it ends without reading the store, where the anchor may already be. */
export class SpeculationIneligibleError extends Error {
  constructor() {
    super('speculation_ineligible');
    this.name = 'SpeculationIneligibleError';
  }
}
