/**
 * Cross-session memory store. Every function runs under withUser() so RLS
 * isolates the account. It never calls a model: embeddings arrive already
 * computed, or as an injected embed function on correctMemory.
 */
import { StoreConflictError, StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { moduleJournal } from '../platform/logger.ts';
import {
  MEMORY_COLUMNS, clampListLimit, decodeCursor, encodeCursor, escapeLike, isConfidence, isEmbedding, isMemoryContent,
  isMemoryKind, rowToMemory, toKind, validateExtractionOps, validateSource, vectorLiteral,
  type AppliedOp, type ApplyExtractionOptions, type ExtractionOp, type ExtractionSource, type ListMemoriesOptions,
  type MemoryCorrection, type MemoryEmbedding, type MemoryRow, type NewMemory, type StoredMemory,
} from './rows.ts';
import { findByContentKey, findStoredDuplicate, lockAccountMemories } from './dedupe.ts';
import { memorySpaceColumn } from './space-column.ts';

const journal = moduleJournal('memory');
export type { AppliedOp, ApplyExtractionOptions, ExtractionOp, MatchRow, MemoryEmbedding, MemoryKind, MemoryMatch, MemoryRow, MemorySurface, StoredMemory } from './rows.ts';
export { decodeCursor, encodeCursor, isMemoryContent, rowToMatch, rowToMemory, validateExtractionOps, vectorLiteral } from './rows.ts';
export { findBestMatch, listStandingMemories, matchMemories, matchMemoriesFullText, nearestCurrentMemories } from './matching.ts';

/** With skipDuplicate, a row whose content key a current row already holds is
 *  not inserted and null is returned. space_id is written only when the column
 *  exists (a hosted store can lag the migration), defaulting to the owner's
 *  private space. */
async function insertMemoryRow(tx: Db, userId: string, memory: NewMemory, skipDuplicate: true): Promise<MemoryRow | null>;
async function insertMemoryRow(tx: Db, userId: string, memory: NewMemory): Promise<MemoryRow>;
async function insertMemoryRow(tx: Db, userId: string, memory: NewMemory, skipDuplicate = false): Promise<MemoryRow | null> {
  const withSpace = await memorySpaceColumn(tx);
  const columns = memory.id !== undefined ? ['id'] : [];
  if (withSpace) columns.push('space_id');
  columns.push(
    'user_id',
    'kind',
    'content',
    'confidence',
    'sensitive',
    'conversation_id',
    'message_id',
    'surface',
    'superseded_by',
    'embedding',
    'embedding_model',
    'embedding_dim',
  );
  const embeddingPosition = columns.indexOf('embedding') + 1;
  const spacePosition = columns.indexOf('space_id') + 1;
  const placeholders = columns.map((_, index) => {
    const position = index + 1;
    if (position === spacePosition) {
      // user_id rides the next parameter.
      return `coalesce($${position}::uuid, (SELECT s.id FROM bob.spaces s
        WHERE s.kind = 'private' AND s.owner_user_id = $${position + 1}::uuid))`;
    }
    return position === embeddingPosition ? `$${position}::extensions.vector` : `$${position}`;
  });
  const params: unknown[] = [];
  if (memory.id !== undefined) params.push(memory.id);
  if (withSpace) params.push(memory.spaceId ?? null);
  params.push(
    userId,
    memory.kind,
    memory.content,
    memory.confidence,
    memory.sensitive ?? false,
    memory.conversationId ?? null,
    memory.messageId ?? null,
    memory.surface ?? 'web_text',
    memory.supersededBy ?? null,
  );
  if (memory.embedding) {
    params.push(vectorLiteral(memory.embedding.values), memory.embedding.model, memory.embedding.dim);
  } else {
    params.push(null, null, null);
  }
  const rows = await tx.query<MemoryRow>(
    `INSERT INTO bob.memories (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     ${skipDuplicate ? 'ON CONFLICT (user_id, content_key) WHERE superseded_by IS NULL DO NOTHING' : ''}
     RETURNING ${MEMORY_COLUMNS}`,
    params,
  );
  const row = rows[0];
  if (row) return row;
  if (skipDuplicate) return null;
  throw new StoreError('insertMemoryRow: no row');
}

/** The action-items row for an action_item is applyExtractionOps' concern, not this function's. */
export async function insertMemory(
  db: Db,
  userId: string,
  memory: NewMemory,
): Promise<StoredMemory> {
  if (!isMemoryKind(memory.kind)) throw new StoreError('insertMemory: invalid kind');
  if (!isMemoryContent(memory.content)) throw new StoreError('insertMemory: invalid content');
  if (!isConfidence(memory.confidence)) throw new StoreError('insertMemory: invalid confidence');
  if (!isEmbedding(memory.embedding)) throw new StoreError('insertMemory: invalid embedding');
  return withUser(db, userId, async (tx) => rowToMemory(await insertMemoryRow(tx, userId, memory)));
}

/** Newest first, keyset-paginated on (created_at desc, id desc). nextCursor is
 *  non-null only when a full page was returned. Includes superseded rows unless
 *  currentOnly narrows. */
export async function listMemories(
  db: Db,
  userId: string,
  options: ListMemoriesOptions = {},
): Promise<{ memories: StoredMemory[]; nextCursor: string | null }> {
  const limit = clampListLimit(options.limit);
  const where: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (options.kind !== undefined) {
    if (!isMemoryKind(options.kind)) throw new StoreError('listMemories: invalid kind filter');
    where.push(`kind = ${push(options.kind)}`);
  }
  if (options.sensitive !== undefined) {
    where.push(`sensitive = ${push(options.sensitive)}`);
  }
  const q = options.q?.trim();
  if (q) {
    where.push(`content ILIKE ${push(`%${escapeLike(q)}%`)} ESCAPE '\\'`);
  }
  if (options.currentOnly === true) {
    where.push('superseded_by IS NULL');
  }
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (!decoded) throw new StoreError('listMemories: invalid cursor');
    where.push(
      `(created_at, id) < (to_timestamp(${push(decoded.createdUs)} / 1000000.0), ${push(decoded.id)})`,
    );
  }
  const rows = await withUser(db, userId, async (tx) =>
    tx.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM bob.memories
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ${push(limit + 1)}`,
      params,
    ),
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(Number(last.createdUs), String(last.id)) : null;
  return { memories: page.map(rowToMemory), nextCursor };
}

/** Null for an unknown id (RLS hides other accounts). */
export async function getMemory(db: Db, userId: string, id: string): Promise<StoredMemory | null> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM bob.memories WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : rowToMemory(rows[0]!);
  });
}

export async function findCurrentMemoryByContent(
  db: Db,
  userId: string,
  content: string,
): Promise<StoredMemory | null> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM bob.memories
       WHERE user_id = $1 AND content = $2 AND superseded_by IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId, content],
    );
    return rows.length === 0 ? null : rowToMemory(rows[0]!);
  });
}

/**
 * Updates content, then re-embeds. When the embed fails (or no embedder is
 * given) the vector, model and dim are nulled so the row never carries a stale
 * vector for its new text; the correction still persists. The embed runs
 * outside the transaction so a slow provider never holds a write lock.
 */
export async function correctMemory(
  db: Db,
  userId: string,
  id: string,
  update: MemoryCorrection,
  embed?: (content: string) => Promise<MemoryEmbedding>,
): Promise<StoredMemory> {
  if (!isMemoryContent(update.content)) throw new StoreError('correctMemory: invalid content');
  if (update.confidence !== undefined && !isConfidence(update.confidence)) {
    throw new StoreError('correctMemory: invalid confidence');
  }
  const row = await withUser(db, userId, async (tx) => {
    const set = ['content = $2', 'updated_at = now()'];
    const params: unknown[] = [id, update.content];
    if (update.confidence !== undefined) {
      set.push(`confidence = $${params.length + 1}`);
      params.push(update.confidence);
    }
    if (update.sensitive !== undefined) {
      set.push(`sensitive = $${params.length + 1}`);
      params.push(update.sensitive);
    }
    let rows: MemoryRow[];
    try {
      rows = await tx.query<MemoryRow>(
        `UPDATE bob.memories SET ${set.join(', ')} WHERE id = $1 RETURNING ${MEMORY_COLUMNS}`,
        params,
      );
    } catch (error) {
      // Another current memory already holds this content.
      if ((error as { code?: unknown }).code === '23505') throw new StoreConflictError('correctMemory: duplicate content');
      throw error;
    }
    if (rows.length === 0) throw new StoreNotFoundError(`memory ${id} not found`);
    const row = rows[0];
    if (!row) throw new StoreError('correctMemory: no row');
    return row;
  });

  let embedding: MemoryEmbedding | null = null;
  if (embed) {
    try {
      embedding = await embed(update.content);
    } catch {
      embedding = null;
    }
  }

  await withUser(db, userId, async (tx) => {
    await tx.query(
      `UPDATE bob.memories
       SET embedding = $2::extensions.vector, embedding_model = $3, embedding_dim = $4
       WHERE id = $1`,
      embedding ? [id, vectorLiteral(embedding.values), embedding.model, embedding.dim] : [id, null, null, null],
    );
  });

  return rowToMemory(row);
}

/** Idempotent; an unknown or other-account id answers false (no oracle). The
 *  action item cascades via the memory_id FK. */
export async function deleteMemory(db: Db, userId: string, id: string): Promise<boolean> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `DELETE FROM bob.memories WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  });
}

/** Returns the number of memory rows deleted; action items follow the cascade. */
export async function deleteAllMemories(db: Db, userId: string): Promise<number> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ total: unknown }>(
      `WITH deleted AS (DELETE FROM bob.memories WHERE user_id = $1 RETURNING id)
       SELECT COUNT(*)::int AS total FROM deleted`,
      [userId],
    );
    const row = rows[0];
    if (!row) throw new StoreError('deleteAllMemories: no row');
    return Number(row.total);
  });
}

/**
 * Applies ops in ONE transaction, for the extractor, `remember` and the manual
 * create route alike. Every content op passes the one duplicate check first,
 * under a per-account advisory lock: an add whose content a current row already
 * holds is a noop on that row; an update or supersede whose new content another
 * current row holds retires its target into that row instead of writing a
 * second copy. An insert that still collides on the unique index is a noop too.
 * An update or supersede whose target row is gone is skipped. Each decision is
 * journaled as `v2.memory_written` (ids and enums only) and returned in op order.
 */
export async function applyExtractionOps(
  db: Db,
  userId: string,
  ops: readonly ExtractionOp[],
  options: ApplyExtractionOptions,
): Promise<AppliedOp[]> {
  validateExtractionOps(ops);
  validateSource(options.source);
  const { source, markMessageId } = options;
  const path = options.path ?? 'extract';
  const log = options.journal ?? journal;
  const applied = await withUser(db, userId, async (tx) => {
    if (ops.some((op) => op.op !== 'noop')) await lockAccountMemories(tx, userId);
    const results: AppliedOp[] = [];
    for (const op of ops) {
      results.push(await applyOne(tx, userId, op, source));
    }
    if (markMessageId) {
      // RLS limits this to the account's own message (messages_update policy);
      // an other-account id silently updates nothing.
      await tx.query(`UPDATE bob.messages SET memory_extracted_at = now() WHERE id = $1`, [
        markMessageId,
      ]);
    }
    return results;
  });
  ops.forEach((op, index) => {
    const result = applied[index];
    if (!result) return;
    log('v2.memory_written', {
      memory_id: result.memoryId ?? undefined,
      op: result.op,
      target_id: result.targetId ?? undefined,
      dup_of: result.dupOf ?? undefined,
      path,
      guard: result.guard,
      conversation_id: source.conversationId ?? undefined,
      message_id: source.messageId ?? undefined,
      kind: op.op === 'add' || op.op === 'supersede' ? op.kind : undefined,
      surface: source.surface,
    });
  });
  return applied;
}

function noop(memoryId: string | null, targetId: string | null, dupOf: string | null, guard: AppliedOp['guard']): AppliedOp {
  return { op: 'noop', memoryId, targetId, dupOf, guard };
}

async function retire(tx: Db, id: string, by: string): Promise<void> {
  await tx.query(
    `UPDATE bob.memories SET superseded_by = $2, updated_at = now() WHERE id = $1 AND superseded_by IS NULL`,
    [id, by],
  );
}

async function applyOne(tx: Db, userId: string, op: ExtractionOp, source: ExtractionSource): Promise<AppliedOp> {
  switch (op.op) {
    case 'add':
      return applyAdd(tx, userId, op, source);
    case 'update':
      return applyUpdate(tx, userId, op);
    case 'supersede':
      return applySupersede(tx, userId, op, source);
    case 'noop':
      return op.judged ? noop(op.id, null, op.id, 'judge') : noop(op.id, op.id, null, 'none');
  }
}

async function applyAdd(
  tx: Db,
  userId: string,
  op: Extract<ExtractionOp, { op: 'add' }>,
  source: ExtractionSource,
): Promise<AppliedOp> {
  const dup = await findStoredDuplicate(tx, userId, op.content, null);
  if (dup !== null) return noop(dup, null, dup, 'find_duplicate');
  const row = await insertMemoryRow(tx, userId, {
    kind: op.kind,
    content: op.content,
    confidence: op.confidence,
    sensitive: op.sensitive,
    conversationId: source.conversationId,
    messageId: source.messageId,
    surface: source.surface,
    spaceId: source.spaceId,
    embedding: op.embedding,
  }, true);
  if (row === null) {
    const existing = await findByContentKey(tx, userId, op.content);
    return noop(existing, null, existing, 'unique_index');
  }
  const id = String(row.id);
  if (op.kind === 'action_item') {
    await tx.query(
      `INSERT INTO bob.action_items (memory_id, user_id, due_at, status)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), 'open')`,
      [id, userId, op.dueAt ?? null],
    );
  }
  return { op: 'add', memoryId: id, targetId: null, dupOf: null, guard: 'none' };
}

async function applyUpdate(
  tx: Db,
  userId: string,
  op: Extract<ExtractionOp, { op: 'update' }>,
): Promise<AppliedOp> {
  const dup = await findStoredDuplicate(tx, userId, op.content, op.id);
  if (dup !== null) {
    await retire(tx, op.id, dup);
    return noop(dup, op.id, dup, 'find_duplicate');
  }
  const set = ['content = $2', 'updated_at = now()'];
  const params: unknown[] = [op.id, op.content];
  if (op.confidence !== undefined) {
    set.push(`confidence = $${params.length + 1}`);
    params.push(op.confidence);
  }
  if (op.sensitive !== undefined) {
    set.push(`sensitive = $${params.length + 1}`);
    params.push(op.sensitive);
  }
  if (op.embedding) {
    set.push(
      `embedding = $${params.length + 1}::extensions.vector`,
      `embedding_model = $${params.length + 2}`,
      `embedding_dim = $${params.length + 3}`,
    );
    params.push(vectorLiteral(op.embedding.values), op.embedding.model, op.embedding.dim);
  } else {
    // The content changed; without a fresh vector the old embedding is
    // stale, so null all three (the correctMemory invariant).
    set.push('embedding = NULL', 'embedding_model = NULL', 'embedding_dim = NULL');
  }
  const rows = await tx.query<{ id: unknown }>(
    `UPDATE bob.memories SET ${set.join(', ')} WHERE id = $1 RETURNING id`,
    params,
  );
  if (rows.length === 0) return noop(null, op.id, null, 'none');
  return { op: 'update', memoryId: op.id, targetId: op.id, dupOf: null, guard: 'none' };
}

async function applySupersede(
  tx: Db,
  userId: string,
  op: Extract<ExtractionOp, { op: 'supersede' }>,
  source: ExtractionSource,
): Promise<AppliedOp> {
  const old = await tx.query<{ kind: unknown; sensitive: unknown }>(
    `SELECT kind, sensitive FROM bob.memories WHERE id = $1`,
    [op.id],
  );
  const oldRow = old[0];
  if (!oldRow) return noop(null, op.id, null, 'none');
  const dup = await findStoredDuplicate(tx, userId, op.content, op.id);
  if (dup !== null) {
    await retire(tx, op.id, dup);
    return noop(dup, op.id, dup, 'find_duplicate');
  }
  const replacement = await insertMemoryRow(tx, userId, {
    kind: op.kind ?? toKind(oldRow.kind),
    content: op.content,
    confidence: op.confidence,
    sensitive: op.sensitive ?? Boolean(oldRow.sensitive),
    conversationId: source.conversationId,
    messageId: source.messageId,
    surface: source.surface,
    spaceId: source.spaceId,
    embedding: op.embedding,
  }, true);
  if (replacement === null) {
    // Same content key as a current row: the target itself (a re-spelling of
    // it) stays as it is; any other row takes the target's place.
    const existing = await findByContentKey(tx, userId, op.content);
    if (existing !== null && existing !== op.id) await retire(tx, op.id, existing);
    return noop(existing, op.id, existing, 'unique_index');
  }
  const id = String(replacement.id);
  await retire(tx, op.id, id);
  return { op: 'supersede', memoryId: id, targetId: op.id, dupOf: null, guard: 'none' };
}
