/**
 * Early prep: a paired device turn's transcript-free prep, started at turn_start while the user speaks, so it has
 * settled when the transcript lands (docs/voice-latency-rca.md "Prep to 5 ms").
 * Trigger: TurnDeps.startEarlyPrep at turn_start; taken (or peeked by a speculative reply) for its own turn only.
 * Steps: 1. resolve the account context, then loadPrep on the pinned conversation, behind a gate runTurn opens once
 *   the anchor write settles. 2. recall on the streaming STT hypothesis. 3. at model start, merge the memory pack with
 *   a recall that already settled (never awaited).
 * Outcome: an EarlyPrep the turn uses only on the scope it was read for; never throws.
 * Journal: none (generate.ts journals prep_source, memory_source and partial_recall_*).
 */
import { packWithRecall, startMemoryRecall, type RetrievalResult } from '../memory/retrieval.ts';
import type { SessionDto } from '../voice/protocol.ts';
import { watchSttHypothesis } from '../voice/turn/stream-stt.ts';
import { personalMemoryTurn, resolveTurnMemory, type TurnMemoryContext } from '../voice/turn/context.ts';
import type { TurnDeps } from '../voice/turn/deps.ts';
import { waitedFor } from './prep-kit.ts';
import { loadPrep, type TurnPrep } from './device-prep.ts';

/** The transcript-free prep of one paired turn, started at turn_start while
 *  the user speaks, so it has settled when the transcript lands
 *  (docs/voice-latency-rca.md "Prep to 5 ms"). Held for its own turn only. */
export interface EarlyPrep {
  turnRef: string;
  startedAt: number;
  /** The conversation pinned at turn_start: a turn pinned elsewhere by turn_end does not use this. */
  conversationId: string | undefined;
  /** resolveTurnMemory, without the extraction worker (runTurn attaches it). */
  context: Promise<{ memory: TurnMemoryContext | null; contextMs?: number }>;
  /** loadPrep's reads that hang off the context; null with no account, nothing pinned or no readable scope (the turn
   *  then preps inline). */
  snapshot: Promise<TurnPrep | null>;
  /** Set by runTurn just before the anchor write: a history read that settles
   *  after it may already hold this turn's user message, so it is not used. */
  sealed: boolean;
  /** The query recall on the streaming STT hypothesis, once one started. */
  recall?: PartialRecall;
  /** Opened by runTurn when the anchor write settles; closeGate (cancel, abort, false wake) rejects it and aborts `signal`,
   *  which the early Google and app calls take. Those read their anchor after it; an early model gates every tool on it. */
  gate: Promise<void>;
  signal: AbortSignal;
  openGate: () => void; closeGate: () => void;
}

/** A query recall on the user's words so far; `ms` and `value` are set once it settles. */
interface PartialRecall {
  ms?: number;
  value: RetrievalResult | null;
}

/** Starts the query search (embed + match) on the hypothesis, only for a turn
 *  the memory pack serves (personal memory) outside an ACTIVE game, whose turn
 *  gets no memory block. Never throws. */
function startPartialRecall(deps: TurnDeps, session: SessionDto, early: EarlyPrep, hypothesis: string): PartialRecall {
  const startedAt = Date.now();
  const recall: PartialRecall = { value: null };
  const settle = (value: RetrievalResult | null): void => { recall.ms = Date.now() - startedAt; recall.value = value; };
  const search = async (): Promise<RetrievalResult | null> => {
    const [{ memory }, snapshot] = await Promise.all([early.context, early.snapshot]);
    if (!personalMemoryTurn(session, memory) || !snapshot?.pack) return null;
    if ((await snapshot.capabilities.catch(() => null))?.game?.mode === 'active') return null;
    return startMemoryRecall(memory.db, memory.userId, hypothesis, { embedder: deps.embedder() }).result;
  };
  search().then(settle, () => { settle(null); });
  return recall;
}

const earlyPreps = new WeakMap<SessionDto, EarlyPrep>();

/** Starts a paired turn's transcript-free prep: the account context, then loadPrep on the pinned conversation.
 *  Replaces any snapshot an abandoned turn left. Never throws. */
export function startEarlyPrep(deps: TurnDeps, session: SessionDto, turnRef: string): void {
  const context = resolveTurnMemory(deps, session);
  const cancel = new AbortController();
  let openGate = (): void => undefined;
  const gate = new Promise<void>((resolve, reject) => { openGate = resolve; cancel.signal.addEventListener('abort', () => { reject(new Error('turn_cancelled')); }); });
  gate.catch(() => undefined);
  const early: EarlyPrep = {
    turnRef, startedAt: Date.now(), conversationId: session.activeConversationId, context, snapshot: Promise.resolve(null), sealed: false,
    gate, signal: cancel.signal, openGate, closeGate: () => { cancel.abort(); },
  };
  early.snapshot = context.then(({ memory }) => {
    if (memory?.conversation?.conversationId === undefined || session.activeConversationId !== early.conversationId) return null;
    const prep = loadPrep(deps, session, memory, early.gate, 'early', { signal: early.signal });
    prep.history.result.then(() => { if (!early.sealed) prep.history.beforeSeal = true; }, () => undefined);
    return prep;
  }, () => null);
  context.catch(() => undefined);
  earlyPreps.set(session, early);
  // Recall on the words so far, while the uplink drains (docs/voice-latency-rca.md "Prep to 5 ms").
  watchSttHypothesis(session, (hypothesis) => { early.recall = startPartialRecall(deps, session, early, hypothesis); });
}

/** The turn's early prep, once: undefined for another turn, or when the
 *  turn's conversation is no longer the one pinned at turn_start. */
export function takeEarlyPrep(session: SessionDto, turnRef: string): EarlyPrep | undefined {
  const early = earlyPreps.get(session);
  if (early?.turnRef !== turnRef) return undefined;
  earlyPreps.delete(session);
  return early.conversationId === session.activeConversationId ? early : undefined;
}

/** The turn's early prep without taking it, for the speculative reply that runs before turn_end;
 *  runTurn's takeEarlyPrep still finds it. Same turn and conversation check as takeEarlyPrep. */
export function peekEarlyPrep(session: SessionDto, turnRef: string): EarlyPrep | undefined {
  const early = earlyPreps.get(session);
  return early?.turnRef === turnRef && early.conversationId === session.activeConversationId ? early : undefined;
}

/** The memory block from the pack (no query embed or search on the critical path); a pack failure or timeout only omits
 *  it. An early prep's partial recall is read after the pack and used only if it already settled: never awaited. */
export async function packedMemory(pack: Promise<RetrievalResult>, source: TurnPrep['source'], early: EarlyPrep | undefined, waits: Record<string, number>): Promise<{
  block: string | null; memorySource: 'pack' | 'pack+partial'; partialRecall?: { partial_recall_ready: boolean; partial_recall_ms?: number };
}> {
  let memorySource: 'pack' | 'pack+partial' = 'pack';
  const packed = await waitedFor(waits, 'retrieval_wait_ms', pack).catch(() => null);
  let block = packed?.block ?? null;
  const recall = source === 'early' ? early?.recall : undefined;
  if (recall === undefined) return { block, memorySource };
  const partialRecall = { partial_recall_ready: recall.ms !== undefined, ...(recall.ms !== undefined ? { partial_recall_ms: recall.ms } : {}) };
  // pack+partial only when the recall added a memory the pack did not hold.
  if (packed !== null && recall.value !== null) {
    const merged = packWithRecall(packed, recall.value, new Date());
    if (merged.added > 0) {
      block = merged.block;
      memorySource = 'pack+partial';
    }
  }
  return { block, memorySource, partialRecall };
}
