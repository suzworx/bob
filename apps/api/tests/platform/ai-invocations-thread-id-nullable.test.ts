/**
 * The #756 PR5 stage-A migration (20261002170000_ai_invocations_thread_id_nullable)
 * on real Postgres: rows the old server wrote (an invocation keyed only by thread_id,
 * active pointers with legacy thread columns) are seeded before it runs. After
 * it, thread_id is nullable, every invocation is keyed by conversation_id, the
 * pointer's thread columns are null with no pointer lost, and the
 * conversation_id partial unique index alone serialises running invocations.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from '../support/pg-template.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const STAGE_A = '20261002170000_ai_invocations_thread_id_nullable.sql';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const GROUP = '20000000-0000-4000-8000-0000000000f0';
const C1 = '40000000-0000-4000-8000-000000000001';
const C2 = '40000000-0000-4000-8000-000000000002';
const trigger = (n: number): string => `50000000-0000-4000-8000-00000000000${n}`;
const running = (conversation: string, n: number): string => `insert into bob.ai_invocations
  (space_id, conversation_id, actor_user_id, trigger_message_id, context_high_water, membership_revision, state)
  values ('${GROUP}', '${conversation}', '${A}', '${trigger(n)}', 1, 1, 'running')`;

// What the old server left behind before stage A.
const OLD_ROWS = `
insert into auth.users (id) values ('${A}'), ('${B}');
insert into bob.spaces (id, kind, name, owner_user_id) values ('${GROUP}', 'group', 'Family', '${A}');
insert into bob.space_memberships (space_id, user_id, role) values ('${GROUP}', '${A}', 'owner'), ('${GROUP}', '${B}', 'member');
insert into bob.conversations (id, user_id, space_id, title) values
  ('${C1}', '${A}', '${GROUP}', 'Family chat'), ('${C2}', '${A}', '${GROUP}', 'Plans');
insert into bob.ai_invocations
  (space_id, thread_id, actor_user_id, trigger_message_id, context_high_water, membership_revision, state)
  values ('${GROUP}', '${C2}', '${A}', '${trigger(1)}', 1, 1, 'completed');
insert into bob.active_conversations (user_id, conversation_id, thread_id, thread_space_id, surface) values
  ('${A}', '${C1}', '${C1}', '${GROUP}', 'picker'),
  ('${B}', null, '${C2}', '${GROUP}', 'picker');`;

describe('ai_invocations thread_id nullable migration (#756 PR5 stage A)', () => {
  let db: TestDb;
  const rows = async <T,>(sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;

  beforeAll(async () => {
    db = await createMigratedDb({ before: STAGE_A });
    await db.exec(OLD_ROWS);
    const sql = readFileSync(new URL(STAGE_A, dir), 'utf8');
    await db.transaction(async (tx) => void (await tx.exec(sql)));
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('makes ai_invocations.thread_id nullable', async () => {
    expect(await rows(`select is_nullable from information_schema.columns
        where table_schema = 'bob' and table_name = 'ai_invocations' and column_name = 'thread_id'`))
      .toEqual([{ is_nullable: 'YES' }]);
  });

  it('keys an old thread-only invocation by conversation_id', async () => {
    expect(await rows(`select conversation_id from bob.ai_invocations where trigger_message_id = '${trigger(1)}'`))
      .toEqual([{ conversation_id: C2 }]);
  });

  it('nulls the pointer thread columns, keeping or backfilling conversation_id first', async () => {
    expect(await rows(`select user_id, conversation_id, thread_id, thread_space_id
        from bob.active_conversations order by user_id`))
      .toEqual([
        { user_id: A, conversation_id: C1, thread_id: null, thread_space_id: null },
        { user_id: B, conversation_id: C2, thread_id: null, thread_space_id: null },
      ]);
  });

  it('rejects a second running invocation for one conversation; NULL thread_id rows never collide', async () => {
    await db.query(running(C1, 2));
    await expect(db.query(running(C1, 3))).rejects.toMatchObject({ code: '23505' });
    await db.query(running(C2, 4));
    expect(await rows(`select conversation_id, thread_id from bob.ai_invocations
        where state = 'running' order by conversation_id`))
      .toEqual([{ conversation_id: C1, thread_id: null }, { conversation_id: C2, thread_id: null }]);
  });
});
