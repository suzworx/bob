/**
 * A device's Recent list: the turns one paired device spoke, newest first,
 * plus the account's timers that fired in the same window (scope 'account':
 * a timer rings every device, so it is never claimed for this one). RLS scopes
 * every row and the owner filters are kept too, so another account's device
 * id lists nothing. The route journals the count only.
 */
import { withUser, type Db } from '../platform/db/db.ts';
import { DEVICE_ACTIVITY_MAX, HEARD_EXCERPT_MAX } from './schemas.ts';

type TurnItem =
  | { kind: 'turn'; at: number; title: string; heard_excerpt: string; conversation_id: string }
  | { kind: 'turn'; at: number; title: string; heard_excerpt: string; thread_id: string; space_id: string };
type TimerItem = { kind: 'timer'; at: number; label: string | null; status: 'fired' | 'dismissed'; scope: 'account' };
type DeviceActivityItem = TurnItem | TimerItem;

const ms = (value: unknown): number => new Date(value as string | Date).getTime();

/** The user's words, whitespace folded, cut to HEARD_EXCERPT_MAX with an ellipsis. */
function heardExcerpt(text: string): string {
  const folded = text.replace(/\s+/g, ' ').trim();
  if (folded.length <= HEARD_EXCERPT_MAX) return folded;
  return `${folded.slice(0, HEARD_EXCERPT_MAX - 1).trimEnd()}…`;
}

/** The text parts of a stored version, joined (a file part says nothing here). */
function partsText(stored: unknown): string {
  const parts: unknown = typeof stored === 'string' ? JSON.parse(stored) : stored;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
      ? String((part as { text?: unknown }).text ?? '') : ''))
    .join(' ');
}

/** The caller has already proved the device is theirs. Timers are read from
 *  the oldest listed turn on, so a page never mixes in older timers. */
export async function listDeviceActivity(
  db: Db,
  userId: string,
  device: { id: string; pairedAt: number },
  limit: number,
): Promise<DeviceActivityItem[]> {
  const take = Math.min(Math.max(1, Math.trunc(limit)), DEVICE_ACTIVITY_MAX);
  return withUser(db, userId, async (tx) => {
    const general = await tx.query<{ conversationId: unknown; createdAt: unknown; title: unknown; parts: unknown }>(
      `SELECT m.conversation_id AS "conversationId", m.created_at AS "createdAt", c.title,
              (SELECT v.parts FROM bob.message_versions v
                WHERE v.message_id = m.id ORDER BY v.is_selected DESC, v.version_index LIMIT 1) AS parts
         FROM bob.messages m JOIN bob.conversations c ON c.id = m.conversation_id
        WHERE m.device_id = $1 AND m.user_id = $2 AND m.role = 'user'
          AND (c.space_id IS NULL OR c.space_id IN (SELECT id FROM bob.spaces WHERE kind = 'private'))
        ORDER BY m.created_at DESC LIMIT $3`,
      [device.id, userId, take],
    );
    const threads = await tx.query<{ threadId: unknown; spaceId: unknown; createdAt: unknown; title: unknown; parts: unknown }>(
      `SELECT m.conversation_id AS "threadId", m.space_id AS "spaceId", m.created_at AS "createdAt", c.title,
              (SELECT v.parts FROM bob.message_versions v
                WHERE v.message_id = m.id ORDER BY v.is_selected DESC, v.version_index DESC LIMIT 1) AS parts
         FROM bob.messages m JOIN bob.conversations c ON c.id = m.conversation_id
        WHERE m.device_id = $1 AND m.author_user_id = $2 AND m.tombstoned_at IS NULL
          AND c.space_id IN (SELECT id FROM bob.spaces WHERE kind <> 'private')
        ORDER BY m.created_at DESC LIMIT $3`,
      [device.id, userId, take],
    );
    const turns: TurnItem[] = [
      ...general.map((row): TurnItem => ({
        kind: 'turn', at: ms(row.createdAt), title: String(row.title),
        heard_excerpt: heardExcerpt(partsText(row.parts)), conversation_id: String(row.conversationId),
      })),
      ...threads.map((row): TurnItem => ({
        kind: 'turn', at: ms(row.createdAt), title: String(row.title),
        heard_excerpt: heardExcerpt(partsText(row.parts)), thread_id: String(row.threadId), space_id: String(row.spaceId),
      })),
    ].sort((a, b) => b.at - a.at).slice(0, take);
    const oldest = turns.length === take ? turns[turns.length - 1]?.at ?? device.pairedAt : device.pairedAt;
    const since = Math.max(oldest, device.pairedAt);
    const fired = await tx.query<{ label: unknown; status: unknown; firedAt: unknown }>(
      `SELECT title AS label, status, fired_at AS "firedAt" FROM bob.reminders
        WHERE created_by = $1 AND kind <> 'reminder' AND status IN ('fired', 'dismissed') AND fired_at IS NOT NULL
          AND fired_at >= to_timestamp($2 / 1000.0)
        ORDER BY fired_at DESC LIMIT $3`,
      [userId, since, take],
    );
    const timers = fired.map((row): TimerItem => ({
      kind: 'timer', at: ms(row.firedAt), label: row.label === null ? null : String(row.label),
      status: row.status === 'dismissed' ? 'dismissed' : 'fired', scope: 'account',
    }));
    return [...turns, ...timers].sort((a, b) => b.at - a.at).slice(0, take);
  });
}
