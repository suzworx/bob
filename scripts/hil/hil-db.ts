/*
 * hil-db.ts — the per-run database of a HIL run, on the LOCAL Supabase stack.
 *
 *   tsx scripts/hil/hil-db.ts acquire <name>   creates it; prints its loopback bob_server URL
 *   tsx scripts/hil/hil-db.ts release <name>   drops it
 *
 * acquire copies the migration-complete template the api tests use
 * (apps/api/tests/support/pg-template.ts: built from this checkout's
 * supabase/migrations, never written to the live database) and seeds the dev
 * account's auth.users row (as the stack's admin, through the same definer the
 * tests use), which bob_server cannot insert itself
 * (resolveDevAccount swallows that refusal). rig.mjs names it
 * bob_hil_<runId>, which the tests' leftover cleanup (bob_test_*) never
 * touches, keeps the one URL across server restarts and drops it when the run
 * ends. The URL goes to stdout only, for rig.mjs to hand to the harness; it is
 * never logged.
 */
import { randomUUID } from 'node:crypto';

import { DEV_ACCOUNT_ID } from '../../apps/api/src/account/dev-account.ts';
import { acquireDatabase, adminDatabaseUrl, releaseDatabase, withAdmin } from '../../apps/api/tests/support/pg-template.ts';

const [command, name = ''] = process.argv.slice(2);
if (!/^bob_hil_[a-z0-9_]+$/.test(name) || (command !== 'acquire' && command !== 'release')) {
  console.error('hil-db: usage: hil-db.ts acquire|release bob_hil_<run id>');
  process.exit(2);
}

try {
  if (command === 'release') {
    await releaseDatabase(name);
  } else {
    const { url } = await acquireDatabase(name);
    await withAdmin(await adminDatabaseUrl(name), (sql) =>
      sql`select bob_private.ensure_test_session(${DEV_ACCOUNT_ID}::uuid, ${randomUUID()}::uuid)`);
    process.stdout.write(`${url}\n`);
  }
} catch (error) {
  console.error(`hil-db: ${command} failed (${(error as Error).message}). HIL needs the local Supabase stack: npm run dev:offline, or npx supabase start.`);
  process.exit(1);
}
