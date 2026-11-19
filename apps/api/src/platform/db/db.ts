/**
 * Database access for conversation and account persistence.
 *
 * One store: the Db port (T006, specs/008-supabase-auth-pairing) — a
 * query/tx interface over postgres.js plus the withUser / asServer account
 * helpers. One engine everywhere: real Postgres, the local Supabase stack in
 * development, tests and HIL, hosted Supabase in production. getDb() needs
 * BOB_DATABASE_URL and refuses without it.
 */
import postgres from 'postgres';

/**
 * The store port shared by every backend: query rows with parameters, and run
 * a unit of work in one transaction. A tx() bound Db reuses the same
 * transaction, so withUser / asServer and nested store calls compose.
 */
export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

/** withUser validates this before touching any SQL (data-model.md §1). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-instance close handles so closeDb() can release any adapter. */
const closers = new WeakMap<Db, () => Promise<void>>();

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export class StoreConflictError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = 'StoreConflictError';
  }
}

export class StoreNotFoundError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = 'StoreNotFoundError';
  }
}

// --- Db port: adapters, account helpers, singleton -------------------------

/** Driver-boundary cast: the Db port accepts any runtime value (unknown[]),
 * while postgres.js types parameters against its custom type maps. */
function pgParams(params: unknown[] | undefined): postgres.ParameterOrJSON<never>[] {
  return (params ?? []) as postgres.ParameterOrJSON<never>[];
}

/** postgres.js adapter: pool max 5, session-mode pooler friendly (prepared
 * statements stay on). Idle connections are kept (idle_timeout 0): reaping
 * them made the next turn pay reconnect, TLS and every statement's prepare
 * again. The pool still holds at most 5 per process, postgres.js recycles each
 * connection after its max_lifetime (30-60 min) and TCP keepalive (60 s)
 * holds idle sockets open through NAT (R1). */
export function createPostgresDb(url: string): Db {
  const sql = postgres(url, { max: 5, idle_timeout: 0, prepare: true });
  const db: Db = {
    query<T>(sqlText: string, params?: unknown[]): Promise<T[]> {
      return sql.unsafe<T[]>(sqlText, pgParams(params), { prepare: true });
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      // postgres.js begin() types its result through UnwrapPromiseArray; fn
      // never returns an array of promises, so the unwrap is the identity.
      return sql.begin(async (tx) => fn(wrapPostgresTx(tx))) as Promise<T>;
    },
  };
  closers.set(db, () => sql.end());
  return db;
}

/** A Db bound to a postgres.js transaction; nested tx() reuses the transaction. */
function wrapPostgresTx(tx: postgres.TransactionSql): Db {
  return {
    query<T>(sqlText: string, params?: unknown[]): Promise<T[]> {
      return tx.unsafe<T[]>(sqlText, pgParams(params), { prepare: true });
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      return fn(wrapPostgresTx(tx));
    },
  };
}

/**
 * data-model.md §1: run fn in one transaction with the request.jwt.claims GUC
 * set to userId and the effective role switched to authenticated, so Supabase's
 * auth.uid() and the RLS policies see the caller as that account (R3).
 */
export async function withUser<T>(
  db: Db,
  userId: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(userId)) {
    throw new StoreError('withUser: invalid userId, expected a uuid');
  }
  return db.tx(async (tx) => {
    // One setup statement (set_config('role', ..., true) is SET LOCAL ROLE),
    // sent before fn runs and not awaited first: fn's first query rides the
    // same round trip. Statements on one connection run in order, so fn still
    // sees the role and claims; a setup failure aborts the transaction, and
    // Promise.all rejects with it first, so the transaction rolls back.
    const setup = tx.query(
      `select set_config('request.jwt.claims',
         json_build_object('sub', $1::text, 'role', 'authenticated')::text, true),
       set_config('role', 'authenticated', true)`,
      [userId],
    ).then(() => undefined);
    const work = (async () => fn(tx))(); // a sync throw becomes a rejection
    const [, result] = await Promise.all([setup, work]);
    return result;
  });
}

/**
 * The complement of withUser: no claims, no role switch. fn receives a Db whose
 * query() throws unless the SQL text calls an bob_private.* function, so a
 * store module that should run as the server cannot accidentally touch account
 * rows (plan.md §A).
 */
export function asServer<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  return fn(asServerView(db));
}

function asServerView(db: Db): Db {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (!sql.includes('bob_private.')) {
        throw new StoreError('asServer: only bob_private functions may be called');
      }
      return db.query<T>(sql, params);
    },
    tx<T>(fn: (txDb: Db) => Promise<T>): Promise<T> {
      return db.tx((tx) => fn(asServerView(tx)));
    },
  };
}

let sharedDb: Promise<Db> | null = null;

/** What getDb() and the boot check say when BOB_DATABASE_URL is missing.
 *  Names the fix, never a URL. */
export const DATABASE_URL_REQUIRED =
  'BOB_DATABASE_URL is required: run `npm run dev:offline` or point it at the local Supabase stack';

export const DATABASE_URL_DIRECT_HOST =
  'BOB_DATABASE_URL points at the Supabase direct host, which is IPv6-only and unreachable from the production host: use the Session pooler connection string (Supabase dashboard, Connect)';

/** Supabase's direct host is db.<project-ref>.supabase.co; matched by shape so no project ref is baked in. */
const SUPABASE_DIRECT_HOST = /^db\.[a-z0-9]+\.supabase\.co$/;

export function isSupabaseDirectHost(url: string): boolean {
  if (!URL.canParse(url)) return false;
  return SUPABASE_DIRECT_HOST.test(new URL(url).hostname.toLowerCase());
}

/** The process-wide Db (R2): postgres at BOB_DATABASE_URL. Rejects with a
 * StoreError when it is unset; there is no stand-in database. */
export function getDb(): Promise<Db> {
  if (!sharedDb) {
    const url = process.env.BOB_DATABASE_URL;
    if (!url) return Promise.reject(new StoreError(DATABASE_URL_REQUIRED));
    sharedDb = Promise.resolve(createPostgresDb(url));
  }
  return sharedDb;
}

/** Test seam: close the shared Db and forget it so the next getDb() reopens. */
export async function closeDb(): Promise<void> {
  const managed = sharedDb;
  sharedDb = null;
  if (!managed) return;
  const db = await managed.catch(() => null);
  if (db) await endDb(db);
}

/** Closes a createPostgresDb() pool so a one-shot script can exit (idle connections are kept). */
export async function endDb(db: Db): Promise<void> {
  await closers.get(db)?.();
}

/** Test seam: replace the process-wide Db so routes and session handling that
 *  call getDb() internally share the caller's instance (asDb() over a per-test
 *  database from tests/support/test-db.ts). closeDb() closes and forgets it,
 *  exactly as it does for a getDb()-created instance. */
export function setSharedDb(db: Promise<Db>): void {
  sharedDb = db;
}