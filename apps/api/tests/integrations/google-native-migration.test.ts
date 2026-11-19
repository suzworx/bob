import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createGoogleConsentAttempt } from '../../src/integrations/google-consent-store.ts';
import { withUser } from '../../src/platform/db/db.ts';
import { createMigratedDb } from '../support/pg-template.ts';
import { addAccount, asDb, closeTestDb, type TestDb } from '../support/test-db.ts';

const migration = '20261101190000_google_native_consent.sql';
let pg: TestDb;
beforeAll(async () => { pg = await createMigratedDb({ before: migration }); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
it('keeps legacy prepared INSERT RETURNING * valid on the same pooled backend across migration', async () => {
  const owner = await addAccount(pg); const db = asDb(pg);
  const [before] = await db.query<{ pid: number }>('select pg_backend_pid() as pid');
  await createGoogleConsentAttempt(db,owner.userId,{ capabilities: ['calendar.read'] });
  const prepared = await db.query<{ name: string }>(`select name from pg_prepared_statements
    where statement like $1 and statement like $2`, ['%insert into bob.google_consent_attempts%', '%returning *%']);
  expect(prepared).toHaveLength(1);
  const oldRows = await withUser(db,owner.userId,(tx) => tx.query('select * from bob.google_consent_attempts'));
  await pg.exec(readFileSync(new URL(`../../../../supabase/migrations/${migration}`,import.meta.url),'utf8'));
  await createGoogleConsentAttempt(db,owner.userId,{ capabilities: ['calendar.read'] });
  const [after] = await db.query<{ pid: number }>('select pg_backend_pid() as pid');
  expect(after?.pid).toBe(before?.pid);
  expect(await db.query<{ name: string }>(`select name from pg_prepared_statements
    where statement like $1 and statement like $2`, ['%insert into bob.google_consent_attempts%', '%returning *%'])).toEqual(prepared);
  const rows = await withUser(db,owner.userId,(tx) => tx.query('select * from bob.google_consent_attempts'));
  expect(rows).toHaveLength(2);
  expect(rows).toEqual(expect.arrayContaining(oldRows));
  expect(Object.keys(rows[0] ?? {}).sort()).toEqual(Object.keys(oldRows[0] ?? {}).sort());
});
