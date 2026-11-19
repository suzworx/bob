/**
 * The one duplicate check every memory write goes through, called by
 * applyExtractionOps inside its transaction. The unique index on
 * (user_id, content_key) is the backstop when two writes race past the lock.
 */
import { findDuplicate } from '@bob/ai';
import type { Db } from '../platform/db/db.ts';

/** How many current rows the duplicate check reads: the account's rows that
 *  share any word with the new content, best text rank first. */
const DEDUPE_CANDIDATES = 50;

/** Serialises this account's memory writes until the transaction ends, so two
 *  concurrent writes of one fact cannot both miss each other. */
export async function lockAccountMemories(tx: Db, userId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bob.memories:${userId}`]);
}

/**
 * The id of a current memory that already says everything `content` says, or
 * null. `excludeId` leaves out the row an update or supersede is replacing.
 * Candidates are the same content key first, then rows sharing any word (an OR
 * of its lexemes); findDuplicate then requires every knowledge word of
 * `content` to be in one.
 */
export async function findStoredDuplicate(
  tx: Db,
  userId: string,
  content: string,
  excludeId: string | null,
): Promise<string | null> {
  const rows = await tx.query<{ id: unknown; content: unknown }>(
    `WITH q AS (
       SELECT bob.memory_content_key($2) AS key,
              nullif(replace(plainto_tsquery('english', $2)::text, ' & ', ' | '), '') AS words
     )
     SELECT m.id, m.content
     FROM bob.memories m, q
     WHERE m.user_id = $1
       AND m.superseded_by IS NULL
       AND ($3::text IS NULL OR m.id <> $3)
       AND (m.content_key = q.key
            OR (q.words IS NOT NULL AND m.fts @@ q.words::tsquery))
     ORDER BY (m.content_key = q.key) DESC,
              CASE WHEN q.words IS NULL THEN 0 ELSE ts_rank_cd(m.fts, q.words::tsquery) END DESC,
              m.created_at, m.id
     LIMIT $4`,
    [userId, content, excludeId, DEDUPE_CANDIDATES],
  );
  const candidates = rows.map((row) => ({ id: String(row.id), content: String(row.content) }));
  return findDuplicate(content, candidates);
}

/** The current row holding exactly this content key, or null: what an insert
 *  that hit the unique index collided with. */
export async function findByContentKey(tx: Db, userId: string, content: string): Promise<string | null> {
  const rows = await tx.query<{ id: unknown }>(
    `SELECT id FROM bob.memories
     WHERE user_id = $1 AND superseded_by IS NULL AND content_key = bob.memory_content_key($2)
     LIMIT 1`,
    [userId, content],
  );
  const row = rows[0];
  return row ? String(row.id) : null;
}
