/**
 * Thread store over the unified conversation tables. A thread is an
 * bob.conversations row in a shared (pair or group) space (SHARED_SCOPE); a
 * private space's conversations never appear here, whatever the shape of their
 * id. Its messages are bob.messages rows whose body is the selected
 * bob.message_versions row's text (parts [{type:'text', text: body}]).
 *
 * Every function runs under withUser() so RLS decides access from ACTIVE
 * membership in the space: a thread the caller cannot see answers the same
 * StoreNotFoundError as a missing id. The sequence is allocated under a lock on
 * the conversation row, so two concurrent posts get consecutive sequences and a
 * client_message_id retry is seen after the lock (never a 23505 that aborts the
 * transaction). Editing adds a version and bumps revision, with no truncation;
 * posting never calls a model.
 */
import { StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { jsonbParam } from '../platform/db/jsonb.ts';
import { requireSpaceMember } from '../spaces/store.ts';
import type { ChatMessage } from './chat-message.ts';
import { SHARED_SCOPE, sharedScope } from './space-scope.ts';
import { DECODED_PARTS, partsText } from './store.ts';

/** A thread (a shared conversation) with epoch-ms stamps, plus the caller's
 *  own unread count when it was read for a listing/detail. */
export type StoredThread = {
  id: string;
  spaceId: string;
  title: string;
  createdBy: string;
  archivedAt: number | null;
  lastSequence: number;
  createdAt: number;
  updatedAt: number;
  unreadCount?: number;
};

/** A thread message (authorUserId null means the assistant). */
export type StoredThreadMessage = {
  id: string;
  threadId: string;
  spaceId: string;
  authorUserId: string | null;
  body: string;
  replyToMessageId: string | null;
  sequence: number;
  clientMessageId: string;
  revision: number;
  tombstonedAt: number | null;
  tombstonedBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** Which surface spoke it (bob.messages.origin: NOT NULL). */
  origin: 'web_text' | 'web_voice' | 'device';
};

/** The caller's read state in one thread. */
export type ThreadReadState = {
  threadId: string;
  userId: string;
  lastReadSequence: number;
  updatedAt: number;
};

type NewMessage = {
  threadId: string;
  body: string;
  replyToMessageId?: string | null;
  clientMessageId: string;
  /** The device that spoke it (DEVICE_REF_SQL); absent for web posts. */
  deviceId?: string | null;
};

/** A raw bob.conversations row (aliases follow THREAD_COLUMNS, plus unreadCount). */
type ThreadRow = {
  id: unknown;
  spaceId: unknown;
  title: unknown;
  createdBy: unknown;
  archivedAt: unknown;
  lastSequence: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  unreadCount?: unknown;
};

/** A raw bob.messages row (aliases follow MESSAGE_COLUMNS); `parts` is the
 *  selected version's parts, decoded to the body by rowToMessage. */
type MessageRow = {
  id: unknown;
  threadId: unknown;
  spaceId: unknown;
  authorUserId: unknown;
  parts: unknown;
  replyToMessageId: unknown;
  sequence: unknown;
  clientMessageId: unknown;
  revision: unknown;
  tombstonedAt: unknown;
  tombstonedBy: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  origin: unknown;
};

type ThreadInsert = {
  thread: StoredThread;
  authorUserId: string | null;
  body: string;
  replyToMessageId: string | null;
  clientMessageId: string;
  deviceId: string | null;
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** The caller's own device with this id, else null (RLS scopes it). */
const DEVICE_REF_SQL = (param: string): string => `(SELECT d.id FROM bob.devices d WHERE d.id::text = ${param})`;

/** Unqualified, so it serves SELECT (FROM bob.conversations t) and RETURNING. */
const THREAD_COLUMNS = `id, space_id AS "spaceId", title, created_by AS "createdBy",
  floor(extract(epoch from archived_at) * 1000)::bigint AS "archivedAt",
  last_sequence AS "lastSequence",
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt"`;

/** Message columns for `FROM bob.messages m`; parts are the selected version's. */
const MESSAGE_COLUMNS = `m.id, m.conversation_id AS "threadId", m.space_id AS "spaceId",
  m.author_user_id AS "authorUserId", m.reply_to_message_id AS "replyToMessageId",
  (SELECT ${DECODED_PARTS} FROM bob.message_versions v
    WHERE v.message_id = m.id ORDER BY v.is_selected DESC, v.version_index DESC LIMIT 1) AS parts,
  m.sequence, m.client_message_id AS "clientMessageId", m.revision,
  floor(extract(epoch from m.tombstoned_at) * 1000)::bigint AS "tombstonedAt",
  m.tombstoned_by AS "tombstonedBy",
  floor(extract(epoch from m.created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from m.updated_at) * 1000)::bigint AS "updatedAt",
  m.origin`;

/** The caller's unread count for thread `t` (`$2` is the userId): a COUNT of
 *  non-tombstoned messages after the caller's read cursor. */
const THREAD_UNREAD_COUNT = `(
  SELECT COUNT(*)::int FROM bob.messages m
  WHERE m.conversation_id = t.id AND m.tombstoned_at IS NULL
    AND m.sequence > COALESCE(
      (SELECT r.last_read_sequence FROM bob.conversation_reads r
       WHERE r.conversation_id = t.id AND r.user_id = $2), 0)
) AS "unreadCount"`;

const nullableNumber = (value: unknown): number | null => (value === null ? null : Number(value));
const nullableString = (value: unknown): string | null => (value === null ? null : String(value));

/** The text-only parts of a version holding `body`, as bound JSON. */
const textParts = (body: string): string => JSON.stringify([{ type: 'text', text: body }]);

function rowToThread(row: ThreadRow): StoredThread {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    title: String(row.title),
    createdBy: String(row.createdBy),
    archivedAt: nullableNumber(row.archivedAt),
    lastSequence: Number(row.lastSequence),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    unreadCount: row.unreadCount === undefined ? undefined : Number(row.unreadCount),
  };
}

/** The text of a version's parts (a driver may hand jsonb back as a string). */
function bodyOf(parts: unknown): string {
  const decoded: unknown = typeof parts === 'string' ? JSON.parse(parts) : parts;
  return Array.isArray(decoded) ? partsText(decoded) : '';
}

function rowToMessage(row: MessageRow): StoredThreadMessage {
  return {
    id: String(row.id),
    threadId: String(row.threadId),
    spaceId: String(row.spaceId),
    authorUserId: nullableString(row.authorUserId),
    // A tombstoned message's text is kept in its version but no read returns it.
    body: row.tombstonedAt === null ? bodyOf(row.parts) : '',
    replyToMessageId: nullableString(row.replyToMessageId),
    sequence: Number(row.sequence),
    clientMessageId: String(row.clientMessageId),
    revision: Number(row.revision),
    tombstonedAt: nullableNumber(row.tombstonedAt),
    tombstonedBy: nullableString(row.tombstonedBy),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    origin: row.origin as StoredThreadMessage['origin'],
  };
}

/** 1..120 chars after trim. */
function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > 120) throw new StoreError('thread title must be 1..120 characters');
  return trimmed;
}

/** 1..8000 chars after trim; stores the original. */
function validateBody(body: string): string {
  if (body.trim().length < 1 || body.length > 8000) throw new StoreError('message body must be 1..8000 characters');
  return body;
}

function validateClientMessageId(clientMessageId: string): string {
  const trimmed = clientMessageId.trim();
  if (trimmed.length < 1 || trimmed.length > 128) throw new StoreError('client_message_id must be 1..128 characters');
  return clientMessageId;
}

/** Keyset cursor: `${sequence hex}-${id}` (sequence is unique per thread). */
export function encodeCursor(sequence: number, id: string): string {
  return `${sequence.toString(16)}-${id}`;
}

/** Decodes a cursor; null for anything malformed (never throws). */
function decodeCursor(cursor: string): { sequence: number; id: string } | null {
  const separator = cursor.indexOf('-');
  if (separator <= 0) return null;
  const sequence = Number.parseInt(cursor.slice(0, separator), 16);
  const id = cursor.slice(separator + 1);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || id.length === 0) return null;
  return { sequence, id };
}

/** One thread by id under RLS, or null (missing, hidden and private-space
 *  rows are all an empty read -- the identity-leak rule). */
async function readThreadRow(tx: Db, id: string): Promise<ThreadRow | null> {
  const rows = await tx.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM bob.conversations t WHERE t.id = $1 AND ${sharedScope('t')}`,
    [id],
  );
  return rows[0] ?? null;
}

/** One thread message by id under RLS, or null unless it is in a shared space. */
async function readMessageRow(tx: Db, messageId: string): Promise<MessageRow | null> {
  const rows = await tx.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM bob.messages m WHERE m.id = $1 AND ${sharedScope('m')}`,
    [messageId],
  );
  return rows[0] ?? null;
}

/** The caller's role in a space, or null when not an active member. */
async function callerRole(tx: Db, spaceId: string, userId: string): Promise<string | null> {
  const rows = await tx.query<{ role: unknown }>(
    `SELECT m.role FROM bob.space_memberships m
     WHERE m.space_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL`,
    [spaceId, userId],
  );
  const row = rows[0];
  return row ? String(row.role) : null;
}

function onlyThread(rows: ThreadRow[]): StoredThread {
  const row = rows[0];
  if (!row) throw new StoreNotFoundError('thread not found');
  return rowToThread(row);
}

function requireMessage(row: MessageRow | null): StoredThreadMessage {
  if (!row) throw new StoreNotFoundError('message not found');
  return rowToMessage(row);
}

/** Locks the thread's conversation row for the sequence allocator; null when
 *  missing or hidden. */
async function lockThread(tx: Db, threadId: string): Promise<StoredThread | null> {
  const rows = await tx.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM bob.conversations t
     WHERE t.id = $1 AND ${sharedScope('t')} FOR UPDATE`,
    [threadId],
  );
  const row = rows[0];
  return row ? rowToThread(row) : null;
}

/** Inserts the message and its selected version at the next position (the
 *  caller holds lockThread), then moves last_sequence. `userId` is the actor. */
async function insertThreadMessage(tx: Db, userId: string, input: ThreadInsert): Promise<StoredThreadMessage> {
  const inserted = await tx.query<{ id: unknown; sequence: unknown }>(
    `INSERT INTO bob.messages
       (id, conversation_id, space_id, role, user_id, author_user_id, position, sequence,
        client_message_id, reply_to_message_id, revision, origin, device_id)
     SELECT gen_random_uuid()::text, $1, $2, $3, $4, $5, p.next, p.next + 1, $6, $7, 1,
            CASE WHEN $8::text IS NULL THEN 'web_text' ELSE 'device' END, ${DEVICE_REF_SQL('$8::text')}
       FROM (SELECT coalesce(max(position) + 1, 0) AS next
               FROM bob.messages WHERE conversation_id = $1) p
     RETURNING id, sequence`,
    [
      input.thread.id,
      input.thread.spaceId,
      input.authorUserId === null ? 'assistant' : 'user',
      userId,
      input.authorUserId,
      input.clientMessageId,
      input.replyToMessageId,
      input.deviceId,
    ],
  );
  const row = inserted[0];
  if (!row) throw new StoreError('could not post message');
  const id = String(row.id);
  await tx.query(
    `INSERT INTO bob.message_versions (message_id, user_id, space_id, parts, version_index, is_selected)
     VALUES ($1, $2, $3, ${jsonbParam('$4')}, 0, true)`,
    [id, userId, input.thread.spaceId, textParts(input.body)],
  );
  await tx.query(
    `UPDATE bob.conversations SET last_sequence = $2, updated_at = now() WHERE id = $1`,
    [input.thread.id, Number(row.sequence)],
  );
  return requireMessage(await readMessageRow(tx, id));
}

/** The space's non-archived threads, newest activity first, each with the
 *  caller's unread count. A space the caller is not in answers an empty list. */
export async function listThreads(db: Db, userId: string, spaceId: string): Promise<StoredThread[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<ThreadRow>(
      `SELECT ${THREAD_COLUMNS}, ${THREAD_UNREAD_COUNT}
       FROM bob.conversations t
       WHERE t.space_id = $1 AND t.archived_at IS NULL AND ${sharedScope('t')}
       ORDER BY t.updated_at DESC`,
      [spaceId, userId],
    );
    return rows.map(rowToThread);
  });
}

/** Creates a thread in a shared space the caller is an active member of;
 *  created_by is always the caller. A private space has no multi-author
 *  conversations, so it answers like a missing space. */
export async function createThread(
  db: Db,
  userId: string,
  input: { spaceId: string; title: string },
): Promise<StoredThread> {
  const title = validateTitle(input.title);
  return withUser(db, userId, async (tx) => {
    await requireSpaceMember(tx, input.spaceId, userId);
    const shared = await tx.query(`SELECT 1 AS one FROM bob.spaces WHERE id = $1 AND kind <> 'private'`, [input.spaceId]);
    if (shared.length === 0) throw new StoreNotFoundError('space not found');
    const rows = await tx.query<ThreadRow>(
      `INSERT INTO bob.conversations (id, user_id, space_id, created_by, title)
       VALUES (gen_random_uuid()::text, $3, $1, $3, $2)
       RETURNING ${THREAD_COLUMNS}`,
      [input.spaceId, title, userId],
    );
    const row = rows[0];
    if (!row) throw new StoreError('could not create thread');
    return rowToThread(row);
  });
}

/** One thread with the caller's unread count; hidden equals missing. */
export async function getThread(db: Db, userId: string, threadId: string): Promise<StoredThread> {
  return withUser(db, userId, async (tx) =>
    onlyThread(
      await tx.query<ThreadRow>(
        `SELECT ${THREAD_COLUMNS}, ${THREAD_UNREAD_COUNT}
         FROM bob.conversations t WHERE t.id = $1 AND ${sharedScope('t')}`,
        [threadId, userId],
      ),
    ),
  );
}

/** A thread's messages in ascending sequence order, keyset-paginated;
 *  nextCursor is non-null only when more rows follow. `cursor` is an
 *  encodeCursor value from a previous page. */
export async function listMessages(
  db: Db,
  userId: string,
  threadId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ messages: StoredThreadMessage[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
  return withUser(db, userId, async (tx) => {
    if (!(await readThreadRow(tx, threadId))) throw new StoreNotFoundError('thread not found');
    let after = -1;
    if (options.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (!decoded) throw new StoreError('listMessages: invalid cursor');
      after = decoded.sequence;
    }
    const rows = await tx.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM bob.messages m
       WHERE m.conversation_id = $1 AND m.sequence > $2
       ORDER BY m.sequence ASC, m.id ASC
       LIMIT $3`,
      [threadId, after, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor(Number(last.sequence), String(last.id)) : null;
    return { messages: page.map(rowToMessage), nextCursor };
  });
}

export async function renameThread(
  db: Db,
  userId: string,
  threadId: string,
  input: { title: string },
): Promise<StoredThread> {
  const title = validateTitle(input.title);
  return withUser(db, userId, async (tx) =>
    onlyThread(
      await tx.query<ThreadRow>(
        `UPDATE bob.conversations SET title = $2, updated_at = now()
         WHERE id = $1 AND ${SHARED_SCOPE}
         RETURNING ${THREAD_COLUMNS}`,
        [threadId, title],
      ),
    ),
  );
}

/** Archives a thread: it leaves the list, the rows survive. Idempotent. */
export async function archiveThread(db: Db, userId: string, threadId: string): Promise<StoredThread> {
  return withUser(db, userId, async (tx) =>
    onlyThread(
      await tx.query<ThreadRow>(
        `UPDATE bob.conversations SET archived_at = now(), updated_at = now()
         WHERE id = $1 AND ${SHARED_SCOPE}
         RETURNING ${THREAD_COLUMNS}`,
        [threadId],
      ),
    ),
  );
}

/** Reopens the same shared thread in an already-authorized, exact audience. */
export async function reopenThread(db: Db, userId: string, threadId: string, spaceId: string): Promise<StoredThread> {
  return withUser(db, userId, async (tx) => onlyThread(await tx.query<ThreadRow>(
    `UPDATE bob.conversations SET archived_at = null, updated_at = now()
     WHERE id=$1 AND space_id=$2 AND ${SHARED_SCOPE}
     RETURNING ${THREAD_COLUMNS}`, [threadId, spaceId],
  )));
}

/** Posts a human message. A retry with the same client_message_id (per
 *  author) returns the original with created false (the route answers 200). */
export async function postMessage(
  db: Db,
  userId: string,
  input: NewMessage,
): Promise<{ message: StoredThreadMessage; created: boolean }> {
  const body = validateBody(input.body);
  const clientMessageId = validateClientMessageId(input.clientMessageId);
  return withUser(db, userId, async (tx) => {
    const thread = await lockThread(tx, input.threadId);
    if (!thread) throw new StoreNotFoundError('thread not found');
    if (thread.archivedAt !== null) throw new StoreError('cannot post to an archived thread');
    if (input.replyToMessageId) {
      const replies = await tx.query(
        `SELECT 1 FROM bob.messages WHERE id = $1 AND conversation_id = $2`,
        [input.replyToMessageId, input.threadId],
      );
      if (replies.length === 0) throw new StoreError('reply_to_message_id must be a message in the same thread');
    }
    const existing = await tx.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM bob.messages m
       WHERE m.author_user_id = $1 AND m.client_message_id = $2`,
      [userId, clientMessageId],
    );
    const original = existing[0];
    if (original) return { message: rowToMessage(original), created: false };
    const message = await insertThreadMessage(tx, userId, {
      thread,
      authorUserId: userId,
      body,
      replyToMessageId: input.replyToMessageId ?? null,
      clientMessageId,
      deviceId: input.deviceId ?? null,
    });
    return { message, created: true };
  });
}

/** Hidden equals missing. */
export async function getMessage(db: Db, userId: string, messageId: string): Promise<StoredThreadMessage> {
  return withUser(db, userId, async (tx) => requireMessage(await readMessageRow(tx, messageId)));
}

/** Edits the caller's own message: deselects the old version, adds the new
 *  body as the next version and bumps revision; later messages are untouched.
 *  A foreign or hidden id answers StoreNotFoundError (no authorship probe). */
export async function editMessage(
  db: Db,
  userId: string,
  messageId: string,
  input: { body: string },
): Promise<StoredThreadMessage> {
  const body = validateBody(input.body);
  return withUser(db, userId, async (tx) => {
    const row = await readMessageRow(tx, messageId);
    if (!row || row.authorUserId === null || String(row.authorUserId) !== userId) {
      throw new StoreNotFoundError('message not found');
    }
    if (row.tombstonedAt !== null) throw new StoreError('cannot edit a tombstoned message');
    await tx.query(
      `UPDATE bob.message_versions SET is_selected = false WHERE message_id = $1 AND is_selected`,
      [messageId],
    );
    await tx.query(
      `INSERT INTO bob.message_versions (message_id, user_id, space_id, parts, version_index, is_selected)
       SELECT $1, $2, $3, ${jsonbParam('$4')}, coalesce(max(version_index) + 1, 0), true
         FROM bob.message_versions WHERE message_id = $1`,
      [messageId, userId, String(row.spaceId), textParts(body)],
    );
    await tx.query(
      `UPDATE bob.messages SET revision = revision + 1, updated_at = now() WHERE id = $1`,
      [messageId],
    );
    return requireMessage(await readMessageRow(tx, messageId));
  });
}

/** Tombstones a message: its author, or an owner/admin of the space as
 *  moderation (recorded in tombstoned_by); anyone else gets not found. */
export async function tombstoneMessage(db: Db, userId: string, messageId: string): Promise<StoredThreadMessage> {
  return withUser(db, userId, async (tx) => {
    const row = await readMessageRow(tx, messageId);
    if (!row) throw new StoreNotFoundError('message not found');
    const role = await callerRole(tx, String(row.spaceId), userId);
    const isModerator = role === 'owner' || role === 'admin';
    if (row.authorUserId !== userId && !isModerator) throw new StoreNotFoundError('message not found');
    await tx.query(
      `UPDATE bob.messages SET tombstoned_at = now(), tombstoned_by = $2, updated_at = now() WHERE id = $1`,
      [messageId, userId],
    );
    return requireMessage(await readMessageRow(tx, messageId));
  });
}

/** Moves the caller's read cursor forward only (GREATEST), clamped to the
 *  thread's last_sequence; with no value it marks everything read. */
export async function markRead(
  db: Db,
  userId: string,
  threadId: string,
  input: { lastReadSequence?: number } = {},
): Promise<ThreadReadState> {
  if (input.lastReadSequence !== undefined && (!Number.isInteger(input.lastReadSequence) || input.lastReadSequence < 0)) {
    throw new StoreError('markRead: last_read_sequence must be a nonnegative integer');
  }
  return withUser(db, userId, async (tx) => {
    const thread = await readThreadRow(tx, threadId);
    if (!thread) throw new StoreNotFoundError('thread not found');
    const threadLast = Number(thread.lastSequence);
    const target = Math.max(0, Math.min(input.lastReadSequence ?? threadLast, threadLast));
    const rows = await tx.query<{ threadId: unknown; userId: unknown; lastReadSequence: unknown; updatedAt: unknown }>(
      `INSERT INTO bob.conversation_reads (conversation_id, user_id, last_read_sequence)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, user_id) DO UPDATE
       SET last_read_sequence = GREATEST(conversation_reads.last_read_sequence, EXCLUDED.last_read_sequence),
           updated_at = now()
       RETURNING conversation_id AS "threadId", user_id AS "userId",
         last_read_sequence AS "lastReadSequence",
         floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt"`,
      [threadId, userId, target],
    );
    const readRow = rows[0];
    if (!readRow) throw new StoreError('could not mark thread read');
    return {
      threadId: String(readRow.threadId),
      userId: String(readRow.userId),
      lastReadSequence: Number(readRow.lastReadSequence),
      updatedAt: Number(readRow.updatedAt),
    };
  });
}

/** The caller's unread count: non-tombstoned messages after their cursor. */
export async function unreadCount(db: Db, userId: string, threadId: string): Promise<number> {
  return withUser(db, userId, async (tx) => {
    if (!(await readThreadRow(tx, threadId))) throw new StoreNotFoundError('thread not found');
    const rows = await tx.query<{ total: unknown }>(
      `SELECT COUNT(*)::int AS total FROM bob.messages m
       WHERE m.conversation_id = $1 AND m.tombstoned_at IS NULL
         AND m.sequence > COALESCE(
           (SELECT r.last_read_sequence FROM bob.conversation_reads r
            WHERE r.conversation_id = $1 AND r.user_id = $2), 0)`,
      [threadId, userId],
    );
    const countRow = rows[0];
    if (!countRow) throw new StoreError('unreadCount: no row');
    return Number(countRow.total);
  });
}

/** The newest `limit` non-deleted messages, oldest first, mapped for a model
 *  prompt (author null = assistant). Hidden equals missing. */
export async function listRecentMessages(
  db: Db,
  userId: string,
  threadId: string,
  limit: number,
): Promise<ChatMessage[]> {
  const whole = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIST_LIMIT;
  const bounded = Math.max(1, Math.min(whole, MAX_LIST_LIMIT));
  return withUser(db, userId, async (tx) => {
    if (!(await readThreadRow(tx, threadId))) throw new StoreNotFoundError('thread not found');
    const rows = await tx.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM bob.messages m
       WHERE m.conversation_id = $1 AND m.tombstoned_at IS NULL
       ORDER BY m.sequence DESC, m.id DESC
       LIMIT $2`,
      [threadId, bounded],
    );
    return rows.reverse().map((row): ChatMessage => {
      const message = rowToMessage(row);
      return { role: message.authorUserId === null ? 'assistant' : 'user', content: message.body };
    });
  });
}

/** Persists an assistant reply (author NULL, user_id the acting user) at the
 *  next sequence; client_message_id is `bob:<invocationId>`. deviceId names
 *  the device a spoken reply played on. */
export class ThreadAudienceChangedError extends Error {
  constructor() { super('thread audience changed'); this.name = 'ThreadAudienceChangedError'; }
}

export async function postAssistantMessage(
  db: Db,
  userId: string,
  target: { threadId: string; spaceId: string; expectedMembershipRevision?: number },
  invocationId: string,
  body: string,
  deviceId: string | null = null,
): Promise<StoredThreadMessage> {
  return withUser(db, userId, async (tx) => {
    if (target.expectedMembershipRevision !== undefined) {
      // Same lock order as membership changes: audience first, conversation
      // second. Keep this lock through message insertion so a reply cannot
      // outlive the audience revision used to generate it.
      const rows = await tx.query<{ membership_revision: number }>(
        'SELECT bob_private.lock_thread_audience_revision($1::uuid) AS membership_revision',
        [target.spaceId],
      );
      if (rows[0]?.membership_revision !== target.expectedMembershipRevision) throw new ThreadAudienceChangedError();
    }
    const thread = await lockThread(tx, target.threadId);
    if (!thread) throw new Error('could not allocate message sequence');
    return insertThreadMessage(tx, userId, {
      thread,
      authorUserId: null,
      body,
      replyToMessageId: null,
      clientMessageId: `bob:${invocationId}`,
      deviceId,
    });
  });
}
