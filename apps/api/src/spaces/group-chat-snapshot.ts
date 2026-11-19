import { StoreConflictError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { DECODED_PARTS } from '../conversations/store.ts';
import { jsonbParam } from '../platform/db/jsonb.ts';

export class UnsupportedGroupHistoryError extends StoreConflictError {
  constructor() {
    super('Choose text-only history to leave unsupported content in your private chat.');
    this.name = 'UnsupportedGroupHistoryError';
  }
}

type SnapshotMessage = { role: string; parts: unknown; created_at: number };
type Snapshot = { title: string; messages: SnapshotMessage[] };

/** One SQL statement snapshots selected visible versions consistently, even while
 * the original is being edited. The caller's private source is never mutated. */
export async function readGroupSnapshot(tx: Db, userId: string, sourceId?: string): Promise<Snapshot> {
  if (sourceId === undefined) return { title: 'Chat', messages: [] };
  const rows = await tx.query<Snapshot>(
    `SELECT c.title, COALESCE((SELECT jsonb_agg(jsonb_build_object(
       'role', m.role, 'parts', v.parts,
       'created_at', floor(extract(epoch from m.created_at) * 1000)::bigint) ORDER BY m.position)
     FROM bob.messages m
     JOIN LATERAL (SELECT ${DECODED_PARTS} AS parts FROM bob.message_versions
       WHERE message_id = m.id AND is_selected = true LIMIT 1) v ON true
     WHERE m.conversation_id = c.id AND m.tombstoned_at IS NULL), '[]'::jsonb) AS messages
     FROM bob.conversations c WHERE c.id = $1 AND c.user_id = $2
       AND (c.space_id IS NULL OR c.space_id IN (
         SELECT id FROM bob.spaces WHERE kind = 'private' AND owner_user_id = $2))`,
    [sourceId, userId],
  );
  const source = rows[0];
  if (!source) throw new StoreNotFoundError('conversation not found');
  return { ...source, title: source.title.slice(0, 120) };
}

function visibleText(parts: unknown, textOnly: boolean): { type: 'text'; text: string }[] {
  if (!Array.isArray(parts)) throw new UnsupportedGroupHistoryError();
  const text: { type: 'text'; text: string }[] = [];
  for (const part of parts as unknown[]) {
    if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'text'
        && 'text' in part && typeof part.text === 'string') {
      text.push({ type: 'text', text: part.text });
    } else if (!textOnly) {
      throw new UnsupportedGroupHistoryError();
    }
  }
  return text;
}

export async function copyGroupSnapshot(
  tx: Db, userId: string, chatId: string, spaceId: string, snapshot: Snapshot, textOnly: boolean,
): Promise<void> {
  let position = 0;
  for (const message of snapshot.messages) {
    const parts = visibleText(message.parts, textOnly);
    if (parts.length === 0) continue;
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO bob.messages
        (id, conversation_id, space_id, role, user_id, author_user_id, position, sequence,
         client_message_id, revision, origin, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $6 + 1,
         $7, 1, 'web_text', to_timestamp($8::double precision / 1000), to_timestamp($8::double precision / 1000))
       RETURNING id`,
      [chatId, spaceId, message.role, userId, message.role === 'assistant' ? null : userId,
        position, `snapshot-${chatId}-${position}`, message.created_at],
    );
    const row = rows[0];
    if (!row) throw new StoreNotFoundError('conversation not found');
    await tx.query(
      `INSERT INTO bob.message_versions (message_id, user_id, space_id, parts, version_index, is_selected)
       VALUES ($1, $2, $3, ${jsonbParam('$4')}, 0, true)`,
      [row.id, userId, spaceId, JSON.stringify(parts)],
    );
    position += 1;
  }
  await tx.query('UPDATE bob.conversations SET last_sequence = $2 WHERE id = $1', [chatId, position]);
}
