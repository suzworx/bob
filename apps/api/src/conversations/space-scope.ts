/**
 * Shared SQL predicates for the one conversation model. Space threads live in
 * bob.conversations/messages too, so a General (private) query must say
 * which rows it means: a row with no space yet (old write path) or one in a
 * private space. Each takes the table alias (or '' for an unqualified column)
 * and is pasted into a WHERE clause.
 */

const column = (alias: string, name: string): string => (alias ? `${alias}.${name}` : name);

/** The row is General's: no space yet, or a private space. RLS lists only the
 *  caller's spaces, so the subquery never reaches another account's. */
function privateScope(alias = ''): string {
  const spaceId = column(alias, 'space_id');
  return `(${spaceId} IS NULL OR ${spaceId} IN (SELECT id FROM bob.spaces WHERE kind = 'private'))`;
}

export const PRIVATE_SCOPE = privateScope();

/** A scalar subquery for the owner's private space id; `owner` is the bind
 *  placeholder of the owner's user id (e.g. '$2'). Null when none exists yet. */
export function ownPrivateSpace(owner: string): string {
  return `(SELECT id FROM bob.spaces WHERE kind = 'private' AND owner_user_id = ${owner})`;
}

/** The row is in a shared (pair or group) space: the complement of
 *  privateScope. The space kind decides, never the shape of the id. Works for
 *  conversations and messages, which both carry space_id. */
export function sharedScope(alias = ''): string {
  return `${column(alias, 'space_id')} IN (SELECT id FROM bob.spaces WHERE kind <> 'private')`;
}

export const SHARED_SCOPE = sharedScope();
