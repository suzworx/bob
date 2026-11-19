/**
 * Workflow: archive a Space, remove a member, or hand a Space's ownership to another member.
 * Trigger: DELETE /api/spaces/:id, DELETE /api/spaces/:id/members/:userId, PUT /api/spaces/:id/owner (spaces/http.ts).
 * Steps: archiveSpace: 1. read whether it was already archived. 2. archive it. 3. journal.
 *          4. email the other members, only on the first archive. 5. clear the members' active pointers.
 *        removeMember: 1. revoke the membership. 2. journal. 3. email the removed member.
 *          4. clear their active pointers.
 *        transferOwner: 1. transfer ownership. 2. journal. 3. email the new owner.
 * Outcome: the store write commits first. Emails and active-pointer clears never fail the request: a
 *   failed clear journals and a stale id is nulled on the next read. Returns the Space (archive, transfer)
 *   or nothing (remove), and the route maps that to its status and body.
 * Journal: v2.space_archived, v2.member_removed, v2.owner_transferred, v2.active_space_clear_failed,
 *   v2.space_email_sent/failed (spaces/emails.ts), and the account bus events active_space.changed
 *   and active.changed.
 */
import { type AccountEvent } from '../account/events-bus.ts';
import { clearActiveThreadInSpace } from '../conversations/active.ts';
import { type Db } from '../platform/db/db.ts';
import { moduleJournal } from '../platform/logger.ts';
import { clearActiveSpaceIf } from '../spaces/active.ts';
import { sendMemberRemoved, sendOwnershipTransferred, sendSpaceArchived } from '../spaces/emails.ts';
import {
  archiveSpace as archiveSpaceRecord,
  getSpace,
  listMembers,
  revokeMember,
  transferOwnership,
  type StoredSpace,
} from '../spaces/store.ts';

const journal = moduleJournal('spaces');

export type AccountEventSink = { publish: (userId: string, event: AccountEvent) => void };

export interface MembershipChangeDeps {
  db: Db;
  events: AccountEventSink;
}

/** Notify affected accounts after commit, even when no active pointer changed. */
export function publishSpaceAccessChange(events: AccountEventSink, spaceId: string, userIds: readonly string[]): void {
  for (const userId of new Set(userIds)) {
    try { events.publish(userId, { type: 'space.access_changed', space_id: spaceId }); }
    catch (error) { journal('v2.space_access_publish_failed', { error: error instanceof Error ? error.name : 'unknown' }); }
  }
}

/**
 * After an archive or a revoke, clears each account's active-Space pointer
 * (and any device thread in this Space) that still names it, telling only the
 * accounts it cleared. Best-effort: a failure is journaled and never fails the
 * request (a stale id is also nulled on the next read).
 */
async function clearActiveSpaces(
  db: Db,
  events: AccountEventSink,
  userIds: readonly string[],
  spaceId: string,
): Promise<void> {
  for (const userId of userIds) {
    try {
      const changedAt = await clearActiveSpaceIf(db, userId, spaceId);
      if (changedAt !== null) {
        events.publish(userId, {
          type: 'active_space.changed', space_id: null, name: null, surface: 'web', changed_at: changedAt,
        });
      }
      const threadClearedAt = await clearActiveThreadInSpace(db, userId, spaceId);
      if (threadClearedAt === null) continue;
      events.publish(userId, {
        type: 'active.changed', conversation_id: null, title: null, surface: 'activate', changed_at: threadClearedAt,
      });
    } catch (error) {
      journal('v2.active_space_clear_failed', {
        space_id: spaceId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

/** Archives a Space for everyone, telling the other members only on the call that archives it. */
export async function archiveSpace(deps: MembershipChangeDeps, input: { actorUserId: string;
  spaceId: string }): Promise<StoredSpace> {
  const { db, events } = deps;
  const { actorUserId: userId, spaceId: id } = input;
  // Archiving is idempotent; only the call that archives it tells the members.
  const wasArchived = (await getSpace(db, userId, id)).archivedAt !== null;
  const { space, invitationsRevoked } = await archiveSpaceRecord(db, userId, id);
  journal('v2.space_archived', { space_id: id, invitations_revoked: invitationsRevoked });
  let memberIds: string[] = [];
  try {
    memberIds = (await listMembers(db, userId, id)).map((member) => member.userId);
  } catch (error) {
    journal('v2.active_space_clear_failed', {
      space_id: id,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
  publishSpaceAccessChange(events, id, memberIds);
  if (!wasArchived) await sendSpaceArchived(db, { actorUserId: userId, space });
  await clearActiveSpaces(db, events, memberIds, id);
  return space;
}

/** Removes a member from a Space. Removing yourself sends no email. */
export async function removeMember(deps: MembershipChangeDeps, input: { actorUserId: string;
  spaceId: string; targetUserId: string }): Promise<void> {
  const { db, events } = deps;
  await revokeMember(db, input.actorUserId, input.spaceId, input.targetUserId);
  publishSpaceAccessChange(events, input.spaceId, [input.targetUserId]);
  journal('v2.member_removed', { space_id: input.spaceId, target_user_id: input.targetUserId });
  await sendMemberRemoved(db, { actorUserId: input.actorUserId, spaceId: input.spaceId,
    removedUserId: input.targetUserId });
  await clearActiveSpaces(db, events, [input.targetUserId], input.spaceId);
}

/** Hands a Space's ownership to another member and tells them. */
export async function transferOwner(deps: MembershipChangeDeps, input: { actorUserId: string;
  spaceId: string; newOwnerUserId: string }): Promise<StoredSpace> {
  const { db, events } = deps;
  const space = await transferOwnership(db, input.actorUserId, input.spaceId, input.newOwnerUserId);
  publishSpaceAccessChange(events, input.spaceId, [input.actorUserId, input.newOwnerUserId]);
  journal('v2.owner_transferred', { space_id: input.spaceId });
  await sendOwnershipTransferred(db, { actorUserId: input.actorUserId, space,
    newOwnerUserId: input.newOwnerUserId });
  return space;
}
