/**
 * The #756 switch migration (20261002100000_conversation_unify_switch) on
 * real Postgres: PR1 runs over seeded threads, then OLD code keeps writing the thread
 * tables (a new thread, an edit, a tombstone, a rename, an archive, a read
 * advance, an invocation, a private conversation with no space). The switch
 * runs unify_catch_up() and a second call must change nothing.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from '../support/pg-template.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const EXPAND = '20261001100000_conversation_unify_expand.sql';
const SWITCH = '20261002100000_conversation_unify_switch.sql';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const E = '00000000-0000-4000-8000-00000000000e';
const GROUP = '20000000-0000-4000-8000-0000000000f0';
const T1 = '40000000-0000-4000-8000-000000000001';
const T2 = '40000000-0000-4000-8000-000000000002';
const NEW_CONV = '40000000-0000-4000-8000-0000000000ff';
const tm = (n: number): string => `50000000-0000-4000-8000-00000000000${n}`;
const inv = (thread: string, trigger: string) => `insert into bob.ai_invocations
  (space_id, thread_id, actor_user_id, trigger_message_id, context_high_water, membership_revision, state)
  values ('${GROUP}', '${thread}', '${A}', '${trigger}', 1, 1, 'completed')`;

const SEED = `
insert into auth.users (id) values ('${A}'), ('${B}');
insert into bob.spaces (id, kind, name, owner_user_id) values ('${GROUP}', 'group', 'Family', '${A}');
insert into bob.space_memberships (space_id, user_id, role) values ('${GROUP}', '${A}', 'owner'), ('${GROUP}', '${B}', 'member');
insert into bob.threads (id, space_id, title, created_by, last_sequence) values ('${T1}', '${GROUP}', 'Family chat', '${A}', 2);
insert into bob.thread_messages (id, thread_id, space_id, author_user_id, body, sequence, client_message_id) values
  ('${tm(1)}', '${T1}', '${GROUP}', '${A}', 'hello', 1, 'c1'), ('${tm(2)}', '${T1}', '${GROUP}', '${B}', 'oops', 2, 'c2');
insert into bob.thread_reads (thread_id, user_id, last_read_sequence) values ('${T1}', '${B}', 1);`;

// What the old server writes after PR1 applied.
const OLD_WRITES = `
insert into auth.users (id) values ('${E}');
update bob.thread_messages set body = 'hello edited', revision = 2, updated_at = '2026-10-01T09:00:00Z' where id = '${tm(1)}';
update bob.thread_messages set tombstoned_at = '2026-10-01T09:01:00Z', tombstoned_by = '${B}', revision = 2 where id = '${tm(2)}';
update bob.threads set title = 'Renamed', archived_at = '2026-10-01T09:02:00Z' where id = '${T1}';
update bob.thread_reads set last_read_sequence = 2 where thread_id = '${T1}';
insert into bob.threads (id, space_id, title, created_by, last_sequence) values ('${T2}', '${GROUP}', 'New', '${B}', 2);
insert into bob.thread_messages (id, thread_id, space_id, author_user_id, body, sequence, client_message_id) values
  ('${tm(3)}', '${T2}', '${GROUP}', '${B}', 'first', 1, 'c3'), ('${tm(4)}', '${T2}', '${GROUP}', null, 'answer', 2, 'c4');
${inv(T2, tm(3))};
insert into bob.conversations (id, user_id, title) values ('conv_e_priv', '${E}', 'E private');
insert into bob.messages (id, conversation_id, user_id, role, position) values ('msg_e_zero', 'conv_e_priv', '${E}', 'user', 0);`;

const TABLES = ['spaces', 'space_memberships', 'conversations', 'messages', 'message_versions', 'conversation_reads'];

describe('conversation unify switch migration (#756 PR2)', () => {
  let db: TestDb;
  const rows = async <T,>(sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;
  const snapshot = () =>
    Promise.all([
      ...TABLES.map((t) => rows(`select count(*)::int as n from bob.${t}`)),
      rows('select id, revision, tombstoned_at, updated_at from bob.messages order by id'),
      rows('select id, version_index, is_selected, parts from bob.message_versions order by id'),
    ]);

  beforeAll(async () => {
    // The threads were written before PR1 (EXPAND) ran over them.
    db = await createMigratedDb({ before: SWITCH, seed: { [EXPAND]: SEED } });
    await db.exec(OLD_WRITES);
    const sql = readFileSync(new URL(SWITCH, dir), 'utf8');
    await db.transaction(async (tx) => void (await tx.exec(sql)));
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('catches up renames, archives, new threads and their messages in order', async () => {
    expect(await rows(`select id, title, archived_at is not null as archived from bob.conversations where id in ('${T1}', '${T2}') order by id`))
      .toEqual([{ id: T1, title: 'Renamed', archived: true }, { id: T2, title: 'New', archived: false }]);
    expect(await rows(`select id, sequence::int as seq, role, author_user_id from bob.messages where conversation_id = '${T2}' order by sequence`))
      .toEqual([{ id: tm(3), seq: 1, role: 'user', author_user_id: B }, { id: tm(4), seq: 2, role: 'assistant', author_user_id: null }]);
  });

  it('an edit becomes a new selected version; a tombstone is copied', async () => {
    expect(await rows(`select version_index, is_selected, parts->0->>'text' as body from bob.message_versions where message_id = '${tm(1)}' order by version_index`))
      .toEqual([{ version_index: 0, is_selected: false, body: 'hello' }, { version_index: 1, is_selected: true, body: 'hello edited' }]);
    expect(await rows(`select id, revision, tombstoned_by from bob.messages where id in ('${tm(1)}', '${tm(2)}') order by id`))
      .toEqual([{ id: tm(1), revision: 2, tombstoned_by: null }, { id: tm(2), revision: 2, tombstoned_by: B }]);
  });

  it('advances read cursors, keys invocations and fills the private conversation', async () => {
    expect(await rows(`select last_read_sequence::int as seq from bob.conversation_reads where conversation_id = '${T1}'`)).toEqual([{ seq: 2 }]);
    expect(await rows('select bool_and(conversation_id = thread_id::text) as ok from bob.ai_invocations')).toEqual([{ ok: true }]);
    expect(await rows(`select s.owner_user_id, c.created_by, m.sequence::int as seq, m.author_user_id, v.n
        from bob.conversations c join bob.spaces s on s.id = c.space_id and s.kind = 'private'
        join bob.messages m on m.conversation_id = c.id and m.space_id = c.space_id
        cross join (select count(*)::int as n from bob.message_versions where message_id = 'msg_e_zero') v
       where c.id = 'conv_e_priv'`)).toEqual([{ owner_user_id: E, created_by: E, seq: 1, author_user_id: E, n: 0 }]);
  });

  it('a second catch-up duplicates and changes nothing', async () => {
    const first = await snapshot();
    await db.query('select bob_private.unify_catch_up()');
    expect(await snapshot()).toEqual(first);
  });

  it('drops the invocation and notification thread FKs: an invocation may name a conversation that has no thread row', async () => {
    await db.query(`insert into bob.conversations (id, user_id, space_id, title) values ('${NEW_CONV}', '${A}', '${GROUP}', 'unified only')`);
    await db.query(`${inv(NEW_CONV, tm(9))}`);
    await db.query(`update bob.ai_invocations set conversation_id = thread_id::text, result_message_id = '${tm(8)}' where thread_id = '${NEW_CONV}'`);
    expect(await rows(`select conversation_id from bob.ai_invocations where thread_id = '${NEW_CONV}'`)).toEqual([{ conversation_id: NEW_CONV }]);
    expect(await rows(`select count(*)::int as n from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       where c.contype = 'f' and a.attname in ('thread_id', 'result_message_id')
         and c.conrelid in ('bob.ai_invocations'::regclass, 'bob.notification_preferences'::regclass)`))
      .toEqual([{ n: 0 }]);
  });
});
