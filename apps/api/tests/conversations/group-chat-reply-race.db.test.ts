import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { getSpace } from '../../src/spaces/store.ts';
import { acceptGroupChatLink, createGroupChat, createGroupChatLink } from '../../src/spaces/group-chat-store.ts';
import { listMessages, postAssistantMessage } from '../../src/conversations/thread-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

function observeLock(database: Db, onLock: () => void): Db {
  return {
    query: <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (/FOR UPDATE|lock_thread_audience_revision/i.test(sql)) onLock();
      return database.query<T>(sql, params);
    },
    tx: <T>(run: (tx: Db) => Promise<T>): Promise<T> => database.tx((tx) => run(observeLock(tx, onLock))),
  };
}

it.each(['actor', 'other'])('does not commit after %s membership changes between revision check and insertion', async (removed) => {
  const owner = await addAccount(pg);
  const guest = await addAccount(pg);
  const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
  const link = await createGroupChatLink(db, owner.userId, chat.id);
  await acceptGroupChatLink(db, guest.userId, link.token);
  const revision = (await getSpace(db, owner.userId, chat.space_id)).membershipRevision;
  let lockAttempted: () => void = () => undefined;
  const attempted = new Promise<void>((resolve) => { lockAttempted = resolve; });
  let reply: Promise<unknown> = Promise.resolve();
  await withUser(db, owner.userId, async (tx) => {
    await tx.query('SELECT id FROM bob.spaces WHERE id = $1 FOR UPDATE', [chat.space_id]);
    reply = postAssistantMessage(observeLock(db, lockAttempted), removed === 'actor' ? guest.userId : owner.userId,
      { threadId: chat.id, spaceId: chat.space_id, expectedMembershipRevision: revision }, randomUUID(), 'Reply');
    // Attach the rejection handler before releasing the transaction.
    void reply.catch(() => undefined);
    await attempted;
    await tx.query('SELECT bob_private.remove_group_chat_member($1::text, $2::uuid)', [chat.id, guest.userId]);
  });
  await expect(reply).rejects.toThrow('audience changed');
  expect((await listMessages(db, owner.userId, chat.id)).messages).toHaveLength(0);
});

it('allows an ordinary active member to commit against the unchanged audience revision', async () => {
  const owner = await addAccount(pg);
  const guest = await addAccount(pg);
  const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
  const link = await createGroupChatLink(db, owner.userId, chat.id);
  await acceptGroupChatLink(db, guest.userId, link.token);
  const revision = (await getSpace(db, guest.userId, chat.space_id)).membershipRevision;
  await postAssistantMessage(db, guest.userId,
    { threadId: chat.id, spaceId: chat.space_id, expectedMembershipRevision: revision }, randomUUID(), 'Reply');
  expect((await listMessages(db, guest.userId, chat.id)).messages).toHaveLength(1);
});
