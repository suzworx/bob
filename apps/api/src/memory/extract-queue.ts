/**
 * The two queries that drive the extraction worker. There is no queue table:
 * the unextracted set is `memory_extracted_at is null` on bob.messages,
 * served by the messages_unextracted_idx partial index.
 */
import { asServer, withUser, type Db } from '../platform/db/db.ts';
import type { MemorySurface } from './store.ts';

export type UnextractedTurn = {
  messageId: string;
  conversationId: string;
  surface: MemorySurface;
  userText: string;
  assistantText: string;
};

/** Concatenated text of every text part. A driver that does not parse jsonb
 *  returns it as a string, so both shapes are accepted. */
function partsText(parts: unknown): string {
  let value = parts;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return '';
    }
  }
  if (!Array.isArray(value)) return '';
  let text = '';
  for (const part of value) {
    if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
      const inner = (part as { text?: unknown }).text;
      if (typeof inner === 'string') text += inner;
    }
  }
  return text;
}

function rowToTurn(row: {
  messageId: unknown;
  conversationId: unknown;
  surface: unknown;
  userParts: unknown;
  assistantParts: unknown;
}): UnextractedTurn {
  const surface = row.surface === 'web_voice' || row.surface === 'device' ? row.surface : 'web_text';
  return {
    messageId: String(row.messageId),
    conversationId: String(row.conversationId),
    surface,
    userText: partsText(row.userParts),
    assistantText: partsText(row.assistantParts),
  };
}

/**
 * Oldest first, each paired with the selected version of the first assistant
 * message that follows it before the next user message. A turn whose reply was never persisted is still
 * returned (empty text) so the worker can mark it and move on. Explicitly
 * prepared device turns remain withheld until their finalization or failure.
 */
export async function listUnextracted(
  db: Db,
  userId: string,
  limit: number,
): Promise<UnextractedTurn[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{
      messageId: unknown;
      conversationId: unknown;
      surface: unknown;
      userParts: unknown;
      assistantParts: unknown;
    }>(
      `SELECT u.id AS "messageId",
              u.conversation_id AS "conversationId",
              u.origin AS surface,
              uv.parts AS "userParts",
              av.parts AS "assistantParts"
         FROM bob.messages u
         JOIN bob.message_versions uv
           ON uv.message_id = u.id AND uv.is_selected = true
         LEFT JOIN LATERAL (
           SELECT v.parts
             FROM bob.messages a
             JOIN bob.message_versions v
               ON v.message_id = a.id AND v.is_selected = true
            WHERE a.conversation_id = u.conversation_id
              AND a.role = 'assistant'
              AND a.position > u.position
              AND NOT EXISTS (
                SELECT 1 FROM bob.messages next_user
                 WHERE next_user.conversation_id = u.conversation_id
                   AND next_user.role = 'user'
                   AND next_user.position > u.position
                   AND next_user.position < a.position
              )
            ORDER BY a.position ASC
            LIMIT 1
         ) av ON true
        WHERE u.user_id = $1
          AND u.role = 'user'
          AND u.memory_extracted_at IS NULL
          AND NOT u.device_turn_pending
          -- Private conversations only: a copied space thread is never personal memory.
          AND (u.space_id IS NULL OR u.space_id IN (SELECT id FROM bob.spaces WHERE kind = 'private'))
        ORDER BY u.created_at ASC, u.id ASC
        LIMIT $2`,
      [userId, limit],
    );
    return rows.map(rowToTurn);
  });
}

/**
 * The startup scan: accounts with an unextracted message since `sinceMs`. It
 * is necessarily cross-account, so it runs through the SECURITY DEFINER
 * helper: under FORCE RLS the bob_server connection is nobypassrls, and a
 * direct scan silently returns zero rows. Without the helper (an unmigrated
 * database) it answers an empty list, so boot never fails.
 */
export async function listAccountsWithUnextracted(
  db: Db,
  sinceMs: number,
  limit: number,
): Promise<Array<{ userId: string }>> {
  let rows: Array<{ userId: unknown }>;
  try {
    rows = await asServer(db, (server) =>
      server.query<{ userId: unknown }>(
        `SELECT o.user_id AS "userId"
           FROM bob_private.accounts_with_unextracted(
                  to_timestamp($1 / 1000.0), $2
                ) o
          ORDER BY o.user_id ASC`,
        [sinceMs, limit],
      ),
    );
  } catch {
    return [];
  }
  return rows.map((row) => ({ userId: String(row.userId) }));
}
