/**
 * Account content purge (G6, issue #143; web-account.ts). Deletes everything
 * the account owns OUTSIDE spaces -- the reach eraseAccount's definer does not
 * touch (core/erasure.ts's module doc lists exactly what it covers). Each
 * table's delete runs under withUser, so RLS scopes it to the caller and the
 * existing per-table delete grant/policy is the only privilege used.
 * messages/message_versions cascade from conversations, action_items from
 * memories (bob_init.sql, memory_init.sql FKs), so deleting the parent row
 * is enough. Idempotent: a second call finds nothing left and returns all
 * zeros.
 *
 * bob.notifications is the one exception (CU-REVIEW-3, G6): it has FORCE RLS
 * and no delete policy, and the SELECT policy that a DELETE...WHERE also
 * applies would hide space-scoped rows once erasure has already revoked the
 * membership. purgeAccountNotifications runs through asServer instead, calling
 * the bob_private.purge_account_notifications definer from
 * supabase/migrations/20260922130000_purge_account_notifications.sql.
 */
import { asServer, StoreError, withUser, type Db } from '../platform/db/db.ts';

/** Counts of the caller's own rows removed; never ids. */
export type PurgedAccountCounts = {
  conversations: number;
  memories: number;
  google_accounts: number;
  notification_preferences: number;
};

/** Which optional per-account tables exist on this database. Not cached (see
 *  memory-available.ts's guard for the cached variant): the caller needs the
 *  live answer on every DELETE /api/account so a migration applied after
 *  process start is seen without a restart. */
export async function accountTablesPresent(db: Db): Promise<{ googleAccounts: boolean; googleConsentAttempts: boolean; memories: boolean }> {
  const rows = await db.query<{ googleAccounts: boolean; googleConsentAttempts: boolean; memories: boolean }>(
    `SELECT to_regclass('bob.google_accounts') IS NOT NULL AS "googleAccounts",
            to_regclass('bob.google_consent_attempts') IS NOT NULL AS "googleConsentAttempts",
            to_regclass('bob.memories') IS NOT NULL AS "memories"`,
  );
  const row = rows[0];
  if (!row) throw new StoreError('accountTablesPresent: no row');
  return { googleAccounts: row.googleAccounts, googleConsentAttempts: row.googleConsentAttempts, memories: row.memories };
}

/** A conversation copied in from a shared space (#756) belongs to the space, not
 *  to its creator: the purge takes only private ones (conversations/space-scope.ts). */
const PRIVATE_CONVERSATIONS =
  "(space_id IS NULL OR space_id IN (SELECT id FROM bob.spaces WHERE kind = 'private'))";

async function deleteOwnRows(tx: Db, userId: string, table: string, scope = 'true'): Promise<number> {
  const rows = await tx.query<{ total: unknown }>(
    `WITH d AS (DELETE FROM ${table} WHERE user_id = $1 AND ${scope} RETURNING 1)
     SELECT COUNT(*)::int AS total FROM d`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new StoreError('deleteOwnRows: no row');
  return Number(row.total);
}

/** Deletes the account's conversations, memories, google_accounts and
 *  notification_preferences in one withUser transaction. `present` skips the
 *  delete (reporting 0) for a table this database does not have; conversations
 *  and notification_preferences are always present and stay unconditional. */
export async function purgeAccountContent(
  db: Db,
  userId: string,
  present: { googleAccounts: boolean; memories: boolean; googleConsentAttempts?: boolean },
): Promise<PurgedAccountCounts> {
  const hasConsent = present.googleConsentAttempts ?? (await accountTablesPresent(db)).googleConsentAttempts;
  return withUser(db, userId, async (tx) => {
    // Serialize with consent finalization: a callback either commits before
    // this purge removes its account or finds its authorization row missing.
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`google-accounts:${userId}`]);
    if (hasConsent) await deleteOwnRows(tx, userId, 'bob.google_consent_attempts');
    // Ask Bob proposals; their audit rows cascade. Erasure keeps the auth row, so the auth.users cascade never fires.
    await deleteOwnRows(tx, userId, 'heybob.xyzroval_proposals');
    const [tools] = await tx.query<{ present: boolean }>("select to_regclass('bob.tool_preferences') is not null as present");
    if (tools?.present) await tx.query('delete from bob.tool_preferences where owner_user_id=$1', [userId]);
    return {
      conversations: await deleteOwnRows(tx, userId, 'bob.conversations', PRIVATE_CONVERSATIONS),
      memories: present.memories ? await deleteOwnRows(tx, userId, 'bob.memories') : 0,
      google_accounts: present.googleAccounts ? await deleteOwnRows(tx, userId, 'bob.google_accounts') : 0,
      notification_preferences: await deleteOwnRows(tx, userId, 'bob.notification_preferences'),
    };
  });
}

/** Deletes every notification addressed to the account, space-scoped or not,
 *  through the bob_private definer (FORCE RLS + no delete policy on
 *  bob.notifications rules out a plain withUser delete). Returns the count
 *  removed. Idempotent: a second call finds nothing left and returns 0. */
export async function purgeAccountNotifications(db: Db, userId: string): Promise<number> {
  const rows = await asServer(db, (server) =>
    server.query<{ total: unknown }>(
      `SELECT bob_private.purge_account_notifications($1::uuid) AS total`,
      [userId],
    ),
  );
  const row = rows[0];
  if (!row) throw new StoreError('purgeAccountNotifications: no row');
  return Number(row.total);
}
