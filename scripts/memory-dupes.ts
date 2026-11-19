/**
 * memory:dupes (#758): a read-only drift check for duplicate current memories.
 * Groups each account's current (not superseded) rows by the same normalised
 * content key the `memories_current_content_key_uidx` unique index enforces
 * (supabase/migrations/20261001120000_memories_content_key.sql) and reports
 * any group with more than one row. Counts only -- no content, no account
 * emails. Exits 1 when any duplicate group exists, 0 otherwise.
 *
 * Run with `npm run memory:dupes`. Requires BOB_DATABASE_URL -- the same
 * bob_server production/staging connection `getDb()` would use, which runs
 * under FORCE RLS with no policy of its own (like every other bob_server
 * connection outside withUser). So this reads through the SECURITY DEFINER
 * `bob_private.memory_duplicate_groups()` (the migration above), the same
 * pattern as the startup scan helper -- never a raw cross-account query. This
 * script never writes.
 */
import 'dotenv/config';
import { createPostgresDb, endDb } from '../apps/api/src/platform/db/db.ts';

async function main(): Promise<void> {
  const url = process.env.BOB_DATABASE_URL;
  if (!url) {
    console.error('memory:dupes: BOB_DATABASE_URL is not set.');
    process.exitCode = 2;
    return;
  }
  const db = createPostgresDb(url);
  try {
    const rows = await db.query<{ user_id: string; content_key: string; row_count: number }>(
      `SELECT * FROM bob_private.memory_duplicate_groups()`,
    );
    const accounts = new Set(rows.map((row) => row.user_id)).size;
    const groups = rows.length;
    const extraRows = rows.reduce((sum, row) => sum + (row.row_count - 1), 0);
    console.log(JSON.stringify({ accounts, groups, extra_rows: extraRows }));
    if (groups > 0) process.exitCode = 1;
  } finally {
    await endDb(db);
  }
}

main().catch((error: unknown) => {
  console.error('memory:dupes: failed:', error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
