/**
 * The #756 contract migration (20261003100000_conversation_unify_contract) on
 * real Postgres: every earlier migration is applied and legacy thread rows are seeded
 * and caught up. Each precondition aborts the whole migration (rolled back)
 * when violated; valid data passes, the thread tables and legacy columns go,
 * the replaced functions still work and the unified rows are untouched.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from '../support/pg-template.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const CONTRACT = '20261003100000_conversation_unify_contract.sql';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const G = '20000000-0000-4000-8000-0000000000f0';
const T = '40000000-0000-4000-8000-000000000001';
const M1 = '41000000-0000-4000-8000-000000000001';
const M2 = '41000000-0000-4000-8000-000000000002';

const LEGACY = `
insert into auth.users (id) values ('${A}'), ('${B}');
insert into bob.spaces (id, kind, name, owner_user_id) values ('${G}', 'group', 'Family', '${A}');
insert into bob.space_memberships (space_id, user_id, role) values ('${G}', '${A}', 'owner'), ('${G}', '${B}', 'member');
insert into bob.threads (id, space_id, title, created_by, last_sequence) values ('${T}', '${G}', 'Plans', '${A}', 2);
insert into bob.thread_messages (id, thread_id, space_id, author_user_id, body, sequence, client_message_id) values
  ('${M1}', '${T}', '${G}', '${A}', 'Milk?', 1, 'c1'), ('${M2}', '${T}', '${G}', null, 'Added.', 2, 'c2');
insert into bob.thread_reads (thread_id, user_id, last_read_sequence) values ('${T}', '${A}', 2);
select bob_private.unify_catch_up();
insert into bob.active_conversations (user_id, conversation_id, surface) values ('${B}', '${T}', 'picker');
insert into bob.notification_preferences (user_id, space_id, thread_id, conversation_id) values ('${A}', '${G}', '${T}', '${T}');`;

// Simulates data the catch-up cannot fix (it runs first inside the migration).
const NO_CATCH_UP = `create or replace function bob_private.unify_catch_up() returns void language sql as '';`;

const UNIFIED = `select 'c:' || id || ':' || last_sequence as k from bob.conversations
  union all select 'm:' || id || ':' || sequence || ':' || revision from bob.messages
  union all select 'v:' || id || ':' || is_selected from bob.message_versions
  union all select 'r:' || conversation_id || ':' || last_read_sequence from bob.conversation_reads
  order by 1`;

describe('conversation unify contract migration (#756 PR5)', () => {
  let db: TestDb;
  let contract: string;
  let before: unknown[];
  const rows = async <T,>(sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;
  const run = (setup = ''): Promise<void> =>
    db.transaction(async (tx) => void (await tx.exec(setup + contract)));

  beforeAll(async () => {
    db = await createMigratedDb({ before: CONTRACT });
    await db.exec(LEGACY);
    contract = readFileSync(new URL(CONTRACT, dir), 'utf8');
    before = await rows(UNIFIED);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('aborts when a thread has no conversation row', async () => {
    await expect(run(`${NO_CATCH_UP} insert into bob.threads (space_id, title, created_by) values ('${G}', 'Lost', '${A}');`))
      .rejects.toThrow(/1 thread\(s\) have no conversation row/);
  });

  it('aborts when a thread message does not match its unified message', async () => {
    await expect(run(`${NO_CATCH_UP} update bob.messages set revision = 9 where id = '${M1}';`))
      .rejects.toThrow(/1 thread message\(s\) have no matching message row/);
  });

  it('aborts when a thread read cursor has no conversation_reads row', async () => {
    await expect(run(`${NO_CATCH_UP} delete from bob.conversation_reads;`))
      .rejects.toThrow(/1 thread read\(s\) have no conversation_reads row/);
  });

  it('aborts on notification preferences that never got a conversation_id', async () => {
    await expect(run(`insert into bob.notification_preferences (user_id, thread_id) values ('${A}', gen_random_uuid());`))
      .rejects.toThrow(/1 notification preference\(s\) have thread_id but no conversation_id/);
  });

  it('aborts when the orphan-cleanup key notification_prefs_conversation_only_uidx is missing', async () => {
    await expect(run('drop index bob.notification_prefs_conversation_only_uidx;'))
      .rejects.toThrow(/notification_prefs_conversation_only_uidx is missing/);
  });

  it('applies on valid data, leaves the unified rows untouched and re-runs cleanly', async () => {
    await run();
    expect(await rows(UNIFIED)).toEqual(before);
    await run();
    expect(await rows(UNIFIED)).toEqual(before);
  });

  it('drops the thread tables, the legacy columns and the thread-keyed indexes', async () => {
    expect(await rows(`select to_regclass('bob.threads') t, to_regclass('bob.thread_messages') m,
        to_regclass('bob.thread_reads') r, to_regprocedure('bob_private.unify_catch_up()') f`))
      .toEqual([{ t: null, m: null, r: null, f: null }]);
    expect(await rows(`select table_name, column_name from information_schema.columns
        where table_schema = 'bob' and column_name in ('thread_id', 'thread_space_id')`)).toEqual([]);
    expect((await rows<{ i: string }>(`select indexname i from pg_indexes where schemaname = 'bob'
        and tablename in ('active_conversations', 'ai_invocations', 'notification_preferences') order by 1`)).map((r) => r.i))
      .toEqual(expect.arrayContaining(['ai_invocations_one_running_per_conversation', 'notification_prefs_conversation_only_uidx']));
    expect(await rows(`select indexname from pg_indexes where indexname in ('notification_prefs_key_uidx', 'notification_prefs_conversation_key_uidx',
        'ai_invocations_one_running_per_thread', 'active_conversations_thread_idx', 'active_conversations_thread_space_idx')`))
      .toEqual([]);
  });

  it('makes ai_invocations.conversation_id NOT NULL and leaves space_id nullable', async () => {
    expect(await rows(`select table_name, is_nullable from information_schema.columns
        where table_schema = 'bob' and ((column_name = 'space_id' and table_name in ('conversations', 'messages', 'message_versions'))
           or (table_name = 'ai_invocations' and column_name = 'conversation_id')) order by 1`))
      .toEqual([
        { table_name: 'ai_invocations', is_nullable: 'NO' },
        { table_name: 'conversations', is_nullable: 'YES' },
        { table_name: 'message_versions', is_nullable: 'YES' },
        { table_name: 'messages', is_nullable: 'YES' },
      ]);
  });

  it('keeps one notification preference per conversation key; the app upsert still arbitrates on it', async () => {
    await expect(db.query(`insert into bob.notification_preferences (user_id, space_id, conversation_id)
        values ('${A}', '${G}', '${T}')`)).rejects.toMatchObject({ code: '23505' });
    // The ON CONFLICT target upsertPreference (notifications/store.ts) names.
    await db.query(`insert into bob.notification_preferences (user_id, space_id, conversation_id, muted)
        values ('${A}', '${G}', '${T}', true)
        on conflict (user_id, (coalesce(space_id, '00000000-0000-0000-0000-000000000000')),
                     (coalesce(conversation_id, '')), (coalesce(type, '')))
        do update set muted = excluded.muted`);
    expect(await rows(`select conversation_id, muted from bob.notification_preferences where user_id = '${A}'`))
      .toEqual([{ conversation_id: T, muted: true }]);
  });

  it('clears a shared-space pointer by conversation_id and still erases an account', async () => {
    await db.exec(`set request.jwt.claim.sub = '${B}'`);
    expect(await rows(`select bob_private.clear_active_conversation_in_space('${B}', '${G}') ok`)).toEqual([{ ok: true }]);
    expect(await rows(`select conversation_id from bob.active_conversations where user_id = '${B}'`)).toEqual([{ conversation_id: null }]);
    await db.exec(`reset request.jwt.claim.sub`);
    expect(await rows(`select "membershipsRevoked" from bob_private.erase_account('${B}', now())`))
      .toEqual([{ membershipsRevoked: 1 }]);
    expect(await rows(`select count(*)::int n from bob.messages where author_user_id = '${A}'`)).toEqual([{ n: 1 }]);
  });
});
