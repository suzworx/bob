// Unified thread store tests (#756 PR2): a parity copy of
// collaboration/store-threads.test.ts retargeted at conversations/thread-store
// over bob.conversations/messages/message_versions/conversation_reads. Every
// behavioural assertion is identical: sequence under a row lock, client id
// dedupe, additive edits, authorship, not-found-equals-forbidden, per-person unread.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreError, StoreNotFoundError, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { archiveThread, createThread, editMessage, getMessage, getThread, listMessages, listRecentMessages, listThreads, markRead, postAssistantMessage, postMessage, renameThread, tombstoneMessage, unreadCount } from '../../src/conversations/thread-store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

/** A group space with owner A, plain member B, and admin C; D is an outsider. */
async function familySpace() {
  const a = await addAccount(pg);
  const b = await addAccount(pg);
  const c = await addAccount(pg);
  const d = await addAccount(pg);
  const space = await createSpace(db, a.userId, { kind: 'group', name: 'Family' });
  await addMember(db, a.userId, space.id, b.userId, 'member');
  await addMember(db, a.userId, space.id, c.userId, 'admin');
  return { a, b, c, d, space };
}

describe('threads store', () => {
  it('rule 1: concurrent posts get distinct consecutive sequences and both survive', async () => {
    const { a, b, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Concurrent' });

    const [one, two] = await Promise.all([
      postMessage(db, a.userId, { threadId: thread.id, body: 'one', clientMessageId: 'c1' }),
      postMessage(db, b.userId, { threadId: thread.id, body: 'two', clientMessageId: 'c2' }),
    ]);
    expect(one.created).toBe(true);
    expect(two.created).toBe(true);
    expect(one.message.sequence).not.toBe(two.message.sequence);

    const { messages } = await listMessages(db, a.userId, thread.id, {});
    expect(messages).toHaveLength(2);
    const sequences = messages.map((m) => m.sequence).sort((x, y) => x - y);
    expect(sequences).toEqual([1, 2]);
    expect(messages[0]!.sequence).toBeLessThan(messages[1]!.sequence);
  });

  it('rule 2: the same client_message_id returns the original message, one row', async () => {
    const { a, b, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Dedupe' });

    const first = await postMessage(db, a.userId, {
      threadId: thread.id,
      body: 'hello',
      clientMessageId: 'same-id',
    });
    const retry = await postMessage(db, a.userId, {
      threadId: thread.id,
      body: 'hello (edited client copy)',
      clientMessageId: 'same-id',
    });
    expect(retry.created).toBe(false);
    expect(retry.message.id).toBe(first.message.id);
    expect(retry.message.body).toBe('hello');

    // The unique is per author: B may use the same client id independently.
    const bOwn = await postMessage(db, b.userId, {
      threadId: thread.id,
      body: 'mine',
      clientMessageId: 'same-id',
    });
    expect(bOwn.created).toBe(true);

    const { messages } = await listMessages(db, a.userId, thread.id, {});
    expect(messages).toHaveLength(2);
  });

  it('rule 3: editing writes a new revision and leaves every later message intact', async () => {
    const { a, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Additive' });

    const original = await postMessage(db, a.userId, {
      threadId: thread.id,
      body: 'first',
      clientMessageId: 'e-a',
    });
    const reply = await postMessage(db, a.userId, {
      threadId: thread.id,
      body: 'second (a reply)',
      clientMessageId: 'e-b',
      replyToMessageId: original.message.id,
    });

    const edited = await editMessage(db, a.userId, original.message.id, { body: 'first edited' });
    expect(edited.revision).toBe(2);
    expect(edited.body).toBe('first edited');

    // The regression this schema exists to prevent: the reply posted AFTER the
    // edited message still exists, untouched, in ascending order.
    const { messages } = await listMessages(db, a.userId, thread.id, {});
    expect(messages).toHaveLength(2);
    expect(messages[0]!.id).toBe(original.message.id);
    expect(messages[0]!.revision).toBe(2);
    expect(messages[1]!.id).toBe(reply.message.id);
    expect(messages[1]!.body).toBe('second (a reply)');
    expect(messages[1]!.revision).toBe(1);
    expect(messages[1]!.sequence).toBeGreaterThan(messages[0]!.sequence);
  });

  it('rule 4: only the author edits; an owner/admin may tombstone another as moderation', async () => {
    const { a, b, c, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Authorship' });

    const aMsg = await postMessage(db, a.userId, {
      threadId: thread.id,
      body: 'a says',
      clientMessageId: 'auth-a',
    });

    // A plain member cannot rewrite or tombstone another's message.
    await expect(
      editMessage(db, b.userId, aMsg.message.id, { body: 'rewritten' }),
    ).rejects.toThrow(StoreNotFoundError);
    await expect(tombstoneMessage(db, b.userId, aMsg.message.id)).rejects.toThrow(
      StoreNotFoundError,
    );

    // An admin may tombstone another's message as moderation, recorded as such.
    const moderated = await tombstoneMessage(db, c.userId, aMsg.message.id);
    expect(moderated.tombstonedAt).not.toBeNull();
    expect(moderated.tombstonedBy).toBe(c.userId);

    // The owner may not rewrite another's body either.
    const bMsg = await postMessage(db, b.userId, {
      threadId: thread.id,
      body: 'b says',
      clientMessageId: 'auth-b',
    });
    await expect(editMessage(db, a.userId, bMsg.message.id, { body: 'nope' })).rejects.toThrow(
      StoreNotFoundError,
    );

    // The author can still edit their own.
    const selfEdit = await editMessage(db, b.userId, bMsg.message.id, { body: 'b edited' });
    expect(selfEdit.body).toBe('b edited');
    expect(selfEdit.revision).toBe(2);
  });

  it('rule 5: not found equals forbidden for getThread and listMessages', async () => {
    const { a, d, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Hidden' });
    await postMessage(db, a.userId, { threadId: thread.id, body: 'secret', clientMessageId: 'nf' });

    const hiddenThread = await getThread(db, d.userId, thread.id).catch((error: unknown) => error);
    const missingThread = await getThread(db, d.userId, randomUUID()).catch((error: unknown) => error);
    expect(hiddenThread).toBeInstanceOf(StoreNotFoundError);
    expect(missingThread).toBeInstanceOf(StoreNotFoundError);
    expect((hiddenThread as Error).message).toBe((missingThread as Error).message);

    const hiddenList = await listMessages(db, d.userId, thread.id).catch((error: unknown) => error);
    const missingList = await listMessages(db, d.userId, randomUUID()).catch((error: unknown) => error);
    expect(hiddenList).toBeInstanceOf(StoreNotFoundError);
    expect(missingList).toBeInstanceOf(StoreNotFoundError);
    expect((hiddenList as Error).message).toBe((missingList as Error).message);
  });

  it('rule 6: unread is per person', async () => {
    const { a, b, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Unread' });
    await postMessage(db, a.userId, { threadId: thread.id, body: 'm1', clientMessageId: 'u1' });
    await postMessage(db, b.userId, { threadId: thread.id, body: 'm2', clientMessageId: 'u2' });

    expect(await unreadCount(db, a.userId, thread.id)).toBe(2);
    expect(await unreadCount(db, b.userId, thread.id)).toBe(2);

    await markRead(db, a.userId, thread.id, { lastReadSequence: 1 });
    expect(await unreadCount(db, a.userId, thread.id)).toBe(1);
    // B is unaffected by A's read.
    expect(await unreadCount(db, b.userId, thread.id)).toBe(2);

    await markRead(db, b.userId, thread.id); // mark everything read
    expect(await unreadCount(db, b.userId, thread.id)).toBe(0);
    expect(await unreadCount(db, a.userId, thread.id)).toBe(1);
  });

  it('listMessages paginates ascending with a keyset cursor', async () => {
    const { a, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Pages' });
    for (let index = 1; index <= 3; index += 1) {
      await postMessage(db, a.userId, {
        threadId: thread.id,
        body: `message ${index}`,
        clientMessageId: `page-${index}`,
      });
    }

    const page1 = await listMessages(db, a.userId, thread.id, { limit: 2 });
    expect(page1.messages.map((m) => m.sequence)).toEqual([1, 2]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listMessages(db, a.userId, thread.id, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map((m) => m.sequence)).toEqual([3]);
    expect(page2.nextCursor).toBeNull();
  });

  it('a tombstoned message no longer counts as unread but still exists', async () => {
    const { a, b, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Tombstones' });
    const msg = await postMessage(db, b.userId, {
      threadId: thread.id,
      body: 'retracted later',
      clientMessageId: 'tomb',
    });

    expect(await unreadCount(db, a.userId, thread.id)).toBe(1);
    await tombstoneMessage(db, b.userId, msg.message.id);
    expect(await unreadCount(db, a.userId, thread.id)).toBe(0);

    const { messages } = await listMessages(db, a.userId, thread.id, {});
    expect(messages).toHaveLength(1);
    expect(messages[0]!.tombstonedAt).not.toBeNull();
  });

  it('a tombstoned message never returns its body', async () => {
    const { a, b, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Redaction' });
    const msg = await postMessage(db, b.userId, {
      threadId: thread.id,
      body: 'secret plan',
      clientMessageId: 'redact-1',
    });

    const tombstoned = await tombstoneMessage(db, b.userId, msg.message.id);
    expect(tombstoned.body).toBe('');

    const { messages } = await listMessages(db, a.userId, thread.id, {});
    expect(messages.find((m) => m.id === msg.message.id)!.body).toBe('');

    const fetched = await getMessage(db, a.userId, msg.message.id);
    expect(fetched.body).toBe('');

    // A later message is unaffected.
    const later = await postMessage(db, a.userId, {
      threadId: thread.id,
      body: 'still here',
      clientMessageId: 'redact-2',
    });
    expect(later.message.body).toBe('still here');
  });

  it('archiving removes a thread from the list and blocks further posts', async () => {
    const { a, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Archive' });

    expect((await listThreads(db, a.userId, space.id)).map((t) => t.id)).toContain(thread.id);
    const archived = await archiveThread(db, a.userId, thread.id);
    expect(archived.archivedAt).not.toBeNull();
    expect((await listThreads(db, a.userId, space.id)).map((t) => t.id)).not.toContain(thread.id);

    await expect(
      postMessage(db, a.userId, { threadId: thread.id, body: 'late', clientMessageId: 'late' }),
    ).rejects.toThrow(StoreError);

    const renamed = await renameThread(db, a.userId, thread.id, { title: 'Renamed' });
    expect(renamed.title).toBe('Renamed');
    expect((await getThread(db, a.userId, thread.id)).title).toBe('Renamed');
  });

  it('rejects whitespace titles, whitespace bodies, and wrong-thread replies', async () => {
    const { a, b, space } = await familySpace();
    await expect(
      createThread(db, a.userId, { spaceId: space.id, title: '   ' }),
    ).rejects.toThrow(StoreError);
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Validation' });

    await expect(
      postMessage(db, a.userId, { threadId: thread.id, body: '   ', clientMessageId: 'v-b' }),
    ).rejects.toThrow(StoreError);

    const other = await createThread(db, b.userId, { spaceId: space.id, title: 'Other thread' });
    const otherMsg = await postMessage(db, b.userId, {
      threadId: other.id,
      body: 'elsewhere',
      clientMessageId: 'v-o',
    });
    await expect(
      postMessage(db, a.userId, {
        threadId: thread.id,
        body: 'cross-thread reply',
        clientMessageId: 'v-x',
        replyToMessageId: otherMsg.message.id,
      }),
    ).rejects.toThrow(StoreError);
  });

  it('markRead is monotonic and clamps to the thread last_sequence', async () => {
    const { a, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Cursors' });
    await postMessage(db, a.userId, { threadId: thread.id, body: 'one', clientMessageId: 'cur-1' });
    await postMessage(db, a.userId, { threadId: thread.id, body: 'two', clientMessageId: 'cur-2' });

    await markRead(db, a.userId, thread.id, { lastReadSequence: 99 });
    expect(await unreadCount(db, a.userId, thread.id)).toBe(0);

    // A rewind attempt does not move the cursor backwards.
    await markRead(db, a.userId, thread.id, { lastReadSequence: 1 });
    expect(await unreadCount(db, a.userId, thread.id)).toBe(0);
  });
});
describe('thread history and assistant posts (#565)', () => {
  it('listRecentMessages returns the newest `limit` messages, oldest first, author null as assistant', async () => {
    const { a, b, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'History' });
    for (const [i, author] of [a, b, a, b].entries()) {
      await postMessage(db, author.userId, { threadId: thread.id, body: `m${i + 1}`, clientMessageId: `h-${i}` });
    }
    await postAssistantMessage(db, a.userId, { threadId: thread.id, spaceId: space.id }, randomUUID(), 'reply');

    const recent = await listRecentMessages(db, b.userId, thread.id, 3);
    expect(recent).toEqual([
      { role: 'user', content: 'm3' },
      { role: 'user', content: 'm4' },
      { role: 'assistant', content: 'reply' },
    ]);
    expect(await listRecentMessages(db, a.userId, thread.id, 40)).toHaveLength(5);
  });

  it('listRecentMessages skips deleted messages', async () => {
    const { a, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Deleted' });
    await postMessage(db, a.userId, { threadId: thread.id, body: 'keep one', clientMessageId: 'd-1' });
    const gone = await postMessage(db, a.userId, { threadId: thread.id, body: 'secret', clientMessageId: 'd-2' });
    await postMessage(db, a.userId, { threadId: thread.id, body: 'keep two', clientMessageId: 'd-3' });
    await tombstoneMessage(db, a.userId, gone.message.id);

    const recent = await listRecentMessages(db, a.userId, thread.id, 2);
    expect(recent.map((m) => m.content)).toEqual(['keep one', 'keep two']);
  });

  it('another account cannot read a thread it is not a member of', async () => {
    const { a, d, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Private' });
    await postMessage(db, a.userId, { threadId: thread.id, body: 'members only', clientMessageId: 'p-1' });

    await expect(listRecentMessages(db, d.userId, thread.id, 40)).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(listRecentMessages(db, d.userId, randomUUID(), 40)).rejects.toBeInstanceOf(StoreNotFoundError);
  });

  it('postAssistantMessage takes the next sequence with author null and bob:<invocationId>', async () => {
    const { a, b, space } = await familySpace();
    const thread = await createThread(db, a.userId, { spaceId: space.id, title: 'Assistant' });
    await postMessage(db, a.userId, { threadId: thread.id, body: 'one', clientMessageId: 'x-1' });
    await postMessage(db, b.userId, { threadId: thread.id, body: 'two', clientMessageId: 'x-2' });

    const invocationId = randomUUID();
    const reply = await postAssistantMessage(db, a.userId, { threadId: thread.id, spaceId: space.id }, invocationId, 'done');
    expect(reply.sequence).toBe(3);
    expect(reply.authorUserId).toBeNull();
    expect(reply.clientMessageId).toBe(`bob:${invocationId}`);
    expect(reply.threadId).toBe(thread.id);
    expect(reply.spaceId).toBe(space.id);

    const stored = await getMessage(db, b.userId, reply.id);
    expect(stored.sequence).toBe(3);
    expect(stored.authorUserId).toBeNull();
    expect(stored.body).toBe('done');
  });
});
