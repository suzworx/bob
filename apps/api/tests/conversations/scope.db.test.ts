// test:db suite for #756 PR3: a device ref's conversation scope, against the
// local Supabase stack as bob_server under real RLS. Shared-space behaviour
// keys off the space's kind; a conversation the caller cannot see is null.
// Skips cleanly when Docker is not available.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archiveSpace, createSpace } from '../../src/spaces/store.ts';
import { archiveThread, createThread } from '../../src/conversations/thread-store.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { getConversationScope } from '../../src/conversations/scope.ts';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;

describe.skipIf(!dockerUp)('getConversationScope (#756, test:db)', () => {
  let env: MemoryTestDb;

  beforeAll(async () => {
    env = await setupMemoryTestDb();
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it('a General conversation is private', async () => {
    const conversation = await createConversation(env.db, env.a.userId, 'Dinner ideas');
    expect(await getConversationScope(env.db, env.a.userId, conversation.id)).toMatchObject({
      conversationId: conversation.id, spaceKind: 'private', spaceArchived: false, archivedAt: null, title: 'Dinner ideas',
    });
  });

  it('a pair thread is pair for both peers', async () => {
    const thread = await createThread(env.db, env.a.userId, { spaceId: env.spaces.pairAB, title: 'Us' });
    const expected = {
      conversationId: thread.id, spaceId: env.spaces.pairAB, spaceKind: 'pair', spaceArchived: false, archivedAt: null, title: 'Us',
    };
    expect(await getConversationScope(env.db, env.a.userId, threadRef(thread.id))).toMatchObject(expected);
    expect(await getConversationScope(env.db, env.b.userId, threadRef(thread.id))).toMatchObject(expected);
  });

  it('a group thread is group; an archived thread carries its stamp', async () => {
    const thread = await createThread(env.db, env.a.userId, { spaceId: env.spaces.groupABC, title: 'Family' });
    expect(await getConversationScope(env.db, env.c.userId, threadRef(thread.id))).toMatchObject({
      conversationId: thread.id, spaceId: env.spaces.groupABC, spaceKind: 'group', archivedAt: null, title: 'Family',
    });
    await archiveThread(env.db, env.a.userId, thread.id);
    const archived = await getConversationScope(env.db, env.a.userId, threadRef(thread.id));
    expect(archived?.archivedAt).toEqual(expect.any(Number));
  });

  it('a thread in an archived space says so', async () => {
    const space = await createSpace(env.db, env.a.userId, { kind: 'group', name: 'Old club' });
    const thread = await createThread(env.db, env.a.userId, { spaceId: space.id, title: 'Minutes' });
    await archiveSpace(env.db, env.a.userId, space.id);
    expect(await getConversationScope(env.db, env.a.userId, threadRef(thread.id))).toMatchObject({
      spaceId: space.id, spaceKind: 'group', spaceArchived: true, archivedAt: null,
    });
  });

  it('a conversation the caller cannot see is null, like an unknown or empty ref', async () => {
    const theirs = await createConversation(env.db, env.a.userId, 'Private words');
    const thread = await createThread(env.db, env.a.userId, { spaceId: env.spaces.groupABC, title: 'Members only' });
    expect(await getConversationScope(env.db, env.d.userId, theirs.id)).toBeNull();
    expect(await getConversationScope(env.db, env.d.userId, threadRef(thread.id))).toBeNull();
    expect(await getConversationScope(env.db, env.a.userId, threadRef(randomUUID()))).toBeNull();
    expect(await getConversationScope(env.db, env.a.userId, '')).toBeNull();
  });
});
