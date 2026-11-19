// pg-template.ts — the per-test Postgres factory (S14-PGSQL-HARNESS).
//
// Backs tests/support/test-db.ts with real Postgres on the LOCAL Supabase
// stack. Per vitest process the harness builds ONE template database
// (`bob_tmpl_<hash of migration filenames+contents>`) with every migration
// applied, then every test file gets its own `CREATE DATABASE ... TEMPLATE`
// copy, so migrations run once instead of per test file. The copy is dropped
// on teardown; leftovers from a killed run are dropped on startup.
//
// The template is built from THIS checkout's supabase/migrations, never from
// the live schema. The live database is shared by every worktree on the
// machine, so it can be behind this branch (a new migration is missing:
// "relation bob.timers does not exist") or ahead of it (another branch's
// table leaks in). Only the Supabase-owned base -- the `auth` and `storage`
// schemas GoTrue and storage-api create -- is read from the live database, with
// a read-only `pg_dump --schema-only`; then every migration file is replayed on
// top with ON_ERROR_STOP. Nothing is ever written to the live database's
// schema. pg_dump/psql are not on PATH here, so they run inside the local db
// container via `docker exec`.
//
// Parallel runs (see docs/testing.md):
//  - The template name hashes the recipe and every migration's name and
//    content, so two checkouts with different migrations get different
//    templates and never share one.
//  - `publishTemplate` builds under a per-name Postgres advisory lock: the first
//    process builds, every other process blocks on the lock and then reuses the
//    finished template. The build happens under `<name>_build` and is renamed
//    into place atomically; a `_build` found under the lock is a dead builder's
//    half-build and is dropped. A failed build drops its own staging database.
//  - Per-test databases are named `bob_test_<pid>_<rand>`. Startup cleanup
//    drops only those whose process is gone, so one run never drops a database
//    another live run is using.
//
// A migration-step test needs the history stopped BEFORE the file it
// exercises, which a finished template cannot give: `createMigratedDb` builds
// such a database from empty with the same base dump and replay.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { offlineEnvPath } from '../../../../scripts/offline-env.mjs';
import { serverPasswordAt } from '../db-harness.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
/** The password file is shared by every worktree (see scripts/offline-env.mjs):
 *  a per-worktree file let each worktree re-set the cluster-wide role under the
 *  others' feet. */
const OFFLINE_ENV = offlineEnvPath(ROOT);
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const shell = process.platform === 'win32';
/** The Supabase-owned schemas the migrations build on (auth.users, auth.uid()). */
const BASE_SCHEMAS = ['auth', 'storage'];
/** Bumped whenever the build recipe changes, so templates built the old way are
 *  never reused. v1 dumped the live schema; v2 replays the migrations; v3
 *  restores the base schemas' USAGE grants. */
const TEMPLATE_RECIPE = 'bob-template-v3:base-dump+grants+migrations';

/** Runs a supabase CLI command with output captured (never inherited). */
function runSupabase(args: string[]): { status: number | null } {
  const result = spawnSync(npx, ['supabase', ...args], { cwd: ROOT, encoding: 'utf8', shell });
  if (result.error) {
    throw new Error(`pg-template: the supabase CLI could not run (${result.error.message}).`);
  }
  return { status: result.status };
}

/** Runs a docker command, returning its captured output. docker is a real exe,
 *  so no shell is involved (no quoting hazards, no shim). */
function runDocker(args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`pg-template: docker could not run (${result.error.message}).`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Parses `supabase status -o env` output: `KEY="value"` lines only. */
function parseSupabaseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)="([^"]*)"$/);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

/** Local stack ports; SUPABASE_DB_PORT / SUPABASE_API_PORT override config.toml like the CLI does. */
const DB_PORT = process.env.SUPABASE_DB_PORT ?? '54322';
const API_PORT = process.env.SUPABASE_API_PORT ?? '54321';

/** The local db container name (pg_dump/psql live there, not on PATH). */
function dbContainerName(): string {
  // Match the container that publishes the db port, so a second local stack
  // (another checkout's) is never the one psql/pg_dump run in.
  const out = runDocker(['ps', '--filter', `publish=${DB_PORT}`, '--format', '{{.Names}}']);
  const name = (out.stdout ?? '').split(/\r?\n/).find((n) => n.startsWith('supabase_db_'));
  if (!name) {
    throw new Error('pg-template: no supabase db container found (is the local stack running?).');
  }
  return name;
}

/** Reads the bob_server password from data/offline.env (or `file`), generating
 *  it on first run. On a fresh machine (every CI run) the parallel vitest workers
 *  all find no file at once. An exclusive create let a worker read the winner's
 *  file while it was still empty (#482), so this shares db-harness's
 *  serverPasswordAt: the file is published whole (temp file + hard link), every
 *  worker returns the one password on disk, and readers retry until the line is
 *  complete. */
export function serverPassword(file: string = OFFLINE_ENV): Promise<string> {
  return serverPasswordAt(file);
}

/** Sets the bob_server password on the LOCAL db (cluster-wide; roles are
 *  shared across databases, so the per-test databases inherit it). */
function setServerPassword(password: string): void {
  const sqlFile = join(tmpdir(), `bob-test-db-role-${process.pid}.sql`);
  writeFileSync(sqlFile, `alter role bob_server with password '${password}';\n`, 'utf8');
  try {
    if (runSupabase(['db', 'query', '--local', '--file', sqlFile]).status !== 0) {
      throw new Error('pg-template: failed to set the bob_server role password on the local stack.');
    }
  } finally {
    rmSync(sqlFile, { force: true });
  }
}

/** The migration files of a directory, in the order Supabase applies them. */
function migrationFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * sha256 of the build recipe and every migration's filename AND CONTENT — the
 * deterministic template name.
 *
 * This used to hash `filename:size`. That left a silent hole: an edit that kept
 * a migration's byte count unchanged -- `<=` to `>=`, a typo fixed in place, a
 * column renamed to another of the same length -- produced the same hash, so the
 * cached template was reused and every test ran against the OLD schema with no
 * error at all. It was hit in practice while workers edited migrations
 * concurrently. Reading ~20 small files per process is negligible next to the
 * cost of a test suite that quietly measures SQL nobody has any more.
 */
export function migrationHash(dir: string = MIGRATIONS_DIR): string {
  const h = createHash('sha256');
  h.update(TEMPLATE_RECIPE);
  h.update('\0');
  for (const f of migrationFiles(dir)) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(join(dir, f)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

function templateName(): string {
  return `bob_tmpl_${migrationHash()}`;
}

/** The local stack's postgres superuser URL (admin/maintenance operations). */
function adminUrl(dbUrl: string): string {
  return dbUrl;
}

/** Builds the bob_server URL for a database on the local stack. */
function serverUrl(dbUrl: string, database: string, password: string): string {
  const url = new URL(dbUrl);
  url.username = 'bob_server';
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

/** A database-name URL on the local stack. */
function dbUrlFor(dbUrl: string, database: string): string {
  const url = new URL(dbUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** The advisory-lock class for template builds; the second key is the
 *  template name's hashtext, so different templates build independently. */
const TEMPLATE_LOCK_CLASS = 0x4f4c58;
/** The advisory-lock key that serializes the bob_server password set. */
const PASSWORD_LOCK = 0x5041535343;

// --- template build --------------------------------------------------------

/** The admin (postgres superuser) URL for a named database on the local
 *  stack. Fixtures use this to reach `auth.*` setup that the app's own role
 *  (bob_server) is deliberately denied. */
export async function adminDatabaseUrl(database: string): Promise<string> {
  const env = await stackEnv();
  return dbUrlFor(env.DB_URL!, database);
}

/** Connects as the stack's postgres role to run an admin query. */
export async function withAdmin<T>(dbUrl: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(adminUrl(dbUrl), { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** True while the process that created a per-test database is still running.
 *  EPERM means it exists but belongs to someone else: still alive. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Drops leftover per-test databases a killed run leaked. Only databases whose
 *  owning pid is gone are forced; an unrecognised name is dropped only when
 *  nothing is connected. The old cleanup force-dropped EVERY `bob_test_%`,
 *  which killed the databases of whatever other run was mid-suite. */
async function dropLeftoverTestDbs(admin: postgres.Sql): Promise<void> {
  const rows = await admin.unsafe<Array<{ datname: string }>>(
    `select datname from pg_database where datname like 'bob\\_test\\_%'`,
  );
  for (const { datname } of rows) {
    const pid = Number(datname.match(/^bob_test_(\d+)_[0-9a-f]+$/)?.[1]);
    if (Number.isInteger(pid) && processAlive(pid)) continue;
    try {
      await admin.unsafe(`drop database if exists "${datname}"${Number.isInteger(pid) ? ' with (force)' : ''}`);
    } catch {
      // In use by a run we cannot identify, or already dropped by a peer.
    }
  }
}

/** True when the template database already exists (reuse, don't rebuild). */
async function templateExists(admin: postgres.Sql, name: string): Promise<boolean> {
  const rows = await admin.unsafe<Array<{ n: number }>>(
    `select count(*)::int as n from pg_database where datname = '${name}'`,
  );
  return rows.length > 0 && rows[0]!.n === 1;
}

/**
 * Publishes the template `name` exactly once across every process on the
 * machine, returning whether this call built it or found it built.
 *
 * Holds a Postgres advisory lock keyed by the name for the whole build, so a
 * concurrent caller blocks until the winner is done and then reuses its result.
 * The build happens under `<name>_build` and is renamed into place atomically
 * (`ALTER DATABASE ... RENAME`), so the final name never exists before its
 * schema does: the unlocked fast path in `templateExistsFast` can trust it. A
 * `_build` database found while holding the lock can only be a dead builder's
 * half-build (a live one would still hold the lock), so it is dropped. A failed
 * populate drops its own staging database before rethrowing. The lock is
 * session-level, so a killed builder's lock dies with its connection.
 */
export async function publishTemplate(
  dbUrl: string,
  name: string,
  populate: (stagingUrl: string, staging: string) => Promise<void>,
): Promise<'built' | 'reused'> {
  const staging = `${name}_build`;
  const lock = `${TEMPLATE_LOCK_CLASS}, hashtext('${name}')`;
  return withAdmin(dbUrl, async (admin) => {
    await admin.unsafe(`select pg_advisory_lock(${lock})`);
    try {
      if (await templateExists(admin, name)) return 'reused';
      await admin.unsafe(`drop database if exists "${staging}" with (force)`);
      await admin.unsafe(`create database "${staging}"`);
      try {
        await populate(dbUrlFor(dbUrl, staging), staging);
        await admin.unsafe(`alter database "${staging}" rename to "${name}"`);
      } catch (error) {
        await admin.unsafe(`drop database if exists "${staging}" with (force)`).catch(() => undefined);
        throw error;
      }
      return 'built';
    } finally {
      await admin.unsafe(`select pg_advisory_unlock(${lock})`).catch(() => undefined);
    }
  });
}

/** Strips pg_dump lines that must not replay into a fresh database: the
 *  pre-existing `public` schema and session-level GUCs that only a superuser
 *  may set (the stack's postgres role is NOT a superuser). */
function sanitizeDump(dump: string): string {
  return dump
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (t === 'CREATE SCHEMA public;') return false;
      if (/^SET ".*" (TO|=)/.test(t)) return false;
      // pg_dump 17.6+ fences the script with psql-only `\restrict` meta-commands,
      // which a plain SQL session (createMigratedDb) cannot run.
      if (/^\\(un)?restrict\b/.test(t)) return false;
      return true;
    })
    .join('\n');
}

/** The Supabase-owned base every migration builds on, as one SQL script: the
 *  `extensions` schema, a read-only schema dump of `auth`/`storage` from the
 *  live local database, and the USAGE grants that dump drops. Dumped once per
 *  process: the template build and every createMigratedDb() share it. */
let baseSqlPromise: Promise<string> | null = null;
function baseSchemaSql(): Promise<string> {
  baseSqlPromise ??= (async () => {
    const dump = runDocker([
      'exec', dbContainerName(), 'pg_dump', '-U', 'postgres', '-d', 'postgres',
      '--schema-only', '--no-owner', '--no-privileges',
      ...BASE_SCHEMAS.flatMap((s) => ['-n', s]),
    ]);
    if (dump.status !== 0) {
      throw new Error(`pg-template: pg_dump of the base schemas failed: ${dump.stderr.slice(0, 400)}`);
    }
    return [
      // Supabase keeps extensions (vector) in their own schema; a fresh database
      // lacks it, and the memory migration creates `vector` there.
      'create schema if not exists extensions;',
      sanitizeDump(dump.stdout),
      // The dump is --no-privileges, so the restored schemas carry no ACL at all
      // and the API roles lose the USAGE the local stack and production grant:
      // `::extensions.vector` casts and match_memories' auth.uid() then fail
      // "permission denied for schema" and memory silently degrades (#435).
      `grant usage on schema ${[...BASE_SCHEMAS, 'extensions'].join(', ')} to anon, authenticated, service_role;`,
    ].join('\n');
  })();
  baseSqlPromise.catch(() => { baseSqlPromise = null; });
  return baseSqlPromise;
}

/** The psql marker echoed before each migration, so a failure names its file. */
const MIGRATION_MARKER = 'bob-template-migration:';

/**
 * Populates an empty staging database with the Supabase base schemas plus
 * THIS checkout's migrations, in one psql session with ON_ERROR_STOP (without
 * it psql exits 0 after a failed statement, and a half-applied schema was
 * published as if complete). The only read of the live database is the
 * schema-only dump of `auth`/`storage`; nothing is written to it. Every
 * connection to the staging database is closed on return (psql has exited),
 * which the publishing RENAME requires.
 */
async function populateFromMigrations(_stagingUrl: string, staging: string): Promise<void> {
  const container = dbContainerName();
  const script = [
    '\\set ON_ERROR_STOP 1',
    await baseSchemaSql(),
    ...migrationFiles(MIGRATIONS_DIR).map((f) =>
      `\\echo ${MIGRATION_MARKER}${f}\n${readFileSync(join(MIGRATIONS_DIR, f), 'utf8')}\n`),
  ].join('\n');
  const psql = runDocker(['exec', '-i', container, 'psql', '-q', '-U', 'postgres', '-d', staging], script);
  if (psql.status !== 0) {
    const failed = psql.stdout.split(/\r?\n/).filter((l) => l.startsWith(MIGRATION_MARKER)).pop();
    const where = failed ? `migration ${failed.slice(MIGRATION_MARKER.length)}` : 'the base schema restore';
    throw new Error(`pg-template: template build failed in ${where}: ${psql.stderr.slice(0, 400)}`);
  }
}

/** Cached local-stack env (status -o env), shared by template + acquire. */
let envPromise: Promise<Record<string, string>> | null = null;

/** The running stack's `supabase status -o env`, or null when it is not up.
 *  Refuses (throws) a non-loopback URL: tests only ever touch the local stack. */
function readStatusEnv(): Record<string, string> | null {
  const result = spawnSync(npx, ['supabase', 'status', '-o', 'env'], { cwd: ROOT, encoding: 'utf8', shell });
  if (result.error || result.status !== 0) return null;
  const env = parseSupabaseEnv(result.stdout ?? '');
  if (!env.DB_URL || !env.API_URL) return null;
  for (const value of [env.DB_URL, env.API_URL]) {
    const host = new URL(value).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
      throw new Error('pg-template REFUSES to continue: Supabase must run on loopback (local stack only).');
    }
  }
  return env;
}

/** Reads the stack's env, starting the stack when it is down. Deliberately NOT
 *  db-harness's ensureLocalStack: that runs `supabase migration up --local`,
 *  which writes THIS checkout's migrations into the live database every other
 *  worktree shares. The template is built from the migration files instead, so
 *  the live schema never needs to match (a fresh `supabase start` applies the
 *  migrations itself, which is the stack's own boot, not ours). */
async function fastStackEnv(): Promise<Record<string, string>> {
  const running = readStatusEnv();
  if (running) return running;
  const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (docker.error || docker.status !== 0) {
    throw new Error('pg-template needs Docker: the local Supabase stack runs in Docker. Start Docker Desktop and retry.');
  }
  if (runSupabase(['start']).status !== 0) {
    throw new Error('pg-template: `npx supabase start` failed. Run it manually for the details.');
  }
  const env = readStatusEnv();
  if (!env) throw new Error('pg-template: `supabase status -o env` did not report DB_URL/API_URL after start.');
  return env;
}

/** The standard local-stack admin URL (status reports it; probing it directly
 *  avoids a `npx supabase` spawn on every warm worker). */
const DEFAULT_ADMIN_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`;

/** True when bob_server can already log in with the stored password. */
async function bobPasswordWorks(env: Record<string, string>, password: string): Promise<boolean> {
  const url = new URL(env.DB_URL!);
  url.username = 'bob_server';
  url.password = password;
  const sql = postgres(url.toString(), { max: 1 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end().catch(() => undefined);
  }
}

async function stackEnv(): Promise<Record<string, string>> {
  if (!envPromise) {
    envPromise = (async () => {
      let env: Record<string, string>;
      const probe = postgres(DEFAULT_ADMIN_URL, { max: 1 });
      try {
        await probe`select 1`;
        env = { DB_URL: DEFAULT_ADMIN_URL, API_URL: `http://127.0.0.1:${API_PORT}` };
      } catch {
        env = await fastStackEnv();
      } finally {
        await probe.end().catch(() => undefined);
      }
      const password = await serverPassword();
      // Set the bob_server password at most once per cluster: probe first,
      // and only alter the role when the probe fails, serialized under an
      // advisory lock so parallel vitest workers never race the CLI.
      if (!(await bobPasswordWorks(env, password))) {
        await withAdmin(env.DB_URL!, async (admin) => {
          await admin.unsafe(`select pg_advisory_lock(${PASSWORD_LOCK})`);
          try {
            if (!(await bobPasswordWorks(env, password))) {
              setServerPassword(password);
            }
          } finally {
            await admin.unsafe(`select pg_advisory_unlock(${PASSWORD_LOCK})`);
          }
        });
      }
      return env;
    })();
  }
  return envPromise;
}

/** True when a database with the given name exists (teardown assertion). */
export async function databaseExists(database: string): Promise<boolean> {
  const env = await stackEnv();
  return withAdmin(env.DB_URL!, async (admin) => {
    const rows = await admin.unsafe<Array<{ n: number }>>(
      `select count(*)::int as n from pg_database where datname = '${database}'`,
    );
    return rows.length > 0 && rows[0]!.n === 1;
  });
}

/** True when the template already exists, checked against a fast status env. */
async function templateExistsFast(name: string): Promise<{ exists: boolean; env: Record<string, string> | null }> {
  // Probe the standard loopback admin URL directly — no CLI spawn on the
  // common warm path. The supabase CLI runs `status` per spawn (~3 s), and 60
  // parallel vitest workers spawning it at once is the whole cold-start cost.
  const fallbackEnv = { DB_URL: DEFAULT_ADMIN_URL, API_URL: `http://127.0.0.1:${API_PORT}` };
  try {
    const exists = await withAdmin(DEFAULT_ADMIN_URL, (admin) => templateExists(admin, name));
    if (exists) return { exists: true, env: fallbackEnv };
  } catch {
    // fall through to the status probe below
  }
  let env: Record<string, string>;
  try {
    env = await fastStackEnv();
  } catch {
    return { exists: false, env: null };
  }
  try {
    const exists = await withAdmin(env.DB_URL!, (admin) => templateExists(admin, name));
    return { exists, env };
  } catch {
    return { exists: false, env };
  }
}

/** Ensures this checkout's template exists, building it at most once across
 *  every process on the machine (`publishTemplate`). A worker that finds it
 *  already published takes the fast path with no CLI spawn and no lock. Each
 *  process also sweeps per-test databases leaked by dead runs, once. */
let templatePromise: Promise<string> | null = null;
export async function ensureTemplate(): Promise<string> {
  if (!templatePromise) {
    templatePromise = (async () => {
      const name = templateName();
      const fast = await templateExistsFast(name);
      const env = fast.env ?? (await fastStackEnv());
      if (!fast.exists) {
        await publishTemplate(env.DB_URL!, name, populateFromMigrations);
      }
      await withAdmin(env.DB_URL!, (admin) => dropLeftoverTestDbs(admin)).catch(() => undefined);
      return name;
    })();
  }
  return templatePromise;
}

// --- per-test database acquisition ------------------------------------------

/** Creates a database from the template (a unique per-test name by default;
 *  a HIL run passes its own, scripts/hil/hil-db.ts) and returns its
 *  bob_server URL. The caller must drop it with `releaseDatabase`; a leaked
 *  per-test database is dropped by the next run's startup cleanup. */
export async function acquireDatabase(database: string = testDatabaseName()): Promise<{ database: string; url: string }> {
  const template = await ensureTemplate();
  const env = await stackEnv();
  await withAdmin(env.DB_URL!, (admin) =>
    admin.unsafe(`create database "${database}" template "${template}"`),
  );
  return { database, url: serverUrl(env.DB_URL!, database, await serverPassword()) };
}

/** Drops a per-test database (idempotent; survives a double teardown). */
export async function releaseDatabase(database: string): Promise<void> {
  const env = await stackEnv();
  await withAdmin(env.DB_URL!, (admin) =>
    admin.unsafe(`drop database if exists "${database}" with (force)`),
  );
}

/** A fresh per-test database name. The pid is how dropLeftoverTestDbs tells a
 *  dead run's database from a live one, so every per-test database (template
 *  copy or migrated from empty) uses this one pattern. */
function testDatabaseName(): string {
  return `bob_test_${process.pid}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// --- the test database handle -----------------------------------------------

/** A query result: the rows, plus how many rows the statement touched. */
export interface TestResult<T> {
  rows: T[];
  affectedRows: number;
}

/** One session, or one open transaction, on a test database. */
export interface TestTx {
  query<T>(sql: string, params?: unknown[]): Promise<TestResult<T>>;
  /** Runs one or more statements with no parameters (a seed, a migration file). */
  exec(sql: string): Promise<void>;
}

/** A per-test database: queries, a transaction, and close (which drops it). */
export interface TestDb extends TestTx {
  transaction<T>(fn: (tx: TestTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** The TestTx surface over a postgres.js pool or transaction. */
function session(sql: postgres.Sql | postgres.TransactionSql): TestTx {
  return {
    async query<T>(text: string, params?: unknown[]): Promise<TestResult<T>> {
      const rows = await sql.unsafe<T[]>(text, params as postgres.ParameterOrJSON<never>[], { prepare: true });
      return { rows, affectedRows: rows.count };
    },
    async exec(text: string): Promise<void> {
      // The simple protocol runs several statements in one round trip.
      await sql.unsafe(text).simple();
    },
  };
}

/** A TestDb over one per-test database; close() also drops the database. */
export class PgTestDb implements TestDb {
  private readonly sql: postgres.Sql;
  private readonly root: TestTx;
  private closed = false;

  constructor(url: string, readonly databaseName: string, options: postgres.Options<{}> = {}) {
    this.sql = postgres(url, { max: 5, idle_timeout: 30, prepare: true, ...options });
    this.root = session(this.sql);
  }

  query<T>(sql: string, params?: unknown[]): Promise<TestResult<T>> {
    return this.root.query<T>(sql, params);
  }

  exec(sql: string): Promise<void> {
    return this.root.exec(sql);
  }

  transaction<T>(fn: (tx: TestTx) => Promise<T>): Promise<T> {
    // postgres.js begin() types its result through UnwrapPromiseArray; the
    // callback returns a plain value, so the unwrap is the identity.
    return this.sql.begin(async (tx) => fn(session(tx))) as Promise<T>;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sql.end().catch(() => undefined);
    await releaseDatabase(this.databaseName).catch(() => undefined);
  }
}

// --- migration-step databases -----------------------------------------------

/** The local stack's superuser, used only as the SESSION user of a
 *  migration-step handle so a test may SET ROLE to anything (bob_server,
 *  authenticated); the stack's `postgres` role may not
 *  SET ROLE bob_server. It shares postgres's password on the local stack,
 *  which is all this ever reaches (stackEnv refuses a non-loopback URL). */
const SUPERUSER = 'supabase_admin';

export interface MigratedDbOptions {
  /** Applies only the migrations whose filename sorts before this one: the
   *  migration under test, which the test then runs itself. */
  before?: string;
  /** Leaves a migration out. */
  skip?: (file: string) => boolean;
  /** SQL run just before the named migration file: rows an older server wrote
   *  partway through the history. */
  seed?: Record<string, string>;
  /** Receives the message of every NOTICE the returned handle's session raises. */
  onNotice?: (message: string) => void;
}

/**
 * A fresh database built from empty for a migration-step test: the Supabase
 * base (auth/storage) restored, then THIS checkout's migrations replayed in
 * order, each file in one implicit transaction, as the stack's `postgres` role
 * (the role `supabase db push` uses), exactly as the template is built. Unlike
 * createTestDb it is not a template copy, so a test can stop the history
 * before the migration it exercises.
 *
 * The returned handle is ONE session (max 1 connection), so state a test sets
 * (`set role`, a GUC) holds for its next statement. Its
 * current role is `postgres` (bypassrls, the owner of everything the history
 * created), so the migration under test creates objects with the owner
 * production gives them; its session user is the superuser, so `set role`
 * reaches any role and `reset role` comes back to postgres. close() drops the
 * database.
 */
export async function createMigratedDb(options: MigratedDbOptions = {}): Promise<TestDb> {
  const env = await stackEnv();
  const database = testDatabaseName();
  const url = dbUrlFor(env.DB_URL!, database);
  await withAdmin(env.DB_URL!, (admin) => admin.unsafe(`create database "${database}"`));
  try {
    const setup = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await setup.unsafe(await baseSchemaSql()).simple();
      for (const file of migrationFiles(MIGRATIONS_DIR)) {
        if (options.before !== undefined && file >= options.before) break;
        if (options.skip?.(file)) continue;
        const seed = options.seed?.[file];
        if (seed !== undefined) await setup.unsafe(seed).simple();
        await setup.unsafe(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')).simple().catch((error: Error) => {
          throw new Error(`createMigratedDb: migration ${file} failed: ${error.message}`);
        });
      }
    } finally {
      await setup.end();
    }
  } catch (error) {
    await releaseDatabase(database).catch(() => undefined);
    throw error;
  }
  const sessionUrl = new URL(url);
  sessionUrl.username = SUPERUSER;
  const onNotice = options.onNotice;
  return new PgTestDb(sessionUrl.toString(), database, {
    max: 1,
    idle_timeout: 0,
    connection: { role: 'postgres' },
    onnotice: onNotice ? (notice) => onNotice(String(notice.message ?? '')) : () => undefined,
  });
}
