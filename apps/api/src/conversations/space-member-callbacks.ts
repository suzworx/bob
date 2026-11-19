/**
 * SpaceMemberCallbacks (list_space_members), shared by the device turn (voice/turn/tools.ts) and the
 * invocation service. Its own file because tasks/agent-callbacks.ts imports invocations-service.ts.
 */
import type { SpaceMemberCallbacks } from '@bob/ai';
import { listMembers } from '../spaces/store.ts';
import { type Db } from '../platform/db/db.ts';

/** listMembers runs under
 *  the caller's RLS and refuses anyone who is not an active member with the
 *  same "space not found" as a missing space; only name, handle, role and
 *  whether the member is the caller leave here, never an email or user id. */
export function bindSpaceMemberCallbacks(db: Db, userId: string, spaceId: string): SpaceMemberCallbacks {
  return {
    async listSpaceMembers() {
      const members = await listMembers(db, userId, spaceId);
      return members.map((member) => ({
        name: member.displayName,
        handle: member.handle,
        role: member.role,
        isYou: member.userId === userId,
      }));
    },
  };
}
