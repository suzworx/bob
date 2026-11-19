/** Space membership emails, sent directly (not through the outbox) because
 *  the data must not be persisted (the raw invite token) or the recipient is
 *  losing access. Call AFTER the write commits. Nothing here throws: a failure
 *  journals a template id and a count. Emails carry names, never another
 *  person's address. */
import { moduleJournal } from '../platform/logger.ts';
import { type Db } from '../platform/db/db.ts';
import { appUrl, emailConfigured, recipientEmail, sendTemplateEmail } from '../notifications/email-client.ts';
import { getSpace, listMembers, type SpaceMember, type StoredSpace } from './store.ts';

const journal = moduleJournal('spaces');

const SOMEONE = 'A member';

function memberName(member: SpaceMember | undefined): string {
  if (!member) return SOMEONE;
  return member.displayName ?? `@${member.handle}`;
}

async function members(db: Db, actorUserId: string, spaceId: string): Promise<SpaceMember[]> {
  try { return await listMembers(db, actorUserId, spaceId); } catch { return []; }
}

/** Sends one template to each address; returns how many were accepted. Never throws. */
async function sendAll(template: string, to: ReadonlyArray<string>,
  data: Record<string, unknown>): Promise<number> {
  let sent = 0;
  for (const address of to) {
    try {
      await sendTemplateEmail({ template, to: address, data });
      sent += 1;
    } catch {
      // counted below
    }
  }
  if (sent > 0) journal('v2.space_email_sent', { template, count: sent });
  if (sent < to.length) journal('v2.space_email_failed', { template, count: to.length - sent });
  return sent;
}

function expiresLabel(expiresAt: number): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(expiresAt);
}

/** Emails the invitee their accept link. Returns true when the email was sent. */
export async function sendSpaceInvite(db: Db, input: { actorUserId: string; space: StoredSpace;
  invitedEmail: string; role: string; token: string; expiresAt: number }): Promise<boolean> {
  if (!emailConfigured()) return false;
  try {
    const inviter = (await members(db, input.actorUserId, input.space.id))
      .find((member) => member.userId === input.actorUserId);
    const sent = await sendAll('space-invite', [input.invitedEmail], {
      inviterName: memberName(inviter),
      spaceName: input.space.name,
      spaceKind: input.space.kind,
      role: input.role,
      acceptUrl: appUrl(`/invite/${encodeURIComponent(input.token)}`),
      expiresLabel: expiresLabel(input.expiresAt),
    });
    return sent === 1;
  } catch {
    journal('v2.space_email_failed', { template: 'space-invite', count: 1 });
    return false;
  }
}

/** Tells a removed member who removed them. Self-leave sends nothing. Never throws. */
export async function sendMemberRemoved(db: Db, input: { actorUserId: string; spaceId: string;
  removedUserId: string }): Promise<void> {
  if (!emailConfigured() || input.removedUserId === input.actorUserId) return;
  try {
    const address = await recipientEmail(db, input.removedUserId);
    if (address === null) return;
    const space = await getSpace(db, input.actorUserId, input.spaceId);
    const actor = (await members(db, input.actorUserId, input.spaceId))
      .find((member) => member.userId === input.actorUserId);
    await sendAll('space-member-removed', [address],
      { spaceName: space.name, removedByName: memberName(actor) });
  } catch {
    journal('v2.space_email_failed', { template: 'space-member-removed', count: 1 });
  }
}

/** Tells the new owner they now own the space. Never throws. */
export async function sendOwnershipTransferred(db: Db, input: { actorUserId: string;
  space: StoredSpace; newOwnerUserId: string }): Promise<void> {
  if (!emailConfigured() || input.newOwnerUserId === input.actorUserId) return;
  try {
    const current = await members(db, input.actorUserId, input.space.id);
    const address = await recipientEmail(db, input.newOwnerUserId);
    if (address === null) return;
    await sendAll('space-ownership-transferred', [address], {
      spaceName: input.space.name,
      previousOwnerName: memberName(current.find((member) => member.userId === input.actorUserId)),
      spaceUrl: appUrl(`/spaces/${encodeURIComponent(input.space.id)}`),
    });
  } catch {
    journal('v2.space_email_failed', { template: 'space-ownership-transferred', count: 1 });
  }
}

/** Tells every other member the space was archived. Never throws. */
export async function sendSpaceArchived(db: Db, input: { actorUserId: string;
  space: StoredSpace }): Promise<void> {
  if (!emailConfigured()) return;
  try {
    const current = await members(db, input.actorUserId, input.space.id);
    const actor = current.find((member) => member.userId === input.actorUserId);
    const to = current.filter((member) => member.userId !== input.actorUserId)
      .map((member) => member.email).filter((email): email is string => email !== null);
    await sendAll('space-archived', to,
      { spaceName: input.space.name, archivedByName: memberName(actor) });
  } catch {
    journal('v2.space_email_failed', { template: 'space-archived', count: 1 });
  }
}
