// db-harness.ts — test:db support (010, T009). Brings up the LOCAL Supabase
// stack in Docker, applies the migrations, resolves an bob_server connection
// to the local DB, and creates four throwaway auth users (A/B/C/D) plus the
// isolation-matrix spaces for the four-account matrix. Loopback-only and never
// `--linked`: it refuses any URL that is not 127.0.0.1/localhost/[::1]. Secrets
// (the per-machine bob_server password in data/offline.env and the service
// role key) stay in memory and are never printed.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { offlineEnvPath } from '../../../scripts/offline-env.mjs';
import type { Db } from '../src/platform/db/db.ts';
import { addMember, createSpace, ensurePrivateSpace } from '../src/spaces/store.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OFFLINE_ENV = offlineEnvPath(ROOT);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const shell = process.platform === 'win32';

/** Runs a supabase CLI command with output captured (never inherited), so the
 *  service role key and DB URL credentials in `status -o env` are not logged. */
function runSupabase(args: string[]): { status: number | null } {
  const result = spawnSync(npx, ['supabase', ...args], { cwd: ROOT, encoding: 'utf8', shell });
  if (result.error) {
    throw new Error(`test:db: the supabase CLI could not run (${result.error.message}).`);
  }
  return { status: result.status };
}

/** Parses `npx supabase status -o env` output: `KEY="value"` lines only
 *  (mirrors scripts/dev-offline.mjs parseSupabaseEnv). */
function parseSupabaseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)="([^"]*)"$/);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

/** True only for loopback Supabase URLs; refuses anything else (hosted). */
function isLoopbackUrl(value: string): boolean {
  const host = new URL(value).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

/** Replaces the DB URL credentials with bob_server + the generated password. */
function buildDbUrl(dbUrl: string, password: string): string {
  const url = new URL(dbUrl);
  url.username = 'bob_server';
  url.password = password;
  return url.toString();
}

/** The password line, only once it is complete: every writer ends the line
 *  with a newline, so a half-written file (truncated, or cut mid-value) reads
 *  as "not yet" instead of as a short, wrong password. */
function readServerPasswordLine(file: string): { exists: boolean; password?: string } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
  return { exists: true, password: text.match(/^BOB_SERVER_PASSWORD=(\S+)\r?\n/m)?.[1] };
}

/** Publishes a complete password file, or leaves an existing one alone: the
 *  content goes to a temp file in the same directory first, then a hard link
 *  puts it at `file` in one step that fails with EEXIST if another worker won.
 *  (A rename would be atomic too, but it silently replaces the winner's file.) */
function publishServerPassword(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `BOB_SERVER_PASSWORD=${randomBytes(24).toString('base64url')}\n`, { mode: 0o600 });
  try {
    linkSync(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

export interface ServerPasswordOptions {
  /** How many times to read before giving up (default 50). */
  attempts?: number;
  /** Wait between reads in ms (default 100). */
  delayMs?: number;
}

/** Reads the per-machine bob_server password from `file`, creating it once
 *  on first run. Safe under parallel test workers: every caller returns the
 *  password that is on disk, and a file another writer is still filling is
 *  re-read until its line is complete. Never logs the password. */
export async function serverPasswordAt(
  file: string = OFFLINE_ENV,
  options: ServerPasswordOptions = {},
): Promise<string> {
  const attempts = options.attempts ?? 50;
  const delayMs = options.delayMs ?? 100;
  let sawFile = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const read = readServerPasswordLine(file);
    if (read.password) return read.password;
    if (read.exists) {
      sawFile = true;
    } else {
      publishServerPassword(file);
      continue;
    }
    await sleep(delayMs);
  }
  const state = sawFile ? 'holds no complete BOB_SERVER_PASSWORD line' : 'is missing';
  throw new Error(
    `test:db: ${file} ${state}. Run \`npm run dev:offline\` to create it, ` +
      'or delete the file and rerun so the test harness generates one.',
  );
}

/** A connection handle that may not exist yet when teardown runs. */
export interface ClosableDb {
  close: () => Promise<void>;
}

/** Teardown that tolerates a setup that failed before its pool existed:
 *  `afterAll(() => teardownMemoryTestDb(t))` is a no-op when `t` is undefined. */
export async function teardownMemoryTestDb(
  t: { cleanup: () => Promise<void> } | undefined,
): Promise<void> {
  if (!t) return;
  await t.cleanup();
}

/** Closes a pool handle if one was created; a no-op for undefined. */
export async function closeIfOpen(handle: ClosableDb | undefined): Promise<void> {
  if (!handle) return;
  await handle.close();
}

/** Applies the bob_server password on the LOCAL DB (temp SQL file removed
 *  afterwards). */
function setServerPassword(password: string): void {
  const sqlFile = join(tmpdir(), `bob-test-db-role-${process.pid}.sql`);
  writeFileSync(sqlFile, `alter role bob_server with password '${password}';\n`, 'utf8');
  try {
    const result = runSupabase(['db', 'query', '--local', '--file', sqlFile]);
    if (result.status !== 0) {
      throw new Error('test:db: failed to set the bob_server role password on the local stack.');
    }
  } finally {
    rmSync(sqlFile, { force: true });
  }
}

/** Reads the running local stack's env values, refusing any non-loopback URL. */
function readStatusEnv(): Record<string, string> {
  const result = spawnSync(npx, ['supabase', 'status', '-o', 'env'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      'test:db: the local Supabase stack is not running. Start it with `npx supabase start` ' +
        '(or `npm run dev:offline`) and retry.',
    );
  }
  const env = parseSupabaseEnv(result.stdout ?? '');
  const apiUrl = env.API_URL;
  const dbUrl = env.DB_URL;
  if (!apiUrl || !dbUrl) {
    throw new Error('test:db: `supabase status -o env` did not report API_URL/DB_URL.');
  }
  if (!isLoopbackUrl(apiUrl) || !isLoopbackUrl(dbUrl)) {
    throw new Error(
      'test:db REFUSES to continue: Supabase must run on the loopback interface (local stack only, never hosted).',
    );
  }
  return env;
}

/** Ensures Docker and the local stack are up and the migrations are applied;
 *  fails fast with a clear message. Returns the status env for the callers. */
export async function ensureLocalStack(): Promise<Record<string, string>> {
  const docker = spawnSync('docker', ['info'], { stdio: 'ignore', shell });
  if (docker.error || docker.status !== 0) {
    throw new Error(
      'test:db needs Docker: the local Supabase stack runs in Docker. Start Docker Desktop and retry.',
    );
  }
  const start = runSupabase(['start']);
  if (start.status !== 0) {
    throw new Error('test:db: `npx supabase start` failed. Run it manually for the details.');
  }
  const up = runSupabase(['migration', 'up', '--local']);
  if (up.status !== 0) {
    throw new Error(
      'test:db: `npx supabase migration up --local` failed. Run it manually for the details.',
    );
  }
  return readStatusEnv();
}

// --- bob_server connection (local-only; the caller closes it) -------------

function wrapTx(tx: postgres.TransactionSql): Db {
  return {
    query<T>(text: string, params?: unknown[]): Promise<T[]> {
      return tx.unsafe<T[]>(text, params as postgres.ParameterOrJSON<never>[], { prepare: true });
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      return fn(wrapTx(tx));
    },
  };
}

/** A Db port over postgres.js (same adapter shape as store/db.ts) with an
 *  explicit close handle so the test run does not leave a pool behind. */
function createDb(url: string): { db: Db; close: () => Promise<void> } {
  const sql = postgres(url, { max: 5, idle_timeout: 30, prepare: true });
  const db: Db = {
    query<T>(text: string, params?: unknown[]): Promise<T[]> {
      return sql.unsafe<T[]>(text, params as postgres.ParameterOrJSON<never>[], { prepare: true });
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      return sql.begin(async (tx) => fn(wrapTx(tx))) as Promise<T>;
    },
  };
  return { db, close: () => sql.end() };
}

// --- throwaway auth users (the dev:offline admin-API approach) --------------

interface MemoryTestAccount {
  userId: string;
  email: string;
}

async function createUser(
  apiUrl: string,
  serviceRoleKey: string,
  email: string,
): Promise<MemoryTestAccount> {
  const headers = { Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' };
  const res = await fetch(`${apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password: randomBytes(18).toString('base64url'), email_confirm: true }),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`test:db: auth admin user create failed (${res.status}).`);
  }
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error('test:db: auth admin user create returned no id.');
  return { userId: body.id, email };
}

async function deleteUser(apiUrl: string, serviceRoleKey: string, userId: string): Promise<void> {
  const res = await fetch(`${apiUrl}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (res.status !== 200 && res.status !== 204) {
    throw new Error(`test:db: auth admin user delete failed (${res.status}).`);
  }
}

/** The four matrix spaces, keyed by the role the matrix tests against. */
export interface MatrixSpaces {
  /** A's private space (A is owner; B/C/D are outsiders). */
  privateA: string;
  /** Pair space between A and B (both peers; C/D are outsiders). */
  pairAB: string;
  /** Group space: A owner, B admin, C member, D a non-member outsider. */
  groupABC: string;
}

export interface MemoryTestDb {
  db: Db;
  a: MemoryTestAccount;
  b: MemoryTestAccount;
  c: MemoryTestAccount;
  d: MemoryTestAccount;
  spaces: MatrixSpaces;
  cleanup(): Promise<void>;
}

/** Seeds a pair space and its two peer memberships directly as the local
 *  stack's postgres superuser (RLS bypassed). RLS FORCE with the spaces_insert
 *  policy `auth.uid() = owner_user_id` rejects a pair insert (owner_user_id is
 *  NULL for pair), and no bob_private definer for pair creation exists yet --
 *  the migration says pair spaces are created "by the server path"
 *  (spaces_init 5). This seed stands in for that not-yet-built server path; the
 *  matrix then tests ACCESS under real roles, never creation. Both peers are
 *  seeded role 'owner' (data-model.md: pair peers are symmetric). */
async function seedPairSpace(
  superUrl: string,
  aId: string,
  bId: string,
): Promise<string> {
  const sql = postgres(superUrl, { max: 1, prepare: true });
  try {
    const spaces = await sql.unsafe<Array<{ id: unknown }>>(
      `insert into bob.spaces (kind, name, owner_user_id)
       values ('pair', 'Pair', null) returning id`,
    );
    const spaceId = String(spaces[0]!.id);
    await sql.unsafe(
      `insert into bob.space_memberships (space_id, user_id, role)
       values ($1, $2, 'owner'), ($1, $3, 'owner')`,
      [spaceId, aId, bId],
    );
    return spaceId;
  } finally {
    await sql.end();
  }
}

/** Brings the local stack up, connects as bob_server, and creates four
 *  throwaway auth users plus the isolation-matrix spaces. cleanup() deletes the
 *  users (their memory rows cascade) and closes the connection pool. */
export async function setupMemoryTestDb(): Promise<MemoryTestDb> {
  const env = await ensureLocalStack();
  // The caller may pin the connection with BOB_TEST_DATABASE_URL (loopback
  // only); otherwise derive it from the status env + the per-machine
  // bob_server password in data/offline.env, the way dev-offline does.
  const explicitUrl = process.env.BOB_TEST_DATABASE_URL?.trim();
  let url: string;
  if (explicitUrl) {
    if (!isLoopbackUrl(explicitUrl)) {
      throw new Error(
        'test:db REFUSES to continue: BOB_TEST_DATABASE_URL must point at the local loopback stack.',
      );
    }
    url = explicitUrl;
  } else {
    const password = await serverPasswordAt();
    setServerPassword(password);
    url = buildDbUrl(env.DB_URL!, password);
  }
  const handle = createDb(url);
  // This suite's database IS the local stack: say so to the local-database
  // gates (the dev account, system-test sign-in), which need a loopback URL.
  process.env.BOB_DATABASE_URL ||= url;
  const accounts: MemoryTestAccount[] = [];
  try {
    for (const label of ['a', 'b', 'c', 'd']) {
      accounts.push(
        await createUser(env.API_URL!, env.SERVICE_ROLE_KEY!, `${label}-${randomUUID()}@memtest.bob.local`),
      );
    }
  } catch (err) {
    await handle.close();
    throw err;
  }
  const a = accounts[0];
  const b = accounts[1];
  const c = accounts[2];
  const d = accounts[3];
  if (!a || !b || !c || !d) {
    await handle.close();
    throw new Error('test:db: failed to create the four test accounts.');
  }
  const spaces = await buildMatrixSpaces(handle.db, env.DB_URL!, a, b, c);
  return {
    db: handle.db,
    a,
    b,
    c,
    d,
    spaces,
    cleanup: async () => {
      for (const account of accounts) {
        try {
          await deleteUser(env.API_URL!, env.SERVICE_ROLE_KEY!, account.userId);
        } catch {
          // best effort: the memory rows cascade away with the account anyway
        }
      }
      await handle.close();
    },
  };
}

/** Builds the four-account isolation-matrix spaces:
 *  - A's private space (via the store under real RLS -- ensurePrivateSpace);
 *  - a pair space between A and B (seeded as the server path, RLS bypassed);
 *  - a group space with A owner, B admin, C member (via the store).
 *  D is deliberately left out of every space (the outsider). */
async function buildMatrixSpaces(
  db: Db,
  superUrl: string,
  a: MemoryTestAccount,
  b: MemoryTestAccount,
  c: MemoryTestAccount,
): Promise<MatrixSpaces> {
  const privateA = (await ensurePrivateSpace(db, a.userId)).id;
  const pairAB = await seedPairSpace(superUrl, a.userId, b.userId);
  const group = await createSpace(db, a.userId, { kind: 'group', name: 'Family Group' });
  await addMember(db, a.userId, group.id, b.userId, 'admin');
  await addMember(db, a.userId, group.id, c.userId, 'member');
  return { privateA, pairAB, groupABC: group.id };
}