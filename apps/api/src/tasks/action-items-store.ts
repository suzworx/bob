/**
 * Per-account action items: a thin actionable subset of bob.memories. Every
 * read or write runs inside withUser() so RLS enforces isolation and an
 * other-account id surfaces as null, never an oracle.
 */
import { StoreError, withUser, type Db } from '../platform/db/db.ts';
import { DEFAULT_MATCH_MARGIN, pickUnambiguous } from '../platform/unambiguous-match.ts';

export type ActionItemStatus = 'open' | 'done' | 'dropped';

type ActionItemSummary = {
  id: string;
  memory_id: string;
  content: string;
  confidence: number;
  status: ActionItemStatus;
  due_at: number | null;
  created_at: number;
  updated_at: number;
};

/** The due-soon row feeding the memory context block. */
export type DueSoonActionItem = {
  id: string;
  due_at: number;
  status: 'open';
  content: string;
  confidence: number;
};

/** A best-match candidate below the floor, so the agent can disambiguate. */
type ActionItemCandidate = {
  id: string;
  content: string;
};

type CompleteMatchResult =
  | { completed: true }
  | { completed: false; candidates: ActionItemCandidate[] };

const DUE_SOON_HORIZON_MS = 48 * 60 * 60 * 1000;
const DUE_SOON_LIMIT = 5;

let lastStamp = 0;

/** A strictly increasing millisecond stamp. */
function now(): number {
  const wall = Date.now();
  lastStamp = wall > lastStamp ? wall : lastStamp + 1;
  return lastStamp;
}

const COLUMNS = `ai.id, ai.memory_id AS "memoryId", m.content, m.confidence, ai.status,
  floor(extract(epoch from ai.due_at) * 1000)::bigint AS "dueAt",
  floor(extract(epoch from ai.created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from ai.updated_at) * 1000)::bigint AS "updatedAt"`;

const FROM = `FROM bob.action_items ai JOIN bob.memories m ON m.id = ai.memory_id`;

type ActionItemRow = Record<'id' | 'memoryId' | 'content' | 'confidence' | 'status' | 'dueAt' | 'createdAt' | 'updatedAt', unknown>;

function rowToSummary(row: ActionItemRow): ActionItemSummary {
  return {
    id: String(row.id),
    memory_id: String(row.memoryId),
    content: String(row.content),
    confidence: Number(row.confidence),
    status: row.status as ActionItemStatus,
    due_at: row.dueAt === null ? null : Number(row.dueAt),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
  };
}

function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23503';
}

function notFoundMemory(memoryId: string): never {
  throw new StoreError(`action item memory ${memoryId} not found`);
}

/** Idempotent per memory. An unknown or foreign memory is a StoreError, never an oracle. */
export async function createActionItem(
  db: Db,
  userId: string,
  input: { memoryId: string; dueAt?: number },
): Promise<ActionItemSummary> {
  const stamp = now();
  return withUser(db, userId, async (tx) => {
    const result = await tx.query<ActionItemRow>(
      `SELECT ${COLUMNS} ${FROM}
       WHERE ai.memory_id = $1 AND ai.user_id = $2`,
      [input.memoryId, userId],
    );
    const existing = result[0];
    if (existing) {
      return rowToSummary(existing);
    }
    try {
      const rows = await tx.query<{ id: unknown }>(
        `INSERT INTO bob.action_items (memory_id, user_id, due_at, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'open', to_timestamp($4 / 1000.0), to_timestamp($4 / 1000.0))
         RETURNING id`,
        [input.memoryId, userId, input.dueAt === undefined ? null : input.dueAt, stamp],
      );
      const firstRow = rows[0];
      if (!firstRow) notFoundMemory(input.memoryId);
      const queryRows = await tx.query<ActionItemRow>(`SELECT ${COLUMNS} ${FROM} WHERE ai.id = $1`, [firstRow.id]);
      const row = queryRows[0];
      if (!row) throw new StoreError('createActionItem: no query row');
      return rowToSummary(row);
    } catch (err) {
      // FK 23503 = the memory does not exist (or RLS hid it): a foreign or
      // deleted memory id answers exactly like an unknown one.
      if (isForeignKeyViolation(err)) notFoundMemory(input.memoryId);
      throw err;
    }
  });
}

/** Contract order: open first, then due_at ascending (nulls last), then newest. */
export async function listActionItems(
  db: Db,
  userId: string,
  options?: { status?: ActionItemStatus; dueBefore?: number; limit?: number },
): Promise<ActionItemSummary[]> {
  const limit = Math.min(options?.limit ?? 50, 100);
  return withUser(db, userId, async (tx) => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options?.status !== undefined) {
      params.push(options.status);
      clauses.push(`ai.status = $${params.length}`);
    }
    if (options?.dueBefore !== undefined) {
      params.push(options.dueBefore);
      clauses.push(`ai.due_at < to_timestamp($${params.length} / 1000.0)`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    const rows = await tx.query<ActionItemRow>(
      `SELECT ${COLUMNS} ${FROM} ${where}
       ORDER BY ai.status != 'open', ai.due_at ASC NULLS LAST, ai.created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(rowToSummary);
  });
}

/** null when the id is unknown or owned by another account (RLS makes the two indistinguishable). */
export async function setActionItemStatus(
  db: Db,
  userId: string,
  id: string,
  status: ActionItemStatus,
): Promise<ActionItemSummary | null> {
  const stamp = now();
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<ActionItemRow>(
      `SELECT ${COLUMNS} ${FROM}
       WHERE ai.id = $1 AND ai.user_id = $2`,
      [id, userId],
    );
    if (rows.length === 0) return null;
    await tx.query(
      `UPDATE bob.action_items
       SET status = $1, updated_at = to_timestamp($2 / 1000.0)
       WHERE id = $3 AND user_id = $4`,
      [status, stamp, id, userId],
    );
    const row = (await tx.query<ActionItemRow>(`SELECT ${COLUMNS} ${FROM} WHERE ai.id = $1`, [id]))[0]!;
    return rowToSummary(row);
  });
}

/** Open items due within the horizon (default 48 hours), earliest first. */
export async function listDueSoon(
  db: Db,
  userId: string,
  nowMs: number,
  horizonMs = DUE_SOON_HORIZON_MS,
  limit = DUE_SOON_LIMIT,
): Promise<DueSoonActionItem[]> {
  const bound = nowMs + horizonMs;
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{
      id: unknown;
      dueAt: unknown;
      content: unknown;
      confidence: unknown;
    }>(
      `SELECT ai.id, ai.due_at AS "dueAt", m.content, m.confidence
       FROM bob.action_items ai JOIN bob.memories m ON m.id = ai.memory_id
       WHERE ai.user_id = $1 AND ai.status = 'open'
         AND ai.due_at IS NOT NULL
         AND ai.due_at < to_timestamp($2 / 1000.0)
       ORDER BY ai.due_at ASC
       LIMIT $3`,
      [userId, bound, Math.min(limit, 50)],
    );
    return rows.map((row) => ({
      id: String(row.id),
      due_at: Number(row.dueAt),
      status: 'open' as const,
      content: String(row.content),
      confidence: Number(row.confidence),
    }));
  });
}

/**
 * Full-text matches the query against the account's open items. Only a best
 * match above the floor AND ahead of the runner-up by the margin is marked
 * done; otherwise nothing changes and the top 3 candidates come back so the
 * agent can disambiguate.
 */
export async function completeBestMatch(
  db: Db,
  userId: string,
  query: string,
  floor: number,
): Promise<CompleteMatchResult> {
  return withUser(db, userId, async (tx) => {
    const matches = await tx.query<{ id: unknown; content: unknown; score: unknown }>(
      `SELECT ai.id, m.content,
              ts_rank_cd(m.fts, websearch_to_tsquery('english', $2)) AS score
       FROM bob.action_items ai JOIN bob.memories m ON m.id = ai.memory_id
       WHERE ai.user_id = $1 AND ai.status = 'open'
         AND m.fts @@ websearch_to_tsquery('english', $2)
       ORDER BY score DESC, ai.created_at DESC
       LIMIT 3`,
      [userId, query],
    );
    const scored = matches.map((row) => ({
      id: String(row.id),
      content: String(row.content),
      score: Number(row.score),
    }));
    const picked = pickUnambiguous(scored, floor, DEFAULT_MATCH_MARGIN);
    if (!('match' in picked)) {
      return {
        completed: false,
        candidates: picked.candidates.map((row) => ({ id: row.id, content: row.content })),
      };
    }
    const best = picked.match;
    const stamp = now();
    const updated = await tx.query<{ id: unknown }>(
      `UPDATE bob.action_items
       SET status = 'done', updated_at = to_timestamp($1 / 1000.0)
       WHERE id = $2 AND user_id = $3
       RETURNING id`,
      [stamp, best.id, userId],
    );
    if (updated.length === 0) {
      throw new StoreError(`action item ${String(best.id)} not found`);
    }
    return { completed: true };
  });
}