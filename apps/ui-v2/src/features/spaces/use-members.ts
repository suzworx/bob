import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth, useSession } from '@/lib/auth/use-session';

/**
 * Membership and invitation data for a space (specs/014, S02/S03; contract
 * apps/api/src/spaces/http.ts). The caller's own role for permission checks
 * lives on the space itself (Space.role from use-spaces.ts), not here.
 *
 * Listing/creating/revoking invitations is owner/admin only on the server
 * (store/invitations.ts): a plain member's invitations fetch 403s. That is
 * never treated as a fatal error here -- only a members-list failure sets
 * `error` -- so a plain member still sees the member list.
 *
 * The invite token is returned by the server exactly once (only a hash is
 * stored); `invite()` hands the raw token back to the caller to display. It
 * is never persisted here and never refetchable.
 */

export type MemberSummary = {
  user_id: string;
  role: string;
  joined_at: number;
  // Additive fields from a parallel task: prefer when present; a member
  // fetched before that lands has neither.
  display_name?: string;
  email?: string;
};

export type InvitationSummary = {
  id: string;
  space_id: string;
  invited_email: string;
  role: string;
  expires_at: number;
  created_at: number;
};

export type InviteRole = 'admin' | 'member';
export type InviteInput = { email: string; role: InviteRole };

/** A created invitation: the one-time token, and whether the server emailed it. */
export type IssuedInvite = { token: string; emailSent: boolean };

type UseMembersResult = {
  members: MemberSummary[];
  invitations: InvitationSummary[];
  loading: boolean;
  error: string | null;
  invite: (input: InviteInput) => Promise<IssuedInvite | null>;
  revokeInvite: (invitationId: string) => Promise<boolean>;
  removeMember: (userId: string) => Promise<boolean>;
  transferOwner: (userId: string) => Promise<boolean>;
  rolePending: boolean;
  changeRole: (userId: string, role: InviteRole) => Promise<boolean>;
};

const LIST_ERROR = 'Members could not be loaded.';
const INVITE_ERROR = 'The invitation could not be sent.';
const REVOKE_ERROR = 'The invitation could not be revoked.';
const REMOVE_ERROR = 'That member could not be removed.';
const TRANSFER_ERROR = 'Ownership could not be transferred.';
const ROLE_ERROR = 'That role could not be changed.';
const LAST_OWNER_ERROR =
  'You own this space. Make someone else the owner before you leave.';
const OWNER_REMOVAL_ERROR = "The owner can't be removed. Transfer ownership first.";
const PRIVATE_LEAVE_ERROR = "You can't leave your private space.";

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === 'string' ? body.error.code : null;
  } catch {
    return null;
  }
}

/**
 * `refreshKey` is the single account-events wake-up channel (mirrors
 * use-tasks.ts): the caller bumps it from its one `useAccountEvents` handler
 * to refetch. This hook never opens a second event stream.
 */
export function useMembers(spaceId: string, refreshKey = 0): UseMembersResult {
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [invitations, setInvitations] = useState<InvitationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rolePending, setRolePending] = useState(false);
  const roleInFlight = useRef(false);
  // Unknown identity (null session) never counts as self.
  const callerId = useSession().session?.user.id ?? null;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const membersResponse = await fetchWithAuth(`/api/spaces/${spaceId}/members`);
      if (!membersResponse.ok) throw new Error('list_failed');
      const membersBody = (await membersResponse.json()) as { members: MemberSummary[] };
      // Defensive: an unexpected body shape (never a real server response, but
      // possible against a test double or a future contract drift) never
      // crashes the render -- it degrades to an empty list instead.
      setMembers(Array.isArray(membersBody.members) ? membersBody.members : []);
      setError(null);
    } catch {
      setError(LIST_ERROR);
      setLoading(false);
      return;
    }
    try {
      const invitationsResponse = await fetchWithAuth(`/api/spaces/${spaceId}/invitations`);
      if (!invitationsResponse.ok) throw new Error('invitations_failed');
      const invitationsBody = (await invitationsResponse.json()) as {
        invitations: InvitationSummary[];
      };
      setInvitations(Array.isArray(invitationsBody.invitations) ? invitationsBody.invitations : []);
    } catch {
      // Expected for a plain member (403); never surfaces as a page error.
      setInvitations([]);
    }
    setLoading(false);
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const invite = useCallback(
    async (input: InviteInput): Promise<IssuedInvite | null> => {
      setError(null);
      try {
        const response = await fetchWithAuth(`/api/spaces/${spaceId}/invitations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!response.ok) throw new Error('invite_failed');
        const created = (await response.json()) as {
          invitation: InvitationSummary;
          token: string;
          email_sent?: unknown;
        };
        setInvitations((prev) => [created.invitation, ...prev]);
        // Only an explicit true claims delivery; false or missing keeps the link fallback.
        return { token: created.token, emailSent: created.email_sent === true };
      } catch {
        setError(INVITE_ERROR);
        return null;
      }
    },
    [spaceId],
  );

  const revokeInvite = useCallback(async (invitationId: string): Promise<boolean> => {
    setError(null);
    try {
      const response = await fetchWithAuth(`/api/invitations/${invitationId}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('revoke_failed');
      setInvitations((prev) => prev.filter((invitation) => invitation.id !== invitationId));
      return true;
    } catch {
      setError(REVOKE_ERROR);
      return false;
    }
  }, []);

  const removeMember = useCallback(
    async (userId: string): Promise<boolean> => {
      setError(null);
      try {
        const response = await fetchWithAuth(`/api/spaces/${spaceId}/members/${userId}`, {
          method: 'DELETE',
        });
        if (!response.ok) {
          const code = await errorCode(response);
          if (code === 'last_owner') {
            setError(callerId !== null && userId === callerId ? LAST_OWNER_ERROR : OWNER_REMOVAL_ERROR);
          }
          else if (code === 'private_space') setError(PRIVATE_LEAVE_ERROR);
          else setError(REMOVE_ERROR);
          return false;
        }
        setMembers((prev) => prev.filter((member) => member.user_id !== userId));
        return true;
      } catch {
        setError(REMOVE_ERROR);
        return false;
      }
    },
    [spaceId, callerId],
  );

  const transferOwner = useCallback(
    async (userId: string): Promise<boolean> => {
      setError(null);
      try {
        const response = await fetchWithAuth(`/api/spaces/${spaceId}/owner`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId }),
        });
        if (!response.ok) throw new Error('transfer_failed');
        await load();
        return true;
      } catch {
        setError(TRANSFER_ERROR);
        return false;
      }
    },
    [spaceId, load],
  );

  const changeRole = useCallback(
    async (userId: string, role: InviteRole): Promise<boolean> => {
      // A ref, not state: a second click in the same tick must see the guard.
      if (roleInFlight.current) return false;
      roleInFlight.current = true;
      setRolePending(true);
      setError(null);
      try {
        const response = await fetchWithAuth(`/api/spaces/${spaceId}/members/${userId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role }),
        });
        if (!response.ok) throw new Error('role_failed');
        await load();
        return true;
      } catch {
        setError(ROLE_ERROR);
        return false;
      } finally {
        roleInFlight.current = false;
        setRolePending(false);
      }
    },
    [spaceId, load],
  );

  return {
    members,
    invitations,
    loading,
    error,
    rolePending,
    invite,
    revokeInvite,
    removeMember,
    transferOwner,
    changeRole,
  };
}
