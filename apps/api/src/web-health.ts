/**
 * GET /health with the database schema version (#349, docs/deploy.md
 * "Migrations: expand, then contract").
 *
 * The schema this code was written against is DERIVED, not pinned: at startup
 * the server reads the version (filename prefix) of the newest file under the
 * supabase/migrations folder that ships with it. The image carries only the
 * file names there (Dockerfile, `migrations` stage), so a PR that adds a
 * migration edits nothing here. No folder (or no migration in it) means the
 * expected version is null and the status is `unknown`.
 *
 * /health reports the newest applied version and how it compares:
 *   ok             applied == expected
 *   schema_behind  the migration this code needs has not been applied yet
 *   schema_ahead   the schema is newer than this code (a later deploy is due)
 *   unknown        the history or the shipped migrations could not be read
 * The status is informational (200) unless BOB_SCHEMA_STRICT=1, which turns
 * schema_behind into a 503 so Railway's health check holds the new deployment
 * back until the migration lands (ordering option (a) in docs/deploy.md).
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { moduleJournal } from './platform/logger.ts';
import { V2_PATH, V2_PROTOCOL } from './voice/protocol.ts';
import type { Db } from './platform/db/db.ts';

const journal = moduleJournal('server');

/** supabase/migrations at the repo root; /app/supabase/migrations in the image. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

/** Version of the newest `<digits>_*.sql` in `dir`; null when there is none or no folder. */
export function readExpectedSchemaVersion(dir: string = MIGRATIONS_DIR): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const versions = names.filter((n) => /^\d+_.*\.sql$/.test(n)).map((n) => n.slice(0, n.indexOf('_')));
  return versions.sort().pop() ?? null;
}

/** Read once at startup from the migrations shipped with this code. */
export const EXPECTED_SCHEMA_VERSION: string | null = readExpectedSchemaVersion();

export type SchemaStatus = 'ok' | 'schema_behind' | 'schema_ahead' | 'unknown';

interface SchemaCheck {
  schema_version: string | null;
  schema_expected: string | null;
  schema_status: SchemaStatus;
}

/** How long one lookup may take before /health answers `unknown`. */
const LOOKUP_TIMEOUT_MS = 2_000;
/** /health is polled; the history changes once per deploy at most. */
const CACHE_MS = 30_000;

/** Compares two 14-digit versions; equal length makes string order numeric. */
export function compareSchema(applied: string | null, expected: string | null = EXPECTED_SCHEMA_VERSION): SchemaStatus {
  if (!applied || !expected) return 'unknown';
  if (applied === expected) return 'ok';
  return applied < expected ? 'schema_behind' : 'schema_ahead';
}

/**
 * Newest applied version: `supabase db push` records it in
 * supabase_migrations.schema_migrations (hosted and local stack), which
 * bob_server reads only through bob_private.schema_version()
 * (20260926120000_server_reads_schema_version.sql); a superuser connection
 * reads the table itself. Null when neither is readable.
 */
export async function readAppliedSchemaVersion(db: Db): Promise<string | null> {
  const lookups = [
    'select bob_private.schema_version() as version',
    'select max(version)::text as version from supabase_migrations.schema_migrations',
  ];
  for (const sql of lookups) {
    try {
      const rows = await db.query<{ version: string | null }>(sql);
      if (rows[0]?.version) return rows[0].version;
    } catch {
      // Missing table or grant: try the next source.
    }
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

export async function checkSchema(
  db: () => Promise<Db>,
  timeoutMs: number = LOOKUP_TIMEOUT_MS,
  expected: string | null = EXPECTED_SCHEMA_VERSION,
): Promise<SchemaCheck> {
  const applied = await withTimeout(
    db().then((handle) => readAppliedSchemaVersion(handle)),
    timeoutMs,
    null,
  );
  return { schema_version: applied, schema_expected: expected, schema_status: compareSchema(applied, expected) };
}

interface HealthRouteOptions {
  db: () => Promise<Db>;
  strict?: boolean;
  now?: () => number;
  timeoutMs?: number;
  /** Folder to derive the expected version from; defaults to the shipped one. */
  migrationsDir?: string;
}

/**
 * The /health handler. Creating it runs the startup check once and journals
 * `v2.schema_check`, so mount it at boot: `app.get('/health', createHealthRoute({ db: getDb }))`.
 */
export function createHealthRoute(options: HealthRouteOptions): (request: Request, response: Response) => Promise<void> {
  const db = options.db;
  const strict = options.strict ?? process.env.BOB_SCHEMA_STRICT === '1';
  const now = options.now ?? Date.now;
  const expected = options.migrationsDir === undefined ? EXPECTED_SCHEMA_VERSION : readExpectedSchemaVersion(options.migrationsDir);
  let cached: { at: number; check: Promise<SchemaCheck> } | null = null;
  const current = (): Promise<SchemaCheck> => {
    if (!cached || now() - cached.at >= CACHE_MS) cached = { at: now(), check: checkSchema(db, options.timeoutMs, expected) };
    return cached.check;
  };
  void current().then((check) =>
    journal('v2.schema_check', { ...check, schema_version: check.schema_version ?? undefined, schema_expected: check.schema_expected ?? undefined, strict }),
  );
  return async (_request: Request, response: Response): Promise<void> => {
    const check = await current();
    const blocked = strict && check.schema_status === 'schema_behind';
    response.status(blocked ? 503 : 200).json({ ok: !blocked, protocol: V2_PROTOCOL, path: V2_PATH, ...check });
  };
}
