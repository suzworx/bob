// pg-template.test.ts — the template factory's own guarantees (CP-TEST-INFRA).
// Many workers run this suite at once against ONE local Postgres, so the
// template must be keyed by THIS checkout's migrations, built by exactly one
// process at a time, and recover from a builder that died mid-build. These run
// against throwaway `bob_tmplspec_*` databases, never a real template, and
// never import test-db.ts (which would build the real template at load).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adminDatabaseUrl,
  createMigratedDb,
  databaseExists,
  migrationHash,
  publishTemplate,
  withAdmin,
  type PgTestDb,
  type TestDb,
} from './support/pg-template.ts';

describe('migrationHash', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function migrations(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'bob-mig-'));
    dirs.push(dir);
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
    return dir;
  }

  it('is stable for the same files and ignores non-migration files', () => {
    const a = migrations({ '001_a.sql': 'create table a (x int);' });
    const b = migrations({ '001_a.sql': 'create table a (x int);', 'README.md': 'notes' });
    expect(migrationHash(a)).toBe(migrationHash(b));
  });

  it('changes when a migration is edited in place, even at the same byte count', () => {
    const before = migrations({ '001_a.sql': 'select 1 where 1 <= 2;' });
    const after = migrations({ '001_a.sql': 'select 1 where 1 >= 2;' });
    expect(migrationHash(before)).not.toBe(migrationHash(after));
  });

  it('changes when a branch adds a migration', () => {
    const main = migrations({ '001_a.sql': 'create table a (x int);' });
    const branch = migrations({ '001_a.sql': 'create table a (x int);', '002_timers.sql': 'create table t (x int);' });
    expect(migrationHash(main)).not.toBe(migrationHash(branch));
  });
});

describe('publishTemplate', () => {
  const names: string[] = [];
  let adminUrl: string;

  afterEach(async () => {
    adminUrl ??= await adminDatabaseUrl('postgres');
    await withAdmin(adminUrl, async (admin) => {
      for (const name of names.splice(0)) {
        await admin.unsafe(`drop database if exists "${name}" with (force)`);
        await admin.unsafe(`drop database if exists "${name}_build" with (force)`);
      }
    });
  });

  async function freshName(): Promise<string> {
    adminUrl ??= await adminDatabaseUrl('postgres');
    const name = `bob_tmplspec_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    names.push(name);
    return name;
  }

  async function tables(database: string): Promise<string[]> {
    return withAdmin(await adminDatabaseUrl(database), async (sql) =>
      (await sql<{ t: string }[]>`select tablename as t from pg_tables where schemaname = 'public' order by 1`)
        .map((row) => row.t));
  }

  const createMarker = (table: string) => (stagingUrl: string): Promise<void> =>
    withAdmin(stagingUrl, async (sql) => { await sql.unsafe(`create table ${table} (x int)`); });

  it('serialises two concurrent builders: one builds, the other waits and reuses it', async () => {
    const name = await freshName();
    let builds = 0;
    const slowBuild = async (stagingUrl: string): Promise<void> => {
      builds += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await createMarker('built')(stagingUrl);
    };
    const outcomes = await Promise.all([
      publishTemplate(adminUrl, name, slowBuild),
      publishTemplate(adminUrl, name, slowBuild),
    ]);
    expect(builds).toBe(1);
    expect(outcomes.sort()).toEqual(['built', 'reused']);
    expect(await tables(name)).toEqual(['built']);
  });

  it('discards a half-built staging database a killed builder left behind', async () => {
    const name = await freshName();
    await withAdmin(adminUrl, (admin) => admin.unsafe(`create database "${name}_build"`));
    await createMarker('half_built')(await adminDatabaseUrl(`${name}_build`));

    expect(await publishTemplate(adminUrl, name, createMarker('built'))).toBe('built');
    expect(await tables(name)).toEqual(['built']);
    expect(await databaseExists(`${name}_build`)).toBe(false);
  });

  it('a failed build publishes nothing, leaves no staging database, and releases the lock', async () => {
    const name = await freshName();
    const failing = publishTemplate(adminUrl, name, async () => { throw new Error('migration 002 failed'); });
    await expect(failing).rejects.toThrow(/migration 002 failed/);
    expect(await databaseExists(name)).toBe(false);
    expect(await databaseExists(`${name}_build`)).toBe(false);

    expect(await publishTemplate(adminUrl, name, createMarker('built'))).toBe('built');
  });
});

describe('createMigratedDb', () => {
  const MEMORY_INIT = '20260915200000_memory_init.sql';
  const regclass = async (db: TestDb, name: string): Promise<string | null> =>
    (await db.query<{ t: string | null }>('select to_regclass($1)::text as t', [name])).rows[0]!.t;

  it('stops the history before a file, as one postgres session that may set any role, and close() drops it', async () => {
    const db = await createMigratedDb({ before: MEMORY_INIT });
    const { databaseName } = db as PgTestDb;
    try {
      // The pattern dropLeftoverTestDbs sweeps once its pid is gone.
      expect(databaseName).toMatch(/^bob_test_\d+_[0-9a-f]{12}$/);
      expect(await regclass(db, 'bob.conversations')).toBe('bob.conversations');
      expect(await regclass(db, 'bob.memories')).toBeNull();
      // The migration owner, as `supabase db push` runs them; reset role returns here.
      expect((await db.query('select current_user as u')).rows).toEqual([{ u: 'postgres' }]);
      // One session: a role set by one statement holds for the next.
      await db.exec('set role bob_server');
      expect((await db.query('select current_user as u')).rows).toEqual([{ u: 'bob_server' }]);
      await db.exec('reset role');
      expect((await db.query('select current_user as u')).rows).toEqual([{ u: 'postgres' }]);
    } finally {
      await db.close();
    }
    expect(await databaseExists(databaseName)).toBe(false);
  }, 60_000);

  it('runs a seed just before its file, honours skip, and applies the vector migrations', async () => {
    const notices: string[] = [];
    const db = await createMigratedDb({
      before: '20260916050000_spaces_init.sql',
      skip: (file) => file === '20260915210000_voice_interrupted.sql',
      seed: { [MEMORY_INIT]: `insert into auth.users (id) values ('00000000-0000-4000-8000-00000000000a')` },
      onNotice: (message) => notices.push(message),
    });
    try {
      expect((await db.query('select count(*)::int as n from auth.users')).rows).toEqual([{ n: 1 }]);
      expect((await db.query(`select count(*)::int as n from information_schema.columns
          where table_schema = 'bob' and table_name = 'messages' and column_name = 'interrupted'`)).rows)
        .toEqual([{ n: 0 }]);
      expect(await regclass(db, 'bob.memories')).toBe('bob.memories');
      expect((await db.query(`select data_type from information_schema.columns
          where table_schema = 'bob' and table_name = 'memories' and column_name = 'embedding'`)).rows)
        .toEqual([{ data_type: 'USER-DEFINED' }]);
      await db.exec(`do $$ begin raise notice 'hello from the session'; end $$`);
      expect(notices).toEqual(['hello from the session']);
    } finally {
      await db.close();
    }
  }, 60_000);
});
