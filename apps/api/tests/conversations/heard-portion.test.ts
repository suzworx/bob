/**
 * Heard-portion PATCH tests (013 R6, FR-015, specs/013-voice-first-web):
 * PATCH /api/conversations/:id/messages/:messageId truncates the selected
 * version of an interrupted assistant reply to the last fully-heard sentence
 * and sets bob.messages.interrupted. Runs on the real Postgres test db, where the unmarked
 * migration applies (plan Technical Context "Storage").
 *
 * Covered here: boundary truncation, the flag, idempotence (never grows), a
 * user message rejected, a foreign/misplaced id 404 (no oracle), a bad body
 * 400, the hosted-DB 42703 -> 503 feature_unavailable mapping via a stubbed
 * store error, the history loader returning the truncated text, and the
 * journal carrying no reply text (FR-028, Principle II).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());
// Partial store mock: markReplyInterrupted is spy-able per test, every other
// export runs the real implementation (createTestDb applies the migration).
vi.mock('../../src/conversations/store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/conversations/store.ts')>();
  return { ...actual, markReplyInterrupted: vi.fn(actual.markReplyInterrupted) };
});

import { markReplyInterruptedRoute } from '../../src/conversations/messages-http.ts';
import { appendMessage, createConversation, getConversation, markReplyInterrupted } from '../../src/conversations/store.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { journal } from '../../src/platform/logger.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  withUserRaw,
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
const REPLY = 'First sentence here. Second sentence here. Third sentence here.';

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
    body: {},
    account: { userId: who.userId, sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 },
    ...overrides,
  };
}

async function seedAssistantReply(
  text = REPLY,
  owner: TestAccount = account,
): Promise<{ conversation: Awaited<ReturnType<typeof createConversation>>; messageId: string }> {
  const conversation = await createConversation(db, owner.userId, 'interrupted');
  const message = (await appendMessage(db, owner.userId, conversation.id, {
    role: 'assistant',
    parts: [{ type: 'text', text }],
  }))!;
  return { conversation, messageId: message.id };
}

async function patch(
  conversationId: string,
  messageId: string,
  body: Record<string, unknown>,
  who: TestAccount = account,
): Promise<ReturnType<typeof response>> {
  const result = response();
  await markReplyInterruptedRoute(appDeps)(
    request({ params: { id: conversationId, messageId }, body }, who) as never,
    result as never,
  );
  return result;
}

async function selectedText(conversationId: string, messageId: string): Promise<string | undefined> {
  const detail = (await getConversation(db, account.userId, conversationId))!;
  const message = detail.messages.find((entry) => entry.id === messageId)!;
  const selected = message.versions.find((version) => version.selected);
  if (!selected) return undefined;
  const parts = selected.parts as Array<{ type?: string; text?: string }>;
  return parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
}

describe('heard-portion PATCH (013 R6)', () => {
  it('truncates the selected version to the last fully-heard sentence boundary', async () => {
    const { conversation, messageId } = await seedAssistantReply();
    const result = await patch(conversation.id, messageId, { heard_chars: 30, interrupted: true });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ message_id: messageId, heard_chars: 30, interrupted: true });
    // heard_chars 30 lands inside "Second sentence"; the cut backs up to the
    // end of the fully-heard first sentence.
    expect(await selectedText(conversation.id, messageId)).toBe('First sentence here.');
  });

  it('keeps the tool calls and other parts of a web reply; only its text is cut (#1007 D1)', async () => {
    const conversation = await createConversation(db, account.userId, 'tools');
    const tool = { type: 'tool-list_tasks', toolCallId: 'call-1', state: 'output-available', input: {}, output: { ok: true, items: [] } };
    const stored = await appendMessage(db, account.userId, conversation.id, {
      role: 'assistant',
      parts: [{ type: 'step-start' }, tool, { type: 'step-start' }, { type: 'reasoning', text: 'thinking' }, { type: 'text', text: REPLY }],
    });
    const messageId = stored?.id ?? '';
    expect((await patch(conversation.id, messageId, { heard_chars: 30, interrupted: true })).statusCode).toBe(200);
    const detail = await getConversation(db, account.userId, conversation.id);
    const parts = (detail?.messages.find((entry) => entry.id === messageId)?.versions.find((version) => version.selected)?.parts ?? []) as Array<{ type: string }>;
    expect(parts.map((part) => part.type)).toEqual(['step-start', 'tool-list_tasks', 'step-start', 'reasoning', 'step-start', 'text']);
    expect(parts[1]).toEqual(tool);
    expect(await selectedText(conversation.id, messageId)).toBe('First sentence here.');
  });

  it('sets the interrupted flag on the message', async () => {
    const { conversation, messageId } = await seedAssistantReply();
    const result = await patch(conversation.id, messageId, { heard_chars: 30, interrupted: true });
    expect(result.statusCode).toBe(200);
    // Read as account: messages_select is auth.uid() = user_id, and this
    // message's conversation (and its messages) belong to `account` (the
    // default seedAssistantReply owner).
    const rows = await withUserRaw(pg, account.userId, (tx) =>
      tx.query<{ interrupted: boolean }>(
        'SELECT interrupted FROM bob.messages WHERE id = $1',
        [messageId],
      ),
    );
    expect(rows.rows[0]?.interrupted).toBe(true);
  });

  it('is idempotent and never grows the text back', async () => {
    const { conversation, messageId } = await seedAssistantReply();
    await patch(conversation.id, messageId, { heard_chars: 30, interrupted: true });

    // Same heard_chars: nothing changes, still truncated: false.
    const again = await markReplyInterrupted(db, account.userId, conversation.id, messageId, 30);
    expect(again).toEqual({ length: 20, truncated: false });
    // A larger heard_chars must NOT grow the text back.
    const grown = await markReplyInterrupted(db, account.userId, conversation.id, messageId, 60);
    expect(grown).toEqual({ length: 20, truncated: false });

    const repeat = await patch(conversation.id, messageId, { heard_chars: 60, interrupted: true });
    expect(repeat.statusCode).toBe(200);
    expect(await selectedText(conversation.id, messageId)).toBe('First sentence here.');

    const detail = (await getConversation(db, account.userId, conversation.id))!;
    const message = detail.messages.find((entry) => entry.id === messageId)!;
    // The original version 0 plus exactly one truncated version.
    expect(message.versions).toHaveLength(2);
  });

  it('rejects a user message with 404', async () => {
    const conversation = await createConversation(db, account.userId, 'user msg');
    const message = (await appendMessage(db, account.userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'a question' }],
    }))!;
    const result = await patch(conversation.id, message.id, { heard_chars: 5, interrupted: true });
    expect(result.statusCode).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('answers a foreign or misplaced message with 404, identical to an unknown id', async () => {
    // Another account's conversation and message: RLS hides it entirely.
    const theirs = await seedAssistantReply('secret reply', foreign);
    const viaTheirs = await patch(theirs.conversation.id, theirs.messageId, { heard_chars: 3, interrupted: true });

    // The caller's own message but named under a different conversation.
    const mine = await seedAssistantReply('mine reply');
    const wrongConv = await patch(theirs.conversation.id, mine.messageId, { heard_chars: 3, interrupted: true });

    // A genuinely unknown message id.
    const unknown = await patch(mine.conversation.id, 'msg_unknown_0001', { heard_chars: 3, interrupted: true });

    expect(viaTheirs.statusCode).toBe(404);
    expect(wrongConv.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(viaTheirs.body).toEqual(wrongConv.body);
    expect(viaTheirs.body).toEqual(unknown.body);
  });

  it('rejects a bad body with 400', async () => {
    const { conversation, messageId } = await seedAssistantReply();
    for (const body of [
      {},
      { heard_chars: 10 },
      { heard_chars: -1, interrupted: true },
      { heard_chars: 1.5, interrupted: true },
      { heard_chars: 10, interrupted: false },
      { heard_chars: 10, interrupted: true, extra: 1 },
      { heard_chars: '10', interrupted: true },
    ]) {
      const result = await patch(conversation.id, messageId, body);
      expect(result.statusCode).toBe(400);
      expect((result.body as { error: { code: string } }).error.code).toBe('invalid_request');
    }
  });

  it('maps a missing interrupted column (42703) to 503 feature_unavailable', async () => {
    vi.mocked(markReplyInterrupted).mockRejectedValueOnce(
      Object.assign(new Error('column bob.messages.interrupted does not exist'), { code: '42703' }),
    );
    const { conversation, messageId } = await seedAssistantReply();
    const result = await patch(conversation.id, messageId, { heard_chars: 30, interrupted: true });
    expect(result.statusCode).toBe(503);
    expect((result.body as { error: { code: string } }).error.code).toBe('feature_unavailable');
    const unavailable = vi.mocked(journal).mock.calls.find(
      (call) => call[0] === 'v2.reply_interrupted_unavailable',
    );
    expect(unavailable).toBeDefined();
    expect(unavailable![1]).toEqual({ reason: 'undefined_column' });
  });

  it('journals reply_interrupted with metadata only, never reply text', async () => {
    vi.mocked(journal).mockClear();
    const { conversation, messageId } = await seedAssistantReply('Keep this sentence. And this secret detail here.');
    const result = await patch(conversation.id, messageId, { heard_chars: 21, interrupted: true });
    expect(result.statusCode).toBe(200);
    const call = vi.mocked(journal).mock.calls.find((entry) => entry[0] === 'v2.reply_interrupted');
    expect(call).toBeDefined();
    expect(call![1]).toEqual({ heard_chars: 21, truncated: true });
    // FR-028: no assistant text anywhere in the journal.
    const all = JSON.stringify(vi.mocked(journal).mock.calls);
    expect(all).not.toContain('Keep this sentence');
    expect(all).not.toContain('secret detail');
  });
});