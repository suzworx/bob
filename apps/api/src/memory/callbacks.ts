/**
 * The memory tool callbacks (apps/ai never imports the DB, so apps/api supplies
 * them). Every call runs inside withUser so a foreign id is a no-op, never an
 * oracle. When memory is unavailable every callback returns { disabled: true }
 * WITHOUT touching SQL.
 */
import { withUser, type Db } from '../platform/db/db.ts';
import { completeBestMatch, listActionItems, setActionItemStatus, type ActionItemStatus } from '../tasks/action-items-store.ts';
import {
  applyExtractionOps,
  deleteMemory,
  findBestMatch,
  nearestCurrentMemories,
  type AppliedOp,
  type ExtractionOp,
  type MemoryEmbedding,
  type MemorySurface,
} from './store.ts';
import { memoryAvailable } from './available.ts';
import { canonicalMemoryVoice, secretReason, type MemoryJudge, type MemoryJudgeVerdict, sensitiveCategory, type ActionItemCandidate, type ActionItemView, type CompleteActionCallbackResult, type CompleteActionInput, type ForgetCallbackResult, type ForgetInput, type ListActionsInput, type RememberCallbackResult, type RememberInput } from '@bob/ai';

/** The forget / complete_action targeting floor: any text-rank hit (score > 0)
 *  qualifies; websearch_to_tsquery with @@ already requires every query term,
 *  and the ambiguity margin then decides. */
export const DEFAULT_TARGET_FLOOR = 0;

type MemoryCallbackTurn = {
  conversationId: string | null;
  messageId: string | null;
  surface: MemorySurface;
};

interface MemoryCallbackDeps {
  isAvailable?: () => Promise<boolean>;
  matchFloor?: number;
  /** Defaults to web_text with no conversation. */
  turn?: MemoryCallbackTurn;
  /** Defaults to the owner's private space (resolved by the store on insert). */
  spaceId?: string;
  /** On failure remember stores without a vector. */
  embedder?: (content: string) => Promise<MemoryEmbedding>;
  /** Metadata only: ids and counts, never content. */
  journal?: (event: string, fields: Record<string, string | number | boolean | undefined>) => void;
  /** Without it (or without an embedding) remember relies on the store's lexical check alone. */
  judge?: MemoryJudge;
}

/** The memory judge's candidates: the nearest current memories within this
 *  cosine distance. Calibrated on text-embedding-3-small: true paraphrases
 *  measured 0.07-0.29, so 0.35 keeps them; the judge, not the distance,
 *  decides. Most remembers have no row this close and pay no model call. */
const JUDGE_MAX_DISTANCE = 0.35;
const JUDGE_CANDIDATES = 3;
/** A slow judge never holds up the turn: past this the memory is added. */
const JUDGE_TIMEOUT_MS = 5000;

const NOT_JUDGED: MemoryJudgeVerdict = { relation: 'different', id: null };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function rememberReason(decision: AppliedOp | undefined): string {
  if (decision?.op === 'add') return 'new';
  if (decision?.op === 'supersede') return 'judge_updates';
  if (decision?.guard === 'judge') return 'judge_same';
  return 'duplicate';
}

/** Never the message body: it can quote memory content. */
function errorClassName(error: unknown): string {
  if (error instanceof Error) return error.name || error.constructor?.name || 'Error';
  return 'UnknownError';
}

function toView(row: {
  id: string;
  content: string;
  status: ActionItemStatus;
  due_at: number | null;
}): ActionItemView {
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    due_at: row.due_at === null ? null : new Date(row.due_at).toISOString(),
  };
}

export function createMemoryCallbacks(
  db: Db,
  userId: string,
  deps: MemoryCallbackDeps = {},
): {
  listActions(input: ListActionsInput): Promise<ActionItemView[] | { disabled: true }>;
  completeAction(input: CompleteActionInput): Promise<CompleteActionCallbackResult>;
  remember(input: RememberInput): Promise<RememberCallbackResult>;
  forget(input: ForgetInput): Promise<ForgetCallbackResult>;
} {
  const isAvailable = deps.isAvailable ?? (() => memoryAvailable(db));
  const floor = deps.matchFloor ?? DEFAULT_TARGET_FLOOR;
  const turn = deps.turn ?? { conversationId: null, messageId: null, surface: 'web_text' };
  const source = { conversationId: turn.conversationId, messageId: turn.messageId, surface: turn.surface, spaceId: deps.spaceId };
  const log = deps.journal ?? (() => undefined);

  async function listActions(
    input: ListActionsInput,
  ): Promise<ActionItemView[] | { disabled: true }> {
    if (!(await isAvailable())) return { disabled: true };
    const rows = await withUser(db, userId, (tx) =>
      listActionItems(tx, userId, { status: input.status ?? 'open' }),
    );
    return rows.map(toView);
  }

  async function completeAction(
    input: CompleteActionInput,
  ): Promise<CompleteActionCallbackResult> {
    if (!(await isAvailable())) return { disabled: true };
    if (input.id !== undefined) {
      const updated = await withUser(db, userId, (tx) =>
        setActionItemStatus(tx, userId, input.id!, 'done'),
      );
      if (!updated) return { completed: false, candidates: [] };
      return { completed: true, action_item_id: updated.id };
    }
    const result = await withUser(db, userId, (tx) =>
      completeBestMatch(tx, userId, input.query!, floor),
    );
    if (result.completed) return { completed: true, action_item_id: null };
    const candidates: ActionItemCandidate[] = result.candidates.map((c) => ({
      id: c.id,
      content: c.content,
    }));
    return { completed: false, candidates };
  }

  async function remember(input: RememberInput): Promise<RememberCallbackResult> {
    if (!(await isAvailable())) return { disabled: true };
    const kind = input.kind ?? 'fact';
    // One voice for every stored memory: "My wife's name is ..." is stored as
    // "User's wife's name is ...", the extractor's phrasing.
    const content = canonicalMemoryVoice(input.content);
    // The server's own checks, not the model's flag: a secret is refused before
    // any store call; a sensitive category is stored as sensitive whatever the
    // model said.
    const refusal = secretReason(content);
    if (refusal !== null) {
      log('v2.memory_refused', { route: 'remember', reason: refusal });
      return { stored: false, memory_id: null, sensitive: false };
    }
    const sensitive = input.sensitive === true || sensitiveCategory(content) !== null;

    let embedding: MemoryEmbedding | null = null;
    if (deps.embedder) {
      try {
        embedding = await deps.embedder(content);
      } catch (error) {
        embedding = null;
        log('v2.memory_embed_failed', { error_name: errorClassName(error) });
      }
    }

    // The judge first (a paraphrase or a change of a held fact), then the
    // store's own duplicate check on whatever op that leaves.
    const due = input.due !== undefined ? Date.parse(input.due) : undefined;
    const verdict = kind === 'fact' || kind === 'preference'
      ? await judgeAgainstNearest(content, embedding)
      : NOT_JUDGED;
    const op: ExtractionOp = verdict.relation === 'same' && verdict.id !== null
      ? { op: 'noop', id: verdict.id, judged: true }
      : verdict.relation === 'updates' && verdict.id !== null
        ? { op: 'supersede', id: verdict.id, kind, content, confidence: 1, sensitive, embedding }
        : { op: 'add', kind, content, confidence: 1, sensitive, dueAt: kind === 'action_item' ? due : undefined, embedding };
    const [decision] = await applyExtractionOps(db, userId, [op], { source, path: 'remember', journal: deps.journal });
    const memory_id = decision?.memoryId ?? null;
    const stored = decision?.op === 'add' || decision?.op === 'supersede';
    log('v2.memory_remembered', {
      memory_id: memory_id ?? '',
      kind,
      outcome: decision?.op ?? 'noop',
      reason: rememberReason(decision),
      conversation_id: turn.conversationId ?? undefined,
      message_id: turn.messageId ?? undefined,
    });
    return { stored, memory_id, sensitive };
  }

  /** Asks the judge about the nearest current memories. Any failure (no
   *  judge, no vector, no close row, a judge error or timeout) answers
   *  "different", so remember stores exactly as it did without a judge. */
  async function judgeAgainstNearest(content: string, embedding: MemoryEmbedding | null): Promise<MemoryJudgeVerdict> {
    if (!deps.judge || !embedding) return NOT_JUDGED;
    const candidates = await nearestCurrentMemories(db, userId, embedding.values, JUDGE_CANDIDATES, JUDGE_MAX_DISTANCE);
    const top = candidates[0];
    if (!top) return NOT_JUDGED;
    const started = Date.now();
    try {
      const verdict = await withTimeout(deps.judge({ content, candidates }), JUDGE_TIMEOUT_MS);
      log('v2.memory_judged', {
        verdict: verdict.relation,
        memory_id: verdict.id ?? undefined,
        candidates: candidates.length,
        top_distance: Math.round(top.distance * 1000) / 1000,
        judge_ms: Date.now() - started,
      });
      return verdict;
    } catch (error) {
      log('v2.memory_judge_failed', { error_name: errorClassName(error), judge_ms: Date.now() - started });
      return NOT_JUDGED;
    }
  }

  async function forget(input: ForgetInput): Promise<ForgetCallbackResult> {
    if (!(await isAvailable())) return { disabled: true };
    if (input.id !== undefined) {
      const deleted = await withUser(db, userId, (tx) => deleteMemory(tx, userId, input.id!));
      if (deleted) log('v2.memory_forgotten', { memory_id: input.id });
      return { deleted: deleted ? 1 : 0, memory_id: deleted ? input.id : null };
    }
    const result = await withUser(db, userId, (tx) =>
      findBestMatch(tx, userId, input.query!, floor),
    );
    if ('match' in result) {
      const deleted = await withUser(db, userId, (tx) =>
        deleteMemory(tx, userId, result.match.id),
      );
      if (deleted) log('v2.memory_forgotten', { memory_id: result.match.id });
      return { deleted: deleted ? 1 : 0, memory_id: deleted ? result.match.id : null };
    }
    // A top candidate above the floor was withheld because the match was
    // ambiguous; otherwise nothing cleared the floor.
    const top = result.candidates[0];
    const reason = top !== undefined && top.score > floor ? 'ambiguous' : 'below_floor';
    log('v2.memory_forget_candidates', { count: result.candidates.length, reason });
    const candidates: ActionItemCandidate[] = result.candidates.map((c) => ({
      id: c.id,
      content: c.content,
    }));
    return { deleted: 0, memory_id: null, candidates };
  }

  return { listActions, completeAction, remember, forget };
}