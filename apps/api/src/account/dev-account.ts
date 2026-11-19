/**
 * The temporary fixed dev account (T008, specs/008-supabase-auth-pairing).
 *
 * Until US1 lands (T012 scopes web routes to req.account and T018 binds the
 * device to a real identity) every session and web route acts as one fixed
 * account, so all rows it touches carry a user_id and RLS has something to
 * enforce. This module is the single place that account is resolved, and it
 * MUST throw under BOB_PRODUCTION=1: a shared account in production would
 * put every deployment's conversations under one owner.
 */
import type { Db } from '../platform/db/db.ts';

/** The fixed uuid every dev-mode session and web route acts as. */
export const DEV_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

/** Hosts that reach only this machine (auth.ts isLoopbackHost reads it too). */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * True when the database is on this machine: an BOB_DATABASE_URL whose host
 * is loopback (the local Supabase stack). System-test sign-in and the dev
 * account create auth.users rows for any id they are given, so they run only
 * here; a dev .env naming the hosted pooler once filled production with
 * email-less accounts. An unset, empty or unparseable URL is not local: no
 * database is not a local one (the server refuses to boot without a URL). Lives here, not in
 * auth.ts, so importing it never loads @bob/ai (its stub flag is read once
 * at import, and tests set BOB_SYSTEM_TEST after importing this module).
 */
export function usesLocalDatabase(env: Record<string, string | undefined>): boolean {
  const url = env.BOB_DATABASE_URL;
  if (!url) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.replace(/^\[(.*)\]$/, '$1'));
  } catch {
    return false;
  }
}

/**
 * Returns the dev account id, ensuring its auth.users row exists (system-test
 * / local stack only — the auth.users FK on every bob row needs it).
 *
 * The insert runs on the base connection (not withUser): under the guard-role
 * tests the connection is bob_server, which has no INSERT grant on
 * auth.users, and the row was already created by the test setup before the
 * role switch — so a refused insert is expected there. A real store outage is
 * surfaced by the caller's next store call (every caller already degrades).
 * aud/role are GoTrue's defaults and every token column is set to '' because
 * GoTrue scans them into non-nullable strings and a NULL breaks
 * /auth/v1/admin/users for the whole project (S14-DEVAUTH-FIX).
 */
export async function resolveDevAccount(db: Db): Promise<string> {
  if (process.env.BOB_PRODUCTION === '1') {
    throw new Error('resolveDevAccount: the shared dev account is forbidden in production');
  }
  if (!usesLocalDatabase(process.env)) {
    throw new Error('resolveDevAccount: the shared dev account needs a local database (a loopback BOB_DATABASE_URL)');
  }
  try {
    await db.query(
      `insert into auth.users (
         id, aud, role, confirmation_token, recovery_token, email_change,
         email_change_token_new, email_change_token_current, phone_change,
         phone_change_token, reauthentication_token
       ) values (
         $1, 'authenticated', 'authenticated', '', '', '', '', '', '', '', ''
       ) on conflict (id) do nothing`,
      [DEV_ACCOUNT_ID],
    );
  } catch {
    // falls through — see doc comment above
  }
  return DEV_ACCOUNT_ID;
}