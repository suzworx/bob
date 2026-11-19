// Test database helpers (T005, specs/008-supabase-auth-pairing;
// S14-PGSQL-HARNESS reimplementation).
//
// `createTestDb()` returns a `TestDb` over a REAL Postgres database copied
// from a migration-complete template on the LOCAL Supabase stack (see
// pg-template.ts): `query` returning `{ rows }`, `exec`, `transaction`,
// `close`, and `asDb()` turns it into the app's Db port. Every connection runs as
// `bob_server` (nobypassrls), never as a superuser. Connecting as anything
// else re-introduces exactly the failure this replaced: a test that passes
// because it bypasses RLS is the bug we are removing.
//
// `addAccount` creates users through `bob_private.ensure_test_session`
// (SECURITY DEFINER, granted to bob_server), the sanctioned production path
// — the migrations grant bob_server no direct privilege on auth.*.
//
// Rule: tests never touch `auth.*` directly, because the test role is
// deliberately not a superuser. `addAccount` and `addSession` are the only
// sanctioned ways a test creates an auth user or session row.
import { randomUUID } from 'node:crypto';
import {
  acquireDatabase,
  adminDatabaseUrl,
  ensureTemplate,
  PgTestDb,
  withAdmin,
  type TestDb,
  type TestTx,
} from './pg-template.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { DEV_ACCOUNT_ID } from '../../src/account/dev-account.ts';

/** A loopback URL nothing listens on (port 1): what a test process's
 *  BOB_DATABASE_URL names unless the run set one. Its databases are real and
 *  local -- each file's own template copy, shared with getDb() through
 *  setSharedDb -- so the local-database gates (system-test sign-in, the dev
 *  account) must see a loopback URL; one that refuses connections makes a
 *  getDb() that bypassed setSharedDb fail loudly instead of touching the
 *  shared live database. */
export const TEST_DATABASE_URL = 'postgresql://bob_server@127.0.0.1:1/bob_no_shared_db';
process.env.BOB_DATABASE_URL ||= TEST_DATABASE_URL;

// Warm the template (stack + migration-complete schema) at module load: the
// per-process build happens ONCE and is slow (~10s), so doing it during
// import — before any beforeAll/it timeout starts counting — keeps consumers'
// 5s/10s hooks green on their first createTestDb().
await ensureTemplate();

export type { TestDb, TestResult, TestTx } from './pg-template.ts';

/** Work started through asDb() and not yet settled, per TestDb. */
const inFlight = new WeakMap<TestDb, Set<Promise<unknown>>>();

/** Records work on db until it settles, so closeTestDb can wait for it. */
function track<T>(db: TestDb, work: Promise<T>): Promise<T> {
  let pending = inFlight.get(db);
  if (!pending) inFlight.set(db, (pending = new Set()));
  const settled = pending;
  settled.add(work);
  const forget = (): void => {
    settled.delete(work);
  };
  work.then(forget, forget);
  return work;
}

/**
 * The app's Db port over a TestDb: rows instead of `{ rows }`, and tx() on the
 * handle's transaction (a nested tx() reuses it). Store functions and routes
 * take this; setSharedDb(Promise.resolve(asDb(testDb))) shares it with getDb().
 * Every query and transaction is tracked until it settles: fire-and-forget
 * writes (turn metrics, memory extraction) can outlive a test, and closing the
 * pool under one leaks an unhandled CONNECTION_CLOSED from postgres.js.
 */
export function asDb(db: TestDb): Db {
  return {
    query: <T>(sql: string, params?: unknown[]): Promise<T[]> =>
      track(db, db.query<T>(sql, params).then((result) => result.rows)),
    tx: <T>(fn: (tx: Db) => Promise<T>): Promise<T> => track(db, db.transaction((tx) => fn(txDb(tx)))),
  };
}

/** A Db bound to one open transaction. */
function txDb(tx: TestTx): Db {
  return {
    query: <T>(sql: string, params?: unknown[]): Promise<T[]> =>
      tx.query<T>(sql, params).then((result) => result.rows),
    tx: <T>(fn: (inner: Db) => Promise<T>): Promise<T> => fn(txDb(tx)),
  };
}

export interface AddAccountOptions {
  /** Fixed user id (uuid). Defaults to a fresh random uuid. */
  id?: string;
  /** Fixed session id (uuid). Defaults to a fresh random uuid. */
  sessionId?: string;
  /** When true, sets banned_until in the future so the account is disabled.
   *  NOTE: on real Postgres as bob_server the migrations grant no write
   *  path to auth.users.banned_until, so a banned account cannot be created
   *  (a finding, not a silent fallback). */
  banned?: boolean;
}

export interface TestAccount {
  userId: string;
  sessionId: string;
}

/** The narrow admin surface fixtures may use for `auth.*` setup. It is NOT a
 *  "run arbitrary SQL as superuser" escape hatch: it is the handful of
 *  auth-side operations fixtures legitimately need, and nothing more. */
export interface AuthAdmin {
  /** Inserts an auth.users row (id only), returning the id. */
  createUser(id: string): Promise<string>;
  /** Sets banned_until to a future value, disabling the account. */
  banUser(userId: string, bannedUntil: string): Promise<void>;
  /** Deletes an auth.sessions row -- what Supabase Auth does on sign-out, and
   *  the state `requireActiveSession` must refuse. Our server never deletes
   *  sessions itself, so a test simulating a signed-out session belongs here,
   *  not on the bob_server connection (which is refused on schema auth). */
  endSession(sessionId: string): Promise<void>;
  /** Reads one auth.users row's GoTrue-scanned columns, or null when absent.
   *  A read rather than a write, but still auth.* only -- which is this seam's
   *  whole charter. bob_server has no grant on schema auth, so verifying the
   *  shape of an auth.users row (e.g. that GoTrue's token columns are '' and
   *  never NULL) has no other honest path. */
  getUser(id: string): Promise<Record<string, string | null> | null>;
  /** Sets an account's identity email and/or metadata display name -- the
   *  profile fields Supabase Auth owns and our server only ever reads (e.g.
   *  for @handle derivation and invitation email matching). */
  setAccountState(userId: string, state: { confirmed?: boolean; deleted?: boolean; createdAt?: string }): Promise<void>;
  createRefreshToken(sessionId: string, userId: string): Promise<string>;
  refreshTokenExists(token: string): Promise<boolean>;
  setProfile(userId: string, profile: { email?: string | null; name?: string }): Promise<void>;
  /** True when an auth.sessions row with this id belongs to this user -- how
   *  the harness's own tests verify that addAccount created a live session. */
  sessionExists(sessionId: string, userId: string): Promise<boolean>;
}

/**
 * Creates a fresh per-test database from the migration-complete template and
 * returns a TestDb connected as bob_server. Every test
 * file gets an isolated database; closeTestDb drops it.
 */
/** The fixed session id paired with DEV_ACCOUNT_ID, so the seeded row is
 *  deterministic across runs and files. */
const DEV_ACCOUNT_SESSION_ID = '00000000-0000-4000-8000-0000000000a1';

export async function createTestDb(): Promise<TestDb> {
  const { database, url } = await acquireDatabase();
  const handle = new PgTestDb(url, database);
  // Seed the dev account's auth.users row. `resolveDevAccount` documents that
  // it relies on the test setup having created this row already: its own insert
  // runs on the base connection, which is bob_server here and has no INSERT
  // grant on auth.users, so a refused insert is expected and deliberately
  // swallowed. The old in-process test database made the row appear anyway; on
  // real Postgres nothing did, so every conversation written by a route acting as the
  // dev account failed conversations_user_id_fkey -- 58 failures across five
  // files from this one gap. Created through the same definer addAccount uses,
  // not the admin seam, because the definer is the narrower privilege.
  await handle.query(
    'select bob_private.ensure_test_session($1::uuid, $2::uuid)',
    [DEV_ACCOUNT_ID, DEV_ACCOUNT_SESSION_ID],
  );
  return handle;
}

/**
 * Inserts an auth.users row (plus an auth.sessions row) so the FKs on
 * conversations.user_id, devices.user_id, active_conversations.user_id, and
 * pairing_requests.approved_by have their Supabase targets (data-model §8).
 * Runs through bob_private.ensure_test_session — the SECURITY DEFINER the
 * migrations grant to bob_server (20260917010000_auth_user_token_defaults).
 */
export async function addAccount(
  db: TestDb,
  options: AddAccountOptions = {},
): Promise<TestAccount> {
  const userId = options.id ?? randomUUID();
  const sessionId = options.sessionId ?? randomUUID();
  await db.query(
    'select bob_private.ensure_test_session($1::uuid, $2::uuid)',
    [userId, sessionId],
  );
  if (options.banned === true) {
    const bannedUntil = new Date(Date.now() + 86_400_000).toISOString();
    await withAdminAuth(db, (admin) => admin.banUser(userId, bannedUntil));
  }
  return { userId, sessionId };
}

/**
 * Ensures an auth.sessions row for an existing account through
 * `bob_private.ensure_test_session` (SECURITY DEFINER, granted to
 * bob_server). This is the only sanctioned way a test creates a session row;
 * hand-writing `insert into auth.sessions` is what caused the sessions_pkey
 * collisions and the `permission denied for schema auth` failures. Idempotent
 * (`on conflict (id) do nothing`), so a replay or a shared template never
 * collides. Returns the session id that was ensured.
 */
export async function addSession(
  db: TestDb,
  userId: string,
  sessionId: string = randomUUID(),
): Promise<string> {
  await db.query(
    'select bob_private.ensure_test_session($1::uuid, $2::uuid)',
    [userId, sessionId],
  );
  return sessionId;
}

/**
 * ADMIN seam (S14-PG-FIXTURE-SEAM): the only sanctioned way a fixture writes
 * `auth.*` against a real Postgres test database. It opens a separate
 * connection as the stack's postgres superuser (reusing `withAdmin` from
 * pg-template.ts) to run ONE of the narrow operations in `AuthAdmin`.
 *
 * Why this exists: direct auth table writes remain privileged. The server
 * uses narrow SECURITY DEFINER functions for test sessions and administrator
 * sign-in changes; it has no general auth table write grants. A fixture that inserts them
 * as bob_server would be exercising a path that does not exist in
 * production, and it fails for the right reason ("permission denied for schema
 * auth"). The TestDb handed to ordinary tests stays on bob_server with
 * rolbypassrls false; only fixtures that deliberately call this seam may touch
 * auth.* as admin. Rows the app DOES create (everything in bob.*) must never
 * go through here -- they belong on the app's own store functions.
 */
export async function withAdminAuth<T>(
  db: TestDb,
  fn: (admin: AuthAdmin) => Promise<T>,
): Promise<T> {
  const database = (db as PgTestDb).databaseName;
  const url = await adminDatabaseUrl(database);
  return withAdmin(url, async (sql) => {
    const admin: AuthAdmin = {
      createUser: async (id: string): Promise<string> => {
        await sql`insert into auth.users (id) values (${id}) on conflict (id) do nothing`;
        return id;
      },
      banUser: async (userId: string, bannedUntil: string): Promise<void> => {
        await sql`update auth.users set banned_until = ${bannedUntil} where id = ${userId}`;
      },
      endSession: async (sessionId: string): Promise<void> => {
        await sql`delete from auth.sessions where id = ${sessionId}`;
      },
      getUser: async (id: string): Promise<Record<string, string | null> | null> => {
        const rows = await sql<Record<string, string | null>[]>`
          select aud, role, confirmation_token, recovery_token, email_change,
                 email_change_token_new, email_change_token_current,
                 phone_change, phone_change_token, reauthentication_token
            from auth.users where id = ${id}`;
        return rows[0] ?? null;
      },
      setAccountState: async (userId, state): Promise<void> => {
        if (state.confirmed !== undefined) await sql`update auth.users set email_confirmed_at = ${state.confirmed ? new Date('2026-01-01T00:00:00Z') : null} where id = ${userId}`;
        if (state.deleted !== undefined) await sql`update auth.users set deleted_at = ${state.deleted ? new Date('2026-01-01T00:00:00Z') : null} where id = ${userId}`;
        if (state.createdAt !== undefined) await sql`update auth.users set created_at = ${state.createdAt} where id = ${userId}`;
      },
      createRefreshToken: async (sessionId, userId): Promise<string> => {
        const token = randomUUID();
        await sql`insert into auth.refresh_tokens (token,user_id,session_id,revoked) values (${token},${userId},${sessionId},false)`;
        return token;
      },
      refreshTokenExists: async (token): Promise<boolean> => {
        const rows = await sql`select 1 from auth.refresh_tokens where token = ${token}`;
        return rows.length > 0;
      },
      setProfile: async (userId: string, profile: { email?: string | null; name?: string }): Promise<void> => {
        if (profile.email !== undefined) {
          await sql`update auth.users set email = ${profile.email} where id = ${userId}`;
        }
        if (profile.name !== undefined) {
          await sql`update auth.users set raw_user_meta_data = jsonb_build_object('name', ${profile.name}::text) where id = ${userId}`;
        }
      },
      sessionExists: async (sessionId: string, userId: string): Promise<boolean> => {
        const rows = await sql<{ n: number }[]>`
          select count(*)::int as n
            from auth.sessions s
            join auth.users u on u.id = s.user_id
           where s.id = ${sessionId} and u.id = ${userId}`;
        return rows[0]?.n === 1;
      },
    };
    return fn(admin);
  });
}

/**
 * data-model.md §1 transaction: sets the transaction-local request.jwt.claims
 * GUC and switches the effective role to authenticated, then runs fn. Used by
 * tests that need raw account-scoped SQL; the Db port (T006) wraps this.
 */
export async function withUserRaw<T>(
  db: TestDb,
  userId: string,
  fn: (tx: TestTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(
      `select set_config('request.jwt.claims',
         json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`,
      [userId],
    );
    await tx.query('set local role authenticated');
    return fn(tx);
  });
}

/** Waits for the work still in flight through asDb(db), then closes the
 *  connection and drops the per-test database. */
export async function closeTestDb(db: TestDb): Promise<void> {
  await Promise.allSettled([...(inFlight.get(db) ?? [])]);
  await db.close();
}