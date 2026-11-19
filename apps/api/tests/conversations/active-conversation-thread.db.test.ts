// test:db suite for #565 U1 (local Supabase stack only): the device pointer in
// bob.active_conversations can name a space thread (stored as conversation_id
// since the #756 contract). Proves a non-member can neither read the thread nor
// point at it through setActive, the store's archived/stale handling, the old-server rollback rule (a
// conversation-only upsert over a thread pointer reads back as that
// conversation), a deleted thread reading back cleared, and that
// clearActiveThreadInSpace touches only the named space. Never skips: a stack
// that is down fails the suite.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import { clearActiveThreadInSpace, getActive, setActive } from '../../src/conversations/active.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { StoreNotFoundError, withUser } from '../../src/platform/db/db.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { archiveThread, createThread } from '../../src/conversations/thread-store.ts';
import { ensureLocalStack, setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

describe('active pointer names a space thread (#565 U1, test:db)', () => {
  let env: MemoryTestDb;
  let admin: postgres.Sql;

  beforeAll(async () => {
    const status = await ensureLocalStack();
    env = await setupMemoryTestDb();
    admin = postgres(status.DB_URL!, { max: 1, prepare: true });
  });

  afterAll(async () => {
    await admin?.end();
    await env?.cleanup();
  });

  async function thread(spaceId: string, title: string): Promise<string> {
    return (await createThread(env.db, env.a.userId, { spaceId, title })).id;
  }

  async function point(userId: string, ref: string | null): Promise<number> {
    return withUser(env.db, userId, (tx) => setActive(tx, userId, ref, 'picker'));
  }

  /** The pointer's one stored column (the #756 contract dropped thread_id/thread_space_id). */
  async function storedConversation(userId: string): Promise<string | null> {
    const rows = await admin.unsafe<Array<{ conversation_id: string | null }>>(
      `select active_conversation_id as conversation_id from bob.user_state where user_id = $1`,
      [userId],
    );
    return rows[0]!.conversation_id;
  }

  async function legacyColumns(): Promise<unknown[]> {
    return admin.unsafe(
      `select 1 from information_schema.columns
       where table_schema = 'bob' and table_name = 'user_state'
         and column_name in ('thread_id', 'thread_space_id')`,
    );
  }

  it('a member can point at a thread in a shared space', async () => {
    const threadId = await thread(env.spaces.groupABC, 'Weekend');
    await point(env.c.userId, threadRef(threadId));
    expect(await getActive(env.db, env.c.userId)).toMatchObject({
      conversationId: threadRef(threadId), kind: 'thread', threadId, spaceId: env.spaces.groupABC,
      title: 'Weekend', cleared: false,
    });
    expect(await storedConversation(env.c.userId)).toBe(threadId);
    expect(await legacyColumns()).toEqual([]);
  });

  // The pointer row itself has no membership policy any more: the
  // thread_space_id check went with its column, and active_conversations has no
  // RLS check on conversation_id membership (known finding from #774). Reads
  // stay safe: conversations RLS hides the thread and setActive refuses it.
  it('a non-member cannot read the shared thread, and setActive refuses it', async () => {
    const threadId = await thread(env.spaces.groupABC, 'Members only');
    const visible = await withUser(env.db, env.d.userId, (tx) =>
      tx.query('select id from bob.conversations where id = $1', [threadId]));
    expect(visible).toEqual([]);
    await expect(point(env.d.userId, threadRef(threadId))).rejects.toBeInstanceOf(StoreNotFoundError);

    await point(env.d.userId, (await createConversation(env.db, env.d.userId, 'Mine')).id);
    await expect(point(env.d.userId, threadRef(threadId))).rejects.toBeInstanceOf(StoreNotFoundError);
    expect((await getActive(env.db, env.d.userId))?.kind).toBe('conversation');
  });

  it('refuses an archived thread', async () => {
    const threadId = await thread(env.spaces.groupABC, 'Old news');
    await archiveThread(env.db, env.a.userId, threadId);
    await expect(point(env.a.userId, threadRef(threadId))).rejects.toBeInstanceOf(StoreNotFoundError);
  });

  it('nulls a thread whose membership was revoked on read, cleared: true', async () => {
    const space = await createSpace(env.db, env.a.userId, { kind: 'group', name: 'Book club' });
    await addMember(env.db, env.a.userId, space.id, env.d.userId, 'member');
    const threadId = await thread(space.id, 'Next book');
    await point(env.d.userId, threadRef(threadId));
    await revokeMember(env.db, env.a.userId, space.id, env.d.userId);

    expect(await getActive(env.db, env.d.userId)).toMatchObject({ conversationId: null, kind: null, cleared: true });
    expect(await storedConversation(env.d.userId)).toBeNull();
    expect(await legacyColumns()).toEqual([]);
    expect((await getActive(env.db, env.d.userId))?.cleared).toBe(false);
  });

  it('an old-server conversation-only upsert over a thread pointer reads back as that conversation', async () => {
    const threadId = await thread(env.spaces.pairAB, 'Pair plans');
    const conversation = await createConversation(env.db, env.b.userId, 'Old server chat');
    await point(env.b.userId, threadRef(threadId));
    await withUser(env.db, env.b.userId, (tx) => tx.query(
      `INSERT INTO bob.user_state
         (user_id, active_conversation_id, conversation_changed_at, conversation_surface)
       VALUES ($1, $2, now(), 'device')
       ON CONFLICT (user_id) DO UPDATE
         SET active_conversation_id  = EXCLUDED.active_conversation_id,
             conversation_changed_at = EXCLUDED.conversation_changed_at,
             conversation_surface    = EXCLUDED.conversation_surface`,
      [env.b.userId, conversation.id],
    ));
    expect(await getActive(env.db, env.b.userId)).toMatchObject({
      conversationId: conversation.id, kind: 'conversation', threadId: null, spaceId: null,
      title: 'Old server chat', surface: 'device', cleared: false,
    });
  });

  // #756 PR3: the pointer holds the thread as conversation_id, so a delete goes
  // through the FK `on delete set null` like a private conversation's (cleared: false).
  it('a deleted thread reads back as a nulled pointer', async () => {
    const threadId = await thread(env.spaces.groupABC, 'Doomed');
    await point(env.a.userId, threadRef(threadId));
    await admin.unsafe(`delete from bob.conversations where id = $1`, [threadId]);
    expect(await getActive(env.db, env.a.userId)).toMatchObject({ conversationId: null, kind: null, cleared: false });
    expect(await storedConversation(env.a.userId)).toBeNull();
    expect(await legacyColumns()).toEqual([]);
  });

  it('clearActiveThreadInSpace touches only that space', async () => {
    const inGroup = await thread(env.spaces.groupABC, 'Group topic');
    await point(env.a.userId, threadRef(inGroup));
    expect(await clearActiveThreadInSpace(env.db, env.a.userId, env.spaces.pairAB)).toBeNull();
    expect((await getActive(env.db, env.a.userId))?.threadId).toBe(inGroup);
    expect(await clearActiveThreadInSpace(env.db, env.a.userId, env.spaces.groupABC)).toEqual(expect.any(Number));
    expect(await storedConversation(env.a.userId)).toBeNull();
  });
});
