/**
 * The #756 PR5 expand migration (20261002160000_notification_prefs_conversation)
 * on real Postgres: legacy preference rows (global, space-level, thread-level, and one
 * whose thread never reached bob.conversations) are seeded before it runs;
 * it backfills conversation_id, leaves the orphan NULL (never deleted) and adds
 * the conversation-keyed unique index beside the old one.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from '../support/pg-template.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const MIGRATION = '20261002160000_notification_prefs_conversation.sql';
const A = '00000000-0000-4000-8000-00000000000a';
const GROUP = '20000000-0000-4000-8000-0000000000f0';
const T1 = '40000000-0000-4000-8000-000000000001';
const GONE = '40000000-0000-4000-8000-0000000000dd';
const GONE2 = '40000000-0000-4000-8000-0000000000de';
const pref = (space: string | null, thread: string | null, type: string | null) =>
  `insert into bob.notification_preferences (user_id, space_id, thread_id, type, muted)
   values ('${A}', ${space ? `'${space}'` : 'null'}, ${thread ? `'${thread}'` : 'null'}, ${type ? `'${type}'` : 'null'}, true)`;

const SEED = `
insert into auth.users (id) values ('${A}');
insert into bob.spaces (id, kind, name, owner_user_id) values ('${GROUP}', 'group', 'Family', '${A}');
insert into bob.conversations (id, user_id, space_id, title) values ('${T1}', '${A}', '${GROUP}', 'Family chat');
${pref(null, null, null)};
${pref(GROUP, null, null)};
${pref(GROUP, T1, null)};
${pref(GROUP, GONE, 'mention')};
${pref(GROUP, GONE2, 'mention')};`;

describe('notification preferences conversation_id expand migration (#756 PR5)', () => {
  let db: TestDb;
  const rows = async <T,>(sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;

  beforeAll(async () => {
    db = await createMigratedDb({ before: MIGRATION });
    await db.exec(SEED);
    const sql = readFileSync(new URL(MIGRATION, dir), 'utf8');
    await db.transaction(async (tx) => void (await tx.exec(sql)));
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('backfills conversation_id from thread_id and leaves a missing conversation NULL, not deleted', async () => {
    expect(await rows(`select thread_id, conversation_id from bob.notification_preferences
        order by thread_id nulls first, space_id nulls first`)).toEqual([
      { thread_id: null, conversation_id: null },
      { thread_id: null, conversation_id: null },
      { thread_id: T1, conversation_id: T1 },
      { thread_id: GONE, conversation_id: null },
      { thread_id: GONE2, conversation_id: null },
    ]);
  });

  it('keeps the old key index and adds the conversation key index', async () => {
    expect(await rows(`select indexname from pg_indexes where tablename = 'notification_preferences'
        and indexname like 'notification_prefs_%key_uidx' order by indexname`))
      .toEqual([{ indexname: 'notification_prefs_conversation_key_uidx' }, { indexname: 'notification_prefs_key_uidx' }]);
  });

  it('rejects a duplicate conversation-level key while space-level and thread-level rows coexist', async () => {
    // A distinct thread_id passes the old index, so only the new one can reject it.
    await expect(db.query(`insert into bob.notification_preferences (user_id, space_id, thread_id, conversation_id)
        values ('${A}', '${GROUP}', '${GONE}', '${T1}')`)).rejects.toThrow(/notification_prefs_conversation_key_uidx/);
    expect(await rows(`select count(*)::int as n from bob.notification_preferences
        where space_id = '${GROUP}' and type is null`)).toEqual([{ n: 2 }]);
  });

  it('cascades a deleted conversation to its preferences', async () => {
    await db.query(`delete from bob.conversations where id = '${T1}'`);
    expect(await rows(`select count(*)::int as n from bob.notification_preferences where thread_id = '${T1}'`))
      .toEqual([{ n: 0 }]);
  });
});
