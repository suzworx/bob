/**
 * Erasure data access (S14-ERASURE, issue #143, specs/014-family-collaboration/
 * data-model.md "Authorization and revocation contract" and "Retention, migration
 * and portability"; S14-PG-ERASURE). Erasure is inherently cross-user and
 * privileged (it rewrites other people's authorship, revokes memberships,
 * touches auth.users), so it follows the established shape for every such
 * operation in this repo: a SECURITY DEFINER function in bob_private,
 * called through asServer (see pairing.ts, invitations.ts, outbox.ts).
 *
 * A bare bob_server transaction cannot do this work at all: the guard query
 * below would see zero rows under FORCE RLS (bob_server is nobypassrls),
 * and the auth.users insert is refused outright. The migration
 * (supabase/migrations/20260918000000_erase_account_definer.sql) runs the
 * whole thing -- guard, sentinel insert, anonymize, clear, delete, revoke,
 * invalidate -- as one atomic call as the definer, who bypasses the lock.
 *
 * The current definer body is supabase/migrations/20260926140100_erasure_gaps.sql
 * (#513): it also anonymizes group reminders, calendars, events, AI
 * invocations, publications and invitations, hands a co-owned group to another
 * owner, and clears timers, device settings, the active space and
 * conversation, reminder recipients/occurrences and event attendance. The
 * five counts are unchanged; the new rows fold into `anonymized` and
 * `assignmentsCleared`. tests/account/erasure-gaps.db.test.ts fails when a new
 * bob.* column referencing auth.users is handled by nothing.
 */
import { asServer, type Db } from '../platform/db/db.ts';

/** The named refusal for criterion 3: an owner who still solely owns a group
 *  must transfer or delete it first. The migration raises this as SQLSTATE
 *  'OX001' with the count in DETAIL; nothing else uses that code. */
export const ERASE_REFUSED_SQLSTATE = 'OX001';

/** The raw row bob_private.erase_account returns (columns already aliased
 *  to match EraseResult). */
type EraseAccountRow = {
  anonymized: unknown;
  assignmentsCleared: unknown;
  privateSpacesDeleted: unknown;
  membershipsRevoked: unknown;
  jobsInvalidated: unknown;
};

/** The five erasure counts, as returned by the definer. */
type EraseAccountCounts = {
  anonymized: number;
  assignmentsCleared: number;
  privateSpacesDeleted: number;
  membershipsRevoked: number;
  jobsInvalidated: number;
};

/**
 * Runs the whole erasure as one call to bob_private.erase_account. Throws
 * whatever the definer raises (a plain error whose `code` is
 * ERASE_REFUSED_SQLSTATE and whose `detail` is the owned-group count, for the
 * refusal case) -- the core maps that back to EraseRefusedError.
 */
export async function eraseAccountRow(db: Db, userId: string, now: number): Promise<EraseAccountCounts> {
  // One transaction: the games purge (game_sessions, game_settings and
  // game_usage, epic #460 G2), the email effects purge (#545) and the user
  // scopes purge (the auth row is kept, so its cascade never fires) commit only
  // with the erasure they belong to.
  const rows = await db.tx((tx) =>
    // The owner lock (salt 1225, the Marketing installation key) is taken first, on the same transaction, so a queued
    // installation re-checks its session only after this erasure commits and revokes it. asServer's guard only allows
    // bob_private SQL, so the lock runs on the raw transaction and the server view nests inside it.
    tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1225))', [userId]).then(() =>
      asServer(tx, (server) =>
        server.tx(async (inner) => {
          // Shared writes never take the personal owner fence. Hold the same
          // audience rows they use before revoking membership or purging work.
          await inner.query('SELECT bob_private.lock_account_app_audiences($1::uuid)', [userId]);
          await inner.query('SELECT bob_private.purge_closed_group_chats($1::uuid)', [userId]);
          const erased = await inner.query<EraseAccountRow>(
            `SELECT * FROM bob_private.erase_account($1::uuid, $2::timestamptz)`,
            [userId, new Date(now)],
          );
          await inner.query(`SELECT bob_private.purge_account_games($1::uuid)`, [userId]);
          await inner.query(`SELECT bob_private.purge_account_email_effects($1::uuid)`, [userId]);
          await inner.query('SELECT bob_private.purge_account_push($1::uuid)', [userId]);
          await inner.query('SELECT bob_private.purge_account_google_native($1::uuid)', [userId]);
          await inner.query(`SELECT bob_private.purge_account_scopes($1::uuid)`, [userId]);
          await inner.query(`SELECT bob_private.purge_account_group_chats($1::uuid)`, [userId]);
          await inner.query('SELECT bob_private.purge_bob_apps($1::uuid)', [userId]);
          return erased;
        }),
      ),
    ),
  );
  const row = rows[0]!;
  return {
    anonymized: Number(row.anonymized),
    assignmentsCleared: Number(row.assignmentsCleared),
    privateSpacesDeleted: Number(row.privateSpacesDeleted),
    membershipsRevoked: Number(row.membershipsRevoked),
    jobsInvalidated: Number(row.jobsInvalidated),
  };
}
