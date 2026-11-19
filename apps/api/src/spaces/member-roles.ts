/**
 * Owner-only role changes for an existing member of an active group.
 *
 * Authorization lives here, not in RLS: the memberships UPDATE policy also lets
 * an admin through, so the caller's role is checked explicitly. The space row
 * is locked FOR UPDATE (the row transferOwnership also writes), then the
 * caller's role is read again, so a concurrent ownership transfer cannot let a
 * stale owner change roles. The owner role is never granted or removed here.
 */
import { StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { StoreForbiddenError } from './invitations.ts';
import { SpaceRuleError } from './store.ts';

export type ManagedRole = 'admin' | 'member';

async function roleOf(tx: Db, spaceId: string, userId: string): Promise<string | undefined> {
  const rows = await tx.query<{ role: unknown }>(
    `SELECT m.role FROM bob.space_memberships m
     WHERE m.space_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL`,
    [spaceId, userId],
  );
  return rows[0] === undefined ? undefined : String(rows[0].role);
}

/**
 * Sets an active non-owner member's role to admin or member. Same-role is a
 * no-op (no revision bump). Returns true when the role actually changed.
 * Outsider and missing space: StoreNotFoundError. Non-owner caller:
 * StoreForbiddenError. Owner target: StoreForbiddenError.
 */
export async function setMemberRole(
  db: Db,
  userId: string,
  spaceId: string,
  targetUserId: string,
  role: ManagedRole,
): Promise<boolean> {
  return withUser(db, userId, async (tx) => {
    // An outsider and a missing space are the same 404. A visible non-owner is
    // refused before locking: the spaces UPDATE policy would hide the row from
    // their FOR UPDATE, which must not read as a 404.
    const firstRole = await roleOf(tx, spaceId, userId);
    if (firstRole === undefined) throw new StoreNotFoundError('space not found');
    if (firstRole !== 'owner') throw new StoreForbiddenError('only the owner can change member roles');

    await assertOwnerOfLockedGroup(tx, spaceId, userId);

    const targetRole = await roleOf(tx, spaceId, targetUserId);
    if (targetRole === undefined) throw new StoreNotFoundError('member not found');
    if (targetRole === 'owner') throw new StoreForbiddenError('the owner role cannot be changed here');
    if (targetRole === role) return false;

    await writeRole(tx, spaceId, targetUserId, role);
    return true;
  });
}

/**
 * Locks the space row (what archiveSpace and transferOwnership also write),
 * then decides from the locked row and a re-read caller role only. Nothing
 * read before the lock is trusted: an archive or a transfer may have committed.
 */
async function assertOwnerOfLockedGroup(tx: Db, spaceId: string, userId: string): Promise<void> {
  const locked = await tx.query<{ kind: unknown; archivedAt: unknown }>(
    `SELECT s.kind, s.archived_at AS "archivedAt" FROM bob.spaces s WHERE s.id = $1 FOR UPDATE`,
    [spaceId],
  );
  const space = locked[0];
  const lockedRole = await roleOf(tx, spaceId, userId);
  if (lockedRole === undefined) throw new StoreNotFoundError('space not found');
  if (space === undefined || lockedRole !== 'owner') {
    throw new StoreForbiddenError('only the owner can change member roles');
  }
  if (space.kind === 'private') throw new SpaceRuleError('private_space', 'a private space has no other members');
  if (space.kind !== 'group') throw new SpaceRuleError('unsupported_kind', 'only a group has member roles');
  if (space.archivedAt !== null) throw new SpaceRuleError('space_archived', 'an archived space cannot change');
}

/** Writes a non-owner member's role, then bumps the membership revision. */
async function writeRole(tx: Db, spaceId: string, targetUserId: string, role: ManagedRole): Promise<void> {
  const updated = await tx.query<{ id: unknown }>(
    `UPDATE bob.space_memberships SET role = $3
     WHERE space_id = $1 AND user_id = $2 AND revoked_at IS NULL AND role <> 'owner'
     RETURNING id`,
    [spaceId, targetUserId, role],
  );
  if (updated.length === 0) throw new StoreError('member role was not updated');
  await tx.query('select bob_private.bump_membership_revision($1::uuid)', [spaceId]);
}
