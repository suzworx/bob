/**
 * Background memory-extraction worker, off the voice path: enqueue is
 * synchronous, debounced per account, and a no-op when memory is disabled. The
 * ops are applied with memory_extracted_at written in the SAME transaction. A
 * failure retries with backoff up to maxAttempts, then leaves the message
 * unmarked so the next boot's scan retries it. It never throws into the
 * caller; journals carry metadata only, never content.
 */
import { canonicalMemoryVoice, findDuplicate, MEMORY_GATE_THRESHOLD, updateActiveSpanMetadata, type ExistingMemory, type ExtractInput, type ExtractResult, type Embedder, type MemoryGate } from '@bob/ai';
import { telemetryConversationId } from '../platform/observability/conversation-correlation.ts';
import { traceWorkflow, type SetWorkflowOutcome } from '../platform/observability/workflow-diagnostics.ts';
import type { JournalFields } from '../platform/logger.ts';
import { withUser, type Db } from '../platform/db/db.ts';
import { GAME_PAUSE_AFTER_MS } from '../voice/games-store.ts';
import type { AppliedOp, ApplyExtractionOptions, ExtractionOp, MemoryEmbedding, MemorySurface } from './store.ts';
import type { UnextractedTurn } from './extract-queue.ts';
import { PREFILTER_VERSION, prefilter, prefilterEnforced, userCharsBucket } from './prefilter.ts';
import { isProviderContentTurn } from './provider-content.ts';

/** id null with kind null is a store that cannot say (unit fakes), treated as legacy private. */
type TurnSpace = { id: string | null; kind: string | null };

/** Personal memory is read and extracted only in a private space. A null kind
 *  is a legacy conversation with no space yet, which was private. */
export function allowsPersonalMemory(spaceKind: string | null | undefined): boolean {
  return spaceKind === null || spaceKind === undefined || spaceKind === 'private';
}

/** The startup scan reads recent messages only, so a boot never re-scans every row ever written. */
export const STARTUP_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const STARTUP_SCAN_LIMIT = 100;
export const RUN_BATCH_LIMIT = 200;
/** Live memories nearest an add's own vector that its first-line dedupe reads. */
const DEDUPE_NEAREST = 3;

interface MemoryMatchLike {
  id: string;
  kind: string;
  content: string;
}

interface MemoryExtractionWorkerDeps {
  db: Db;
  extractor: (input: ExtractInput) => Promise<ExtractResult>;
  embedder: Embedder;
  listUnextracted: (db: Db, userId: string, limit: number) => Promise<UnextractedTurn[]>;
  listAccounts: (
    db: Db,
    sinceMs: number,
    limit: number,
  ) => Promise<Array<{ userId: string }>>;
  matchMemories: (db: Db, userId: string, options: {
    queryText: string;
    queryEmbedding: number[];
    matchCount: number;
  }) => Promise<MemoryMatchLike[]>;
  applyExtractionOps: (
    db: Db,
    userId: string,
    ops: readonly ExtractionOp[],
    options: ApplyExtractionOptions,
  ) => Promise<readonly AppliedOp[] | void>;
  memoryAvailable: (db: Db) => Promise<boolean>;
  journal: (event: string, fields?: JournalFields) => void;
  clock: () => number;
  /** A game turn is marked extracted with no ops. Defaults to isGameTurnInStore on a real Db. */
  isGameTurn?: (db: Db, userId: string, turn: UnextractedTurn) => Promise<boolean>;
  /** Durable exclusion, checked again on every retry and startup scan. */
  isProviderContentTurn?: (db: Db, userId: string, turn: UnextractedTurn) => Promise<boolean>;
  /** A non-private turn is marked extracted with no ops. Defaults to turnSpaceInStore on a real Db. */
  turnSpace?: (db: Db, userId: string, turn: UnextractedTurn) => Promise<TurnSpace>;
  /** Present only when BOB_MEMORY_GATE is shadow or on: scores each turn
   *  before extraction; with `enforce`, a low score skips the extractor. */
  memoryGate?: { score: MemoryGate; enforce: boolean };
  debounceMs?: number;
  maxAttempts?: number;
}

export interface MemoryExtractionWorker {
  enqueue(userId: string): void;
  scanUnprocessed(): Promise<number>;
  idle(): Promise<void>;
  stop(): Promise<void>;
}

const TOP_SIMILAR = 5;
const BACKOFF_BASE_MS = 200;
/** A model id is journaled only when it looks like one (never free text). */
const MODEL_ID = /^[A-Za-z0-9._:/@-]{1,128}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A class name and status code only: never the message body (it can quote user text). */
function errorCause(error: unknown): { error_name: string; error_status?: number } {
  if (error instanceof Error) {
    const status = (error as { status?: unknown; statusCode?: unknown }).status
      ?? (error as { statusCode?: unknown }).statusCode;
    return {
      error_name: error.name || error.constructor?.name || 'Error',
      ...(typeof status === 'number' ? { error_status: status } : {}),
    };
  }
  return { error_name: 'UnknownError' };
}

function roundScore(score: number): number {
  return Math.round(score * 100) / 100;
}

/** A coarse label from the mean op confidence, never the raw distribution. */
function confidenceBucket(ops: ExtractionOp[]): string {
  const scored = ops.filter(
    (op) => op.op === 'add' || op.op === 'update' || op.op === 'supersede',
  ) as Array<{ confidence: number }>;
  if (scored.length === 0) return 'low';
  const mean = scored.reduce((sum, op) => sum + op.confidence, 0) / scored.length;
  if (mean >= 0.75) return 'high';
  if (mean >= 0.5) return 'medium';
  return 'low';
}

/** Adds of one kind the store actually wrote (a deduped add is not one). */
function addsOfKind(ops: readonly ExtractionOp[], finalOps: readonly string[], kind: string): number {
  return ops.filter((op, index) => op.op === 'add' && op.kind === kind && finalOps[index] === 'add').length;
}

function parseDueAt(op: ExtractResult['ops'][number]): number | null {
  if (op.op !== 'add' || op.due_at === undefined) return null;
  const parsed = Date.parse(op.due_at);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Pairs every content-bearing op with its vector, in ops order. */
function buildExtractionOps(
  result: ExtractResult,
  vectors: number[][],
  embedder: Embedder,
): ExtractionOp[] {
  const ops: ExtractionOp[] = [];
  let vectorIndex = 0;
  const nextEmbedding = (): MemoryEmbedding =>
    ({ values: vectors[vectorIndex++]!, model: embedder.modelId, dim: embedder.dim });
  for (const op of result.ops) {
    switch (op.op) {
      case 'add': {
        const embedding = nextEmbedding();
        const dueAt = parseDueAt(op);
        ops.push({
          op: 'add',
          kind: op.kind,
          content: op.content,
          confidence: op.confidence,
          ...(op.kind === 'action_item' && dueAt !== null ? { dueAt } : {}),
          embedding,
        });
        break;
      }
      case 'update':
        ops.push({ op: 'update', id: op.id, content: op.content, confidence: op.confidence, embedding: nextEmbedding() });
        break;
      case 'supersede':
        ops.push({ op: 'supersede', id: op.id, content: op.content, confidence: op.confidence, embedding: nextEmbedding() });
        break;
      case 'noop':
        ops.push({ op: 'noop', id: op.id });
        break;
    }
  }
  return ops;
}

function embedTexts(result: ExtractResult): string[] {
  const texts: string[] = [];
  for (const op of result.ops) {
    if (op.op === 'add' || op.op === 'update' || op.op === 'supersede') {
      texts.push(op.content);
    }
  }
  return texts;
}

/**
 * Whether a stored turn falls inside the lifetime of a game in its
 * conversation, widened by 2 minutes each side so the turns that start and
 * stop the game count too. Skipping is the safe direction. A game
 * is over at min(ended_at, last_turn_at + the pause window): a paused game
 * keeps ended_at null for a day, and the normal turns after it are
 * remembered. A store without the games table (42P01) has no games.
 */
export async function isGameTurnInStore(db: Db, userId: string, turn: UnextractedTurn): Promise<boolean> {
  try {
    const rows = await withUser(db, userId, (tx) => tx.query<{ hit: unknown }>(
      `SELECT 1 AS hit FROM bob.game_sessions g
       JOIN bob.messages m ON m.id = $2 AND m.user_id = $1 AND m.conversation_id = g.conversation_id
       WHERE g.user_id = $1
         AND m.created_at >= g.started_at - interval '2 minutes'
         AND m.created_at <= least(coalesce(g.ended_at, 'infinity'::timestamptz),
           g.last_turn_at + make_interval(secs => $3 / 1000.0)) + interval '2 minutes'
       LIMIT 1`,
      [userId, turn.messageId, GAME_PAUSE_AFTER_MS],
    ));
    return rows.length > 0;
  } catch (error) {
    if ((error as { code?: unknown }).code === '42P01') return false;
    throw error;
  }
}

/** A conversation with no space yet is a legacy private one (kind null). A
 *  space the caller cannot see answers kind 'unknown', which is not private:
 *  skipping is the safe direction. */
async function turnSpaceInStore(db: Db, userId: string, turn: UnextractedTurn): Promise<TurnSpace> {
  const rows = await withUser(db, userId, (tx) => tx.query<{ spaceId: unknown; kind: unknown }>(
    `SELECT c.space_id AS "spaceId", s.kind
       FROM bob.conversations c
       LEFT JOIN bob.spaces s ON s.id = c.space_id
      WHERE c.id = $1`,
    [turn.conversationId],
  ));
  const row = rows[0];
  if (!row || row.spaceId === null || row.spaceId === undefined) return { id: null, kind: null };
  return { id: String(row.spaceId), kind: typeof row.kind === 'string' ? row.kind : 'unknown' };
}

export function createMemoryExtractionWorker(deps: MemoryExtractionWorkerDeps): MemoryExtractionWorker {
  const debounceMs = deps.debounceMs ?? 2000;
  // A fake store in unit tests (no tx) cannot hold games or spaces.
  const isGameTurn = deps.isGameTurn ?? (typeof deps.db?.tx === 'function' ? isGameTurnInStore : null);
  const turnSpace = deps.turnSpace ?? (typeof deps.db?.tx === 'function' ? turnSpaceInStore : null);
  const providerContent = deps.isProviderContentTurn ?? (typeof deps.db?.tx === 'function' ? isProviderContentTurn : null);
  const maxAttempts = deps.maxAttempts ?? 3;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let active = 0;
  let stopped = false;
  let wakeIdle: (() => void) | null = null;

  function markDirty(): void {
    if (active === 0 && timers.size === 0 && wakeIdle) {
      const wake = wakeIdle;
      wakeIdle = null;
      wake();
    }
  }

  async function runAccount(userId: string): Promise<void> {
    if (stopped) return;
    return traceWorkflow('memory-account', { detached: true, tags: ['memory'] }, (outcome) => runAccountWork(userId, outcome));
  }

  async function runAccountWork(userId: string, outcome: SetWorkflowOutcome): Promise<void> {
    let available = false;
    try {
      available = await deps.memoryAvailable(deps.db);
    } catch {
      available = false;
    }
    if (!available) { outcome('skipped'); updateActiveSpanMetadata({ reason: 'unavailable' }); return; }

    let turns: UnextractedTurn[] = [];
    try {
      turns = await deps.listUnextracted(deps.db, userId, RUN_BATCH_LIMIT);
    } catch {
      // A store outage is journaled as skipped; the next scan retries.
      deps.journal('v2.memory_skipped', { reason: 'store_unavailable' });
      outcome('failed');
      return;
    }

    for (const turn of turns) {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          await traceWorkflow('memory-extract', {
            detached: true,
            workflowNamespace: `memory/${userId}`, turnId: turn.messageId,
            conversationId: telemetryConversationId(turn.conversationId), userId, tags: ['memory'],
            metadata: { attempt: String(attempt) },
          }, (report) => processTurn(userId, turn, report));
          break;
        } catch (error) {
          if (attempt < maxAttempts) {
            await sleep(BACKOFF_BASE_MS * attempt);
            continue;
          }
          deps.journal('v2.memory_skipped', {
            reason: 'extract_failed',
            attempts: attempt,
            ...errorCause(error),
          });
          outcome('failed');
          break;
        }
      }
    }
  }

  /** Marks the turn extracted with no ops: it never reaches the extractor. */
  async function skipTurn(userId: string, turn: UnextractedTurn, outcome: SetWorkflowOutcome,
    reason: string, fields: JournalFields = {}): Promise<void> {
    await deps.applyExtractionOps(deps.db, userId, [], {
      source: { conversationId: turn.conversationId, messageId: turn.messageId, surface: turn.surface as MemorySurface },
      markMessageId: turn.messageId,
    });
    deps.journal('v2.memory_skipped', { reason, ...fields });
    outcome('skipped'); updateActiveSpanMetadata({ reason });
  }

  async function processTurn(userId: string, turn: UnextractedTurn, outcome: SetWorkflowOutcome): Promise<void> {
    if (providerContent !== null && await providerContent(deps.db, userId, turn)) {
      return skipTurn(userId, turn, outcome, 'external_provider_content');
    }
    // A second gate behind listUnextracted's private-only filter.
    const space: TurnSpace = turnSpace === null ? { id: null, kind: null } : await turnSpace(deps.db, userId, turn);
    if (!allowsPersonalMemory(space.kind)) return skipTurn(userId, turn, outcome, 'shared_space');
    if (isGameTurn !== null && await isGameTurn(deps.db, userId, turn)) return skipTurn(userId, turn, outcome, 'game_turn');
    const verdict = prefilter(turn.userText);
    if (prefilterEnforced() && verdict.verdict === 'skip') {
      return skipTurn(userId, turn, outcome, 'prefiltered', {
        prefilter_version: PREFILTER_VERSION,
        prefilter_reason: verdict.reason,
        user_chars_bucket: userCharsBucket(turn.userText),
      });
    }
    // The gate fails open: an error or timeout extracts as if it were absent.
    let gateScore: number | undefined;
    if (deps.memoryGate) {
      try {
        gateScore = await deps.memoryGate.score({ userText: turn.userText, assistantText: turn.assistantText, userId });
      } catch (error) {
        deps.journal('v2.memory_gate_failed', errorCause(error));
      }
      if (deps.memoryGate.enforce && gateScore !== undefined && gateScore < MEMORY_GATE_THRESHOLD) {
        return skipTurn(userId, turn, outcome, 'gated', { gate_score: roundScore(gateScore) });
      }
    }
    const queryEmbedding = await deps.embedder.embed(turn.userText);
    const matches = await deps.matchMemories(deps.db, userId, {
      queryText: turn.userText,
      queryEmbedding,
      matchCount: TOP_SIMILAR,
    });
    const existing: ExistingMemory[] = matches.map((match) => ({
      id: match.id,
      kind: match.kind as ExistingMemory['kind'],
      content: match.content,
    }));

    // extract_ms is the extraction model call alone (not embeds or writes).
    const extractStartedAt = Date.now();
    const extracted = await deps.extractor({
      userText: turn.userText,
      assistantText: turn.assistantText,
      existing,
      now: new Date(deps.clock()),
    });
    const extractMs = Date.now() - extractStartedAt;
    // One voice for every stored memory, before anything is embedded.
    const result: ExtractResult = {
      ...extracted,
      ops: extracted.ops.map((op) => (op.op === 'noop' ? op : { ...op, content: canonicalMemoryVoice(op.content) })),
    };

    const texts = embedTexts(result);
    const vectors = texts.length === 0 ? [] : await deps.embedder.embedMany(texts);
    // The extractor compared adds only against the memories nearest the user's
    // words; each add is also compared against the live memories nearest its
    // own vector, so a paraphrase outside that set still becomes a noop. The
    // store's own lexical check is the backstop for whatever reaches it.
    let echoDuplicates = 0;
    const ops: ExtractionOp[] = [];
    for (const op of buildExtractionOps(result, vectors, deps.embedder)) {
      if (op.op !== 'add' || !op.embedding) {
        ops.push(op);
        continue;
      }
      const nearest = await deps.matchMemories(deps.db, userId, {
        queryText: op.content,
        queryEmbedding: op.embedding.values,
        matchCount: DEDUPE_NEAREST,
      });
      const id = findDuplicate(op.content, nearest);
      if (id === null) {
        ops.push(op);
      } else {
        echoDuplicates += 1;
        ops.push({ op: 'noop', id });
      }
    }
    const source: ApplyExtractionOptions['source'] = {
      conversationId: turn.conversationId,
      messageId: turn.messageId,
      surface: turn.surface as MemorySurface,
      ...(space.id !== null ? { spaceId: space.id } : {}),
    };
    const applied = await traceWorkflow('memory-extract-write', {}, () => deps.applyExtractionOps(deps.db, userId, ops, {
      source,
      markMessageId: turn.messageId,
      path: 'extract',
      journal: deps.journal,
    }));
    // The store's decisions when it reports them (a fake may not): an op it
    // found already stored counts as a noop, and as a duplicate when it was an add.
    const decided = Array.isArray(applied) && applied.length === ops.length ? applied : null;
    const finalOps = decided ? decided.map((entry) => entry.op) : ops.map((op) => op.op);
    const deduped = decided ? decided.filter((entry) => entry.guard !== 'none').length : 0;
    const addsDeduped = decided ? decided.filter((entry, index) => entry.guard !== 'none' && ops[index]?.op === 'add').length : 0;
    const duplicates = (result.rejected?.duplicate ?? 0) + echoDuplicates + addsDeduped;

    const extractModel = result.modelId !== undefined && MODEL_ID.test(result.modelId) ? result.modelId : undefined;
    deps.journal('v2.memory_extracted', {
      count: ops.length,
      conversation_id: turn.conversationId ?? undefined,
      message_id: turn.messageId,
      reason: ops.length === 0 ? 'no_ops' : deduped > 0 ? 'deduped' : 'applied',
      ops_deduped: deduped,
      embed_model: deps.embedder.modelId,
      ...(extractModel !== undefined ? { extract_model: extractModel } : {}),
      ...(result.usage?.inputTokens !== undefined ? { extract_input_tokens: result.usage.inputTokens } : {}),
      ...(result.usage?.outputTokens !== undefined ? { extract_output_tokens: result.usage.outputTokens } : {}),
      extract_ms: extractMs,
      confidence_bucket: confidenceBucket(ops),
      ops_add: finalOps.filter((op) => op === 'add').length,
      ops_update: finalOps.filter((op) => op === 'update').length,
      ops_supersede: finalOps.filter((op) => op === 'supersede').length,
      ops_noop: finalOps.filter((op) => op === 'noop').length,
      adds_fact: addsOfKind(ops, finalOps, 'fact'),
      adds_preference: addsOfKind(ops, finalOps, 'preference'),
      adds_intent: addsOfKind(ops, finalOps, 'intent'),
      adds_action_item: addsOfKind(ops, finalOps, 'action_item'),
      dropped_secret: result.dropped.secret,
      dropped_sensitive: result.dropped.sensitive,
      adds_ungrounded: result.rejected?.ungrounded ?? 0,
      adds_duplicate: duplicates,
      changes_ungrounded: result.rejected?.changesUngrounded ?? 0,
      changes_narrowed: result.rejected?.narrowed ?? 0,
      prefilter_version: PREFILTER_VERSION,
      prefilter_verdict: verdict.verdict,
      prefilter_reason: verdict.reason,
      user_chars_bucket: userCharsBucket(turn.userText),
      ...(gateScore !== undefined ? { gate_score: roundScore(gateScore) } : {}),
    });
  }

  /** A burst of enqueues collapses into one run after debounceMs. */
  function enqueue(userId: string): void {
    if (stopped) return;
    const existing = timers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(userId);
      active += 1;
      void runAccount(userId)
        .catch(() => undefined)
        .finally(() => {
          active -= 1;
          markDirty();
        });
    }, debounceMs);
    timers.set(userId, timer);
  }

  async function scanUnprocessed(): Promise<number> {
    if (stopped) return 0;
    return traceWorkflow('memory-scan', { detached: true, tags: ['memory'] }, scanAccounts);
  }

  async function scanAccounts(outcome: SetWorkflowOutcome): Promise<number> {
    let available = false;
    try {
      available = await deps.memoryAvailable(deps.db);
    } catch {
      available = false;
    }
    if (!available) { outcome('skipped'); return 0; }
    let accounts: Array<{ userId: string }> = [];
    try {
      accounts = await deps.listAccounts(deps.db, deps.clock() - STARTUP_SCAN_WINDOW_MS, STARTUP_SCAN_LIMIT);
    } catch {
      outcome('failed');
      return 0;
    }
    for (const account of accounts) {
      enqueue(account.userId);
    }
    return accounts.length;
  }

  async function idle(): Promise<void> {
    if (active === 0 && timers.size === 0) return;
    await new Promise<void>((resolve) => {
      wakeIdle = resolve;
    });
  }

  async function stop(): Promise<void> {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    await idle();
  }

  return { enqueue, scanUnprocessed, idle, stop };
}
