/**
 * The scope of the conversation a device ref names: which space it
 * lives in and that space's kind. Shared-space behaviour keys off `spaceKind`
 * (pair or group), never off the ref's prefix. Runs under withUser(), so RLS
 * decides visibility: a conversation the caller cannot see answers null, the
 * same as an unknown id.
 */
import { withUser, type Db } from '../platform/db/db.ts';
import { parseDeviceRef } from '../devices/conversation-ref.ts';

export type ConversationSpaceKind = 'private' | 'pair' | 'group';

/** A visible conversation's space. spaceId is null for a General row the
 *  append heal has not yet moved into the private space. */
export interface ConversationScope {
  conversationId: string;
  spaceId: string | null;
  spaceKind: ConversationSpaceKind;
  /** The space's name (null for a General row with no space yet). */
  spaceName: string | null;
  spaceArchived: boolean;
  archivedAt: number | null;
  title: string;
}

interface ScopeRow {
  title: unknown;
  spaceId: unknown;
  kind: unknown;
  name: unknown;
  archivedAt: unknown;
  spaceArchived: unknown;
}

const SPACE_KINDS: readonly ConversationSpaceKind[] = ['private', 'pair', 'group'];

/** The scope of the conversation `ref` names, or null when the ref names
 *  nothing or the caller cannot see the conversation or its space. */
export async function getConversationScope(db: Db, userId: string, ref: string): Promise<ConversationScope | null> {
  const parsed = parseDeviceRef(ref);
  if (parsed === null) return null;
  const conversationId = parsed.kind === 'thread' ? parsed.threadId : parsed.conversationId;
  const rows = await withUser(db, userId, (tx) => tx.query<ScopeRow>(
    `SELECT c.title, c.space_id AS "spaceId", s.kind, s.name,
       floor(extract(epoch from c.archived_at) * 1000)::bigint AS "archivedAt",
       s.archived_at IS NOT NULL AS "spaceArchived"
     FROM bob.conversations c
     LEFT JOIN bob.spaces s ON s.id = c.space_id
     WHERE c.id = $1`,
    [conversationId],
  ));
  const row = rows[0];
  if (!row) return null;
  const spaceId = row.spaceId === null || row.spaceId === undefined ? null : String(row.spaceId);
  if (spaceId === null) {
    return { conversationId, spaceId, spaceKind: 'private', spaceName: null, spaceArchived: false, archivedAt: stamp(row.archivedAt), title: String(row.title) };
  }
  // A space the caller cannot see (RLS) hides the conversation too.
  const spaceKind = SPACE_KINDS.find((kind) => kind === row.kind);
  if (spaceKind === undefined) return null;
  return {
    conversationId, spaceId, spaceKind, spaceName: String(row.name), spaceArchived: row.spaceArchived === true,
    archivedAt: stamp(row.archivedAt), title: String(row.title),
  };
}

/** Whether a device turn runs shared: its conversation's space is a pair or
 *  group. A lost or hidden conversation (null scope) stays shared when its ref
 *  named a thread, so it never reads or feeds the account's private memory. */
export function isSharedConversation(ref: string | undefined, scope: ConversationScope | null): boolean {
  if (scope !== null) return scope.spaceKind !== 'private';
  return ref !== undefined && parseDeviceRef(ref)?.kind === 'thread';
}

function stamp(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
