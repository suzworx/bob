/**
 * The #757 device-settings expand migration (20261003150000_device_settings_onto_devices)
 * on real Postgres: bob.device_settings rows are seeded, the migration backfills the ten
 * settings columns on bob.devices, and the constraints, RLS grants and the replaced
 * erase_account behave. The old table is left untouched.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb, type TestTx } from '../support/pg-template.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const EXPAND = '20261003150000_device_settings_onto_devices.sql';
const id = (n: string): string => `00000000-0000-4000-8000-0000000000${n}`;
const [A, B] = [id('0a'), id('0b')];
const [D1, D2, D3, D4] = [id('d1'), id('d2'), id('d3'), id('d4')];
const COLUMNS = 'volume, muted, mode, dnd, pending_push, device_reported, ring_seconds, ring_sound, ring_reported';
const DEFAULTS = { volume: 6, muted: false, mode: 'ptt', dnd: false, pending_push: false, device_reported: false, ring_seconds: 30, ring_sound: 'classic', ring_reported: false };

const SEED = `
insert into auth.users (id) values ('${A}'), ('${B}');
insert into bob.devices (id, user_id, name, model, fw_version, revoked_at) values
  ('${D1}', '${A}', 'Kitchen', 'cardputer', '1.0', null),
  ('${D2}', '${A}', 'Desk', 'cardputer', '1.0', '2026-01-01T00:00:00Z'),
  ('${D3}', '${A}', 'Bare', 'cardputer', '1.0', null),
  ('${D4}', '${B}', 'Theirs', 'cardputer', '1.0', null);
insert into bob.device_settings (device_id, volume, muted, mode, dnd, updated_at, pending_push, device_reported, ring_seconds, ring_sound, ring_reported) values
  ('${D1}', 9, true, 'wake', true, '2026-05-01T10:00:00Z', true, true, 90, 'pulse', true),
  ('${D2}', 0, false, 'announce_only', false, '2026-05-02T10:00:00Z', false, true, 10, 'chime', false),
  ('${D4}', 3, false, 'ptt', false, '2026-05-03T10:00:00Z', false, false, 30, 'classic', false);`;

describe('device settings expand migration (#757)', () => {
  let db: TestDb;
  let sql: string;
  const rows = async <T,>(q: string): Promise<T[]> => (await db.query<T>(q)).rows;
  const device = async (did: string) =>
    (await rows<Record<string, unknown>>(`select ${COLUMNS}, settings_updated_at from bob.devices where id = '${did}'`))[0] as Record<string, unknown>;
  const snapshot = () => rows(`select to_jsonb(d) j from bob.devices d order by id`);
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
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('backfills every value of each device_settings row onto its device', async () => {
    expect(await device(D1)).toMatchObject({ volume: 9, muted: true, mode: 'wake', dnd: true, pending_push: true, device_reported: true, ring_seconds: 90, ring_sound: 'pulse', ring_reported: true });
    expect(new Date((await device(D1)).settings_updated_at as string).toISOString()).toBe('2026-05-01T10:00:00.000Z');
    expect(await device(D2)).toMatchObject({ volume: 0, mode: 'announce_only', device_reported: true, ring_seconds: 10, ring_sound: 'chime', ring_reported: false });
    expect(new Date((await device(D2)).settings_updated_at as string).toISOString()).toBe('2026-05-02T10:00:00.000Z');
    expect(await device(D4)).toMatchObject({ volume: 3 });
  });

  it('leaves a device with no device_settings row at defaults with a null settings_updated_at', async () => {
    expect(await device(D3)).toEqual({ ...DEFAULTS, settings_updated_at: null });
  });

  it('is re-runnable: a second run changes nothing, even after a settings write', async () => {
    await db.exec(`update bob.devices set volume = 2, settings_updated_at = now() where id = '${D1}'`);
    const before = await snapshot();
    await run();
    expect(await snapshot()).toEqual(before);
    expect(await device(D1)).toMatchObject({ volume: 2 });
  });

  it('refuses out-of-range settings values', async () => {
    for (const set of ['volume = 11', 'volume = -1', "mode = 'loud'", 'ring_seconds = 9', 'ring_seconds = 121', "ring_sound = 'siren'"]) {
      await expect(db.exec(`update bob.devices set ${set} where id = '${D3}'`), set).rejects.toThrow(/check constraint/);
    }
  });

  it('lets an owner write only the settings columns of their own device', async () => {
    const own = await as(A, (tx) => tx.query(`update bob.devices set volume = 4, settings_updated_at = now() where id = '${D3}' returning id`));
    expect(own.rows).toHaveLength(1);
    const foreign = await as(A, (tx) => tx.query(`update bob.devices set volume = 1 where id = '${D4}' returning id`));
    expect(foreign.rows).toHaveLength(0);
    expect((await as(A, (tx) => tx.query(`select id from bob.devices where id = '${D4}'`))).rows).toHaveLength(0);
    await expect(as(A, (tx) => tx.query(`update bob.devices set token_hash = '\\x00' where id = '${D3}'`))).rejects.toThrow(/permission denied/);
    expect(await device(D4)).toMatchObject({ volume: 3 });
  });

  it('erase_account resets the settings and nulls settings_updated_at, keeping the device rows', async () => {
    await db.exec(`update bob.devices set volume = 8, ring_sound = 'pulse', settings_updated_at = now() where id = '${D3}'`);
    await db.query(`select * from bob_private.erase_account($1, now())`, [A]);
    for (const did of [D1, D2, D3]) expect(await device(did)).toEqual({ ...DEFAULTS, settings_updated_at: null });
    expect(await rows(`select id from bob.devices where user_id = '${A}'`)).toHaveLength(3);
    expect(await rows(`select 1 from bob.device_settings where device_id in ('${D1}', '${D2}')`)).toHaveLength(0);
    expect(await device(D4)).toMatchObject({ volume: 3 });
    expect((await device(D4)).settings_updated_at).not.toBeNull();
  });
});
