import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { AdminWaitlistResponseSchema } from '../../src/account/admin-waitlist-schemas.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addAccount, closeTestDb, createTestDb, withAdminAuth, type TestDb, type TestAccount } from '../support/test-db.ts';

let pg: TestDb;
let actor: TestAccount;
async function adminSql(sql: string): Promise<void> {
  const name = (pg as TestDb & { databaseName: string }).databaseName;
  await withAdmin(await adminDatabaseUrl(name), async (admin) => { await admin.unsafe(sql); });
}
async function search(query = '', limit = 25, cursor: string | null = null, status = 'all'): Promise<Record<string, unknown>> {
  const { rows } = await pg.query<{ result: Record<string, unknown> }>(
    'select bob_private.admin_waitlist_search($1::uuid,$2::uuid,$3::text,$4::int,$5::text,$6::text) as result',
    [actor.userId, actor.sessionId, query, limit, cursor, status],
  );
  return rows[0]?.result ?? {};
}
describe('admin waitlist SQL contract', () => {
  beforeAll(async () => {
    pg = await createTestDb();
    actor = await addAccount(pg);
    await withAdminAuth(pg, (auth) => auth.setProfile(actor.userId, { email: 'admin@example.test' }));
  });
  afterAll(async () => { if (pg) await closeTestDb(pg); });
  it('requires fresh admin authority inside the SQL function', async () => {
    await expect(search()).rejects.toMatchObject({ code: '42501' });
    await pg.query("select bob_private.grant_user_scope($1::uuid,'accounts.admin')", [actor.userId]);
    expect(await search()).toMatchObject({ entries: [], counts: { total: 0 }, nextCursor: null });
  });
  it('paginates equal timestamps, applies literal search and status filters, and keeps counts global', async () => {
    const existing = await addAccount(pg);
    await withAdminAuth(pg, async (auth) => {
      await auth.setProfile(existing.userId, { email: 'match@example.test' });
      await auth.banUser(existing.userId, '2099-01-01T00:00:00Z');
    });
    await adminSql(`insert into bob.waitlist(email,created_at,verified_at,source) values
      ('Match@example.test','2026-01-01','2026-01-02','landing'),
      ('waiting@example.test','2026-01-01','2026-01-02','landing'),
      ('literal_%@example.test','2026-01-01',null,'landing')`);
    const first = AdminWaitlistResponseSchema.parse(await search('', 2));
    const second = AdminWaitlistResponseSchema.parse(await search('', 2, first.nextCursor));
    expect(new Set([...first.entries, ...second.entries].map(row => row.id)).size).toBe(3);
    expect(second.nextCursor).toBeNull();
    const counts = { total: 3, verified: 2, pending: 1, withAccount: 1, waitingVerified: 1 };
    expect(first.counts).toEqual(counts);
    const literal = AdminWaitlistResponseSchema.parse(await search('literal_%'));
    expect(literal.entries).toHaveLength(1);
    expect(literal.counts).toEqual(counts);
    const waiting = AdminWaitlistResponseSchema.parse(await search('', 25, null, 'waiting'));
    expect(waiting.entries.map(row => row.email)).toEqual(['waiting@example.test']);
    const matched = AdminWaitlistResponseSchema.parse(await search('', 25, null, 'with_account'));
    expect(matched.entries).toEqual([expect.objectContaining({ email: 'Match@example.test', accountStatus: 'disabled' })]);
    const serialized = JSON.stringify(first);
    for (const secret of ['code_hash', 'code_expires_at', 'generation_token', 'last_sent_at']) expect(serialized).not.toContain(secret);
    await expect(search('', 0)).rejects.toMatchObject({ code: '22023' });
    await expect(search('', 25, '{}')).rejects.toMatchObject({ code: '22023' });
    await expect(search('', 25, null, 'unknown')).rejects.toMatchObject({ code: '22023' });
  });
  it('rejects stale and disabled sessions, revoked admin scope, and direct authenticated execution', async () => {
    const other = await addAccount(pg);
    await expect(pg.query('select bob_private.admin_waitlist_search($1::uuid,$2::uuid,\'\',25)', [actor.userId, other.sessionId])).rejects.toMatchObject({ code: '42501' });
    await withAdminAuth(pg, auth => auth.banUser(actor.userId, '2099-01-01T00:00:00Z'));
    await expect(search()).rejects.toMatchObject({ code: '42501' });
    await withAdminAuth(pg, auth => auth.banUser(actor.userId, '2000-01-01T00:00:00Z'));
    await adminSql(`delete from bob.user_scopes where user_id = '${actor.userId}' and scope = 'accounts.admin'`);
    await expect(search()).rejects.toMatchObject({ code: '42501' });
    await pg.query("select bob_private.grant_user_scope($1::uuid,'accounts.admin')", [actor.userId]);
    await withAdminAuth(pg, auth => auth.endSession(actor.sessionId));
    await expect(search()).rejects.toMatchObject({ code: '42501' });
    const { rows } = await pg.query<{ allowed: boolean }>(`select has_function_privilege('authenticated',
      'bob_private.admin_waitlist_search(uuid,uuid,text,integer,text,text)', 'execute') as allowed`);
    expect(rows[0]?.allowed).toBe(false);
  });
});
