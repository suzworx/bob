/**
 * Merges memories that were stored twice before the memory judge existed
 * ("User has a wife named Maya." beside "My wife's name is Maya"). Run by
 * `npm run memory:reconcile`, one account at a time, dry run first.
 *
 * planReconcile pairs current facts and preferences whose embeddings sit
 * within MAX_DISTANCE (closest first) and asks the judge about the newer one
 * against the older one. "same" keeps the older row; "updates" keeps the newer
 * one, the change. A row a decision already retires is not paired again.
 * Nothing is deleted: the retired row is marked superseded_by the kept one.
 */
import type { MemoryJudge } from '@bob/ai';
import { withUser, type Db } from '../platform/db/db.ts';
import { lockAccountMemories } from './dedupe.ts';
import type { MemoryJournal } from './rows.ts';

/** The same band remember's judge uses (callbacks.ts). */
const MAX_DISTANCE = 0.35;
/** Most pairs judged per account in one run. */
const PAIR_LIMIT = 200;

export interface ReconcileDecision {
  keep: string;
  retire: string;
  verdict: 'same' | 'updates';
  distance: number;
  /** Contents, for an operator reviewing their own account; never journaled. */
  keptContent: string;
  retiredContent: string;
}

export interface ReconcilePlan {
  decisions: ReconcileDecision[];
  /** Pairs the judge was asked about. */
  judged: number;
  /** Current facts/preferences with no embedding: never paired. */
  withoutEmbedding: number;
}

interface PairRow {
  older_id: unknown;
  older_content: unknown;
  newer_id: unknown;
  newer_content: unknown;
  distance: unknown;
}

export async function planReconcile(
  db: Db,
  userId: string,
  judge: MemoryJudge,
): Promise<ReconcilePlan> {
  const { pairs, withoutEmbedding } = await withUser(db, userId, async (tx) => {
    const rows = await tx.query<PairRow>(
      `SELECT a.id AS older_id, a.content AS older_content, b.id AS newer_id, b.content AS newer_content,
              (a.embedding OPERATOR(extensions.<=>) b.embedding)::double precision AS distance
       FROM bob.memories a
       JOIN bob.memories b ON b.user_id = a.user_id AND (a.created_at, a.id) < (b.created_at, b.id)
       WHERE a.user_id = $1
         AND a.superseded_by IS NULL AND b.superseded_by IS NULL
         AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
         AND a.kind IN ('fact', 'preference') AND b.kind IN ('fact', 'preference')
         AND (a.embedding OPERATOR(extensions.<=>) b.embedding) <= $2
       ORDER BY distance, b.created_at
       LIMIT $3`,
      [userId, MAX_DISTANCE, PAIR_LIMIT],
    );
    const missing = await tx.query<{ total: unknown }>(
      `SELECT COUNT(*)::int AS total FROM bob.memories
       WHERE user_id = $1 AND superseded_by IS NULL AND embedding IS NULL AND kind IN ('fact', 'preference')`,
      [userId],
    );
    return { pairs: rows, withoutEmbedding: Number(missing[0]?.total ?? 0) };
  });

  const retired = new Set<string>();
  const decisions: ReconcileDecision[] = [];
  let judged = 0;
  for (const pair of pairs) {
    const older = { id: String(pair.older_id), content: String(pair.older_content) };
    const newer = { id: String(pair.newer_id), content: String(pair.newer_content) };
    if (retired.has(older.id) || retired.has(newer.id)) continue;
    judged += 1;
    const verdict = await judge({ content: newer.content, candidates: [older] });
    if (verdict.relation === 'different' || verdict.id !== older.id) continue;
    const [kept, gone] = verdict.relation === 'same' ? [older, newer] : [newer, older];
    retired.add(gone.id);
    decisions.push({
      keep: kept.id,
      retire: gone.id,
      verdict: verdict.relation,
      distance: Number(pair.distance),
      keptContent: kept.content,
      retiredContent: gone.content,
    });
  }
  return { decisions, judged, withoutEmbedding };
}

/** Applies a plan under the account's memory lock, but only while both rows
 *  are still current (a row changed since the plan was made is left alone).
 *  Returns how many applied. */
export async function applyReconcile(
  db: Db,
  userId: string,
  decisions: readonly ReconcileDecision[],
  journal: MemoryJournal = () => undefined,
): Promise<number> {
  const applied = await withUser(db, userId, async (tx) => {
    await lockAccountMemories(tx, userId);
    const done: ReconcileDecision[] = [];
    for (const decision of decisions) {
      const rows = await tx.query<{ id: unknown }>(
        `UPDATE bob.memories SET superseded_by = $2, updated_at = now()
         WHERE id = $1 AND superseded_by IS NULL
           AND EXISTS (SELECT 1 FROM bob.memories k WHERE k.id = $2 AND k.superseded_by IS NULL)
         RETURNING id`,
        [decision.retire, decision.keep],
      );
      if (rows.length > 0) done.push(decision);
    }
    return done;
  });
  for (const decision of applied) {
    journal('v2.memory_reconciled', { memory_id: decision.retire, kept_id: decision.keep, verdict: decision.verdict });
  }
  return applied.length;
}
