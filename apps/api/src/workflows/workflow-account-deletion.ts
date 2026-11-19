/**
 * Workflow: self-service account deletion (DELETE /api/account).
 * Trigger: DELETE /api/account route in account/http.ts, after the session check.
 * Steps:
 *   1. Check which account tables exist, once, before any erasure.
 *   2. Email `account-deleted` while the address can still be resolved (best-effort).
 *   3. Erase the account's reach; refused while the user still owns groups.
 *   4. Best-effort revoke every connected Google account's provider token.
 *   5. Purge the account's own content outside spaces, and its notifications.
 *   6. Revoke every device and close its live sessions (WS code 4003).
 * Outcome: deleted when every step ran. owns_groups when erasure is refused (the
 *   email in step 2 has already gone, and nothing was erased). store_error when
 *   the purge after erasure hits a StoreError. Any other error throws to the
 *   caller. Not atomic: each step commits on its own, and every step is
 *   idempotent, so a retry re-runs cleanly and picks up where the first call stopped.
 * Journal: v2.account_deleted, v2.account_deleted_email_failed (module `account`); v2.erasure (step 3, from
 *   account/erasure-service.ts); v2.email_sent, v2.email_skipped, v2.email_send_failed (step 2, from
 *   notifications/email-client.ts).
 */
import { moduleJournal } from '../platform/logger.ts';
import { StoreError, type Db } from '../platform/db/db.ts';
import { eraseAccount, EraseRefusedError } from '../account/erasure-service.ts';
import { recipientEmail, sendTemplateEmail } from '../notifications/email-client.ts';
import { accountTablesPresent, purgeAccountContent, purgeAccountNotifications } from '../account/store.ts';
import { listGoogleAccounts } from '../integrations/google-store.ts';
import { listDevices } from '../devices/store.ts';
import { PairingNotFoundError, revokeDevice } from '../devices/pairing-store.ts';
import type { createGoogleConnectionService } from '../integrations/google-connection-service.ts';
import { type DeviceSessions } from '../voice/device-sessions.ts';

const journal = moduleJournal('account');

export interface AccountDeletionDeps {
  db: Db;
  googleConnection?: Pick<ReturnType<typeof createGoogleConnectionService>, 'revoke'>;
  deviceSessions: Pick<DeviceSessions, 'closeDevice'>;
  now: () => number;
}

export type AccountDeletionResult =
  | { outcome: 'deleted' }
  | { outcome: 'owns_groups'; count: number }
  | { outcome: 'store_error' };

/** Emails `account-deleted` before erasure removes the address. Never throws. */
async function sendAccountDeleted(db: Db, userId: string): Promise<void> {
  try {
    const to = await recipientEmail(db, userId);
    if (to === null) return;
    await sendTemplateEmail({ template: 'account-deleted', to, data: {} });
  } catch {
    journal('v2.account_deleted_email_failed', {});
  }
}

/** Revokes provider tokens, purges content and revokes devices after erasure;
 *  journals counts only. */
async function purgeAccount(
  db: Db,
  userId: string,
  present: Awaited<ReturnType<typeof accountTablesPresent>>,
  { googleConnection, deviceSessions }: { googleConnection?: Pick<ReturnType<typeof createGoogleConnectionService>, 'revoke'>; deviceSessions: Pick<DeviceSessions, 'closeDevice'> },
): Promise<void> {
  let providerRevokeFailed = 0;
  if (present.googleAccounts) {
    for (const account of await listGoogleAccounts(db, userId)) {
      try {
        if (!googleConnection) throw new Error('google_connection_unavailable');
        await googleConnection.revoke(userId, account.id);
      } catch {
        providerRevokeFailed += 1;
      }
    }
  }
  const purged = await purgeAccountContent(db, userId, present);
  const notifications = await purgeAccountNotifications(db, userId);
  let devicesRevoked = 0;
  for (const device of await listDevices(db, userId)) {
    try {
      await revokeDevice(db, userId, device.id);
    } catch (error) {
      if (!(error instanceof PairingNotFoundError)) throw error;
    }
    deviceSessions.closeDevice(device.id, 4003, 'revoked');
    devicesRevoked += 1;
  }
  journal('v2.account_deleted', {
    conversations: purged.conversations,
    memories: purged.memories,
    google_accounts: purged.google_accounts,
    notification_preferences: purged.notification_preferences,
    notifications,
    devices_revoked: devicesRevoked,
    provider_revoke_failed: providerRevokeFailed,
  });
}

/** Runs the account deletion steps in order and returns the outcome for the trigger to send. */
export async function deleteAccount(
  { db, googleConnection, deviceSessions, now }: AccountDeletionDeps,
  { userId }: { userId: string },
): Promise<AccountDeletionResult> {
  const present = await accountTablesPresent(db);
  await sendAccountDeleted(db, userId);
  try {
    await eraseAccount({ db, userId, now: now() });
  } catch (error) {
    if (error instanceof EraseRefusedError) return { outcome: 'owns_groups', count: error.count };
    throw error;
  }
  try {
    await purgeAccount(db, userId, present, { googleConnection, deviceSessions });
    return { outcome: 'deleted' };
  } catch (error) {
    if (error instanceof StoreError) return { outcome: 'store_error' };
    throw error;
  }
}
