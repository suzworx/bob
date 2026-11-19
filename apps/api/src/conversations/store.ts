/**
 * Per-account conversation store on the Db port. Every account-data read or
 * write runs inside withUser() so RLS enforces isolation, and an other-account
 * id surfaces as StoreNotFoundError. Timestamps are timestamptz read back as
 * epoch ms so the optimistic-concurrency token survives the round-trip;
 * positions are allocated under a lock on the conversation row.
 */
import { randomUUID } from 'node:crypto';
import { isToolUIPart } from 'ai';
import { StoreConflictError, StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { jsonbParam } from '../platform/db/jsonb.ts';
import { ensurePrivateSpace } from '../spaces/store.ts';
import { ownPrivateSpace, PRIVATE_SCOPE } from './space-scope.ts';

export { StoreConflictError, StoreNotFoundError };

type MessageOrigin = 'web_text' | 'web_voice' | 'device';

export type StoredConversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

/** The pin/archive booleans are only ever present on the list path, never on getConversation. */
type ListedConversation = StoredConversation & { pinned: boolean; archived: boolean };

type StoredVersion = {
  id: string;
  parts: unknown[];
  versionIndex: number;
  selected: boolean;
};

type StoredMessage = {
  id: string;
  role: 'user' | 'assistant';
  position: number;
  origin: MessageOrigin;
  /** Epoch ms the message was appended; the chat shows it as the message's time. */
  createdAt: number;
  versions: StoredVersion[];
};

export type ConversationDetail = StoredConversation & {
  messages: StoredMessage[];
};

type NewMessage = {
  id?: string;
  role: 'user' | 'assistant';
  parts: unknown[];
  origin?: MessageOrigin;
};

/** One history message: its single chosen version's parts. */
export type RecentMessage = {
  id: string;
  role: 'user' | 'assistant';
  position: number;
  origin: MessageOrigin;
  parts: unknown[];
};

type ConversationRow = {
  id: unknown;
  title: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

type ListedConversationRow = ConversationRow & { pinned: unknown; archived: unknown };

const TITLE_MAX_CHARS = 60;
const DEFAULT_LIST_LIMIT = 200;

/**
 * First ~60 characters of the opening message on a word boundary. Never
 * invented: empty or audio-only openings fall back to a timestamp label.
 */
export function deriveTitle(text: string): string {
  const collapsed = text.replaceAll(/\s+/g, ' ').trim();
  if (!collapsed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `Voice chat ${stamp}`;
  }
  if (collapsed.length <= TITLE_MAX_CHARS) return collapsed;
  const cut = collapsed.slice(0, TITLE_MAX_CHARS);
  const boundary = cut.lastIndexOf(' ');
  return boundary >= 30 ? cut.slice(0, boundary) : cut;
}

let lastStamp = 0;

/** A strictly increasing millisecond stamp. */
function now(): number {
  const wall = Date.now();
  lastStamp = wall > lastStamp ? wall : lastStamp + 1;
  return lastStamp;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

const ORIGINS: readonly MessageOrigin[] = ['web_text', 'web_voice', 'device'];

function toOrigin(value: unknown): MessageOrigin {
  return ORIGINS.includes(value as MessageOrigin) ? (value as MessageOrigin) : 'web_text';
}

/** The conversation columns with timestamptz converted to epoch-ms bigints. */
const CONVERSATION_COLUMNS = `id, title,
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt"`;

/** CONVERSATION_COLUMNS plus the pin/archive booleans. Kept separate so
 *  getConversation/renameConversation never reference those columns, and so a
 *  hosted store missing them fails ONLY the list path. */
const LIST_COLUMNS = `${CONVERSATION_COLUMNS}, (pinned_at IS NOT NULL) AS pinned, (archived_at IS NOT NULL) AS archived`;

function rowToConversation(row: ConversationRow): StoredConversation {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function rowToListedConversation(row: ListedConversationRow): ListedConversation {
  return { ...rowToConversation(row), pinned: Boolean(row.pinned), archived: Boolean(row.archived) };
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/** Postgres 42703 `undefined_column`: a column whose migration has not reached
 *  the hosted store yet. */
export function isUndefinedColumnError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42703';
}

/** jsonb parts as an array: a driver may hand jsonb back as a string. */
function decodeParts(parts: unknown): unknown[] {
  return typeof parts === 'string' ? (JSON.parse(parts) as unknown[]) : (parts as unknown[]);
}

/** A file part without its url (the base64 data URL stays in Postgres); every
 *  other part passes through unchanged, in its original order. */
const TEXT_ONLY_PARTS = `CASE WHEN jsonb_typeof(v.parts) = 'array' THEN (
    SELECT COALESCE(jsonb_agg(CASE WHEN e.p->>'type' = 'file' THEN e.p - 'url' ELSE e.p END ORDER BY e.ord), '[]'::jsonb)
    FROM jsonb_array_elements(v.parts) WITH ORDINALITY AS e(p, ord)
  ) ELSE v.parts END`;

/** A version's parts as a jsonb array: a driver that binds the JSON text as a
 *  jsonb string stores the array double-encoded, so it is decoded here. */
export const DECODED_PARTS = `CASE jsonb_typeof(parts) WHEN 'string' THEN (parts #>> '{}')::jsonb ELSE parts END`;

/** Whether a stored part is a tool part (`tool-<name>` or `dynamic-tool`). */
export function isToolPart(part: unknown): boolean {
  return typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string'
    && isToolUIPart(part as never);
}

/**
 * A reply's parts with its text cut to `text`. Every other part stays (a
 * barge-in does not undo the tools it ran), with a step-start before the
 * text, so the next turn's model still sees the call. A text-only reply is
 * just the text; with tools, nothing heard adds no (empty) text part.
 */
function cutReplyParts(parts: unknown[], text: string): unknown[] {
  const textPart = { type: 'text', text };
  if (!parts.some(isToolPart)) return [textPart];
  const kept = parts.filter((part) => (part as { type?: unknown } | null)?.type !== 'text');
  if (text === '') return kept;
  const last = kept.at(-1) as { type?: unknown } | undefined;
  return [...kept, ...(last?.type === 'step-start' ? [] : [{ type: 'step-start' }]), textPart];
}

/** Concatenated text of every text part in a stored version (parts are opaque). */
export function partsText(parts: unknown[]): string {
  let text = '';
  for (const part of parts) {
    if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
      const value = (part as { text?: unknown }).text;
      if (typeof value === 'string') text += value;
    }
  }
  return text;
}

/** The last fully-heard boundary of a reply: cut at heardChars, then back to
 *  the last sentence boundary (". ", "! ", "? ", newline) at or before it, or
 *  the last whitespace when no sentence boundary is in the heard prefix. Never
 *  grows a reply. */
function truncateToHeard(text: string, heardChars: number): string {
  const limit = Math.max(0, Math.min(heardChars, text.length));
  if (limit >= text.length) return text;
  const prefix = text.slice(0, limit);
  let cut = -1;
  for (const marker of ['. ', '! ', '? ', '\n']) {
    cut = Math.max(cut, prefix.lastIndexOf(marker));
  }
  if (cut < 0) {
    for (let index = prefix.length - 1; index >= 0; index -= 1) {
      if (/\s/.test(prefix.charAt(index))) {
        cut = index;
        break;
      }
    }
  }
  return cut >= 0 ? prefix.slice(0, cut + 1).trimEnd() : prefix;
}

/**
 * Optimistic concurrency: a mutation may carry the updatedAt it read; a stale
 * write is rejected instead of applied. An other-account id is invisible here
 * and surfaces as StoreNotFoundError first (not-found precedes any conflict).
 */
async function assertNotStale(tx: Db, id: string, expectedUpdatedAt: number | undefined): Promise<void> {
  if (expectedUpdatedAt === undefined) return;
  const rows = await tx.query<{ updatedAt: unknown }>(
    `SELECT floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt"
     FROM bob.conversations WHERE id = $1 AND ${PRIVATE_SCOPE}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new StoreNotFoundError(`conversation ${id} not found`);
  if (Number(row.updatedAt) !== expectedUpdatedAt) {
    throw new StoreConflictError(`conversation ${id} changed since it was read`);
  }
}

/** Locks the caller's conversation row so concurrent writes serialise; false when absent or hidden. */
async function lockConversation(tx: Db, conversationId: string): Promise<boolean> {
  const locked = await tx.query<{ id: string }>(
    `SELECT id FROM bob.conversations WHERE id = $1 AND ${PRIVATE_SCOPE} FOR UPDATE`,
    [conversationId],
  );
  return locked.length > 0;
}

async function touchConversation(tx: Db, conversationId: string, stamp: number = now()): Promise<void> {
  await tx.query(`UPDATE bob.conversations SET updated_at = to_timestamp($1 / 1000.0) WHERE id = $2`, [
    stamp,
    conversationId,
  ]);
}

export async function listConversations(
  db: Db,
  userId: string,
  options?: { q?: string; limit?: number; archived?: boolean },
): Promise<ListedConversation[]> {
  const limit = Math.min(options?.limit ?? DEFAULT_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  const filter = options?.q?.trim();
  const archived = options?.archived === true;
  const archivedClause = archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL';
  const params = filter ? [userId, `%${escapeLike(filter)}%`, limit] : [userId, limit];
  try {
    return await withUser(db, userId, async (tx) => {
      const rows = await tx.query<ListedConversationRow>(
        filter
          ? `SELECT ${LIST_COLUMNS} FROM bob.conversations
             WHERE user_id = $1 AND title ILIKE $2 AND ${archivedClause} AND ${PRIVATE_SCOPE}
             ORDER BY pinned_at DESC NULLS LAST, updated_at DESC LIMIT $3`
          : `SELECT ${LIST_COLUMNS} FROM bob.conversations
             WHERE user_id = $1 AND ${archivedClause} AND ${PRIVATE_SCOPE}
             ORDER BY pinned_at DESC NULLS LAST, updated_at DESC LIMIT $2`,
        params,
      );
      return rows.map(rowToListedConversation);
    });
  } catch (error) {
    if (!isUndefinedColumnError(error)) throw error;
    // The transaction that hit 42703 is aborted; a fresh withUser opens a new
    // one. archived=true has no pre-migration answer, so it is empty rather
    // than fabricated (never an existence oracle on a column that isn't there).
    if (archived) return [];
    return withUser(db, userId, async (tx) => {
      const rows = await tx.query<ConversationRow>(
        filter
          ? `SELECT ${CONVERSATION_COLUMNS} FROM bob.conversations
             WHERE user_id = $1 AND title ILIKE $2
             ORDER BY updated_at DESC LIMIT $3`
          : `SELECT ${CONVERSATION_COLUMNS} FROM bob.conversations
             WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
        params,
      );
      return rows.map((row) => ({ ...rowToConversation(row), pinned: false, archived: false }));
    });
  }
}

/** Cheap single-row existence probe for a conversation. Never loads messages. */
export async function conversationExists(db: Db, userId: string, id: string): Promise<boolean> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ one: unknown }>(
      `SELECT 1 AS one FROM bob.conversations WHERE id = $1 AND ${PRIVATE_SCOPE}`,
      [id],
    );
    return rows.length > 0;
  });
}

/** The conversation row alone (title, timestamps), or null when it is absent or
 *  another account's. Never loads messages. */
export async function getConversationSummary(
  db: Db,
  userId: string,
  id: string,
): Promise<StoredConversation | null> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM bob.conversations WHERE id = $1 AND ${PRIVATE_SCOPE}`,
      [id],
    );
    const row = rows[0];
    return row ? rowToConversation(row) : null;
  });
}

/**
 * The newest `limit` messages of a conversation, oldest first, each with ONE
 * version: the selected one, else the lowest version_index -- the same choice
 * getConversation's readers make. Reads at most `limit` message rows and
 * `limit` version rows however long the conversation is. With textOnly, file
 * parts come back without their url, so an inline image never leaves Postgres.
 * An unknown or other-account id (RLS) answers [] -- or null with
 * requireConversation, whose row probe runs in the same transaction as the read.
 */
export async function loadRecentHistory(
  db: Db,
  userId: string,
  conversationId: string,
  limit: number,
  opts: { textOnly?: boolean; requireConversation: true },
): Promise<RecentMessage[] | null>;
export async function loadRecentHistory(
  db: Db,
  userId: string,
  conversationId: string,
  limit: number,
  opts?: { textOnly?: boolean; requireConversation?: false },
): Promise<RecentMessage[]>;
export async function loadRecentHistory(
  db: Db,
  userId: string,
  conversationId: string,
  limit: number,
  opts?: { textOnly?: boolean; requireConversation?: boolean },
): Promise<RecentMessage[] | null> {
  const parts = opts?.textOnly === true ? TEXT_ONLY_PARTS : 'v.parts';
  return withUser(db, userId, async (tx) => {
    if (opts?.requireConversation === true) {
      const found = await tx.query<{ one: unknown }>(
        `SELECT 1 AS one FROM bob.conversations WHERE id = $1 AND ${PRIVATE_SCOPE}`,
        [conversationId],
      );
      if (found.length === 0) return null;
    }
    const rows = await tx.query<{ id: unknown; role: unknown; position: unknown; origin: unknown; parts: unknown }>(
      `SELECT r.id, r.role, r.position, r.origin, ${parts} AS parts
       FROM (SELECT id, role, position, origin FROM bob.messages
             WHERE conversation_id = $1 AND ${PRIVATE_SCOPE} ORDER BY position DESC LIMIT $2) r
       LEFT JOIN LATERAL (SELECT ${DECODED_PARTS} AS parts FROM bob.message_versions
             WHERE message_id = r.id ORDER BY is_selected DESC, version_index ASC LIMIT 1) v ON true
       ORDER BY r.position ASC`,
      [conversationId, limit],
    );
    // A message with no version row keeps its slot with no parts, as
    // getConversation's readers see it.
    return rows.map((row) => ({
      id: String(row.id),
      role: row.role === 'assistant' ? 'assistant' : 'user',
      position: Number(row.position),
      origin: toOrigin(row.origin),
      parts: row.parts === null || row.parts === undefined ? [] : decodeParts(row.parts),
    }));
  });
}

export async function getConversation(
  db: Db,
  userId: string,
  id: string,
): Promise<ConversationDetail | null> {
  return withUser(db, userId, async (tx) => {
    const conversationRows = await tx.query<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM bob.conversations WHERE id = $1 AND ${PRIVATE_SCOPE}`,
      [id],
    );
    const convRow = conversationRows[0];
    if (!convRow) return null;

    const messageRows = await tx.query<{
      id: unknown;
      role: unknown;
      position: unknown;
      origin: unknown;
      createdAt: unknown;
    }>(
      `SELECT id, role, position, origin,
              floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt"
       FROM bob.messages
       WHERE conversation_id = $1 ORDER BY position ASC`,
      [id],
    );

    const versionRows = await tx.query<{
      id: unknown;
      messageId: unknown;
      parts: unknown;
      versionIndex: unknown;
      selected: unknown;
    }>(
      `SELECT v.id, v.message_id AS "messageId", v.parts, v.version_index AS "versionIndex",
              v.is_selected AS selected
       FROM bob.message_versions v JOIN bob.messages m ON m.id = v.message_id
       WHERE m.conversation_id = $1 ORDER BY m.position ASC, v.version_index ASC`,
      [id],
    );

    const byMessage = new Map<string, StoredMessage>();
    for (const row of messageRows) {
      const stored: StoredMessage = {
        id: String(row.id),
        role: row.role === 'assistant' ? 'assistant' : 'user',
        position: Number(row.position),
        origin: toOrigin(row.origin),
        createdAt: Number(row.createdAt),
        versions: [],
      };
      byMessage.set(stored.id, stored);
    }
    for (const row of versionRows) {
      const stored = byMessage.get(String(row.messageId));
      if (!stored) continue;
      stored.versions.push({
        id: String(row.id),
        parts: decodeParts(row.parts),
        versionIndex: Number(row.versionIndex),
        selected: Boolean(row.selected),
      });
    }

    return { ...rowToConversation(convRow), messages: [...byMessage.values()] };
  });
}

export async function createConversation(
  db: Db,
  userId: string,
  title: string,
): Promise<StoredConversation> {
  const stamp = now();
  const record: StoredConversation = { id: newId('cnv'), title, createdAt: stamp, updatedAt: stamp };
  // Provision the owner's private space, then key the row to it inside the
  // insert's own transaction (the same lookup the append heal uses). A database
  // without the spaces tables yet still creates the conversation, unscoped
  // (space_id stays NULL, the legacy private path the append heal fills later).
  await ensurePrivateSpace(db, userId).catch(() => undefined);
  await withUser(db, userId, async (tx) => {
    await tx.query(
      `INSERT INTO bob.conversations (id, user_id, space_id, created_by, title, created_at, updated_at)
       VALUES ($1, $2, ${ownPrivateSpace('$2')}, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($4 / 1000.0))`,
      [record.id, userId, record.title, stamp],
    );
  });
  return record;
}

export async function renameConversation(
  db: Db,
  userId: string,
  id: string,
  title: string,
  expectedUpdatedAt?: number,
): Promise<StoredConversation> {
  return withUser(db, userId, async (tx) => {
    await assertNotStale(tx, id, expectedUpdatedAt);
    const stamp = now();
    const result =
      expectedUpdatedAt === undefined
        ? await tx.query<{ id: string }>(
            `UPDATE bob.conversations SET title = $1, updated_at = to_timestamp($2 / 1000.0)
             WHERE id = $3 AND ${PRIVATE_SCOPE} RETURNING id`,
            [title, stamp, id],
          )
        : await tx.query<{ id: string }>(
            `UPDATE bob.conversations SET title = $1, updated_at = to_timestamp($2 / 1000.0)
             WHERE id = $3 AND ${PRIVATE_SCOPE} AND updated_at = to_timestamp($4 / 1000.0) RETURNING id`,
            [title, stamp, id, expectedUpdatedAt],
          );
    if (result.length === 0) {
      if (expectedUpdatedAt === undefined) {
        throw new StoreNotFoundError(`conversation ${id} not found`);
      }
      // assertNotStale passed, so a write landed in the gap and the guarded
      // UPDATE refused it.
      throw new StoreConflictError(`conversation ${id} changed since it was read`);
    }
    const rows = await tx.query<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM bob.conversations WHERE id = $1 AND ${PRIVATE_SCOPE}`,
      [id],
    );
    const convRow = rows[0];
    if (!convRow) throw new StoreNotFoundError(`conversation ${id} not found`);
    return rowToConversation(convRow);
  });
}

/** The only columns a flag may target: a fixed map, never an interpolated
 *  string, so `flag` can never reach the SQL text as raw input. */
const FLAG_COLUMNS = { pinned: 'pinned_at', archived: 'archived_at' } as const;

/** Sets or clears a conversation's pinned_at/archived_at. Setting an
 *  already-set flag keeps its original timestamp (coalesce), so toggling on
 *  twice does not bump the pin/archive moment. updated_at is deliberately
 *  untouched -- a pin/archive is not a content change. */
export async function setConversationFlag(
  db: Db,
  userId: string,
  id: string,
  flag: 'pinned' | 'archived',
  on: boolean,
  expectedUpdatedAt?: number,
): Promise<ListedConversation> {
  const column = FLAG_COLUMNS[flag];
  return withUser(db, userId, async (tx) => {
    await assertNotStale(tx, id, expectedUpdatedAt);
    const result = await tx.query<{ id: string }>(
      `UPDATE bob.conversations
       SET ${column} = CASE WHEN $1::boolean THEN coalesce(${column}, now()) ELSE NULL END
       WHERE id = $2 AND ${PRIVATE_SCOPE} RETURNING id`,
      [on, id],
    );
    if (result.length === 0) throw new StoreNotFoundError(`conversation ${id} not found`);
    const rows = await tx.query<ListedConversationRow>(
      `SELECT ${LIST_COLUMNS} FROM bob.conversations WHERE id = $1 AND ${PRIVATE_SCOPE}`,
      [id],
    );
    const listedRow = rows[0];
    if (!listedRow) throw new StoreNotFoundError(`conversation ${id} not found`);
    return rowToListedConversation(listedRow);
  });
}

/** Idempotent: deleting an already-deleted conversation succeeds quietly. A row
 *  hidden by RLS because another account owns it answers the same quiet
 *  success as an unknown id -- no existence oracle. */
export async function deleteConversation(
  db: Db,
  userId: string,
  id: string,
  expectedUpdatedAt?: number,
): Promise<void> {
  await withUser(db, userId, async (tx) => {
    await assertNotStale(tx, id, expectedUpdatedAt);
    await tx.query(`DELETE FROM bob.conversations WHERE id = $1 AND ${PRIVATE_SCOPE}`, [id]);
  });
}

export async function countMessages(db: Db, userId: string, conversationId: string): Promise<number> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM bob.messages WHERE conversation_id = $1 AND ${PRIVATE_SCOPE}`,
      [conversationId],
    );
    const countRow = rows[0];
    if (!countRow) throw new StoreError('countMessages: no row');
    return Number(countRow.total);
  });
}

/** A version carries its message's space key (the composite same-space FK). */
async function insertVersion(
  tx: Db,
  userId: string,
  messageId: string,
  parts: unknown[],
  versionIndex: number,
  selected: boolean,
): Promise<string> {
  const id = newId('ver');
  await tx.query(
    `INSERT INTO bob.message_versions
       (id, message_id, user_id, space_id, parts, version_index, is_selected, created_at)
     VALUES ($1, $2, $3, (SELECT space_id FROM bob.messages WHERE id = $2), ${jsonbParam('$4')}, $5, $6,
             to_timestamp($7 / 1000.0))`,
    [id, messageId, userId, JSON.stringify(parts), versionIndex, selected, now()],
  );
  return id;
}

/** Adds `parts` as the message's next version and selects it. Clear-then-select
 *  keeps exactly one selected row per message. */
async function addSelectedVersion(
  tx: Db,
  userId: string,
  messageId: string,
  parts: unknown[],
  caller: string,
): Promise<void> {
  const maxRows = await tx.query<{ next: unknown }>(
    `SELECT COALESCE(MAX(version_index) + 1, 0) AS next
     FROM bob.message_versions WHERE message_id = $1`,
    [messageId],
  );
  const maxRow = maxRows[0];
  if (!maxRow) throw new StoreError(`${caller}: no max row`);
  await tx.query(`UPDATE bob.message_versions SET is_selected = false WHERE message_id = $1`, [messageId]);
  await insertVersion(tx, userId, messageId, parts, Number(maxRow.next), true);
}

/** Appends a message with its initial (selected) version and bumps recency. */
export async function appendMessage(
  db: Db,
  userId: string,
  conversationId: string,
  message: NewMessage,
): Promise<StoredMessage | null> {
  return withUser(db, userId, (tx) => appendMessageWithin(tx, userId, conversationId, message));
}

async function appendMessageWithin(
  tx: Db,
  userId: string,
  conversationId: string,
  message: NewMessage,
): Promise<StoredMessage> {
  // The conversation row lock serialises concurrent appends so positions stay
  // contiguous. RLS hides other accounts.
  const locked = await tx.query<{ spaceId: string | null }>(
    `SELECT space_id AS "spaceId" FROM bob.conversations WHERE id = $1 AND ${PRIVATE_SCOPE} FOR UPDATE`,
    [conversationId],
  );
  const lockedRow = locked[0];
  if (!lockedRow) throw new StoreNotFoundError(`conversation ${conversationId} not found`);
  // A straggler row written before the space key existed joins the owner's
  // private space, so the new message can carry the same key.
  const spaceId =
    lockedRow.spaceId ??
    (
      await tx.query<{ spaceId: string | null }>(
        `UPDATE bob.conversations
         SET space_id = ${ownPrivateSpace('$2')}
         WHERE id = $1 RETURNING space_id AS "spaceId"`,
        [conversationId, userId],
      )
    )[0]?.spaceId ??
    null;

  const positionRows = await tx.query<{ next: unknown }>(
    `SELECT COALESCE(MAX(position) + 1, 0) AS next FROM bob.messages WHERE conversation_id = $1`,
    [conversationId],
  );
  const posRow = positionRows[0];
  if (!posRow) throw new StoreError('appendMessageWithin: no row');
  const position = Number(posRow.next);

  const id = message.id ?? newId('msg');
  const origin = message.origin ?? 'web_text';
  const createdAt = now();
  // sequence follows position (the backfill rule); only a user turn has an author.
  const sequence = position + 1;
  await tx.query(
    `UPDATE bob.conversations SET updated_at = to_timestamp($1 / 1000.0), last_sequence = $2 WHERE id = $3`,
    [createdAt, sequence, conversationId],
  );
  await tx.query(
    `INSERT INTO bob.messages
       (id, conversation_id, space_id, user_id, author_user_id, role, position, sequence, origin, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0))`,
    [id, conversationId, spaceId, userId, message.role === 'user' ? userId : null, message.role, position, sequence, origin, createdAt],
  );
  await insertVersion(tx, userId, id, message.parts, 0, true);
  return {
    id,
    role: message.role,
    position,
    origin,
    createdAt,
    versions: [{ id: '', parts: message.parts, versionIndex: 0, selected: true }],
  };
}

/** The conversation holding this account's user message, or null. RLS hides other accounts. */
export async function findUserMessageConversation(db: Db, userId: string, messageId: string): Promise<string | null> {
  return withUser(db, userId, async (tx) => {
    const found = await tx.query<{ conversationId: string }>(
      `SELECT conversation_id AS "conversationId" FROM bob.messages
       WHERE id = $1 AND role = 'user' AND ${PRIVATE_SCOPE}`,
      [messageId],
    );
    return found[0]?.conversationId ?? null;
  });
}

/**
 * Persists an assistant reply. When the conversation's LAST message is an
 * assistant turn, the reply is a regeneration: a NEW selected version of that
 * turn -- regeneration adds rather than replaces. When the last message is a
 * user turn (a normal reply, or a retry after the previous reply never
 * persisted), a new assistant message row is appended at the next position, so
 * every question keeps its answer in turn order.
 */
export async function addReplyVersion(
  db: Db,
  userId: string,
  conversationId: string,
  parts: unknown[],
  // Where the question was asked. A reply to a spoken turn is spoken back, so a
  // new reply message takes its turn's origin; a new version keeps the row's.
  origin?: MessageOrigin,
): Promise<void> {
  await withUser(db, userId, async (tx) => {
    // The conversation row lock serialises concurrent regenerates so the
    // version_index MAX+1 stays race-free; message rows are not lockable
    // because authenticated has no UPDATE grant on bob.messages.
    if (!(await lockConversation(tx, conversationId))) {
      throw new StoreNotFoundError(`conversation ${conversationId} not found`);
    }
    const latest = await tx.query<{ id: string; role: unknown }>(
      `SELECT id, role FROM bob.messages WHERE conversation_id = $1
       ORDER BY position DESC LIMIT 1`,
      [conversationId],
    );
    const latestRow = latest[0];
    if (!latestRow || latestRow.role !== 'assistant') {
      // Same transaction: no nested BEGIN. An assistant reply belongs to the
      // trailing user question, not to an older assistant turn.
      await appendMessageWithin(tx, userId, conversationId, { role: 'assistant', parts, origin });
      return;
    }
    await addSelectedVersion(tx, userId, latestRow.id, parts, 'addReplyVersion');
    await touchConversation(tx, conversationId);
  });
}

/**
 * Records the heard portion of an interrupted assistant reply: truncates the
 * message's selected version to heardChars -- cut back to the last
 * sentence/word boundary -- by inserting a NEW selected version (so version
 * history stays intact) and sets bob.messages.interrupted. Works only on an
 * ASSISTANT message of the caller's own conversation (RLS hides other accounts,
 * so a foreign id answers null, never an oracle). Idempotent: a repeat call with
 * the same or a larger heardChars changes nothing and never grows the text back.
 * Returns the new text length and whether a truncation landed, or null when the
 * message is not found, not owned, or not an assistant turn.
 */
export async function markReplyInterrupted(
  db: Db,
  userId: string,
  conversationId: string,
  messageId: string,
  heardChars: number,
): Promise<{ length: number; truncated: boolean } | null> {
  return withUser(db, userId, async (tx) => {
    if (!(await lockConversation(tx, conversationId))) return null;

    const messageRows = await tx.query<{ id: string; role: unknown }>(
      `SELECT id, role FROM bob.messages WHERE id = $1 AND conversation_id = $2`,
      [messageId, conversationId],
    );
    const messageRow = messageRows[0];
    if (!messageRow || messageRow.role !== 'assistant') return null;

    const versionRows = await tx.query<{ id: string; parts: unknown; versionIndex: unknown }>(
      `SELECT id, parts, version_index AS "versionIndex" FROM bob.message_versions
       WHERE message_id = $1 AND is_selected = true ORDER BY version_index DESC LIMIT 1`,
      [messageId],
    );
    const versionRow = versionRows[0];
    if (!versionRow) return { length: 0, truncated: false };
    const currentParts = decodeParts(versionRow.parts);
    const currentText = partsText(currentParts);
    const truncated = truncateToHeard(currentText, heardChars);
    // Idempotent: nothing to shrink (the whole reply was heard) or already
    // truncated to this boundary -- a larger heardChars must never grow it back.
    if (truncated.length >= currentText.length) {
      return { length: currentText.length, truncated: false };
    }

    await addSelectedVersion(tx, userId, messageId, cutReplyParts(currentParts, truncated), 'markReplyInterrupted');
    await tx.query(`UPDATE bob.messages SET interrupted = true WHERE id = $1`, [messageId]);
    await touchConversation(tx, conversationId);
    return { length: truncated.length, truncated: true };
  });
}

export async function selectVersion(
  db: Db,
  userId: string,
  messageId: string,
  versionIndex: number,
): Promise<void> {
  await withUser(db, userId, async (tx) => {
    const result = await tx.query<{ id: string }>(
      `UPDATE bob.message_versions
       SET is_selected = CASE WHEN version_index = $1 THEN true ELSE false END
       WHERE message_id = $2 AND ${PRIVATE_SCOPE} RETURNING id`,
      [versionIndex, messageId],
    );
    if (result.length === 0) throw new StoreNotFoundError(`message ${messageId} not found`);
  });
}

/** Deletes every message at a greater position than the anchor. The anchor itself stays. */
export async function truncateAfterMessage(
  db: Db,
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  await withUser(db, userId, async (tx) => {
    const anchor = await tx.query<{ position: unknown }>(
      `SELECT position FROM bob.messages WHERE id = $1 AND conversation_id = $2 AND ${PRIVATE_SCOPE}`,
      [messageId, conversationId],
    );
    const anchorRow = anchor[0];
    if (!anchorRow) throw new StoreNotFoundError(`message ${messageId} not found`);
    await tx.query(
      `DELETE FROM bob.messages WHERE conversation_id = $1 AND position > $2 AND ${PRIVATE_SCOPE}`,
      [conversationId, Number(anchorRow.position)],
    );
  });
}

/**
 * Deletes EVERY message of a conversation (editing its first message, which no
 * anchor precedes). The conversation row is locked like an append so a
 * concurrent write cannot interleave; an unknown or other-account id (RLS hides
 * it) is a StoreNotFoundError, as in truncateAfterMessage.
 */
export async function truncateAllMessages(db: Db, userId: string, conversationId: string): Promise<void> {
  await withUser(db, userId, async (tx) => {
    if (!(await lockConversation(tx, conversationId))) {
      throw new StoreNotFoundError(`conversation ${conversationId} not found`);
    }
    await tx.query(`DELETE FROM bob.messages WHERE conversation_id = $1`, [conversationId]);
  });
}

type DeleteFromResult =
  | { kind: 'deleted'; deleted: number; updatedAt: number }
  | { kind: 'not_found' }
  | { kind: 'not_user_message' };

/**
 * Deletes a USER message and every later message ("delete from here"): the same
 * cut as editing (truncateAfterMessage), one position earlier. Cutting from a
 * user message leaves a clean prefix that ends on a reply -- the context the
 * model had before that question -- rather than the unanswered question or
 * orphan reply a mid-conversation delete would leave.
 */
export async function deleteMessagesFrom(
  db: Db,
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<DeleteFromResult> {
  return withUser(db, userId, async (tx) => {
    if (!(await lockConversation(tx, conversationId))) return { kind: 'not_found' };

    const anchor = await tx.query<{ role: unknown; position: unknown }>(
      `SELECT role, position FROM bob.messages WHERE id = $1 AND conversation_id = $2`,
      [messageId, conversationId],
    );
    const anchorRow = anchor[0];
    if (!anchorRow) return { kind: 'not_found' };
    if (anchorRow.role !== 'user') return { kind: 'not_user_message' };

    const deleted = await tx.query<{ id: string }>(
      `DELETE FROM bob.messages WHERE conversation_id = $1 AND position >= $2 RETURNING id`,
      [conversationId, Number(anchorRow.position)],
    );
    const stamp = now();
    await touchConversation(tx, conversationId, stamp);
    return { kind: 'deleted', deleted: deleted.length, updatedAt: stamp };
  });
}
