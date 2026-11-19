/**
 * Policy coverage guard (issue #116, S14-ISOMATRIX). Runs in the DEFAULT gate
 * (`npm run validate`), not the live `test:db` gate: the per-file test database
 * carries the same migrations under supabase/migrations/, so this file can prove, on every
 * domain table in schema `bob`, that row-level security is ENABLED and FORCED
 * and that at least one policy exists -- unless the table is declared
 * SERVER_ONLY below. A new domain table cannot ship by omission: a table that
 * is neither policied nor allowlisted fails this test by name.
 *
 * This is deliberately a structural guard, weaker than the four-account matrix
 * in isolation-matrix.db.test.ts (specs/014-family-collaboration/STATUS.md,
 * trap 1). It proves policy
 * EXISTENCE, not policy CORRECTNESS -- the matrix proves the latter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, createTestDb, type TestDb } from './support/test-db.ts';

/**
 * Tables in schema `bob` that are legitimately server-only: RLS is forced and
 * there are NO account-facing policies by design. Each entry maps the table to
 * the reason, so a table that silently loses its policy -- or a policy-less
 * table that gains account meaning -- fails loudly rather than passing by
 * omission. The honesty test below re-checks every entry.
 */
const SERVER_ONLY = new Map<string, string>([
  ['outbox', 'server-only queue: no user-facing policy by design (#119)'],
  ['turn_metrics', 'server-only metrics: no identity or text, written and purged only through bob_private definers (analytics)'],
  ['user_scopes', 'server-only permission scopes: read and written only through bob_private definers'],
  ['firmware_releases', 'server-only OTA release catalogue: read and written only through bob_private definers'],
  ['firmware_images', 'server-only OTA image bytes: read and written only through bob_private definers'],
  ['firmware_channels', 'server-only OTA channel pointers and halt flags: read and written only through bob_private definers'],
  ['firmware_events', 'server-only OTA offer and result events: read and written only through bob_private definers'],
  [
    'pairing_requests',
    'server-only pairing queue: authenticated sees nothing here (bob_init 3.6)',
  ],
  [
    'waitlist',
    'server-only marketing list: no account exists to policy against -- joining the ' +
      'waitlist deliberately creates no auth.users row (invite-only, see ' +
      'scripts/invite-only.test.ts), so there is no auth.uid() to key on. Reached ' +
      'only by public.waitlist_begin / waitlist_confirm, definers granted to ' +
      'service_role alone (waitlist_init)',
  ],
]);

/** One table's RLS posture read back from the catalog. */
interface TableRls {
  name: string;
  enabled: boolean;
  forced: boolean;
  policyCount: number;
}

describe('policy coverage guard', () => {
  let pg: TestDb;

  beforeAll(async () => {
    pg = await createTestDb();
  });

  afterAll(async () => {
    await closeTestDb(pg).catch(() => undefined);
  });

  /** Every base table in schema bob, from the catalog. */
  async function domainTables(): Promise<string[]> {
    const result = await pg.query<{ name: string }>(
      `select c.relname as "name"
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'bob' and c.relkind = 'r'
       order by c.relname`,
    );
    return result.rows.map((row) => row.name);
  }

  /** RLS flags and policy count for one table. */
  async function rlsFor(table: string): Promise<TableRls> {
    const flags = await pg.query<{ enabled: boolean; forced: boolean }>(
      `select c.relrowsecurity as enabled, c.relforcerowsecurity as forced
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'bob' and c.relname = $1`,
      [table],
    );
    const count = await pg.query<{ total: number }>(
      `select count(*)::int as total
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'bob' and c.relname = $1`,
      [table],
    );
    const row = flags.rows[0]!;
    return {
      name: table,
      enabled: row.enabled,
      forced: row.forced,
      policyCount: count.rows[0]!.total,
    };
  }

  it('every bob domain table has RLS enabled and forced', async () => {
    const tables = await domainTables();
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const rls = await rlsFor(table);
      expect(rls.enabled, `${table}: RLS must be ENABLED`).toBe(true);
      expect(rls.forced, `${table}: RLS must be FORCED`).toBe(true);
    }
  });

  it('every bob domain table has a policy or a SERVER_ONLY reason', async () => {
    const tables = await domainTables();
    const failures: string[] = [];
    for (const table of tables) {
      const rls = await rlsFor(table);
      if (rls.policyCount === 0 && !SERVER_ONLY.has(table)) {
        failures.push(
          `${table}: no policy and no SERVER_ONLY entry -- a new domain table cannot ship by omission`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('the SERVER_ONLY allowlist is honest: every entry exists, is forced, and has zero policies', async () => {
    const tables = await domainTables();
    for (const [table, reason] of SERVER_ONLY) {
      expect(tables, `allowlisted table ${table} must exist (${reason})`).toContain(table);
      const rls = await rlsFor(table);
      expect(rls.enabled, `${table}: allowlisted table must have RLS enabled`).toBe(true);
      expect(rls.forced, `${table}: allowlisted table must have RLS forced`).toBe(true);
      expect(rls.policyCount, `${table}: allowlisted table must have zero policies (${reason})`).toBe(0);
    }
  });
});