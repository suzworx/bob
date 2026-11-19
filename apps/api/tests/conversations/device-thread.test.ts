// #565 U3 / #756 PR3: a device turn in a shared conversation, through the one
// persistDeviceTurn, against real Postgres. It is the account's message plus the
// assistant's reply, with a completed invocation; retries are one message;
// members hear of it by id; a lost thread falls back to a new General one.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { archiveThread, createThread, listMessages, postMessage } from '../../src/conversations/thread-store.ts';
import { getConversationScope, isSharedConversation } from '../../src/conversations/scope.ts';
import { claimInvocation } from '../../src/conversations/invocations-store.ts';
import { AccountEvents, type AccountEvent } from '../../src/account/events-bus.ts';
import { deviceThreadId } from '../../src/voice/device-thread.ts';
import { loadDeviceThreadHistory, persistDeviceTurn } from '../../src/voice/cardputer-conversation.ts';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let owner: string;
let member: string;
let gone: string;
let spaceId: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  owner = (await addAccount(pg)).userId;
  member = (await addAccount(pg)).userId;
  gone = (await addAccount(pg)).userId;
  spaceId = (await createSpace(db, owner, { kind: 'group', name: 'Family' })).id;
  await addMember(db, owner, spaceId, member, 'member');
  await addMember(db, owner, spaceId, gone, 'member');
  await revokeMember(db, owner, spaceId, gone);
});
afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

async function freshThread(): Promise<string> {
  return (await createThread(db, owner, { spaceId, title: 'Groceries' })).id;
}

type ThreadTurn = { threadId: string; sessionId: string; turnRef: string; transcriptText: string; replyText: string; heardChars?: number };

/** The shared save, or null when the thread was lost and it fell back to General. */
async function persistDeviceThreadTurn(db: Db, userId: string, input: ThreadTurn, events: AccountEvents) {
  const saved = await persistDeviceTurn(db, userId, { ...input, pinnedRef: threadRef(input.threadId) }, events);
  return saved.fellBackFromShared ? null : saved;
}

function turn(threadId: string, turnRef = 'turn_a1b2c3d4'): ThreadTurn {
  // One session per thread: the idempotency key is unique per author, not per thread.
  return { threadId, sessionId: `sess_${threadId.slice(0, 8)}`, turnRef, transcriptText: 'add milk', replyText: 'Added milk.' };
}

async function invocationFor(triggerId: string): Promise<{ state: string; resultMessageId: string | null }> {
  const rows = await withUser(db, owner, (tx) => tx.query<{ state: string; resultMessageId: string | null }>(
    `SELECT state, result_message_id AS "resultMessageId" FROM bob.ai_invocations WHERE trigger_message_id = $1`,
    [triggerId],
  ));
  return rows[0]!;
}

describe('persistDeviceThreadTurn', () => {
  it('saves the account message, then the assistant reply, and completes the invocation', async () => {
    const threadId = await freshThread();
    const saved = await persistDeviceThreadTurn(db, owner, turn(threadId), new AccountEvents());
    expect(saved?.outcome).toBe('completed');
    const { messages } = await listMessages(db, owner, threadId, { limit: 50 });
    expect(messages.map((m) => [m.authorUserId, m.body])).toEqual([[owner, 'add milk'], [null, 'Added milk.']]);
    expect(await invocationFor(saved!.userMessageId)).toEqual({ state: 'completed', resultMessageId: messages[1]!.id });
  });

  it('a retried turn is one message and one reply', async () => {
    const threadId = await freshThread();
    await persistDeviceThreadTurn(db, owner, turn(threadId), new AccountEvents());
    const again = await persistDeviceThreadTurn(db, owner, turn(threadId), new AccountEvents());
    expect(again).toMatchObject({ created: false, outcome: 'duplicate', published: 0 });
    expect((await listMessages(db, owner, threadId, { limit: 50 })).messages).toHaveLength(2);
  });

  it('publishes thread.message_appended (ids only) to every active member', async () => {
    const threadId = await freshThread();
    const events = new AccountEvents();
    const seen = new Map<string, AccountEvent[]>();
    for (const user of [owner, member, gone]) {
      seen.set(user, []);
      events.subscribe(user, (event) => seen.get(user)!.push(event));
    }
    const saved = await persistDeviceThreadTurn(db, owner, turn(threadId), events);
    for (const user of [owner, member]) {
      expect(seen.get(user)!.map((e) => e.type === 'thread.message_appended' && e.message_id))
        .toEqual([saved!.userMessageId, saved!.replyMessageId]);
    }
    expect(seen.get(gone)).toEqual([]);
    expect(JSON.stringify([...seen.values()])).not.toContain('milk');
  });

  it('a busy thread still gets the reply the device already spoke', async () => {
    const threadId = await freshThread();
    const other = await postMessage(db, member, { threadId, body: '@bob hi', clientMessageId: randomUUID() });
    await claimInvocation(db, member, {
      spaceId, threadId, triggerMessageId: other.message.id, contextHighWater: other.message.sequence, membershipRevision: 0,
    });
    const saved = await persistDeviceThreadTurn(db, owner, turn(threadId), new AccountEvents());
    expect(saved?.outcome).toBe('busy');
    expect((await listMessages(db, owner, threadId, { limit: 50 })).messages.at(-1)?.body).toBe('Added milk.');
  });

  it('a cut-off reply saves only what was heard; nothing heard saves no reply', async () => {
    const threadId = await freshThread();
    await persistDeviceThreadTurn(db, owner, { ...turn(threadId), heardChars: 5 }, new AccountEvents());
    await persistDeviceThreadTurn(db, owner, { ...turn(threadId, 'turn_second1'), heardChars: 0 }, new AccountEvents());
    const bodies = (await listMessages(db, owner, threadId, { limit: 50 })).messages.map((m) => m.body);
    expect(bodies).toEqual(['add milk', 'Added', 'add milk']);
  });

  it('a lost thread (archived, unknown, or membership gone) answers null', async () => {
    const archived = await freshThread();
    await archiveThread(db, owner, archived);
    expect(await persistDeviceThreadTurn(db, owner, turn(archived), new AccountEvents())).toBeNull();
    expect(await persistDeviceThreadTurn(db, owner, turn(randomUUID()), new AccountEvents())).toBeNull();
    expect(await persistDeviceThreadTurn(db, gone, turn(await freshThread()), new AccountEvents())).toBeNull();
  });
});

describe('thread history, space and ref', () => {
  it("history holds other members' messages as user and replies as assistant", async () => {
    const threadId = await freshThread();
    await postMessage(db, member, { threadId, body: 'we need eggs', clientMessageId: randomUUID() });
    await persistDeviceThreadTurn(db, owner, turn(threadId), new AccountEvents());
    expect(await loadDeviceThreadHistory(db, owner, await getConversationScope(db, owner, threadRef(threadId)))).toEqual([
      { role: 'user', content: 'we need eggs' }, { role: 'user', content: 'add milk' }, { role: 'assistant', content: 'Added milk.' },
    ]);
  });

  it('the space of a thread ref, null for a General id or a lost thread', async () => {
    const threadId = await freshThread();
    expect(await getConversationScope(db, owner, threadRef(threadId))).toMatchObject({ spaceId, spaceName: 'Family', spaceKind: 'group' });
    expect(await getConversationScope(db, gone, threadRef(threadId))).toBeNull();
    expect(isSharedConversation('cnv_abcdefgh', await getConversationScope(db, owner, 'cnv_abcdefgh'))).toBe(false);
    expect(deviceThreadId(threadRef(threadId))).toBe(threadId);
    expect(deviceThreadId(undefined)).toBeNull();
  });
});
