/**
 * "Delete from here" tests (CU-CHAT-4, G20): DELETE
 * /api/conversations/:id/messages/:messageId deletes a user message and every
 * later message. Editing already makes a safe cut (editFrom/editFromStart);
 * cutting from a USER message (position >= anchor) leaves a clean prefix that
 * ends on a reply -- the context the model had before that question.
 *
 * Covered here: cutting from a later user message, cutting from the first
 * message (zero left), an assistant anchor refused with 409, an unknown or
 * foreign id answered 404 (no oracle), exactly one conversation.updated with a
 * newer updatedAt, the journal carrying ids and counts only (never message
 * text), positions resuming cleanly after the cut, and no account giving 401.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());

import { deleteMessagesFromRoute } from '../../src/conversations/messages-http.ts';
import { addReplyVersion, appendMessage, createConversation, getConversation } from '../../src/conversations/store.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { journal } from '../../src/platform/logger.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
let pg: TestDb;
let db: Db;
let account: TestAccount;
let foreign: TestAccount;

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  account = await addAccount(pg);
  foreign = await addAccount(pg);
  setSharedDb(Promise.resolve(db));
});

afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
    },
    end() {},
  };
}

function request(overrides: Record<string, unknown>, who: TestAccount = account): unknown {
  return {
    params: {},
    account: { userId: who.userId, sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 },
    ...overrides,
  };
}

async function del(
  conversationId: string,
  messageId: string,
  who: TestAccount = account,
): Promise<ReturnType<typeof response>> {
  const result = response();
  await deleteMessagesFromRoute(appDeps)(
    request({ params: { id: conversationId, messageId } }, who) as never,
    result as never,
  );
  return result;
}

/** u1 (pos 0) / a1 (pos 1) / u2 (pos 2) / a2 (pos 3), with distinctive text so
 *  journal assertions can detect a leak. */
async function seedFour(owner: TestAccount) {
  const conversation = await createConversation(db, owner.userId, 'delete-from-here');
  const u1 = (await appendMessage(db, owner.userId, conversation.id, {
    role: 'user',
    parts: [{ type: 'text', text: 'first question SECRET-U1' }],
  }))!;
  const a1 = (await appendMessage(db, owner.userId, conversation.id, {
    role: 'assistant',
    parts: [{ type: 'text', text: 'first answer SECRET-A1' }],
  }))!;
  const u2 = (await appendMessage(db, owner.userId, conversation.id, {
    role: 'user',
    parts: [{ type: 'text', text: 'second question SECRET-U2' }],
  }))!;
  const a2 = (await appendMessage(db, owner.userId, conversation.id, {
    role: 'assistant',
    parts: [{ type: 'text', text: 'second answer SECRET-A2' }],
  }))!;
  return { conversation, u1, a1, u2, a2 };
}

describe('delete-messages-from DELETE (CU-CHAT-4)', () => {
  it('T1: deletes from a later user message onward, leaving a clean prefix', async () => {
    const { conversation, u1, a1, u2 } = await seedFour(account);
    const result = await del(conversation.id, u2.id);
    expect(result.statusCode).toBe(204);
    const detail = (await getConversation(db, account.userId, conversation.id))!;
    expect(detail.messages.map((m) => ({ id: m.id, position: m.position }))).toEqual([
      { id: u1.id, position: 0 },
      { id: a1.id, position: 1 },
    ]);
  });

  it('T2: deletes from the first user message onward, leaving zero messages', async () => {
    const { conversation, u1 } = await seedFour(account);
    const result = await del(conversation.id, u1.id);
    expect(result.statusCode).toBe(204);
    const detail = (await getConversation(db, account.userId, conversation.id))!;
    expect(detail.messages).toHaveLength(0);
  });

  it('T3: refuses an assistant anchor with 409 not_user_message; all four remain', async () => {
    const { conversation, a1 } = await seedFour(account);
    const result = await del(conversation.id, a1.id);
    expect(result.statusCode).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe('not_user_message');
    const detail = (await getConversation(db, account.userId, conversation.id))!;
    expect(detail.messages).toHaveLength(4);
  });

  it('T4: an unknown or foreign id answers 404, identical body; foreign rows untouched', async () => {
    const theirs = await seedFour(foreign);

    const unknown = await del('cnv_unknown_0001', 'msg_unknown_0001');
    const viaTheirs = await del(theirs.conversation.id, theirs.u1.id);

    expect(unknown.statusCode).toBe(404);
    expect(viaTheirs.statusCode).toBe(404);
    expect(unknown.body).toEqual(viaTheirs.body);

    const theirDetail = (await getConversation(db, foreign.userId, theirs.conversation.id))!;
    expect(theirDetail.messages).toHaveLength(4);
  });

  it('T5: publishes exactly one conversation.updated with a newer updatedAt', async () => {
    const { conversation, u2 } = await seedFour(account);
    const before = conversation.updatedAt;
    const events: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(account.userId, (event) => events.push(event));
    const result = await del(conversation.id, u2.id);
    stop();
    expect(result.statusCode).toBe(204);
    const updates = events.filter((event) => event.type === 'conversation.updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ conversation_id: conversation.id });
    expect((updates[0] as { updated_at: number }).updated_at).toBeGreaterThan(before);
  });

  it('T6: journals messages_deleted with id and count only, never message text', async () => {
    vi.mocked(journal).mockClear();
    const { conversation, u2 } = await seedFour(account);
    const result = await del(conversation.id, u2.id);
    expect(result.statusCode).toBe(204);
    const call = vi.mocked(journal).mock.calls.find((entry) => entry[0] === 'v2.messages_deleted');
    expect(call).toBeDefined();
    expect(call![1]).toEqual({ id: conversation.id, messages: 2 });
    const all = JSON.stringify(vi.mocked(journal).mock.calls);
    expect(all).not.toContain('SECRET-U2');
    expect(all).not.toContain('SECRET-A2');
  });

  it('T7: after the cut, new messages resume from the freed position', async () => {
    const { conversation, u2 } = await seedFour(account);
    const result = await del(conversation.id, u2.id);
    expect(result.statusCode).toBe(204);

    const nextUser = (await appendMessage(db, account.userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'new question' }],
    }))!;
    expect(nextUser.position).toBe(2);

    await addReplyVersion(db, account.userId, conversation.id, [{ type: 'text', text: 'new answer' }]);
    const detail = (await getConversation(db, account.userId, conversation.id))!;
    const reply = detail.messages.find((m) => m.role === 'assistant' && m.position === 3);
    expect(reply).toBeDefined();
  });

  it('T8: no account on the request answers 401', async () => {
    const result = response();
    await deleteMessagesFromRoute(appDeps)(
      { params: { id: 'cnv_x', messageId: 'msg_x' }, account: undefined } as never,
      result as never,
    );
    expect(result.statusCode).toBe(401);
    expect((result.body as { error: { code: string } }).error.code).toBe('invalid_token');
  });
});
