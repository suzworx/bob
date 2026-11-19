/** Memory retrieval queries. Every function runs under withUser(), so RLS
 *  keeps the retrieval path to one account; none of them embeds. */
import { withUser, type Db } from '../platform/db/db.ts';
import { DEFAULT_MATCH_MARGIN, pickUnambiguous } from '../platform/unambiguous-match.ts';
import {
  MAX_LIST_LIMIT, MEMORY_COLUMNS, RECENCY_HALF_LIFE_DAYS, RECENCY_WEIGHT, rowToMatch, rowToMemory, vectorLiteral,
  type MatchFullTextOptions, type MatchOptions, type MatchPath, type MatchRow, type MemoryMatch, type MemoryRow,
  type StoredMemory,
} from './rows.ts';

/**
 * Hybrid retrieval: bob.match_memories RRF-fuses full-text and HNSW semantic
 * (SECURITY INVOKER, so RLS applies). With options.maxDistance set,
 * semantic-only rows farther than that cosine distance are dropped (full-text
 * hits stay) and recency is a tie-break only. The distance is valid only for
 * the embedding model it was calibrated on (text-embedding-3-small at 1,536
 * dims). With no floor every semantic hit is kept plus the additive recency term.
 */
export async function matchMemories(
  db: Db,
  userId: string,
  options: MatchOptions,
): Promise<MemoryMatch[]> {
  const maxDistance = options.maxDistance ?? null;
  const floored = maxDistance !== null;
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<MatchRow>(
      `SELECT id, kind, content, confidence, sensitive,
              conversation_id AS "conversationId", message_id AS "messageId", surface,
              floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
              match_source AS "matchSource", score
       FROM bob.match_memories($1, $2::extensions.vector, $3${
         floored ? ', p_max_distance => $4::double precision, p_recency_tiebreak => true' : ''
       })`,
      floored
        ? [options.queryText, vectorLiteral(options.queryEmbedding), options.matchCount, maxDistance]
        : [options.queryText, vectorLiteral(options.queryEmbedding), options.matchCount],
    );
    return rows.map(rowToMatch);
  });
}

/**
 * The DEGRADED retrieval path, used when the query embedding times out or
 * fails: ts_rank_cd over the account's current rows plus the recency term,
 * with matchMemories' row shape and match_source 'full_text'. It must NOT fake
 * a vector. With recencyTieBreak, recency leaves the score and only breaks
 * ties (score DESC, created_at DESC, id), which also makes it the
 * explicit-targeting scan, where a newer row must never win on age.
 */
export async function matchMemoriesFullText(
  db: Db,
  userId: string,
  options: MatchFullTextOptions,
): Promise<MemoryMatch[]> {
  const tieBreak = options.recencyTieBreak ?? false;
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<MatchRow>(
      tieBreak
        ? `SELECT m.id, m.kind, m.content, m.confidence, m.sensitive,
              m.conversation_id AS "conversationId", m.message_id AS "messageId", m.surface,
              floor(extract(epoch from m.created_at) * 1000)::bigint AS "createdAt",
              'full_text'::text AS "matchSource",
              ts_rank_cd(m.fts, websearch_to_tsquery('english', $1))::double precision AS score
       FROM bob.memories m
       WHERE m.user_id = $2
         AND m.superseded_by IS NULL
         AND m.fts @@ websearch_to_tsquery('english', $1)
       ORDER BY score DESC, m.created_at DESC, m.id
       LIMIT $3`
        : `SELECT m.id, m.kind, m.content, m.confidence, m.sensitive,
              m.conversation_id AS "conversationId", m.message_id AS "messageId", m.surface,
              floor(extract(epoch from m.created_at) * 1000)::bigint AS "createdAt",
              'full_text'::text AS "matchSource",
              (ts_rank_cd(m.fts, websearch_to_tsquery('english', $1))
               + $2 * exp(-ln(2.0) * extract(epoch from (now() - m.created_at)) / ($3 * 86400.0))
              )::double precision AS score
       FROM bob.memories m
       WHERE m.user_id = $4
         AND m.superseded_by IS NULL
         AND m.fts @@ websearch_to_tsquery('english', $1)
       ORDER BY score DESC
       LIMIT $5`,
      tieBreak
        ? [options.queryText, userId, options.matchCount]
        : [
            options.queryText,
            RECENCY_WEIGHT,
            RECENCY_HALF_LIFE_DAYS,
            userId,
            options.matchCount,
          ],
    );
    return rows.map(rowToMatch);
  });
}

/** retrieval.ts further trims these to its character budget. */
const STANDING_MEMORY_LIMIT = 12;

/**
 * The account's standing context: current, non-sensitive facts and preferences,
 * most confident first. Every turn gets these regardless of the query, so
 * durable knowledge such as a diet never loses the top-k ranking to
 * conversational rows. Sensitive rows reach the model only through retrieval.
 */
export async function listStandingMemories(
  db: Db,
  userId: string,
  limit: number = STANDING_MEMORY_LIMIT,
): Promise<StoredMemory[]> {
  const bounded = Math.max(1, Math.min(limit, MAX_LIST_LIMIT));
  const rows = await withUser(db, userId, async (tx) =>
    tx.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM bob.memories
       WHERE user_id = $1
         AND superseded_by IS NULL
         AND sensitive = false
         AND kind IN ('fact', 'preference')
       ORDER BY confidence DESC, updated_at DESC, id DESC
       LIMIT $2`,
      [userId, bounded],
    ),
  );
  return rows.map(rowToMemory);
}

/** `{ match }` for the target, or `{ candidates: top3 }` (possibly empty). The
 *  'target' path acts only on an unambiguous match. */
export async function findBestMatch(
  db: Db,
  userId: string,
  query: string,
  floor: number,
  path: MatchPath = 'target',
): Promise<{ match: MemoryMatch } | { candidates: MemoryMatch[] }> {
  if (path === 'remember') return findRememberMatch(db, userId, query, floor);
  const matches = await matchMemoriesFullText(db, userId, { queryText: query, matchCount: 3, recencyTieBreak: true });
  return pickUnambiguous(matches, floor, DEFAULT_MATCH_MARGIN);
}

async function findRememberMatch(
  db: Db,
  userId: string,
  query: string,
  floor: number,
): Promise<{ match: MemoryMatch } | { candidates: MemoryMatch[] }> {
  // Pinned to the recency-inclusive score: the floor was tuned against it.
  const matches = await matchMemoriesFullText(db, userId, {
    queryText: query,
    matchCount: 3,
    recencyTieBreak: false,
  });
  const best = matches[0];
  if (best && best.score >= floor) return { match: best };
  return { candidates: matches };
}

/** The memory judge's candidates. The distance only picks them -- it cannot
 *  decide "same fact" (a correction can sit closer than a paraphrase). */
export async function nearestCurrentMemories(
  db: Db,
  userId: string,
  embedding: readonly number[],
  limit: number,
  maxDistance: number,
): Promise<Array<{ id: string; content: string; distance: number }>> {
  const rows = await withUser(db, userId, async (tx) =>
    tx.query<{ id: unknown; content: unknown; distance: unknown }>(
      `SELECT id, content, (embedding OPERATOR(extensions.<=>) $2::extensions.vector)::double precision AS distance
       FROM bob.memories
       WHERE user_id = $1 AND superseded_by IS NULL AND embedding IS NOT NULL
         AND (embedding OPERATOR(extensions.<=>) $2::extensions.vector) <= $4
       ORDER BY embedding OPERATOR(extensions.<=>) $2::extensions.vector
       LIMIT $3`,
      [userId, vectorLiteral([...embedding]), limit, maxDistance],
    ),
  );
  return rows.map((row) => ({ id: String(row.id), content: String(row.content), distance: Number(row.distance) }));
}
