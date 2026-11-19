// #756 PR3: ONE persistDeviceTurn against a real test database. Shared behaviour keys off the
// conversation's space kind: a pair/group thread slices the reply to what was
// heard and claims an invocation; a private conversation saves the full reply,
// then marks it interrupted, and never touches invocations or thread events.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { archiveThread, createThread, listMessages, postMessage } from '../../src/conversations/thread-store.ts';
import { createConversation, getConversation } from '../../src/conversations/store.ts';
import { claimInvocation } from '../../src/conversations/invocations-store.ts';
import { AccountEvents, type AccountEvent } from '../../src/account/events-bus.ts';
import { persistDeviceTurn } from '../../src/voice/cardputer-conversation.ts';
import { persistTurn } from '../../src/voice/turn/persist.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import type { TurnDeps } from '../../src/voice/turn/deps.ts';
import type { TurnMemoryContext } from '../../src/voice/turn/context.ts';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let owner: string;
let member: string;
let spaceId: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  owner = (await addAccount(pg)).userId;
  member = (await addAccount(pg)).userId;
  spaceId = (await createSpace(db, owner, { kind: 'group', name: 'Us' })).id;
  await addMember(db, owner, spaceId, member, 'member');
});
afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

const freshThread = async (): Promise<string> => (await createThread(db, owner, { spaceId, title: 'Plans' })).id;

function turn(pinnedRef: string | undefined, heardChars?: number) {
  return {
    pinnedRef, sessionId: `sess_${randomUUID().slice(0, 8)}`, turnRef: 'turn_a1b2c3d4', deviceId: null,
    transcriptText: 'add milk', replyText: 'Added milk.', heardChars,
  };
}

const invocationCount = async (): Promise<number> => (await withUser(db, owner, (tx) =>
  tx.query<{ n: unknown }>(`SELECT count(*) AS n FROM bob.ai_invocations`)))[0]!.n as number;

function textOf(parts: unknown[]): string {
  return (parts[0] as { text: string }).text;
}

describe('persistDeviceTurn: private conversation', () => {
  it('saves the full reply, then marks it heard on barge-in; no invocation, no thread event', async () => {
    const conversation = await createConversation(db, owner, 'Shopping');
    const events = new AccountEvents();
    const seen: AccountEvent[] = [];
    events.subscribe(owner, (event) => seen.push(event));
    const before = await invocationCount();
    const saved = await persistDeviceTurn(db, owner, turn(conversation.id, 5), events);
    expect(saved).toMatchObject({ conversationId: conversation.id, spaceKind: 'private', created: false, outcome: 'completed', fellBackFromShared: false });
    const reply = (await getConversation(db, owner, conversation.id))!.messages.at(-1)!;
    expect(reply.versions.map((version) => textOf(version.parts))).toEqual(['Added milk.', 'Added']);
    expect(Number(await invocationCount())).toBe(Number(before));
    expect(seen.filter((event) => event.type === 'thread.message_appended')).toEqual([]);
  });
});

describe('persistDeviceTurn: shared conversation', () => {
  it('nothing heard saves no reply and answers unheard', async () => {
    const threadId = await freshThread();
    const saved = await persistDeviceTurn(db, owner, turn(threadRef(threadId), 0), new AccountEvents());
    expect(saved).toMatchObject({ conversationId: threadRef(threadId), spaceKind: 'group', outcome: 'unheard', replyMessageId: null, changedAt: null });
    expect((await listMessages(db, owner, threadId)).messages.map((m) => m.body)).toEqual(['add milk']);
  });

  it('a busy thread answers busy; a retried turn answers duplicate', async () => {
    const threadId = await freshThread();
    const other = await postMessage(db, member, { threadId, body: '@bob hi', clientMessageId: randomUUID() });
    await claimInvocation(db, member, { spaceId, threadId, triggerMessageId: other.message.id, contextHighWater: other.message.sequence, membershipRevision: 0 });
    expect((await persistDeviceTurn(db, owner, turn(threadRef(threadId)), new AccountEvents())).outcome).toBe('busy');
    const quiet = await freshThread();
    const once = turn(threadRef(quiet));
    await persistDeviceTurn(db, owner, once, new AccountEvents());
    expect(await persistDeviceTurn(db, owner, once, new AccountEvents())).toMatchObject({ created: false, outcome: 'duplicate', published: 0 });
  });

  it('a lost thread falls back to a new private conversation, never enqueuing extraction', async () => {
    const threadId = await freshThread();
    await archiveThread(db, owner, threadId);
    const enqueue = vi.fn();
    const session = { ...createSession(), auth: { kind: 'legacy', userId: owner } } as unknown as Parameters<typeof persistTurn>[1];
    session.activeConversationId = threadRef(threadId);
    const deps = { getDb: async () => db, accountEvents: () => new AccountEvents() } as unknown as TurnDeps;
    const memory = { db, userId: owner, memoryOn: true, worker: { enqueue }, timeZone: 'UTC' } as unknown as TurnMemoryContext;
    await persistTurn(deps, session, 'turn_a1b2c3d4', 'add milk', 'Added milk.', memory);
    expect(session.activeConversationId).not.toBe(threadRef(threadId));
    expect((await getConversation(db, owner, session.activeConversationId!))?.messages).toHaveLength(2);
    expect(enqueue).not.toHaveBeenCalled();
    await persistTurn(deps, session, 'turn_b1b2c3d4', 'and eggs', 'Added eggs.', memory);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
