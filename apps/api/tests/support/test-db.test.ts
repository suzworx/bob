// test-db.test.ts — proves the real-Postgres test harness itself (S14).
// Everything else rests on these five guarantees: the database works with
// migrations applied, per-test databases are isolated, the connection is the
// production `bob_server` role with RLS genuinely enforced (not a superuser
// that silently bypasses it), and teardown drops the database.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addAccount,
  asDb,
  closeTestDb,
  createTestDb,
  withAdminAuth,
  withUserRaw,
  type TestAccount,
  type TestDb,
} from './test-db.ts';
import { databaseExists } from './pg-template.ts';

/** Creates a conversation row under `owner` through real account-scoped SQL. */
async function insertConversation(
  db: TestDb,
  owner: TestAccount,
  id: string,
  title = 'A conv',
): Promise<void> {
  await withUserRaw(db, owner.userId, async (tx) => {
    await tx.query(
      'insert into bob.conversations (id, user_id, title) values ($1, $2, $3)',
      [id, owner.userId, title],
    );
  });
}

describe('real-Postgres test database (S14-PGSQL-HARNESS)', () => {
  it('createTestDb returns a working Db with the migrations applied', async () => {
    const db = await createTestDb();
    try {
      const table = await db.query<{ name: string | null }>(
        'select to_regclass($1)::text as name',
        ['bob.conversations'],
      );
      expect(table.rows[0]?.name).toBe('bob.conversations');
      // A migration-only table proves the template is not the empty shell.
      const tasks = await db.query<{ name: string | null }>(
        'select to_regclass($1)::text as name',
        ['bob.tasks'],
      );
      expect(tasks.rows[0]?.name).toBe('bob.tasks');
      // Every privileged definer lives in bob_private. A template published
      // before its restore finished was cloned with this schema MISSING, and the
      // symptom was scattered "schema bob_private does not exist" failures in
      // ~17 unrelated files. Asserting it here makes that regression fail in one
      // obvious place instead.
      const schema = await db.query<{ present: boolean }>(
        `select exists (select 1 from pg_namespace where nspname = 'bob_private') as present`,
      );
      expect(schema.rows[0]?.present, 'template is missing bob_private: was it cloned mid-build?').toBe(true);
    } finally {
      await closeTestDb(db);
    }
    // The first test in the file pays the per-process template warm-up; its
    // siblings already allow 30 s for the same reason.
  }, 30_000);

  it('two databases acquired concurrently are isolated', async () => {
    const dbA = await createTestDb();
    const dbB = await createTestDb();
    try {
      const owner = await addAccount(dbA);
      await insertConversation(dbA, owner, `conv_isola_${randomUUID().slice(0, 8)}`);

      // dbB has its own copy of the schema and its own empty tables. Read it AS
      // THE OWNER: a bare read has no user context, so under RLS it returns 0
      // whether or not the databases are isolated -- it could not tell a leak
      // from RLS hiding rows. As the owner, isolation reads 0 and a leak reads 1.
      const seen = await withUserRaw(dbB, owner.userId, (tx) =>
        tx.query<{ n: number }>('select count(*)::int as n from bob.conversations'),
      );
      expect(seen.rows[0]?.n).toBe(0);
    } finally {
      await closeTestDb(dbB);
      await closeTestDb(dbA);
    }
  }, 30_000);

  it('the connection is NOT a superuser: bob_server, rolbypassrls false', async () => {
    const db = await createTestDb();
    try {
      const role = await db.query<{ user: string; bypass: boolean }>(
        `select current_user as user,
                (select rolbypassrls from pg_roles where rolname = current_user) as bypass`,
      );
      expect(role.rows[0]?.user).toBe('bob_server');
      expect(role.rows[0]?.bypass).toBe(false);
    } finally {
      await closeTestDb(db);
    }
  });

  it('RLS is genuinely enforced: an unauthorized select returns zero rows', async () => {
    const db = await createTestDb();
    try {
      const owner = await addAccount(db);
      const outsider = await addAccount(db);
      await insertConversation(db, owner, `conv_rls_${randomUUID().slice(0, 8)}`);

      // The row exists for the owner...
      const mine = await db.query<{ n: number }>(
        'select count(*)::int as n from bob.conversations',
      );
      // ...but the base connection has no claims: FORCE RLS hides it.
      expect(mine.rows[0]?.n).toBe(0);

      // And another account with claims but no ownership sees zero too.
      await withUserRaw(db, outsider.userId, async (tx) => {
        const rows = await tx.query<{ id: string }>('select id from bob.conversations');
        expect(rows.rows).toHaveLength(0);
      });

      // The owner sees exactly their own row through the same policy.
      await withUserRaw(db, owner.userId, async (tx) => {
        const rows = await tx.query<{ id: string }>('select id from bob.conversations');
        expect(rows.rows).toHaveLength(1);
      });
    } finally {
      await closeTestDb(db);
    }
  });

  it('the admin seam can create an auth user visible to the app connection', async () => {
    const db = await createTestDb();
    try {
      const id = randomUUID();
      await withAdminAuth(db, (admin) => admin.createUser(id));

      // The app connection can now own a conversation referencing that user id:
      // conversations.user_id is a FK to auth.users, so the insert only resolves
      // if the admin-created row is genuinely there. The owner sees their row
      // through the account-scoped path (FORCE RLS hides it from the bare
      // connection, which has no claims).
      await insertConversation(
        db,
        { userId: id, sessionId: randomUUID() },
        `conv_admin_${randomUUID().slice(0, 8)}`,
      );
      await withUserRaw(db, id, async (tx) => {
        const rows = await tx.query<{ n: number }>(
          'select count(*)::int as n from bob.conversations',
        );
        expect(rows.rows[0]?.n).toBe(1);
      });
    } finally {
      await closeTestDb(db);
    }
  });

  it('addAccount({ banned: true }) succeeds and reads back as banned', async () => {
    const db = await createTestDb();
    try {
      const account = await addAccount(db, { banned: true });
      const rows = await db.query<{ disabled: boolean }>(
        'select bob_private.account_disabled($1::uuid) as disabled',
        [account.userId],
      );
      expect(rows.rows[0]?.disabled).toBe(true);
    } finally {
      await closeTestDb(db);
    }
  });

  it('the app connection CANNOT write auth.users directly', async () => {
    const db = await createTestDb();
    try {
      await expect(
        db.query('insert into auth.users (id) values ($1)', [randomUUID()]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await closeTestDb(db);
    }
  });

  it('the admin seam does not leak onto the TestDb handle', async () => {
    const db = await createTestDb();
    try {
      // The object handed to tests is only the TestDb surface: query/exec/
      // transaction/close. No admin method, no way to run arbitrary SQL as a
      // superuser — that path is the separate explicit `withAdminAuth` function.
      const proto = Object.getPrototypeOf(db) as Record<string, unknown>;
      expect(Object.getOwnPropertyNames(proto)).toEqual(
        expect.arrayContaining(['query', 'exec', 'transaction', 'close']),
      );
      expect(proto.withAdminAuth).toBeUndefined();
      expect(proto.withAdmin).toBeUndefined();
      // And even if a test tried, the facade itself still cannot reach auth.*.
      await expect(
        db.query('insert into auth.users (id) values ($1)', [randomUUID()]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await closeTestDb(db);
    }
  });

  it('teardown drops the per-test database', async () => {
    const db = await createTestDb();
    const current = await db.query<{ database: string }>('select current_database() as database');
    const name = current.rows[0]!.database;
    expect(await databaseExists(name)).toBe(true);

    await closeTestDb(db);

    expect(await databaseExists(name)).toBe(false);
  });

  it('asDb is the Db port over the handle: rows, and one transaction a nested tx() shares', async () => {
    const db = await createTestDb();
    try {
      const port = asDb(db);
      expect(await port.query<{ n: number }>('select 1::int as n')).toEqual([{ n: 1 }]);
      const failing = port.tx(async (tx) => {
        await tx.query(`select set_config('bob.probe', 'set', true)`);
        const seen = await tx.tx((inner) => inner.query<{ v: string }>(`select current_setting('bob.probe') as v`));
        expect(seen).toEqual([{ v: 'set' }]);
        throw new Error('roll back');
      });
      await expect(failing).rejects.toThrow('roll back');
    } finally {
      await closeTestDb(db);
    }
  });
});
