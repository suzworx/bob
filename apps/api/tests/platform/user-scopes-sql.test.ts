/**
 * bob.user_scopes (20261004130000_user_scopes, ANL-SCOPE1): a server-only
 * (user, scope) table reached only through bob_private definers. Runs on the
 * real local Postgres as bob_server; rows are read back through an admin
 * connection because no select definer exists by design.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const FILE = new URL('../../../../supabase/migrations/20261004130000_user_scopes.sql', import.meta.url);
const SCOPE = 'metrics.operator';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

describe('bob.user_scopes (ANL-SCOPE1)', () => {
  let db: TestDb;
  let userId = '';
  let email = '';
  const seeded: string[] = [];
  const admin = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withAdmin(await adminDatabaseUrl((db as unknown as { databaseName: string }).databaseName), async (s) => [
      ...(await s.unsafe<T[]>(sql, params as never[])),
    ]);
  const one = async <T,>(sql: string, params: unknown[]): Promise<T> => {
    const row = (await db.query<T>(sql, params)).rows[0];
    if (row === undefined) throw new Error('no row');
    return row;
  };
  const fn = async (call: string, ...args: unknown[]): Promise<unknown> =>
    (await one<{ v: unknown }>(`select bob_private.${call} as v`, args)).v;
  const asAuthenticated = (sql: string): Promise<unknown> =>
    db.transaction(async (tx) => {
      await tx.exec('set local role authenticated');
      return tx.query(sql);
    });
  const newAccount = async (): Promise<string> => {
    const { userId: id } = await addAccount(db);
    seeded.push(id);
    return id;
  };

  beforeAll(async () => {
    db = await createTestDb();
    userId = await newAccount();
    email = `Scope.Test-${userId}@Example.com`;
    await admin('update auth.users set email = $1 where id = $2::uuid', [email, userId]);
  }, 120_000);

  afterAll(async () => {
    for (const id of seeded) await admin('delete from auth.users where id = $1::uuid', [id]).catch(() => undefined);
    await closeTestDb(db);
  });

  it('forces RLS with zero policies', async () => {
    const [t] = await admin<{ on: boolean; forced: boolean }>(
      `select relrowsecurity as on, relforcerowsecurity as forced from pg_class
        where oid = 'bob.user_scopes'::regclass`);
    expect(t).toEqual({ on: true, forced: true });
    expect(await admin(`select 1 from pg_policies where schemaname = 'bob' and tablename = 'user_scopes'`)).toEqual([]);
  });

  it('denies authenticated select and every function', async () => {
    const u = '00000000-0000-0000-0000-000000000001';
    const denied = [
      'select * from bob.user_scopes',
      `select bob_private.user_has_scope('${u}'::uuid, 'a.b')`,
      `select bob_private.grant_user_scope('${u}'::uuid, 'a.b')`,
      `select bob_private.revoke_user_scope('${u}'::uuid, 'a.b')`,
      `select bob_private.user_scopes_for_email('x@y.z')`,
      `select bob_private.grant_user_scope_by_email('x@y.z', 'a.b')`,
      `select bob_private.revoke_user_scope_by_email('x@y.z', 'a.b')`,
    ];
    for (const sql of denied) await expect(asAuthenticated(sql)).rejects.toThrow(/permission denied/i);
  });

  it('checks a scope: false, grant, true, revoke, false, null is false', async () => {
    expect(await fn('user_has_scope($1::uuid, $2)', userId, SCOPE)).toBe(false);
    expect(await fn('grant_user_scope($1::uuid, $2)', userId, SCOPE)).toBe(true);
    expect(await fn('user_has_scope($1::uuid, $2)', userId, SCOPE)).toBe(true);
    expect(await fn('revoke_user_scope($1::uuid, $2)', userId, SCOPE)).toBe(true);
    expect(await fn('revoke_user_scope($1::uuid, $2)', userId, SCOPE)).toBe(false);
    expect(await fn('user_has_scope($1::uuid, $2)', userId, SCOPE)).toBe(false);
    expect(await fn('user_has_scope($1::uuid, $2)', null, SCOPE)).toBe(false);
    expect(await fn('user_has_scope($1::uuid, $2)', userId, null)).toBe(false);
  });

  it('grants once, then reports a repeat, and rejects an unknown user without its id', async () => {
    expect(await fn('grant_user_scope($1::uuid, $2)', userId, SCOPE)).toBe(true);
    expect(await fn('grant_user_scope($1::uuid, $2)', userId, SCOPE)).toBe(false);
    const ghost = '11111111-2222-3333-4444-555555555555';
    const err = await fn('grant_user_scope($1::uuid, $2)', ghost, SCOPE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/unknown user/i);
    expect(message).not.toContain(ghost);
    expect(message).not.toMatch(UUID_RE);
    await fn('revoke_user_scope($1::uuid, $2)', userId, SCOPE);
  });

  it('resolves by email case-insensitively and lists sorted scopes', async () => {
    expect(await fn('grant_user_scope_by_email($1, $2)', email.toUpperCase(), 'zeta.scope')).toBe(true);
    expect(await fn('grant_user_scope_by_email($1, $2)', email.toLowerCase(), 'alpha.scope')).toBe(true);
    expect(await fn('grant_user_scope_by_email($1, $2)', email, 'alpha.scope')).toBe(false);
    expect(await fn('user_scopes_for_email($1)', email.toLowerCase())).toEqual(['alpha.scope', 'zeta.scope']);
    expect(await fn('revoke_user_scope_by_email($1, $2)', email.toUpperCase(), 'zeta.scope')).toBe(true);
    expect(await fn('revoke_user_scope_by_email($1, $2)', email, 'zeta.scope')).toBe(false);
    expect(await fn('user_scopes_for_email($1)', email)).toEqual(['alpha.scope']);
    expect(await fn('user_scopes_for_email($1)', 'nobody-here@example.com')).toEqual([]);
    await fn('revoke_user_scope_by_email($1, $2)', email, 'alpha.scope');
  });

  it('raises unknown_account for an unknown email without echoing it', async () => {
    const nobody = 'nobody-here@example.com';
    for (const call of ['grant_user_scope_by_email($1, $2)', 'revoke_user_scope_by_email($1, $2)']) {
      const err = await fn(call, nobody, SCOPE).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('unknown_account');
      expect((err as Error).message).not.toContain(nobody);
    }
  });

  it('rejects scope names outside the contract', async () => {
    for (const bad of ['Metrics.Operator', 'x', 'has space', 'a'.repeat(65)]) {
      await expect(fn('grant_user_scope($1::uuid, $2)', userId, bad)).rejects.toThrow(/violates check constraint/i);
    }
  });

  it('purge_account_scopes removes one user\'s scopes, counts them, and leaves others alone', async () => {
    const mine = await newAccount();
    const other = await newAccount();
    for (const s of ['a.one', 'a.two', 'a.three']) await fn('grant_user_scope($1::uuid, $2)', mine, s);
    await fn('grant_user_scope($1::uuid, $2)', other, 'a.one');
    expect(await fn('purge_account_scopes($1::uuid)', mine)).toBe(3);
    expect(await fn('purge_account_scopes($1::uuid)', mine)).toBe(0);
    expect(await admin('select 1 from bob.user_scopes where user_id = $1::uuid', [mine])).toEqual([]);
    expect(await fn('user_has_scope($1::uuid, $2)', other, 'a.one')).toBe(true);
    await expect(asAuthenticated(`select bob_private.purge_account_scopes('${other}'::uuid)`)).rejects.toThrow(/permission denied/i);
  });

  it('deletes the scopes with the auth user (cascade)', async () => {
    const id = await newAccount();
    await fn('grant_user_scope($1::uuid, $2)', id, SCOPE);
    await admin('delete from auth.users where id = $1::uuid', [id]);
    expect(await admin('select 1 from bob.user_scopes where user_id = $1::uuid', [id])).toEqual([]);
  });

  it('keeps email and free text out of the file, and re-applies cleanly', async () => {
    const sql = readFileSync(FILE, 'utf8');
    const table = /create table if not exists bob\.user_scopes \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? '';
    expect(table).toContain('user_id');
    expect(table).not.toMatch(/email|note|reason|granted_by|grantor|comment|description/i);
    expect(table.match(/\btext\b/g)).toHaveLength(1);
    await admin(sql);
    await admin(sql);
    expect(await fn('user_has_scope($1::uuid, $2)', userId, SCOPE)).toBe(false);
  });
});
