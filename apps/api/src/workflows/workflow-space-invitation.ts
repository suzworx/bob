/**
 * Workflow: invite a person to a Space, accept an invitation, and tell the inviter it was accepted.
 * Trigger: POST /api/spaces/:id/invitations and POST /api/invitations/:token/accept (spaces/http.ts).
 * Steps: 1. invite: read the Space and refuse when it is archived.
 *        2. invite: create the invitation and journal it.
 *        3. invite: provision the invitee's account (best-effort), then email the accept link.
 *        4. accept: accept the invitation and journal the outcome.
 *        5. accept: when accepted, enqueue the inviter's notification and announce the new member.
 * Outcome: inviteToSpace returns 'archived' with no write when the Space is archived, otherwise the
 *   stored invitation and the raw token (returned once, never logged) plus whether the email went out
 *   and whether an account was created. acceptInvitation returns the store outcome. Email and
 *   notification steps never throw: a failure journals a count and the accept still stands.
 * Journal: v2.invitation_created, v2.invitee_account (emitted by ensureInviteeAccount),
 *   v2.space_email_sent/failed (spaces/emails.ts), v2.invitation_accepted, v2.notifications_enqueued
 *   (with trace 'notifications-enqueued'), v2.notifications_enqueue_failed, and the member-joined
 *   notification from notifications/notify.ts.
 */
import { ensureInviteeAccount } from '../account/provisioning.ts';
import { moduleJournal } from '../platform/logger.ts';
import { type Db } from '../platform/db/db.ts';
import { traceDelivery } from '../platform/observability/delivery-span.ts';
import { notifyMemberJoined } from '../notifications/notify.ts';
import { enqueueNotifications, getPreferences, isMuted } from '../notifications/store.ts';
import { sendSpaceInvite } from '../spaces/emails.ts';
import {
  acceptInvitation as acceptInvitationRecord,
  createInvitation,
  findAcceptedInvitation,
  type StoredInvitation,
} from '../spaces/invitations.ts';
import { getSpace } from '../spaces/store.ts';

const journal = moduleJournal('spaces');

export interface InvitationDeps {
  db: Db;
}

export type InviteOutcome =
  | { kind: 'archived' }
  | {
    kind: 'created';
    invitation: StoredInvitation;
    token: string;
    emailSent: boolean;
    accountCreated: boolean;
  };

/** Invites an email address to a Space. Refuses an archived Space before any write. */
export async function inviteToSpace(deps: InvitationDeps, input: { actorUserId: string; spaceId: string;
  body: { email: string; role: 'admin' | 'member' } }): Promise<InviteOutcome> {
  const { db } = deps;
  const space = await getSpace(db, input.actorUserId, input.spaceId);
  if (space.archivedAt !== null) return { kind: 'archived' };
  const { invitation, token } = await createInvitation(db, input.actorUserId, input.spaceId, input.body);
  // The raw token is returned exactly once and never logged.
  journal('v2.invitation_created', { space_id: input.spaceId, invitation_id: invitation.id });
  // Signups are off, so an address with no account could never sign in to
  // accept: create one first. Best-effort, like the email.
  const provisioned = await ensureInviteeAccount(invitation.invitedEmail);
  // The token stays in the response so the copy-link fallback works
  // whether or not the email went out.
  const emailSent = await sendSpaceInvite(db, {
    actorUserId: input.actorUserId,
    space,
    invitedEmail: invitation.invitedEmail,
    role: invitation.role,
    token,
    expiresAt: invitation.expiresAt,
  });
  return { kind: 'created', invitation, token, emailSent, accountCreated: provisioned === 'created' };
}

/** Accepts an invitation for the caller and returns the store outcome (the route maps it to a status). */
export async function acceptInvitation(deps: InvitationDeps, input: { actorUserId: string;
  token: string }): Promise<string> {
  const outcome = await acceptInvitationRecord(deps.db, input.actorUserId, input.token);
  journal('v2.invitation_accepted', { outcome });
  if (outcome === 'accepted') await notifyInvitationAccepted(deps.db, input.actorUserId, input.token);
  return outcome;
}

/** Enqueues an 'invitation' notification to the inviter once their invitation is
 *  accepted. Pass the RAW Db. Skipped when the inviter muted it. Never throws. */
export async function notifyInvitationAccepted(db: Db, accepterUserId: string,
  token: string): Promise<void> {
  try {
    const row = await findAcceptedInvitation(db, accepterUserId, token);
    if (!row) return;
    const inviter = row.inviterUserId;
    const spaceId = row.spaceId;
    if (inviter === accepterUserId) return;
    const prefs = await getPreferences(db, inviter);
    const muted = isMuted(prefs, { spaceId, threadId: null, type: 'invitation' });
    if (!muted) {
      await enqueueNotifications(db, [{ recipientUserId: inviter, spaceId, type: 'invitation',
        resourceType: 'invitation', resourceId: String(row.id),
        effectKey: `invitation_accepted:${String(row.id)}` }]);
    }
    const fields = { type: 'invitation', count: muted ? 0 : 1, muted: muted ? 1 : 0 };
    await traceDelivery('notifications-enqueued', fields, () => journal('v2.notifications_enqueued', fields));
    await notifyMemberJoined(db, accepterUserId, { id: String(row.id), spaceId, inviterUserId: inviter });
  } catch {
    journal('v2.notifications_enqueue_failed', { type: 'invitation', count: 1 });
  }
}
