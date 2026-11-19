import { withUser, type Db } from '../platform/db/db.ts';

/** Call with the root Db, never a transaction-scoped Db or inside an outer
 * transaction. Await this function before provider HTTP so its marker has
 * committed; nested Db transactions reuse their parent and cannot guarantee it.
 * The current user message is
 * the precise boundary on web/regeneration. Device turns are not persisted
 * yet: omitting it conservatively also excludes the previous user turn.
 * Unknown, shared, archived or inaccessible conversations fail closed.
 */
export async function markProviderContent(
  db: Db, userId: string, conversationId: string, messageId?: string,
): Promise<void> {
  await withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ id: unknown }>(
      `UPDATE bob.conversations c
       SET memory_provider_from_position = least(c.memory_provider_from_position,
         coalesce((SELECT ${messageId === undefined ? 'max(m.position)' : 'm.position'}
           FROM bob.messages m WHERE m.conversation_id = c.id AND m.user_id = $1
           AND m.role = 'user' ${messageId === undefined ? '' : 'AND m.id = $3'}), 0))
       WHERE c.id = $2 AND c.user_id = $1 AND c.archived_at IS NULL
         AND EXISTS (SELECT 1 FROM bob.spaces s
           WHERE s.id = c.space_id AND s.kind = 'private' AND s.archived_at IS NULL)
         ${messageId === undefined ? '' : `AND EXISTS (SELECT 1 FROM bob.messages m
           WHERE m.id = $3 AND m.conversation_id = c.id AND m.user_id = $1 AND m.role = 'user')`}
       RETURNING c.id`,
      messageId === undefined ? [userId, conversationId] : [userId, conversationId, messageId],
    );
    if (rows.length !== 1) throw new Error('provider_content_scope_unavailable');
  });
}

/** Read on every extraction attempt, including startup scans; selected reply
 * versions and tool-part persistence cannot remove the conversation marker.
 * Missing schema/query failures propagate, so the worker retries without
 * passing potentially external content to the extractor.
 */
export async function isProviderContentTurn(
  db: Db, userId: string, turn: { conversationId: string; messageId: string },
): Promise<boolean> {
  const rows = await withUser(db, userId, (tx) => tx.query<{ excluded: unknown }>(
    `SELECT coalesce(m.position >= c.memory_provider_from_position, false) AS excluded
     FROM bob.conversations c JOIN bob.messages m ON m.conversation_id = c.id
     WHERE c.id = $2 AND c.user_id = $1 AND m.id = $3 AND m.user_id = $1`,
    [userId, turn.conversationId, turn.messageId],
  ));
  return rows[0]?.excluded !== false;
}
