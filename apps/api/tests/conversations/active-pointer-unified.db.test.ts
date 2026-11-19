// test:db suite for #756 PR3 (local Supabase stack only): the active pointer
// holds only conversation_id. A thr_ ref is translated at the edge, the
// definer clears a revoked member's
// pointer (RLS can no longer see the conversation), and a bare shared
// conversation uuid stays not found for General callers. Never skips.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import { clearActiveThreadInSpace, getActive, setActive } from '../../src/conversations/active.ts';
import { getConversation, getConversationSummary } from '../../src/conversations/store.ts';
import { withUser } from '../../src/platform/db/db.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { archiveThread, createThread } from '../../src/conversations/thread-store.ts';
import { ensureLocalStack, setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

type Stored = { conversation_id: string | null };

describe('active pointer holds only conversation_id (#756 PR3, test:db)', () => {
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

  async function sharedThread(name: string, member: string): Promise<{ spaceId: string; threadId: string }> {
    const space = await createSpace(env.db, env.a.userId, { kind: 'group', name });
    await addMember(env.db, env.a.userId, space.id, member, 'member');
    const thread = await createThread(env.db, env.a.userId, { spaceId: space.id, title: name });
    return { spaceId: space.id, threadId: thread.id };
  }

  async function point(userId: string, ref: string): Promise<number> {
    return withUser(env.db, userId, (tx) => setActive(tx, userId, ref, 'picker'));
  }

  async function stored(userId: string): Promise<Stored> {
    const rows = await admin.unsafe<Stored[]>(
      `select active_conversation_id as conversation_id from bob.user_state where user_id = $1`,
      [userId],
    );
    return rows[0]!;
  }

  async function legacyColumns(): Promise<unknown[]> {
    return admin.unsafe(
      `select 1 from information_schema.columns
       where table_schema = 'bob' and table_name = 'user_state'
         and column_name in ('thread_id', 'thread_space_id')`,
    );
  }

  it('a thr_ ref writes conversation_id, and the legacy thread columns are gone', async () => {
    const { spaceId, threadId } = await sharedThread('Unified write', env.d.userId);
    await point(env.d.userId, threadRef(threadId));
    expect(await stored(env.d.userId)).toEqual({ conversation_id: threadId });
    expect(await legacyColumns()).toEqual([]);
    expect(await getActive(env.db, env.d.userId)).toMatchObject({
      conversationId: threadRef(threadId), kind: 'thread', threadId, spaceId, title: 'Unified write', cleared: false,
    });
  });

  it("the definer clears a revoked member's pointer, and only the caller's own", async () => {
    const { spaceId, threadId } = await sharedThread('Revoked', env.d.userId);
    await point(env.d.userId, threadRef(threadId));
    const other = await withUser(env.db, env.a.userId, (tx) => tx.query<{ cleared: boolean }>(
      'select bob_private.clear_active_conversation_in_space($1, $2) as cleared', [env.d.userId, spaceId]));
    expect(other[0]?.cleared).toBe(false);
    expect((await stored(env.d.userId)).conversation_id).toBe(threadId);

    await revokeMember(env.db, env.a.userId, spaceId, env.d.userId);
    expect(await clearActiveThreadInSpace(env.db, env.d.userId, spaceId)).toEqual(expect.any(Number));
    expect(await stored(env.d.userId)).toEqual({ conversation_id: null });
    expect(await getActive(env.db, env.d.userId)).toMatchObject({ conversationId: null, kind: null, cleared: false });
  });

  it('select, then archive, then revoke stays stable', async () => {
    const { spaceId, threadId } = await sharedThread('Stable', env.d.userId);
    await point(env.d.userId, threadRef(threadId));
    await archiveThread(env.db, env.a.userId, threadId);
    expect(await getActive(env.db, env.d.userId)).toMatchObject({ conversationId: null, kind: null, cleared: true });
    await revokeMember(env.db, env.a.userId, spaceId, env.d.userId);
    expect(await clearActiveThreadInSpace(env.db, env.d.userId, spaceId)).toBeNull();
    expect(await getActive(env.db, env.d.userId)).toMatchObject({ conversationId: null, kind: null, cleared: false });
    expect(await stored(env.d.userId)).toEqual({ conversation_id: null });
    expect(await legacyColumns()).toEqual([]);
  });

  it('a bare shared conversation uuid is not found for General callers', async () => {
    const { threadId } = await sharedThread('Bare uuid', env.d.userId);
    expect(await getConversation(env.db, env.d.userId, threadId)).toBeNull();
    expect(await getConversationSummary(env.db, env.d.userId, threadId)).toBeNull();
  });
});
