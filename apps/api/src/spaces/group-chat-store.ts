import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { StoreForbiddenError } from './invitations.ts';
import { groupLifecycleError } from './group-chat-errors.ts';
import { copyGroupSnapshot, readGroupSnapshot } from './group-chat-snapshot.ts';

export type GroupChat = {
  id: string; space_id: string; title: string; created_by: string;
  role: 'owner' | 'admin' | 'member'; created_at: number; updated_at: number;
};
export type GroupChatMember = { user_id: string; display_name: string | null; role: GroupChat['role'] };
const CHAT_SELECT = `SELECT c.id, s.id AS space_id, c.title, c.created_by, m.role,
  floor(extract(epoch from c.created_at) * 1000)::bigint AS created_at,
  floor(extract(epoch from c.updated_at) * 1000)::bigint AS updated_at
  FROM bob.spaces s JOIN bob.conversations c ON c.id = s.conversation_id
  JOIN bob.space_memberships m ON m.space_id = s.id AND m.user_id = $1 AND m.revoked_at IS NULL
  WHERE s.archived_at IS NULL AND c.archived_at IS NULL`;

function toChat(row: GroupChat): GroupChat {
  return { ...row, created_at: Number(row.created_at), updated_at: Number(row.updated_at) };
}
async function findChat(tx: Db, userId: string, chatId: string): Promise<GroupChat> {
  const rows = await tx.query<GroupChat>(`${CHAT_SELECT} AND c.id = $2`, [userId, chatId]);
  const row = rows[0];
  if (!row) throw new StoreNotFoundError('group chat not found');
  return toChat(row);
}

export async function createGroupChat(
  db: Db, userId: string, input: { requestId: string; sourceConversationId?: string; textOnly?: boolean },
): Promise<GroupChat> {
  return withUser(db, userId, async (tx) => {
    // Serialize retries before either existence check or any audience insert.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`group-chat:${userId}:${input.requestId}`]);
    const prior = await tx.query<{ conversation_id: string }>(
      'SELECT conversation_id FROM bob.spaces WHERE group_chat_created_by = $1 AND group_chat_request_id = $2',
      [userId, input.requestId],
    );
    if (prior[0]) return findChat(tx, userId, prior[0].conversation_id);
    const snapshot = await readGroupSnapshot(tx, userId, input.sourceConversationId);
    const chatId = randomUUID();
    const spaceId = randomUUID();
    await tx.query(
      `INSERT INTO bob.spaces (id, kind, name, owner_user_id, conversation_id, group_chat_created_by, group_chat_request_id)
       VALUES ($1, 'group', $2, $3, $4, $3, $5)`,
      [spaceId, snapshot.title.slice(0, 60), userId, chatId, input.requestId],
    );
    await tx.query(
      "INSERT INTO bob.space_memberships (space_id, user_id, role) VALUES ($1, $2, 'owner')",
      [spaceId, userId],
    );
    await tx.query(
      'INSERT INTO bob.conversations (id, user_id, space_id, created_by, title) VALUES ($1, $2, $3, $2, $4)',
      [chatId, userId, spaceId, snapshot.title],
    );
    await copyGroupSnapshot(tx, userId, chatId, spaceId, snapshot, input.textOnly === true);
    return findChat(tx, userId, chatId);
  });
}

export async function getGroupChat(db: Db, userId: string, chatId: string): Promise<GroupChat> {
  return withUser(db, userId, (tx) => findChat(tx, userId, chatId));
}
export async function listGroupChats(db: Db, userId: string): Promise<GroupChat[]> {
  return withUser(db, userId, async (tx) => (
    await tx.query<GroupChat>(`${CHAT_SELECT} ORDER BY c.updated_at DESC, c.id`, [userId])
  ).map(toChat));
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export async function createGroupChatLink(db: Db, userId: string, chatId: string): Promise<{ token: string; expires_at: number }> {
  return withUser(db, userId, async (tx) => {
    const chat = await findChat(tx, userId, chatId);
    const token = randomBytes(32).toString('base64url');
    const rows = await tx.query<{ expires_at: string | number }>(
      `INSERT INTO bob.group_chat_links (space_id, created_by, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '7 days')
       RETURNING floor(extract(epoch from expires_at) * 1000)::bigint AS expires_at`,
      [chat.space_id, userId, tokenHash(token)],
    );
    const row = rows[0];
    if (!row) throw new StoreNotFoundError('group chat not found');
    return { token, expires_at: Number(row.expires_at) };
  });
}
export async function previewGroupChatLink(
  db: Db, userId: string, token: string,
): Promise<{ title: string; inviter_name: string; expires_at: number }> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ title: string; inviter_name: string; expires_at: string | number }>(
      `SELECT title, inviter_name, floor(extract(epoch from expires_at) * 1000)::bigint AS expires_at
       FROM bob_private.preview_group_chat_link($1::text)`, [tokenHash(token)],
    );
    const row = rows[0];
    if (!row) throw new StoreNotFoundError('invitation not found');
    return { ...row, expires_at: Number(row.expires_at) };
  });
}
export async function acceptGroupChatLink(db: Db, userId: string, token: string): Promise<GroupChat> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ conversation_id: string | null }>(
      'SELECT bob_private.accept_group_chat_link($1::text) AS conversation_id', [tokenHash(token)],
    ).catch(groupLifecycleError);
    const id = rows[0]?.conversation_id;
    if (!id) throw new StoreNotFoundError('invitation not found');
    return findChat(tx, userId, id);
  });
}
export async function revokeGroupChatLinks(db: Db, userId: string, chatId: string): Promise<void> {
  return withUser(db, userId, async (tx) => {
    const chat = await findChat(tx, userId, chatId);
    if (chat.role !== 'owner') throw new StoreForbiddenError('Only the group owner can disable links.');
    await tx.query('SELECT id FROM bob.spaces WHERE id = $1 FOR UPDATE', [chat.space_id]);
    await tx.query('UPDATE bob.group_chat_links SET revoked_at = clock_timestamp() WHERE space_id = $1 AND revoked_at IS NULL', [chat.space_id]);
  });
}
export async function listGroupChatMembers(db: Db, userId: string, chatId: string): Promise<GroupChatMember[]> {
  return withUser(db, userId, async (tx) => {
    const chat = await findChat(tx, userId, chatId);
    return tx.query<GroupChatMember>(
      `SELECT m.user_id, p.display_name, m.role FROM bob.space_memberships m
       JOIN bob_private.space_member_profiles($1::uuid) p ON p.user_id = m.user_id
       WHERE m.space_id = $1 AND m.revoked_at IS NULL ORDER BY m.joined_at, m.user_id`, [chat.space_id],
    );
  });
}
export async function removeGroupChatMember(db: Db, userId: string, chatId: string, targetUserId: string): Promise<void> {
  return withUser(db, userId, async (tx) => {
    const chat = await findChat(tx, userId, chatId);
    if (targetUserId !== userId && chat.role !== 'owner') throw new StoreForbiddenError('Only the group owner can remove people.');
    await tx.query('SELECT bob_private.remove_group_chat_member($1::text, $2::uuid)', [chatId, targetUserId]).catch(groupLifecycleError);
  });
}
