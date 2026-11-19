import { asServer, type Db } from '../platform/db/db.ts';
import type { OutboxHandler } from '../platform/outbox/worker.ts';
import {
  emailConfigured,
  EmailSendError,
  sendTemplateEmail,
} from '../notifications/email-client.ts';
import { emailEffectSent, markEmailEffectSent } from '../notifications/store.ts';

export const ADMIN_INVITATION_EVENT = 'email.admininvite';
export type InvitationStatus = 'queued' | 'sent' | 'failed';

/** The account already exists; delivery failure must never roll it back. */
export async function queueAdminInvitation(
  db: Db,
  actorId: string,
  sessionId: string,
  email: string,
  retry: boolean,
): Promise<InvitationStatus> {
  if (!emailConfigured()) return 'failed';
  const rows = await asServer(db, (server) =>
    server.query<{ status: InvitationStatus }>(
      'select bob_private.admin_invitation_queue($1::uuid, $2::uuid, $3::text, $4::boolean) as status',
      [actorId, sessionId, email, retry],
    ),
  );
  return rows[0]?.status ?? 'failed';
}

/** Existing outbox leases serialize delivery; the marker prevents replay after a recorded send. */
export function createAdminInvitationHandler({
  db,
  send = sendTemplateEmail,
  configured = emailConfigured,
}: {
  db: Db;
  send?: typeof sendTemplateEmail;
  configured?: () => boolean;
}): OutboxHandler {
  return async (row) => {
    if (await emailEffectSent(db, row.effectKey)) return;
    const rows = await asServer(db, (server) =>
      server.query<{ email: string | null }>(
        'select bob_private.admin_invitation_recipient($1::uuid) as email',
        [row.resourceId],
      ),
    );
    const email = rows[0]?.email;
    // Missing/banned recipients are acknowledged without a sent marker. Queue status remains failed.
    if (!email) return;
    if (!configured()) throw new EmailSendError('not_configured');
    await send({ template: 'bob-account-invite', to: email, data: {} });
    await markEmailEffectSent(db, row.effectKey, row.resourceId);
  };
}
