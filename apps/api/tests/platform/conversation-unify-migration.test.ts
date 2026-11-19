/**
 * The #756 expand+backfill migration (20261001100000_conversation_unify_expand)
 * on real Postgres: every earlier migration is applied, legacy private conversations
 * and a group thread are seeded, then the new file runs. Proves the backfill
 * (ids kept, sequences, versions, reads, invocations), that it re-runs as a
 * no-op, and the space-member RLS including the RESTRICTIVE space guard.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb, type TestTx } from '../support/pg-template.ts';

const migrationDir = new URL('../../../../supabase/migrations/', import.meta.url);
const TARGET = '20261001100000_conversation_unify_expand.sql';
const expand = readFileSync(new URL(TARGET, migrationDir), 'utf8');

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const D = '00000000-0000-4000-8000-00000000000d';
const SENTINEL = '00000000-0000-4000-8000-0000000000de';
const PRIVATE_A = '20000000-0000-4000-8000-00000000000a';
const GROUP = '20000000-0000-4000-8000-0000000000f0';
const DEVICE = '30000000-0000-4000-8000-00000000000a';
const THREAD = '40000000-0000-4000-8000-000000000001';
const tm = (n: number): string => `50000000-0000-4000-8000-00000000000${n}`;

/** A fresh database with every migration sorted before TARGET. */
function freshDbBeforeTarget(): Promise<TestDb> {
  return createMigratedDb({ before: TARGET });
}

/** Runs the migration under test in one transaction, as the runner does. */
async function runExpand(db: TestDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.exec(expand);
  });
}

async function withUser<T>(
  db: TestDb,
  userId: string,
  fn: (tx: TestTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(
      `select set_config('request.jwt.claims',
         json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`,
      [userId],
    );
    await tx.query('set local role authenticated');
    return fn(tx);
  });
}

/** Legacy data as it stands before the migration (seeded as superuser). */
const SEED = `
insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}'), ('${D}'), ('${SENTINEL}');
insert into bob.spaces (id, kind, name, owner_user_id) values
  ('${PRIVATE_A}', 'private', 'Private', '${A}'),
  ('${GROUP}', 'group', 'Family', '${A}');
insert into bob.space_memberships (space_id, user_id, role) values
  ('${PRIVATE_A}', '${A}', 'owner'),
  ('${GROUP}', '${A}', 'owner'), ('${GROUP}', '${B}', 'admin'), ('${GROUP}', '${C}', 'member');
insert into bob.devices (id, user_id, name, model, fw_version)
  values ('${DEVICE}', '${A}', 'Kitchen', 'M5Stack Cardputer', '2.0.1');

insert into bob.conversations (id, user_id, title) values
  ('conv_a_one', '${A}', 'A private'), ('conv_b_one', '${B}', 'B private');
insert into bob.messages (id, conversation_id, user_id, role, position) values
  ('msg_a_one_0', 'conv_a_one', '${A}', 'user', 0),
  ('msg_a_one_1', 'conv_a_one', '${A}', 'assistant', 1),
  ('msg_b_one_0', 'conv_b_one', '${B}', 'user', 0);
insert into bob.message_versions (id, message_id, user_id, parts, version_index) values
  ('ver_a_one_0', 'msg_a_one_0', '${A}', '[{"type":"text","text":"a0"}]', 0),
  ('ver_a_one_1', 'msg_a_one_1', '${A}', '[{"type":"text","text":"a1"}]', 0),
  ('ver_b_one_0', 'msg_b_one_0', '${B}', '[{"type":"text","text":"b0"}]', 0);

insert into bob.threads (id, space_id, title, created_by, last_sequence)
  values ('${THREAD}', '${GROUP}', 'Family chat', '${A}', 6);
insert into bob.thread_messages
  (id, thread_id, space_id, author_user_id, body, reply_to_message_id, sequence,
   client_message_id, revision, tombstoned_at, tombstoned_by, device_id, updated_at) values
  ('${tm(1)}', '${THREAD}', '${GROUP}', '${A}', 'hello', null, 1, 'c1', 1, null, null, '${DEVICE}', '2026-09-20T10:00:01Z'),
  ('${tm(2)}', '${THREAD}', '${GROUP}', null, 'hi there', null, 2, 'c2', 1, null, null, null, '2026-09-20T10:00:02Z'),
  ('${tm(3)}', '${THREAD}', '${GROUP}', '${B}', 'edited text', null, 3, 'c3', 3, null, null, null, '2026-09-20T10:00:03Z'),
  ('${tm(4)}', '${THREAD}', '${GROUP}', '${C}', 'oops', null, 4, 'c4', 1, '2026-09-20T11:00:00Z', '${C}', null, '2026-09-20T10:00:04Z'),
  ('${tm(5)}', '${THREAD}', '${GROUP}', '${B}', 'reply', '${tm(1)}', 5, 'c5', 1, null, null, null, '2026-09-20T10:00:05Z'),
  ('${tm(6)}', '${THREAD}', '${GROUP}', '${C}', 'from C', null, 6, 'c6', 1, null, null, null, '2026-09-20T10:00:06Z');
insert into bob.thread_reads (thread_id, user_id, last_read_sequence) values
  ('${THREAD}', '${B}', 4), ('${THREAD}', '${C}', 2);
insert into bob.ai_invocations
  (space_id, thread_id, actor_user_id, trigger_message_id, context_high_water,
   membership_revision, state, result_message_id)
  values ('${GROUP}', '${THREAD}', '${A}', '${tm(1)}', 1, 1, 'completed', '${tm(2)}');
`;

async function count(db: TestDb, table: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return rows[0]!.n;
}

describe('conversation unify expand migration (#756 PR1): backfill', () => {
  let db: TestDb;
  const before = { conversations: 0, threads: 0, messages: 0, threadMessages: 0 };

  beforeAll(async () => {
    db = await freshDbBeforeTarget();
    await db.exec(SEED);
    before.conversations = await count(db, 'bob.conversations');
    before.threads = await count(db, 'bob.threads');
    before.messages = await count(db, 'bob.messages');
    before.threadMessages = await count(db, 'bob.thread_messages');
    await runExpand(db);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('gives every non-sentinel user exactly one self space with an owner membership', async () => {
    const { rows } = await db.query<{ user_id: string; spaces: number; owners: number }>(
      `select u.id as user_id,
              (select count(*)::int from bob.spaces s
                where s.kind = 'private' and s.owner_user_id = u.id) as spaces,
              (select count(*)::int from bob.spaces s
                 join bob.space_memberships m on m.space_id = s.id
                where s.kind = 'private' and s.owner_user_id = u.id
                  and m.user_id = u.id and m.role = 'owner') as owners
         from auth.users u order by u.id`,
    );
    for (const row of rows) {
      const want = row.user_id === SENTINEL ? 0 : 1;
      expect(row, row.user_id).toMatchObject({ spaces: want, owners: want });
    }
  });

  it('copies every thread and thread message in, one selected version per message', async () => {
    expect(await count(db, 'bob.conversations')).toBe(before.conversations + before.threads);
    expect(await count(db, 'bob.messages')).toBe(before.messages + before.threadMessages);
    expect(await count(db, 'bob.message_versions')).toBe(await count(db, 'bob.messages'));
  });

  it('keeps thread ids and copies every thread-message column', async () => {
    const conv = await db.query<Record<string, unknown>>(
      `select c.id, c.user_id, c.created_by, c.space_id, c.last_sequence::int as last_sequence
         from bob.conversations c where c.id = $1`,
      [THREAD],
    );
    expect(conv.rows).toEqual([
      { id: THREAD, user_id: A, created_by: A, space_id: GROUP, last_sequence: 6 },
    ]);
    const { rows } = await db.query<Record<string, unknown>>(
      `select m.id = tm.id::text as same_id, m.conversation_id = tm.thread_id::text as same_conv,
              m.sequence = tm.sequence as same_seq, m.revision = tm.revision as same_rev,
              m.tombstoned_at is not distinct from tm.tombstoned_at as same_tomb_at,
              m.tombstoned_by is not distinct from tm.tombstoned_by as same_tomb_by,
              m.author_user_id is not distinct from tm.author_user_id as same_author,
              m.device_id is not distinct from tm.device_id as same_device,
              m.updated_at = tm.updated_at as same_updated,
              m.reply_to_message_id is not distinct from tm.reply_to_message_id::text as same_reply,
              m.space_id = tm.space_id as same_space,
              m.role = case when tm.author_user_id is null then 'assistant' else 'user' end as same_role,
              m.user_id = coalesce(tm.author_user_id, t.created_by) as same_user,
              v.parts = jsonb_build_array(jsonb_build_object('type', 'text', 'text', tm.body)) as same_parts,
              v.version_index = 0 and v.is_selected as selected,
              (select count(*)::int from bob.message_versions x where x.message_id = m.id) as versions
         from bob.thread_messages tm
         join bob.threads t on t.id = tm.thread_id
         left join bob.messages m on m.id = tm.id::text
         left join bob.message_versions v on v.message_id = m.id`,
    );
    expect(rows).toHaveLength(before.threadMessages);
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        expect(value, key).toBe(key === 'versions' ? 1 : true);
      }
    }
    const assistant = await db.query<Record<string, unknown>>(
      'select role, author_user_id, user_id from bob.messages where id = $1',
      [tm(2)],
    );
    expect(assistant.rows).toEqual([{ role: 'assistant', author_user_id: null, user_id: A }]);
    const device = await db.query<{ origin: string }>('select origin from bob.messages where id = $1', [tm(1)]);
    expect(device.rows[0]?.origin).toBe('device');
  });

  it('numbers every conversation strictly increasing; private sequence = position + 1', async () => {
    const { rows } = await db.query<{ conversation_id: string; seqs: number[]; positions: number[]; last_sequence: number; kind: string }>(
      `select m.conversation_id, array_agg(m.sequence::int order by m.sequence) as seqs,
              array_agg(m.position order by m.sequence) as positions, c.last_sequence::int as last_sequence,
              s.kind
         from bob.messages m
         join bob.conversations c on c.id = m.conversation_id
         join bob.spaces s on s.id = c.space_id
        group by m.conversation_id, c.last_sequence, s.kind`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.seqs.every((s, i) => i === 0 || s > row.seqs[i - 1]!), row.conversation_id).toBe(true);
      expect(row.last_sequence, row.conversation_id).toBe(Math.max(...row.seqs));
      if (row.kind === 'private') expect(row.seqs).toEqual(row.positions.map((p) => p + 1));
    }
    const priv = await db.query<Record<string, unknown>>(
      `select id, author_user_id from bob.messages where conversation_id like 'conv_%' order by id`,
    );
    expect(priv.rows).toEqual([
      { id: 'msg_a_one_0', author_user_id: A },
      { id: 'msg_a_one_1', author_user_id: null },
      { id: 'msg_b_one_0', author_user_id: B },
    ]);
  });

  it('copies thread_reads into conversation_reads and keys ai_invocations by conversation', async () => {
    const reads = await db.query<Record<string, unknown>>(
      `select r.thread_id::text as conversation_id, r.user_id, r.last_read_sequence::int as seq,
              cr.last_read_sequence::int as copied, cr.updated_at = r.updated_at as same_updated
         from bob.thread_reads r
         left join bob.conversation_reads cr
           on cr.conversation_id = r.thread_id::text and cr.user_id = r.user_id
        order by r.user_id`,
    );
    expect(reads.rows).toEqual([
      { conversation_id: THREAD, user_id: B, seq: 4, copied: 4, same_updated: true },
      { conversation_id: THREAD, user_id: C, seq: 2, copied: 2, same_updated: true },
    ]);
    expect(await count(db, 'bob.conversation_reads')).toBe(2);
    const inv = await db.query<{ ok: boolean }>(
      'select conversation_id = thread_id::text as ok from bob.ai_invocations',
    );
    expect(inv.rows).toEqual([{ ok: true }]);
  });

  it('re-running the whole migration changes no counts', async () => {
    const tables = [
      'bob.spaces', 'bob.space_memberships', 'bob.conversations', 'bob.messages',
      'bob.message_versions', 'bob.conversation_reads',
    ];
    const first = await Promise.all(tables.map((t) => count(db, t)));
    await runExpand(db);
    expect(await Promise.all(tables.map((t) => count(db, t)))).toEqual(first);
  });

  it('rejects a second message with the same (author_user_id, client_message_id)', async () => {
    await expect(
      db.query(
        `insert into bob.messages
           (id, conversation_id, user_id, role, position, author_user_id, client_message_id)
         values ('msg_dup_c1', 'conv_a_one', $1, 'user', 9, $1, 'c1')`,
        [A],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint "messages_author_client_uidx"/);
  });
});

describe('conversation unify expand migration (#756 PR1): no threads table', () => {
  it('applies when bob.threads is absent (the to_regclass branch is skipped)', async () => {
    const db = await freshDbBeforeTarget();
    try {
      // ai_invocations stays (section 6 alters it unguarded); the cascade only
      // drops its FKs to the thread tables.
      await db.exec(`insert into auth.users (id) values ('${A}');
        drop table bob.thread_reads cascade;
        drop table bob.thread_messages cascade;
        drop table bob.threads cascade;`);
      await expect(runExpand(db)).resolves.toBeUndefined();
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from information_schema.columns
          where table_schema = 'bob' and table_name = 'conversations' and column_name = 'space_id'`,
      );
      expect(rows[0]?.n).toBe(1);
      expect(await count(db, 'bob.conversations')).toBe(0);
    } finally {
      await db.close();
    }
  }, 120_000);
});

describe('conversation unify expand migration (#756 PR1): RLS', () => {
  let db: TestDb;
  const ids = (tx: TestTx, sql: string, params: unknown[] = []): Promise<string[]> =>
    tx.query<{ id: string }>(sql, params).then((r) => r.rows.map((row) => row.id).sort());
  const visible = (tx: TestTx) =>
    Promise.all([
      ids(tx, 'select id from bob.conversations'),
      ids(tx, 'select id from bob.messages'),
      ids(tx, 'select id from bob.message_versions'),
      ids(tx, 'select conversation_id || user_id::text as id from bob.conversation_reads'),
    ]);
  const threadMsgs = [1, 2, 3, 4, 5, 6].map(tm);

  beforeAll(async () => {
    db = await freshDbBeforeTarget();
    await db.exec(SEED);
    await runExpand(db);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('owners read their own private conversations; another account reads none of them', async () => {
    const [convs, msgs] = await withUser(db, A, visible);
    expect(convs.filter((id) => id.startsWith('conv_'))).toEqual(['conv_a_one']);
    expect(msgs.filter((id) => id.startsWith('msg_'))).toEqual(['msg_a_one_0', 'msg_a_one_1']);
    await withUser(db, B, async (tx) => {
      expect(await ids(tx, `select id from bob.conversations where id = 'conv_a_one'`)).toEqual([]);
      expect(await ids(tx, `select id from bob.messages where conversation_id = 'conv_a_one'`)).toEqual([]);
      expect(await ids(tx, `select id from bob.message_versions where message_id like 'msg_a_%'`)).toEqual([]);
    });
  });

  it('every group member reads the group conversation, its messages and versions', async () => {
    for (const member of [A, B, C]) {
      const [convs, msgs, vers, reads] = await withUser(db, member, visible);
      expect(convs, member).toContain(THREAD);
      expect(msgs.filter((id) => threadMsgs.includes(id)), member).toEqual(threadMsgs);
      expect(vers.filter((id) => id.startsWith('ver_5')), member).toHaveLength(6);
      expect(reads, member).toHaveLength(2);
    }
  });

  it('a non-member reads nothing', async () => {
    expect(await withUser(db, D, visible)).toEqual([[], [], [], []]);
  });

  it('old code still inserts a conversation and message with no space_id', async () => {
    await withUser(db, A, async (tx) => {
      await tx.query(`insert into bob.conversations (id, user_id, title) values ('conv_old_path', $1, 'old')`, [A]);
      await tx.query(
        `insert into bob.messages (id, conversation_id, user_id, role, position)
         values ('msg_old_path', 'conv_old_path', $1, 'user', 0)`,
        [A],
      );
      expect(await ids(tx, `select id from bob.messages where conversation_id = 'conv_old_path'`)).toEqual([
        'msg_old_path',
      ]);
    });
  });

  it('the messages update grant covers revision/tombstoned_at but not role/position', async () => {
    const { rows } = await db.query<Record<string, boolean>>(
      `select ${['revision', 'tombstoned_at', 'role', 'position']
        .map((c) => `has_column_privilege('authenticated', 'bob.messages', '${c}', 'UPDATE') as ${c}`)
        .join(', ')}`,
    );
    expect(rows[0]).toEqual({ revision: true, tombstoned_at: true, role: false, position: false });
    await withUser(db, A, async (tx) => {
      const res = await tx.query(`update bob.messages set revision = 2 where id = 'msg_a_one_0'`);
      expect(res.affectedRows).toBe(1);
    });
    for (const set of [`role = 'assistant'`, 'position = 7']) {
      await expect(
        withUser(db, A, (tx) => tx.query(`update bob.messages set ${set} where id = 'msg_a_one_0'`)),
      ).rejects.toThrow(/permission denied/);
    }
  });

  // Last: revokes C. The restrictive guard must hide even rows whose user_id = C.
  it('a former member reads nothing, including rows they authored', async () => {
    const authored = await db.query<{ id: string }>('select id from bob.messages where user_id = $1', [C]);
    expect(authored.rows.length).toBeGreaterThan(0);
    await db.query('update bob.space_memberships set revoked_at = now() where space_id = $1 and user_id = $2', [
      GROUP,
      C,
    ]);
    const [convs, msgs, vers, reads] = await withUser(db, C, visible);
    expect(convs).toEqual([]);
    expect(msgs).toEqual([]);
    expect(vers).toEqual([]);
    expect(reads).toEqual([]);
  });
});
