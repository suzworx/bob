import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, createPostgresDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { acquireDatabase, adminDatabaseUrl, releaseDatabase, withAdmin } from '../support/pg-template.ts';
import {
  EXPECTED_SCHEMA_VERSION,
  MIGRATIONS_DIR,
  compareSchema,
  createHealthRoute,
  readAppliedSchemaVersion,
  readExpectedSchemaVersion,
} from '../../src/web-health.ts';

/** A Db whose query answers per SQL substring; anything else throws, as a
 *  missing table or grant would. */
function fakeDb(answers: Record<string, string | null>): Db {
  const db: Db = {
    async query<T>(sql: string): Promise<T[]> {
      for (const [needle, version] of Object.entries(answers)) {
        if (sql.includes(needle)) return [{ version } as T];
      }
      throw new Error('relation does not exist');
    },
    tx<T>(fn: (inner: Db) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  return db;
}

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

async function callHealth(handler: (req: Request, res: Response) => Promise<void>): Promise<Captured> {
  const captured: Captured = { status: 0, body: {} };
  const response = {
    status(code: number): Response {
      captured.status = code;
      return response as unknown as Response;
    },
    json(body: Record<string, unknown>): Response {
      captured.body = body;
      return response as unknown as Response;
    },
  };
  await handler({} as Request, response as unknown as Response);
  return captured;
}

const behind = '20200101000000';
const ahead = '29990101000000';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('compareSchema', () => {
  it('orders versions', () => {
    expect(compareSchema(EXPECTED_SCHEMA_VERSION)).toBe('ok');
    expect(compareSchema(behind)).toBe('schema_behind');
    expect(compareSchema(ahead)).toBe('schema_ahead');
    expect(compareSchema(null)).toBe('unknown');
    expect(compareSchema(behind, null)).toBe('unknown');
  });
});

describe('expected schema version is derived from the shipped migrations', () => {
  const dirs: string[] = [];
  function migrationsDir(names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'bob-migrations-'));
    dirs.push(dir);
    for (const name of names) writeFileSync(join(dir, name), '');
    return dir;
  }
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('is the newest numbered .sql file in the folder', () => {
    const dir = migrationsDir(['20260101000000_a.sql', '20260301000000_c.sql', 'README.md', '20260201000000_b.sql', '29990101000000_x.txt']);
    expect(readExpectedSchemaVersion(dir)).toBe('20260301000000');
  });

  it('follows a newly added migration with no code edit', () => {
    const dir = migrationsDir(['20260101000000_a.sql']);
    writeFileSync(join(dir, '20270101000000_new.sql'), '');
    expect(readExpectedSchemaVersion(dir)).toBe('20270101000000');
  });

  it('is the newest file in the repo migrations at startup', () => {
    expect(EXPECTED_SCHEMA_VERSION).toMatch(/^\d{14}$/);
    expect(EXPECTED_SCHEMA_VERSION).toBe(readExpectedSchemaVersion(MIGRATIONS_DIR));
    expect(readdirSync(MIGRATIONS_DIR)).toContain(readdirSync(MIGRATIONS_DIR).find((n) => n.startsWith(`${EXPECTED_SCHEMA_VERSION}_`)));
  });

  it('is null when the folder is absent or empty', () => {
    expect(readExpectedSchemaVersion(join(tmpdir(), 'bob-no-such-migrations-dir'))).toBeNull();
    expect(readExpectedSchemaVersion(migrationsDir([]))).toBeNull();
  });

  it('/health answers unknown (200 even when strict) when the folder is absent', async () => {
    const handler = createHealthRoute({
      db: async () => fakeDb({ supabase_migrations: behind }),
      strict: true,
      migrationsDir: join(tmpdir(), 'bob-no-such-migrations-dir'),
    });
    const { status, body } = await callHealth(handler);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, schema_version: behind, schema_expected: null, schema_status: 'unknown' });
  });

  it('/health compares against the folder it was given', async () => {
    const dir = migrationsDir(['20260101000000_a.sql', '20260201000000_b.sql']);
    const handler = createHealthRoute({ db: async () => fakeDb({ supabase_migrations: '20260101000000' }), strict: true, migrationsDir: dir });
    const { status, body } = await callHealth(handler);
    expect(status).toBe(503);
    expect(body).toMatchObject({ schema_expected: '20260201000000', schema_status: 'schema_behind' });
  });
});

describe('readAppliedSchemaVersion', () => {
  it('reads the supabase migration history', async () => {
    const db = fakeDb({ supabase_migrations: '20260926110000' });
    expect(await readAppliedSchemaVersion(db)).toBe('20260926110000');
  });

  it('is null when no history is readable', async () => {
    expect(await readAppliedSchemaVersion(fakeDb({}))).toBeNull();
  });
});

describe('GET /health schema fields', () => {
  it('reports schema_version, the expected version and ok', async () => {
    const handler = createHealthRoute({ db: async () => fakeDb({ supabase_migrations: EXPECTED_SCHEMA_VERSION }), strict: false });
    const { status, body } = await callHealth(handler);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      schema_version: EXPECTED_SCHEMA_VERSION,
      schema_expected: EXPECTED_SCHEMA_VERSION,
      schema_status: 'ok',
    });
    expect(body.protocol).toBeTypeOf('string');
  });

  it('reports schema_behind but stays 200 when not strict', async () => {
    const handler = createHealthRoute({ db: async () => fakeDb({ supabase_migrations: behind }), strict: false });
    const { status, body } = await callHealth(handler);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, schema_status: 'schema_behind', schema_version: behind });
  });

  it('answers 503 on schema_behind when strict (deploy ordering option a)', async () => {
    const handler = createHealthRoute({ db: async () => fakeDb({ supabase_migrations: behind }), strict: true });
    const { status, body } = await callHealth(handler);
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, schema_status: 'schema_behind' });
  });

  it('stays 200 in strict mode when the schema is ahead or unknown', async () => {
    const aheadRoute = createHealthRoute({ db: async () => fakeDb({ supabase_migrations: ahead }), strict: true });
    expect((await callHealth(aheadRoute)).status).toBe(200);
    const unknownRoute = createHealthRoute({ db: async () => Promise.reject(new Error('no database')), strict: true });
    const { status, body } = await callHealth(unknownRoute);
    expect(status).toBe(200);
    expect(body).toMatchObject({ schema_status: 'unknown', schema_version: null });
  });

  it('answers unknown when the lookup hangs', async () => {
    const hanging = createHealthRoute({ db: () => new Promise<Db>(() => {}), strict: false, timeoutMs: 20 });
    expect((await callHealth(hanging)).body).toMatchObject({ schema_status: 'unknown' });
  });

  it('journals v2.schema_check once at startup and caches the lookup', async () => {
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    const query = vi.fn(async () => [{ version: EXPECTED_SCHEMA_VERSION }]);
    const db = { query, tx: vi.fn() } as unknown as Db;
    const handler = createHealthRoute({ db: async () => db, strict: false, now: () => 0 });
    try {
      await callHealth(handler);
      await callHealth(handler);
    } finally { setJournalSink(null); }
    expect(query).toHaveBeenCalledTimes(1);
    const checks = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === 'v2.schema_check');
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ schema_status: 'ok', schema_version: EXPECTED_SCHEMA_VERSION });
  });
});

// The real path on the local Supabase stack: the app's own role, bob_server,
// against the `postgres` database that `supabase start` / `migration up
// --local` migrated, through 20260926120000_server_reads_schema_version.sql.
describe('GET /health on the local stack as bob_server', () => {
  let server: Db;
  let perTest: { database: string; url: string };
  let isolated: Db;
  let applied: string | null;

  /** Db has no close of its own; closeDb() closes whichever Db is shared. */
  async function close(db: Db | undefined): Promise<void> {
    if (!db) return;
    setSharedDb(Promise.resolve(db));
    await closeDb();
  }

  beforeAll(async () => {
    // Acquiring a database also sets the bob_server password on the stack.
    perTest = await acquireDatabase();
    const url = new URL(perTest.url);
    url.pathname = '/postgres';
    server = createPostgresDb(url.toString());
    isolated = createPostgresDb(perTest.url);
    applied = await withAdmin(await adminDatabaseUrl('postgres'), async (admin) => {
      const rows = await admin.unsafe<{ version: string | null }[]>('select max(version)::text as version from supabase_migrations.schema_migrations');
      return rows[0]?.version ?? null;
    });
  });

  afterAll(async () => {
    await close(server);
    await close(isolated);
    await releaseDatabase(perTest.database);
  });

  it('reports the newest applied version and its status', async () => {
    expect(applied, 'run `npx supabase migration up --local`').toMatch(/^\d{14}$/);
    const { status, body } = await callHealth(createHealthRoute({ db: async () => server, strict: false }));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      schema_version: applied,
      schema_expected: EXPECTED_SCHEMA_VERSION,
      schema_status: compareSchema(applied),
    });
  });

  it('reads the version through the definer only, never the history table', async () => {
    await expect(server.query('select max(version) from supabase_migrations.schema_migrations')).rejects.toThrow(/permission denied/);
    expect((await server.query<{ version: string }>('select bob_private.schema_version() as version'))[0]?.version).toBe(applied);
  });

  it('answers null where there is no migration history (per-test databases)', async () => {
    const rows = await isolated.query<{ version: string | null }>('select bob_private.schema_version() as version');
    expect(rows[0]?.version).toBeNull();
  });
});
