/**
 * The #757 contract migration (20261003170000_consolidate_contract) on real Postgres:
 * every earlier migration is applied, rollout writes are left in the six old
 * tables (newer than, or missing from, their new homes), then the migration
 * re-copies them and drops the tables. The replaced definers keep working.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from '../support/pg-template.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const CONTRACT = '20261003170000_consolidate_contract.sql';
const id = (n: string): string => `00000000-0000-4000-8000-0000000000${n}`;
const [A, B, C, D] = [id('0a'), id('0b'), id('0c'), id('0d')];
const G = '20000000-0000-4000-8000-0000000000f0';
const DEV1 = '30000000-0000-4000-8000-000000000001';
const DEV2 = '30000000-0000-4000-8000-000000000002';
const [T1, T2, T3] = [1, 2, 3].map((n) => `60000000-0000-4000-8000-00000000000${n}`);
const [CNV1, CNV2] = ['conv_aaaaaaaa', 'conv_bbbbbbbb'];
const OLD = ['active_conversations', 'active_spaces', 'game_settings', 'device_settings', 'timers', 'email_effects'];

const SEED = `
insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}'), ('${D}');
insert into bob.spaces (id, kind, name, owner_user_id) values ('${G}', 'group', 'Family', '${A}');
insert into bob.space_memberships (space_id, user_id, role) values ('${G}', '${A}', 'owner'), ('${G}', '${B}', 'member');
insert into bob.conversations (id, user_id, title, space_id, created_by) values
  ('${CNV1}', '${A}', 'One', '${G}', '${A}'), ('${CNV2}', '${A}', 'Two', '${G}', '${A}');
insert into bob.user_state (user_id, active_conversation_id, conversation_surface, conversation_changed_at,
    active_space_id, space_surface, space_changed_at, games_enabled, games_updated_at) values
  ('${A}', '${CNV1}', 'picker', '2026-01-01T00:00:00Z', null, 'web', '2026-01-01T00:00:00Z', true, '2026-01-01T00:00:00Z'),
  ('${B}', null, null, null, null, null, null, false, '2026-09-01T00:00:00Z');
insert into bob.active_conversations (user_id, conversation_id, surface, changed_at) values
  ('${A}', '${CNV2}', 'device', '2026-02-01T00:00:00Z'), ('${C}', null, 'picker', '2026-02-01T00:00:00Z');
insert into bob.active_spaces (user_id, space_id, surface, changed_at) values
  ('${A}', null, 'device', '2026-02-01T00:00:00Z'), ('${D}', null, 'web', '2026-02-01T00:00:00Z');
insert into bob.game_settings (user_id, enabled, max_band, updated_at) values
  ('${A}', false, 'grown', '2026-02-01T00:00:00Z'), ('${B}', true, 'little', '2026-02-01T00:00:00Z');
insert into bob.devices (id, user_id, name, model, fw_version, volume, settings_updated_at) values
  ('${DEV1}', '${A}', 'Kitchen', 'cardputer', '1.0', 3, '2026-01-01T00:00:00Z'), ('${DEV2}', '${A}', 'Desk', 'cardputer', '1.0', 4, null);
insert into bob.device_settings (device_id, volume, muted, mode, dnd, pending_push, device_reported, ring_seconds, ring_sound, ring_reported, updated_at) values
  ('${DEV1}', 9, true, 'wake', true, true, true, 60, 'chime', true, '2026-02-01T00:00:00Z'),
  ('${DEV2}', 8, false, 'ptt', false, false, false, 30, 'pulse', false, '2026-02-01T00:00:00Z');
insert into bob.timers (id, user_id, kind, label, fires_at, duration_ms, status, created_at, fired_at) values
  ('${T1}', '${A}', 'timer', 'new', '2030-06-01T10:10:00Z', 600000, 'pending', '2030-06-01T10:00:00Z', null),
  ('${T2}', '${A}', 'alarm', null, '2030-06-02T07:00:00Z', null, 'fired', '2030-06-01T09:00:00Z', '2030-06-02T07:00:01Z'),
  ('${T3}', '${B}', 'timer', 'tea', '2030-06-01T10:05:00Z', 300000, 'pending', '2030-06-01T10:00:00Z', null);
insert into bob.outbox (event_type, resource_type, resource_id, effect_key, payload) values
  ('email.notification', 'notification', gen_random_uuid(), 'k1', '{}'), ('email.notification', 'notification', gen_random_uuid(), 'k2', '{}');
insert into bob.email_effects (effect_key, recipient_user_id, sent_at) values ('k1', '${A}', '2026-05-01T00:00:00Z');`;

describe('consolidate contract migration (#757)', () => {
  let db: TestDb;
  let sql: string;
  const rows = async <T,>(q: string): Promise<T[]> => (await db.query<T>(q)).rows;
  const run = (): Promise<void> => db.transaction(async (tx) => void (await tx.exec(sql)));

  beforeAll(async () => {
    db = await createMigratedDb({ before: CONTRACT });
    await db.exec(SEED);
    // The timers backfill (20261003160000) ran before the seed: T2 was pending in reminders and is fired in the old table.
    await db.exec(`insert into bob.spaces (id, kind, name, owner_user_id) select gen_random_uuid(), 'private', 'Private', '${A}'
        where not exists (select 1 from bob.spaces where kind = 'private' and owner_user_id = '${A}');
      insert into bob.reminders (id, space_id, created_by, kind, title, due_at, due_zone, duration_ms, status, created_at, updated_at)
      select '${T2}', s.id, '${A}', 'alarm', null, '2030-06-02T07:00:00Z', 'UTC', null, 'pending', '2030-06-01T09:00:00Z', '2030-06-01T09:00:00Z'
        from bob.spaces s where s.kind = 'private' and s.owner_user_id = '${A}'`);
    sql = readFileSync(new URL(CONTRACT, dir), 'utf8');
    await run();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  const state = async (uid: string) => (await rows<Record<string, unknown>>(`select * from bob.user_state where user_id = '${uid}'`))[0];

  it('re-copies newer pointers and settings into user_state, keeps newer new-home values', async () => {
    expect(await state(A)).toMatchObject({ active_conversation_id: CNV2, conversation_surface: 'device', space_surface: 'device',
      games_enabled: false, games_max_band: 'grown' });
    expect(await state(B)).toMatchObject({ games_enabled: false, games_max_band: 'kid' });
    expect(await state(C)).toMatchObject({ active_conversation_id: null, conversation_surface: 'picker' });
    expect(await state(D)).toMatchObject({ space_surface: 'web', active_space_id: null });
  });

  it('re-copies newer device settings and fills devices that had none', async () => {
    const r = await rows(`select id, volume, muted, mode, dnd, pending_push, device_reported, ring_seconds, ring_sound, ring_reported
        from bob.devices order by id`);
    expect(r).toMatchObject([
      { id: DEV1, volume: 9, muted: true, mode: 'wake', dnd: true, pending_push: true, device_reported: true, ring_seconds: 60, ring_sound: 'chime', ring_reported: true },
      { id: DEV2, volume: 8, ring_sound: 'pulse' },
    ]);
  });

  it('inserts missing timers and copies the terminal status onto pending reminders', async () => {
    expect(await rows(`select id, kind, title, status, fired_at is not null as fired from bob.reminders where kind <> 'reminder' order by id`))
      .toEqual([
        { id: T1, kind: 'timer', title: 'new', status: 'pending', fired: false },
        { id: T2, kind: 'alarm', title: null, status: 'fired', fired: true },
        { id: T3, kind: 'timer', title: 'tea', status: 'pending', fired: false },
      ]);
  });

  it('copies the email marker onto the outbox row', async () => {
    expect(await rows(`select effect_key, recipient_user_id, email_sent_at is not null as sent from bob.outbox order by effect_key`))
      .toEqual([{ effect_key: 'k1', recipient_user_id: A, sent: true }, { effect_key: 'k2', recipient_user_id: null, sent: false }]);
  });

  it('drops the six tables', async () => {
    const present = await rows<{ t: string }>(`select table_name t from information_schema.tables where table_schema = 'bob' and table_name = any($$${'{' + OLD.join(',') + '}'}$$)`);
    expect(present).toEqual([]);
  });

  it('the replaced definers work without the old tables', async () => {
    expect(await rows(`select bob_private.email_effect_sent('k1') s1, bob_private.email_effect_sent('k2') s2`)).toEqual([{ s1: true, s2: false }]);
    await db.exec(`set request.jwt.claim.sub = '${A}'`);
    expect(await rows(`select bob_private.clear_active_conversation_in_space('${A}', '${G}') ok`)).toEqual([{ ok: true }]);
    expect(await rows(`select bob_private.clear_active_conversation_in_space('${A}', '${G}') ok`)).toEqual([{ ok: false }]);
    await db.exec(`reset request.jwt.claim.sub`);
    await db.exec(`select bob_private.purge_account_games('${A}')`);
    expect(await state(A)).toMatchObject({ games_enabled: true, games_max_band: 'kid', games_updated_at: null });
    expect(await rows(`select bob_private.purge_account_email_effects('${A}') n`)).toEqual([{ n: 1 }]);
    await db.exec(`select * from bob_private.erase_account('${B}', now())`);
    expect(await state(B)).toBeUndefined();
    expect(await rows(`select count(*)::int n from bob.reminders where created_by = '${B}' and kind <> 'reminder'`)).toEqual([{ n: 0 }]);
    await db.exec(`update bob.devices set volume = 5, settings_updated_at = now() where id = '${DEV1}'`);
    await db.exec(`select * from bob_private.erase_account('${C}', now())`);
    expect(await rows(`select count(*)::int n from bob.user_state where user_id = '${C}'`)).toEqual([{ n: 0 }]);
  });

  it('re-running the file is a no-op', async () => {
    const snap = () => rows(`select (select count(*) from bob.user_state) u, (select count(*) from bob.reminders) r, (select count(*) from bob.outbox) o`);
    const before = await snap();
    await run();
    expect(await snap()).toEqual(before);
  });
});
