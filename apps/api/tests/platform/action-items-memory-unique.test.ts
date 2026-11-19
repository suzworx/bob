/**
 * The #757 action_items(memory_id) uniqueness migration on real Postgres: at
 * most one action item per memory. Every earlier migration is applied,
 * memory_init's vector tables included, then the migration runs.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from '../support/pg-template.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const UNIQUE = '20261003140000_action_items_memory_unique.sql';
const U = '00000000-0000-4000-8000-00000000000a';

const SEED = `
insert into auth.users (id) values ('${U}');
insert into bob.memories (id, user_id, kind, content, confidence) values
  ('mem_one_0001', '${U}', 'action_item', 'call dana', 0.9),
  ('mem_two_0002', '${U}', 'action_item', 'buy milk', 0.9);`;

const item = (id: string, memoryId: string): string =>
  `insert into bob.action_items (id, memory_id, user_id) values ('${id}', '${memoryId}', '${U}')`;

describe('action_items memory_id unique migration (#757)', () => {
  let db: TestDb;
  let migration: string;
  const indexes = async (): Promise<string[]> =>
    (await db.query<{ i: string }>(`select indexname i from pg_indexes where schemaname = 'bob'
        and tablename = 'action_items' order by 1`)).rows.map((r) => r.i);
  const apply = (): Promise<void> => db.transaction(async (tx) => void (await tx.exec(migration)));

  beforeAll(async () => {
    db = await createMigratedDb({ before: UNIQUE });
    await db.exec(SEED);
    migration = readFileSync(new URL(UNIQUE, dir), 'utf8');
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('fails loudly, naming only the count, when a memory already has two items', async () => {
    await db.exec(`${item('act_dup_0001', 'mem_one_0001')}; ${item('act_dup_0002', 'mem_one_0001')};`);
    const error = (await apply().then(
      () => null,
      (e: unknown) => e as Error,
    ));
    expect(error?.message).toMatch(/1 memory id\(s\) have more than one action item/);
    expect(error?.message).not.toContain('mem_one_0001');
    expect(await indexes()).not.toContain('action_items_memory_id_key');
  });

  it('applies once the duplicate is gone, keeps the old index and re-runs cleanly', async () => {
    await db.exec(`delete from bob.action_items where id = 'act_dup_0002'`);
    await apply();
    await apply();
    expect(await indexes()).toEqual(expect.arrayContaining(['action_items_memory_id_idx', 'action_items_memory_id_key']));
  });

  it('refuses a second action item for the same memory with a unique violation', async () => {
    await expect(db.query(item('act_dup_0003', 'mem_one_0001'))).rejects.toMatchObject({ code: '23505' });
  });

  it('allows one action item each for two memories', async () => {
    await db.exec(item('act_two_0001', 'mem_two_0002'));
    expect((await db.query(`select id from bob.action_items order by id`)).rows)
      .toEqual([{ id: 'act_dup_0001' }, { id: 'act_two_0001' }]);
  });
});
