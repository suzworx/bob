/**
 * The #757 user_state expand migration (20261003120000_user_state_expand) on
 * real Postgres: the three one-row-per-user tables are seeded, the migration backfills
 * bob.user_state from them, and the RLS, the space-membership trigger and the
 * three replaced definers behave. The old tables are left untouched.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb, type TestTx } from '../support/pg-template.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const EXPAND = '20261003120000_user_state_expand.sql';
const id = (n: string): string => `00000000-0000-4000-8000-0000000000${n}`;
const [A, B, C, D, E] = [id('0a'), id('0b'), id('0c'), id('0d'), id('0e')];
const G = '20000000-0000-4000-8000-0000000000f0';
const H = '20000000-0000-4000-8000-0000000000f1';
const CNV = 'conv_aaaaaaaa';
const DEFAULTS = { games_enabled: true, games_kids_mode: true, games_max_band: 'kid', games_daily_limit_minutes: 45, games_quiet_start: null, games_quiet_end: null };

const SEED = `
insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}'), ('${D}'), ('${E}');
insert into bob.spaces (id, kind, name, owner_user_id) values ('${G}', 'group', 'Family', '${A}'), ('${H}', 'group', 'Club', '${A}');
insert into bob.space_memberships (space_id, user_id, role) values ('${G}', '${A}', 'owner'), ('${G}', '${B}', 'member'), ('${H}', '${A}', 'owner');
insert into bob.conversations (id, user_id, title, space_id, created_by) values ('${CNV}', '${A}', 'Plans', '${G}', '${A}');
insert into bob.active_conversations (user_id, conversation_id, surface, changed_at) values
  ('${A}', '${CNV}', 'picker', '2026-02-01T10:00:00Z'), ('${D}', null, 'device', '2026-02-02T10:00:00Z');
insert into bob.active_spaces (user_id, space_id, surface, changed_at) values
  ('${A}', '${G}', 'device', '2026-03-01T10:00:00Z'), ('${C}', null, 'web', '2026-03-02T10:00:00Z');
insert into bob.game_settings (user_id, enabled, kids_mode, max_band, allowed_games, daily_limit_minutes, quiet_start, quiet_end, updated_at) values
  ('${A}', false, false, 'grown', array['simon_says'], 99, '21:00', '07:00', '2026-04-01T10:00:00Z'),
  ('${B}', true, true, 'kid', array['animal_riddles'], 45, null, null, '2026-04-02T10:00:00Z');`;

describe('user_state expand migration (#757)', () => {
  let db: TestDb;
  let sql: string;
  const rows = async <T,>(q: string): Promise<T[]> => (await db.query<T>(q)).rows;
  const state = (uid: string) => rows<Record<string, unknown>>(`select * from bob.user_state where user_id = '${uid}'`);
  const snapshot = () => rows(`select to_jsonb(u) j from bob.user_state u order by user_id`);
  const as = <T,>(role: string, uid: string, fn: (tx: TestTx) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`, [uid]);
      await tx.query(`set local role ${role}`);
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

  it('backfills one row per distinct user across the three tables, copying every value', async () => {
    expect(await rows(`select count(*)::int n from bob.user_state`)).toEqual([{ n: 4 }]);
    const a = (await state(A))[0] as Record<string, unknown>;
    expect(a).toMatchObject({ active_conversation_id: CNV, conversation_surface: 'picker', active_space_id: G, space_surface: 'device',
      games_enabled: false, games_kids_mode: false, games_max_band: 'grown', games_allowed_games: ['simon_says'],
      games_daily_limit_minutes: 99, games_quiet_start: '21:00', games_quiet_end: '07:00' });
    expect(new Date(a.conversation_changed_at as string).toISOString()).toBe('2026-02-01T10:00:00.000Z');
    expect(new Date(a.space_changed_at as string).toISOString()).toBe('2026-03-01T10:00:00.000Z');
    expect(new Date(a.games_updated_at as string).toISOString()).toBe('2026-04-01T10:00:00.000Z');
    const [b] = await state(B);
    expect(b).toMatchObject({ ...DEFAULTS, conversation_surface: null, space_surface: null, games_allowed_games: ['animal_riddles'] });
    expect(await state(C)).toMatchObject([{ space_surface: 'web', active_space_id: null, conversation_surface: null, games_updated_at: null, ...DEFAULTS }]);
    expect(await state(D)).toMatchObject([{ conversation_surface: 'device', active_conversation_id: null, space_surface: null, games_updated_at: null }]);
    expect(await state(E)).toEqual([]);
  });

  it('re-running the migration body changes nothing', async () => {
    const before = await snapshot();
    await run();
    expect(await snapshot()).toEqual(before);
  });

  it('keeps each account to its own row', async () => {
    expect(await as('authenticated', B, (tx) => tx.query('select user_id from bob.user_state'))).toMatchObject({ rows: [{ user_id: B }] });
    const upd = await as('authenticated', B, (tx) => tx.query(`update bob.user_state set games_enabled = false where user_id = '${A}'`));
    expect(upd.affectedRows).toBe(0);
    await expect(as('authenticated', B, (tx) => tx.query(`insert into bob.user_state (user_id) values ('${A}')`))).rejects.toMatchObject({ code: '42501' });
    await expect(as('authenticated', E, (tx) => tx.query(`delete from bob.user_state where user_id = '${E}'`))).rejects.toThrow(/permission denied/);
  });

  it('refuses a space the caller is not a member of with 42501, allows a member space', async () => {
    const refused = { code: '42501', message: 'new row violates row-level security policy for table "user_state"' };
    await expect(as('authenticated', C, (tx) => tx.query(`update bob.user_state set active_space_id = '${G}', space_surface = 'web' where user_id = '${C}'`)))
      .rejects.toMatchObject(refused);
    await expect(as('authenticated', E, (tx) => tx.query(`insert into bob.user_state (user_id, active_space_id, space_surface) values ('${E}', '${G}', 'web')`)))
      .rejects.toMatchObject(refused);
    await as('authenticated', B, (tx) => tx.query(`update bob.user_state set active_space_id = '${G}', space_surface = 'web' where user_id = '${B}'`));
    await as('authenticated', E, (tx) => tx.query(`insert into bob.user_state (user_id, active_space_id, space_surface) values ('${E}', null, 'web')`));
    expect(await state(B)).toMatchObject([{ active_space_id: G, space_surface: 'web' }]);
  });

  it('clear_active_conversation_in_space nulls only the conversation id', async () => {
    const before = (await state(A))[0] as Record<string, unknown>;
    expect(before).toMatchObject({ active_conversation_id: CNV, conversation_surface: 'picker' });
    expect(await as('bob_server', A, (tx) => tx.query(`select bob_private.clear_active_conversation_in_space('${A}', '${G}') ok`))).toMatchObject({ rows: [{ ok: true }] });
    const [after] = await state(A);
    expect(after).toMatchObject({ active_conversation_id: null, conversation_surface: before.conversation_surface, conversation_changed_at: before.conversation_changed_at, active_space_id: G });
  });

  it('purge_account_games resets the game columns to defaults', async () => {
    await db.exec(`select bob_private.purge_account_games('${A}')`);
    expect(await state(A)).toMatchObject([{ ...DEFAULTS, games_updated_at: null, active_space_id: G }]);
  });

  it('erase_account leaves no user_state row', async () => {
    await db.exec(`select * from bob_private.erase_account('${C}', now())`);
    expect(await state(C)).toEqual([]);
  });

  it('a stale space pointer does not block an unrelated game-setting write', async () => {
    await db.exec(`update bob.space_memberships set revoked_at = now() where space_id = '${G}' and user_id = '${B}'`);
    await as('authenticated', B, (tx) => tx.query(`update bob.user_state set games_enabled = false, games_updated_at = now() where user_id = '${B}'`));
    expect(await state(B)).toMatchObject([{ games_enabled: false, active_space_id: G }]);
  });
});
