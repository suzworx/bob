import type { Db } from '../platform/db/db.ts';
import { ensureInviteeAccount } from '../account/provisioning.ts';
import { appUrl, emailConfigured, sendTemplateEmail } from '../notifications/email-client.ts';
import { createGroupChatLink, getGroupChat, listGroupChatMembers } from './group-chat-store.ts';

export class ChatEmailUnavailableError extends Error {}
export class ChatEmailSendError extends Error {}

/** Delivery uses an ordinary expiring link. A provider timeout can be ambiguous,
 * so failed delivery never claims success and does not revoke existing links. */
export async function sendChatInvitation(db: Db, userId: string, chatId: string, email: string): Promise<void> {
  const chat = await getGroupChat(db, userId, chatId);
  if (!emailConfigured()) throw new ChatEmailUnavailableError();
  // Signups are disabled: provision sign-in access, never chat membership.
  const provisioned = await ensureInviteeAccount(email);
  if (provisioned === 'skipped') throw new ChatEmailUnavailableError();
  if (provisioned === 'failed') throw new ChatEmailSendError();
  const members = await listGroupChatMembers(db, userId, chatId);
  const inviterName = members.find((member) => member.user_id === userId)?.display_name ?? 'Someone';
  const link = await createGroupChatLink(db, userId, chatId);
  try {
    await sendTemplateEmail({
      template: 'chat-invite', to: email,
      data: { inviterName, chatName: chat.title, acceptUrl: appUrl(`/join-chat/${link.token}`),
        expiresLabel: new Date(link.expires_at).toUTCString() },
    });
  } catch {
    throw new ChatEmailSendError();
  }
}
