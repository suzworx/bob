/**
 * The #900 device pointers migration (20261007120000_device_pointers) on real
 * Postgres: per-device conversation/space pointer columns on bob.devices,
 * the space-membership trigger, the column grant, and the new
 * clear_device_conversations_in_space definer. The pre-existing devices
 * columns and grants are left untouched.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb, type TestTx } from './support/pg-template.ts';

const dir = new URL('../../../supabase/migrations/', import.meta.url);
const EXPAND = '20261007120000_device_pointers.sql';
const id = (n: string): string => `00000000-0000-4000-8000-0000000000${n}`;
const [A, B, D] = [id('0a'), id('0b'), id('0d')];
const [D1, D2, D3, D4, D5] = [id('d1'), id('d2'), id('d3'), id('d4'), id('d5')];
const G = '20000000-0000-4000-8000-0000000000f0';
const CNV1 = 'conv_aaaaaaaa';
const CNV2 = 'conv_bbbbbbbb';

const SEED = `
insert into auth.users (id) values ('${A}'), ('${B}'), ('${D}');
insert into bob.spaces (id, kind, name, owner_user_id) values ('${G}', 'group', 'Family', '${A}');
insert into bob.space_memberships (space_id, user_id, role) values ('${G}', '${A}', 'owner'), ('${G}', '${B}', 'member');
insert into bob.conversations (id, user_id, title, space_id, created_by) values
  ('${CNV1}', '${A}', 'Plans', '${G}', '${A}'), ('${CNV2}', '${B}', 'Shared', '${G}', '${B}');
insert into bob.devices (id, user_id, name, model, fw_version) values
  ('${D1}', '${A}', 'Owned', 'cardputer', '1.0'), ('${D2}', '${A}', 'Guarded', 'cardputer', '1.0'),
  ('${D3}', '${A}', 'Member', 'cardputer', '1.0'), ('${D4}', '${D}', 'Outsider', 'cardputer', '1.0'),
  ('${D5}', '${B}', 'Bees', 'cardputer', '1.0');`;

describe('device pointer columns on bob.devices (#900)', () => {
  let db: TestDb;
  let sql: string;
  const rows = async <T,>(q: string): Promise<T[]> => (await db.query<T>(q)).rows;
  const device = async (did: string) =>
    (await rows<Record<string, unknown>>(
      `select active_conversation_id, conversation_surface, conversation_changed_at,
              active_space_id, space_surface, space_changed_at
         from bob.devices where id = '${did}'`,
    ))[0] as Record<string, unknown>;
  const as = <T,>(uid: string, fn: (tx: TestTx) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`, [uid]);
      await tx.query(`set local role authenticated`);
      return fn(tx);
    });
  const run = (): Promise<void> => db.transaction(async (tx) => void (await tx.exec(sql)));

  beforeAll(async () => {
    db = await createMigratedDb({ before: EXPAND });
    await db.exec(SEED);
    sql = readFileSync(new URL(EXPAND, dir), 'utf8');
    await run();
    // Re-runnability (correction c1): a second run over the same seeded rows
    // must not error (add column if not exists, create or replace, etc).
    await run();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('a fresh device row is all-null', async () => {
    expect(await device(D4)).toEqual({
      active_conversation_id: null, conversation_surface: null, conversation_changed_at: null,
      active_space_id: null, space_surface: null, space_changed_at: null,
    });
  });

  it('an owner points their own device at a conversation they can see; deleting it nulls the pointer', async () => {
    await as(A, (tx) => tx.query(
      `update bob.devices set active_conversation_id = '${CNV1}', conversation_surface = 'device', conversation_changed_at = now() where id = '${D1}'`,
    ));
    expect((await device(D1)).active_conversation_id).toBe(CNV1);
    await db.exec(`delete from bob.conversations where id = '${CNV1}'`);
    expect((await device(D1)).active_conversation_id).toBeNull();
  });

  it("another account's write touches zero rows, and the column stays put", async () => {
    const upd = await as(B, (tx) => tx.query(`update bob.devices set conversation_surface = 'device' where id = '${D2}' returning id`));
    expect(upd.rows).toEqual([]);
    expect((await device(D2)).conversation_surface).toBeNull();
  });

  it('refuses a space the device owner is not a member of with 42501, allows a member space', async () => {
    await expect(as(D, (tx) => tx.query(
      `update bob.devices set active_space_id = '${G}', space_surface = 'device' where id = '${D4}'`,
    ))).rejects.toMatchObject({ code: '42501', message: 'new row violates row-level security policy for table "devices"' });

    await as(A, (tx) => tx.query(`update bob.devices set active_space_id = '${G}', space_surface = 'device' where id = '${D3}'`));
    expect((await device(D3)).active_space_id).toBe(G);
  });

  it("clear_device_conversations_in_space nulls only the caller's own matching device", async () => {
    await as(B, (tx) => tx.query(`update bob.devices set active_conversation_id = '${CNV2}' where id = '${D5}'`));

    const asA = await as(A, (tx) => tx.query<{ cleared: boolean }>(`select bob_private.clear_device_conversations_in_space('${B}', '${G}') as cleared`));
    expect(asA.rows[0]?.cleared).toBe(false);
    expect((await device(D5)).active_conversation_id).toBe(CNV2);

    await db.exec(`update bob.space_memberships set revoked_at = now() where space_id = '${G}' and user_id = '${B}'`);
    const asB = await as(B, (tx) => tx.query<{ cleared: boolean }>(`select bob_private.clear_device_conversations_in_space('${B}', '${G}') as cleared`));
    expect(asB.rows[0]?.cleared).toBe(true);
    expect((await device(D5)).active_conversation_id).toBeNull();
  });

  it('leaves the pre-existing devices columns and grants unchanged', async () => {
    const grants = await rows<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_schema = 'bob' and table_name = 'devices' and grantee = 'authenticated' and privilege_type = 'UPDATE'`,
    );
    const columns = grants.map((g) => g.column_name);
    expect(columns).toContain('name');
    expect(columns).toContain('volume');
    expect(columns).not.toContain('token_hash');
    expect(columns).not.toContain('user_id');
    expect(columns).not.toContain('revoked_at');
  });
});
