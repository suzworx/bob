import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCHEMAS } from '../../src/platform/observability/operator-metrics-schemas.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { asDb, addAccount, closeTestDb, createTestDb, withAdminAuth, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
const FROM = '2026-09-10T00:00:00Z';
const TO = '2026-09-13T00:00:00Z';
async function adminSql(sql: string): Promise<void> {
  const name = (pg as TestDb & { databaseName: string }).databaseName;
  await withAdmin(await adminDatabaseUrl(name), async (admin) => { await admin.unsafe(sql); });
}
async function document(): Promise<ReturnType<typeof SCHEMAS.users.parse>> {
  const { rows } = await pg.query<{ doc: unknown }>(
    'select bob_private.operator_metrics_users($1::timestamptz,$2::timestamptz,$3::text) as doc', [FROM, TO, 'day'],
  );
  return SCHEMAS.users.parse(rows[0]?.doc);
}
describe('operator users metrics SQL', () => {
  beforeAll(async () => { pg = await createTestDb(); });
  afterAll(async () => { if (pg) await closeTestDb(pg); });
  it('reports zero inventory and suppresses small activity cohorts rather than faking unavailable zeros', async () => {
    expect(await document()).toMatchObject({ accounts: { total: 0 }, signups: 0,
      active_users: { day: null, week: null, month: null, in_window: null }, activated_users: null });
  });
  it('counts real authors, excludes tombstones/erased accounts, and zero-fills growth buckets', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const account = await addAccount(pg);
      ids.push(account.userId);
      await withAdminAuth(pg, async auth => {
        await auth.setProfile(account.userId, { email: `metric-${index}@example.test` });
        await auth.setAccountState(account.userId, { createdAt: index === 0 ? '2026-09-11T00:00:00Z' : index === 1 ? '2026-09-12T00:00:00Z' : '2026-08-01T00:00:00Z', confirmed: index === 0 });
        if (index === 2) await auth.banUser(account.userId, '2099-01-01T00:00:00Z');
        if (index === 6) await auth.setAccountState(account.userId, { deleted: true });
      });
    }
    const [a,b,c,d,e,f,g] = ids;
    if (!a || !b || !c || !d || !e || !f || !g) throw new Error('missing fixtures');
    const erased = '00000000-0000-4000-8000-0000000000de';
    await addAccount(pg, { id: erased });
    const space = await createSpace(asDb(pg), a, { kind: 'group', name: 'Metrics fixture' });
    await adminSql(`insert into bob.conversations(id,user_id,space_id,title) values ('metrics_shared','${f}','${space.id}','fixture');
      insert into bob.messages(conversation_id,space_id,user_id,author_user_id,role,position,created_at,tombstoned_at) values
      ('metrics_shared','${space.id}','${a}','${a}','user',0,'2026-09-12',null),
      ('metrics_shared','${space.id}','${a}','${a}','user',1,'2026-09-12',null),
      ('metrics_shared','${space.id}','${b}','${b}','user',2,'2026-09-11',null),
      ('metrics_shared','${space.id}','${c}','${c}','user',3,'2026-08-20',null),
      ('metrics_shared','${space.id}','${d}','${d}','user',4,'2026-08-01',null),
      ('metrics_shared','${space.id}','${f}','${d}','user',5,'2026-09-12',null),
      ('metrics_shared','${space.id}','${e}','${e}','user',6,'2026-09-12','2026-09-12'),
      ('metrics_shared','${space.id}','${f}',null,'assistant',7,'2026-09-12',null),
      ('metrics_shared','${space.id}','${f}','${erased}','user',8,'2026-09-12',null),
      ('metrics_shared','${space.id}','${f}',null,'user',9,'2026-09-12',null),
      ('metrics_shared','${space.id}','${g}','${g}','user',10,'2026-09-12',null),
      ('metrics_shared','${space.id}','${e}','${e}','user',11,'2026-09-13',null);
      insert into bob.waitlist(email,verified_at) values ('metric-0@example.test','2026-09-12'),('waiting@example.test','2026-09-12'),('pending@example.test',null);`);
    const doc = await document();
    expect(doc.accounts).toEqual({ total: 6, enabled: 5, disabled: 1, awaitingConfirmation: 4 });
    expect(doc.signups).toBe(2);
    expect(doc.signups_by_bucket.map(row => row.count)).toEqual([0,1,1]);
    expect(doc.active_users).toEqual({ day: null, week: 3, month: 4, in_window: 3 });
    expect(doc.activated_users).toBe(4);
    expect(doc.waitlist).toEqual({ total: 3, verified: 2, pending: 1, withAccount: 1, waitingVerified: 1 });
    expect(JSON.stringify(doc)).not.toContain('example.test');
  });
  it('rejects unbounded windows and denies direct authenticated execution', async () => {
    await expect(pg.query("select bob_private.operator_metrics_users('2026-01-01','2026-09-13','day')")).rejects.toThrow('invalid_window');
    const { rows } = await pg.query<{ allowed: boolean }>(`select has_function_privilege('authenticated',
      'bob_private.operator_metrics_users(timestamp with time zone,timestamp with time zone,text)', 'execute') as allowed`);
    expect(rows[0]?.allowed).toBe(false);
  });
});
