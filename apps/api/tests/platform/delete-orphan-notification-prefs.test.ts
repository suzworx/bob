/**
 * The #756 PR5 stage B migration (20261002180000_delete_orphan_notification_prefs)
 * on real Postgres: legacy preferences and invocations are seeded after every earlier
 * migration ran (as a stage A server wrote them: thread_id only). The migration
 * links what it can, deletes the orphans with a counted notice, leaves
 * space-level preferences alone and is a no-op the second time.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from '../support/pg-template.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const MIGRATION = '20261002180000_delete_orphan_notification_prefs.sql';
const A = '00000000-0000-4000-8000-00000000000a';
const GROUP = '20000000-0000-4000-8000-0000000000f0';
const T1 = '40000000-0000-4000-8000-000000000001';
const GONE = '40000000-0000-4000-8000-0000000000dd';
const GONE2 = '40000000-0000-4000-8000-0000000000de';
const pref = (space: string | null, thread: string | null, type: string | null) =>
  `insert into bob.notification_preferences (user_id, space_id, thread_id, type, muted)
   values ('${A}', ${space ? `'${space}'` : 'null'}, ${thread ? `'${thread}'` : 'null'}, ${type ? `'${type}'` : 'null'}, true)`;
const invocation = (thread: string, trigger: string) =>
  `insert into bob.ai_invocations (space_id, thread_id, actor_user_id, trigger_message_id,
     context_high_water, membership_revision, state)
   values ('${GROUP}', '${thread}', '${A}', '${trigger}', 1, 1, 'completed')`;

const SEED = `
insert into auth.users (id) values ('${A}');
insert into bob.spaces (id, kind, name, owner_user_id) values ('${GROUP}', 'group', 'Family', '${A}');
insert into bob.conversations (id, user_id, space_id, title) values ('${T1}', '${A}', '${GROUP}', 'Family chat');
${pref(null, null, null)};
${pref(GROUP, null, null)};
${pref(GROUP, T1, 'mention')};
${pref(GROUP, GONE, 'mention')};
${pref(GROUP, GONE2, null)};
${invocation(T1, '50000000-0000-4000-8000-000000000001')};
${invocation(GONE, '50000000-0000-4000-8000-000000000002')};`;

describe('delete orphan notification preferences migration (#756 PR5 stage B)', () => {
  let db: TestDb;
  const notices: string[] = [];
  const rows = async <T,>(sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;
  const apply = async (): Promise<void> => {
    const sql = readFileSync(new URL(MIGRATION, dir), 'utf8');
    await db.transaction(async (tx) => void (await tx.exec(sql)));
  };

  beforeAll(async () => {
    db = await createMigratedDb({ before: MIGRATION, onNotice: (message) => notices.push(message) });
    await db.exec(SEED);
    await apply();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('links a linkable thread preference, deletes orphans and leaves space-level rows untouched', async () => {
    expect(await rows(`select space_id, conversation_id, type from bob.notification_preferences
        order by space_id nulls first, conversation_id nulls first`)).toEqual([
      { space_id: null, conversation_id: null, type: null },
      { space_id: GROUP, conversation_id: null, type: null },
      { space_id: GROUP, conversation_id: T1, type: 'mention' },
    ]);
  });

  it('links an invocation whose conversation exists and deletes the one whose thread is gone', async () => {
    expect(await rows('select conversation_id from bob.ai_invocations')).toEqual([{ conversation_id: T1 }]);
  });

  it('reports each deletion count in a notice', () => {
    expect(notices).toContain('deleting 2 orphan notification preference(s)');
    expect(notices).toContain('deleting 1 orphan ai invocation(s)');
  });

  it('drops the thread-keyed index and adds the thread-free conversation index', async () => {
    expect(await rows(`select indexname from pg_indexes where tablename = 'notification_preferences'
        and indexname like 'notification_prefs_%uidx' order by indexname`)).toEqual([
      { indexname: 'notification_prefs_conversation_key_uidx' },
      { indexname: 'notification_prefs_conversation_only_uidx' },
    ]);
  });

  it('arbitrates an upsert on the thread-free index: idempotent, space- and thread-level rows coexist', async () => {
    const upsert = (muted: boolean) => db.query(`insert into bob.notification_preferences
        (user_id, space_id, conversation_id, type, muted) values ('${A}', '${GROUP}', '${T1}', null, ${muted})
      on conflict (user_id, (coalesce(space_id, '00000000-0000-0000-0000-000000000000')),
        (coalesce(conversation_id, '')), (coalesce(type, ''))) do update set muted = excluded.muted`);
    await upsert(true);
    await upsert(false);
    expect(await rows(`select conversation_id, type, muted from bob.notification_preferences
        where space_id = '${GROUP}' and type is null order by conversation_id nulls first`)).toEqual([
      { conversation_id: null, type: null, muted: true },
      { conversation_id: T1, type: null, muted: false },
    ]);
  });

  it('lets two thread mutes in one space coexist', async () => {
    await db.query(`insert into bob.conversations (id, user_id, space_id, title)
        values ('${GONE}', '${A}', '${GROUP}', 'Second chat')`);
    await db.query(`insert into bob.notification_preferences (user_id, space_id, conversation_id, type)
        values ('${A}', '${GROUP}', '${GONE}', 'mention')`);
  });

  it('changes nothing when re-run', async () => {
    const before = await rows('select * from bob.notification_preferences order by id');
    const invocations = await rows('select * from bob.ai_invocations order by id');
    notices.length = 0;
    await apply();
    expect(await rows('select * from bob.notification_preferences order by id')).toEqual(before);
    expect(await rows('select * from bob.ai_invocations order by id')).toEqual(invocations);
    expect(notices.filter((n) => n.startsWith('deleting'))).toEqual([]);
  });
});
