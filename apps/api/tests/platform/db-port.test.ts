// Db port tests (T006, specs/008-supabase-auth-pairing).
// The test-db path runs always (a per-file real Postgres database from the
// migration-complete template, wrapped by asDb). The postgres.js path runs only
// when BOB_TEST_DB_URL points at the local Supabase stack
// (postgresql://postgres:postgres@127.0.0.1:54322/postgres after
// `npx supabase db reset --local`) — see the final describe.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asServer,
  closeDb,
  DATABASE_URL_REQUIRED,
  getDb,
  StoreError,
  withUser,
  type Db,
} from '../../src/platform/db/db.ts';
import {
  addAccount,
  asDb,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

describe('Db port (test database adapter)', () => {
  let pg: TestDb;
  let db: Db;
  let accountA: TestAccount;
  let accountB: TestAccount;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    accountA = await addAccount(pg);
    accountB = await addAccount(pg);
  });

  afterAll(async () => {
    await closeTestDb(pg);
  });

  it('withUser isolates account A from account B through the port', async () => {
    await withUser(db, accountA.userId, async (tx) => {
      await tx.query(
        'insert into bob.conversations (id, user_id, title) values ($1, $2, $3)',
        ['conv_a0001', accountA.userId, 'A first'],
      );
    });
    await withUser(db, accountB.userId, async (tx) => {
      const rows = await tx.query<{ id: string }>('select id from bob.conversations');
      expect(rows).toHaveLength(0);
    });
    await withUser(db, accountA.userId, async (tx) => {
      const rows = await tx.query<{ id: string }>('select id from bob.conversations');
      expect(rows).toHaveLength(1);
    });
  });

  it('nested tx on a transaction-bound Db reuses the same transaction', async () => {
    await withUser(db, accountA.userId, async (tx) => {
      await tx.query(
        'insert into bob.conversations (id, user_id, title) values ($1, $2, $3)',
        ['conv_n0001', accountA.userId, 'outer'],
      );
      await tx.tx(async (inner) => {
        await inner.query(
          'insert into bob.conversations (id, user_id, title) values ($1, $2, $3)',
          ['conv_n0002', accountA.userId, 'inner'],
        );
      });
    });
    // Read back as accountA: a raw bob_server query has no jwt claims, so
    // FORCE RLS on bob.conversations (auth.uid() = user_id) hides both rows.
    const rows = await withUser(db, accountA.userId, (tx) =>
      tx.query<{ id: string }>(
        'select id from bob.conversations where id like $1',
        ['conv_n%'],
      ),
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['conv_n0001', 'conv_n0002']);
  });

  it('tx rolls back every statement when the callback throws', async () => {
    // Give the transaction a user context first: a bare db.tx() runs as
    // bob_server with no jwt claims, so the INSERT itself is rejected by
    // RLS before the callback ever throws boom, and the rollback path this
    // test targets is never exercised.
    await expect(
      withUser(db, accountA.userId, async (tx) => {
        await tx.query(
          'insert into bob.conversations (id, user_id, title) values ($1, $2, $3)',
          ['conv_r0001', accountA.userId, 'rollback me'],
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await db.query<{ id: string }>(
      'select id from bob.conversations where id = $1',
      ['conv_r0001'],
    );
    expect(rows).toHaveLength(0);
  });

  it('asServer allows bob_private functions and rejects plain table queries', async () => {
    await asServer(db, async (sdb) => {
      const rows = await sdb.query<{ session_active: boolean }>(
        'select bob_private.session_active($1) as session_active',
        [accountA.sessionId],
      );
      expect(rows[0]?.session_active).toBe(true);
      await expect(sdb.query('select * from bob.conversations')).rejects.toThrow(
        /bob_private/,
      );
    });
  });

  it('withUser runs fn as the authenticated role with the caller as auth.uid()', async () => {
    const rows = await withUser(db, accountA.userId, (tx) =>
      tx.query<{ role: string; uid: string; claimRole: string }>(
        `select current_user as role, auth.uid()::text as uid,
           current_setting('request.jwt.claims', true)::json->>'role' as "claimRole"`,
      ),
    );
    expect(rows[0]).toEqual({ role: 'authenticated', uid: accountA.userId, claimRole: 'authenticated' });
    // Transaction-local: the next statement outside withUser is the server again.
    const after = await db.query<{ role: string }>('select current_user as role');
    expect(after[0]?.role).not.toBe('authenticated');
  });

  it('withUser rejects and rolls back when fn fails after the pipelined setup', async () => {
    await expect(
      withUser(db, accountA.userId, async (tx) => {
        await tx.query('insert into bob.conversations (id, user_id, title) values ($1, $2, $3)',
          ['conv_p0001', accountA.userId, 'pipelined']);
        await tx.query('select 1/0');
      }),
    ).rejects.toThrow(/division by zero/);
    const rows = await withUser(db, accountA.userId, (tx) =>
      tx.query('select id from bob.conversations where id = $1', ['conv_p0001']));
    expect(rows).toHaveLength(0);
  });

  it('withUser rejects a non-uuid userId before touching SQL', async () => {
    await expect(
      withUser(db, 'not-a-uuid', async (tx) => {
        await tx.query('select 1');
      }),
    ).rejects.toThrow(/uuid/i);
  });
});

/** A Db whose queries stay pending until released, recording what was sent. */
function pendingDb(): { db: Db; sent: string[]; settle: (index: number, error?: Error) => void } {
  const sent: string[] = [];
  const pending: Array<{ resolve: (rows: unknown[]) => void; reject: (error: Error) => void }> = [];
  const db: Db = {
    query: <T>(sql: string): Promise<T[]> => {
      sent.push(sql);
      return new Promise<T[]>((resolve, reject) => pending.push({ resolve: resolve as (rows: unknown[]) => void, reject }));
    },
    tx: (fn) => fn(db),
  };
  const settle = (index: number, error?: Error): void => {
    const entry = pending[index];
    if (!entry) throw new Error(`no query ${index}`);
    if (error) entry.reject(error); else entry.resolve([]);
  };
  return { db, sent, settle };
}

describe('withUser setup (one statement, pipelined)', () => {
  const userId = randomUUID();

  it('sends one setup statement and fn\'s first query without waiting between them', async () => {
    const { db, sent, settle } = pendingDb();
    const run = withUser(db, userId, (tx) => tx.query('select 42'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/set_config\('request\.jwt\.claims'/);
    expect(sent[0]).toMatch(/set_config\('role', 'authenticated', true\)/);
    expect(sent[1]).toBe('select 42');
    settle(0);
    settle(1);
    await expect(run).resolves.toEqual([]);
  });

  it('rejects with the setup failure when the setup statement fails', async () => {
    const { db, settle } = pendingDb();
    const run = withUser(db, userId, (tx) => tx.query('select 42'));
    await new Promise((resolve) => setImmediate(resolve));
    settle(0, new Error('setup failed'));
    settle(1, new Error('current transaction is aborted'));
    await expect(run).rejects.toThrow('setup failed');
  });
});

describe('getDb/closeDb singleton', () => {
  const originalUrl = process.env.BOB_DATABASE_URL;

  afterAll(async () => {
    await closeDb();
    if (originalUrl === undefined) {
      delete process.env.BOB_DATABASE_URL;
    } else {
      process.env.BOB_DATABASE_URL = originalUrl;
    }
  });

  it('returns the same instance until closeDb, then a fresh one', async () => {
    // Force the postgres branch with a never-connected dummy URL: postgres.js
    // opens connections lazily on first query, so constructing is safe.
    process.env.BOB_DATABASE_URL = 'postgres://user:pass@127.0.0.1:1/none';
    await closeDb();
    const db1 = await getDb();
    const db2 = await getDb();
    expect(db1).toBe(db2);
    await closeDb();
    const db3 = await getDb();
    expect(db3).not.toBe(db1);
    await closeDb();
  });

  // One engine everywhere: with no BOB_DATABASE_URL there is no stand-in
  // database, so getDb() refuses and names the fix (never a URL).
  it('rejects with a StoreError naming the fix when BOB_DATABASE_URL is unset', async () => {
    const saved = process.env.BOB_DATABASE_URL;
    delete process.env.BOB_DATABASE_URL;
    try {
      await closeDb();
      const failure = getDb();
      await expect(failure).rejects.toBeInstanceOf(StoreError);
      await expect(failure).rejects.toThrow(DATABASE_URL_REQUIRED);
      expect(DATABASE_URL_REQUIRED).not.toMatch(/:\/\//);
    } finally {
      if (saved === undefined) delete process.env.BOB_DATABASE_URL;
      else process.env.BOB_DATABASE_URL = saved;
      await closeDb();
    }
  });
});

const integrationUrl = process.env.BOB_TEST_DB_URL;

describe.skipIf(!integrationUrl)('Db port (postgres.js, local Supabase)', () => {
  const originalUrl = process.env.BOB_DATABASE_URL;
  let db: Db;
  let accountA: TestAccount;
  let accountB: TestAccount;

  beforeAll(async () => {
    process.env.BOB_DATABASE_URL = integrationUrl!;
    await closeDb();
    db = await getDb();
    accountA = await createPgAccount(db);
    accountB = await createPgAccount(db);
  });

  afterAll(async () => {
    if (db) {
      await db
        .query('delete from auth.users where id in ($1, $2)', [
          accountA.userId,
          accountB.userId,
        ])
        .catch(() => undefined);
    }
    await closeDb();
    if (originalUrl === undefined) {
      delete process.env.BOB_DATABASE_URL;
    } else {
      process.env.BOB_DATABASE_URL = originalUrl;
    }
  });

  it('withUser isolates A from B through the postgres adapter', async () => {
    await withUser(db, accountA.userId, async (tx) => {
      await tx.query(
        'insert into bob.conversations (id, user_id, title) values ($1, $2, $3)',
        ['conv_pg0001', accountA.userId, 'A first'],
      );
    });
    await withUser(db, accountB.userId, async (tx) => {
      const rows = await tx.query<{ id: string }>('select id from bob.conversations');
      expect(rows).toHaveLength(0);
    });
    await withUser(db, accountA.userId, async (tx) => {
      const rows = await tx.query<{ id: string }>('select id from bob.conversations');
      expect(rows).toHaveLength(1);
    });
  });
});

/** Creates an account against the real Supabase auth.users schema through the
 *  sanctioned definer helper (ensure_test_session), never a raw auth insert. */
async function createPgAccount(db: Db): Promise<TestAccount> {
  return addAccount(db as unknown as TestDb);
}