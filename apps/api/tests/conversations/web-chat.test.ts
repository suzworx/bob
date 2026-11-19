import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as documents from '../../src/conversations/document-attachments.ts';
import { readFileSync } from 'node:fs';

const state = vi.hoisted(() => ({
  streamMode: 'text',
  lastUiMessages: [] as Array<{ id: string; role: string; parts: unknown[] }>,
  lastAbortSignal: undefined as AbortSignal | undefined,
  // #415: the exact uiMessages the route handed the agent, captured below.
  agentUiMessages: [] as Array<{ id: string; role: string; parts: unknown[] }>,
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    createAgentUIStreamResponse: vi.fn((options: Parameters<typeof actual.createAgentUIStreamResponse>[0]) => {
      state.agentUiMessages = structuredClone(options.uiMessages) as never;
      return actual.createAgentUIStreamResponse(options);
    }),
  };
});

// #415: pass-through spies, so a test can assert a turn never reads the full
// conversation and reads history in one transaction.
vi.mock('../../src/conversations/store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/conversations/store.ts')>();
  return {
    ...actual,
    getConversation: vi.fn(actual.getConversation),
    getConversationSummary: vi.fn(actual.getConversationSummary),
    loadRecentHistory: vi.fn(actual.loadRecentHistory),
    appendMessage: vi.fn(actual.appendMessage),
  };
});

function providerChunks(): Array<Record<string, unknown>> {
  return [
    { type: 'start', messageId: 'assistant-sdk-id-1' },
    { type: 'text-start', id: 'text-1', text: '' },
    // Raw TextStreamPart shape: text deltas carry `text`; the SDK converts
    // them into UI-message chunks with `delta` on the way out.
    { type: 'text-delta', id: 'text-1', text: 'done' },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: 'stop' },
  ];
}

vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());

// S14-PG-AGENT-MOCK: real Postgres has the `vector` extension, so memory is
// ON here and web-chat.ts builds a PER-TURN agent via createBobAgent,
// imported by the relative path below -- a different module id than
// '@bob/ai', so it is not covered by the mock above and must be mocked
// separately or the memory-enabled branch reaches the real AI Gateway.
// @bob/ai embeddings.ts also imports `gateway` from this same resolved
// module (for the retrieval query embedder, built eagerly every memory-on
// turn); a `gateway.embeddingModel` stub with no `doEmbed` makes that embed
// call fail locally -- caught by memory-retrieval.ts, which degrades to its
// full-text-search arm -- instead of reaching the network.
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
  bobAgent: {
    version: 'agent-v1' as const,
    id: 'test-agent',
    tools: {},
    stream: vi.fn(async ({ abortSignal, prompt }: { abortSignal?: AbortSignal; prompt?: unknown[] }) => {
      state.lastAbortSignal = abortSignal;
      // createAgentUIStreamResponse hands the agent converted ModelMessages;
      // their text content keeps the same [{type:'text',text}] shape.
      const flat = ((prompt ?? []) as Array<{ role?: string; content?: unknown }>).flatMap(
        (message) =>
          typeof message.content === 'string'
            ? [message]
            : [{ role: message.role, parts: message.content }],
      );
      state.lastUiMessages = flat as never;
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of providerChunks()) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    }),
  },
  get AI_STUB_MODE() {
    return state.streamMode === 'system-test';
  },
  // Mirrors the real predicates (@bob/ai errors.ts) so Core's
  // classifyFailure is callable from the web-chat route under test.
  isProviderError: (error: unknown) =>
    error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || /fetch failed|timeout/i.test(error.message)),
  // A test error carries its upstream status as `statusCode`, like a GatewayError.
  providerErrorStatus: (error: unknown) => (error as { statusCode?: number } | null)?.statusCode,
}) ) as Factory),
    ((async (importOriginal) => {
  const { bobAgent: mockAgent } = await importOriginal<typeof import('@bob/ai')>();
  return {
    createBobAgent: vi.fn(() => mockAgent),
    bobAgent: mockAgent,
    assistantAgent: mockAgent,
    chatModel: {},
    gateway: Object.assign(vi.fn(() => ({})), { embeddingModel: vi.fn(() => ({})) }),
    logAgentConfig: vi.fn(),
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

let pg: TestDb;
let db: Db;
let userId: string;

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  userId = await resolveDevAccount(db);
  setSharedDb(Promise.resolve(db));
});

afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

beforeEach(() => {
  state.streamMode = 'text';
});

import { accountTimeZone } from '../../src/account/auth.ts';
import { boundHistoryAttachments } from '../../src/conversations/chat-http.ts';
import { webChat, webChatStop } from '../../src/conversations/chat-http.ts';
import { MAX_HISTORY_MESSAGES, trimHistory as trimWebChatHistory } from '../../src/voice/turn-core.ts';
import { createBobAgent, bobAgent, createProductivityTools } from '@bob/ai';
import { trimHistory } from '../../src/voice/turn-core.ts';
import { journal } from '../../src/platform/logger.ts';
import { ConversationDetailSchema, webChatRequestSchema } from '../../src/web-schemas.ts';
import { closeDb, setSharedDb, withUser, type Db } from '../../src/platform/db/db.ts';
import { vi as viTop } from 'vitest';
import {
  addReplyVersion,
  appendMessage,
  createConversation,
  getConversation,
  getConversationSummary,
  loadRecentHistory,
  selectVersion,
  type ConversationDetail,
} from '../../src/conversations/store.ts';
import { getActive, setActive } from '../../src/conversations/active.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import {
  asDb,
  closeTestDb,
  createTestDb,
  withUserRaw,
  addAccount,
  type TestDb,
} from '../support/test-db.ts';
import { randomUUID } from 'node:crypto';
import { createGroupChat } from '../../src/spaces/group-chat-store.ts';
import { postMessage } from '../../src/conversations/thread-store.ts';

function response() {
  const listeners: Record<string, () => void> = {};
  let closeOnWrite = false;
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    writableEnded: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    write(chunk: Buffer | string) {
      this.chunks.push(String(chunk));
      if (closeOnWrite) {
        closeOnWrite = false;
        listeners.close?.();
      }
    },
    end() {
      this.writableEnded = true;
      listeners.close?.();
    },
    json(body: unknown) {
      this.chunks.push(JSON.stringify(body));
    },
    on(event: string, handler: () => void) {
      listeners[event] = handler;
      return this;
    },
    emit(event: string) {
      listeners[event]?.();
    },
    disconnectOnFirstWrite() {
      closeOnWrite = true;
    },
  };
}

const userMessage = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] });

async function run(body: unknown, result: ReturnType<typeof response>): Promise<void> {
  await webChat(appDeps)(
    {
      body,
      on: vi.fn(),
      account: { userId, sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 },
    } as never,
    result as never,
  );
}

async function seedTurns(conversationId: string, texts: Array<[string, string]>): Promise<void> {
  for (const [role, text] of texts) {
    await appendMessage(db, userId, conversationId, { role: role as 'user' | 'assistant', parts: [{ type: 'text', text }] });
  }
}

describe('browser chat contract (/api/chat)', () => {
  it('1. creates a conversation when id is absent and emits its id in the stream', async () => {
    const result = response();
    await run({ message: userMessage('msg-hello-01', 'hello there') }, result);
    expect(result.statusCode).toBe(200);
    const sse = result.chunks.join('');
    const match = sse.match(/"conversationId":"(cnv_[^"]+)"/);
    expect(match).toBeTruthy();
    const detail = await getConversation(db, userId, match![1]!);
    expect(detail?.title).toBe('hello there');
  });

  it('1a. a memory-enabled turn (real Postgres) is served by the mocked agent, never the real gateway', async () => {
    vi.mocked(bobAgent.stream).mockClear();
    const result = response();
    await run({ message: userMessage('msg-memory-guard-01', 'remember I like chai') }, result);
    expect(result.statusCode).toBe(200);
    const sse = result.chunks.join('');
    expect(sse).not.toContain('GatewayAuthenticationError');
    expect(sse).not.toContain('upstream_error');
    // createBobAgent (the per-turn factory used when memory is on) is
    // mocked to return this same agent object; its stream spy having been
    // called IS the proof the real AI Gateway was never reached this turn.
    expect(bobAgent.stream).toHaveBeenCalled();
  });

  it('2. derives the title from the opening message, trimmed on a word boundary', async () => {
    const result = response();
    const opening = 'considering the cardputer reply truncation problem we saw last week';
    await run({ message: userMessage('msg-title-02', `${opening} and more words that push past sixty characters`) }, result);
    const sse = result.chunks.join('');
    const match = sse.match(/"title":"([^"]+)"/);
    expect(match).toBeTruthy();
    expect(match![1]!.length).toBeLessThanOrEqual(60);
  });

  it('3. loads prior messages from the store rather than the body', async () => {
    const result = response();
    const conversation = await createConversation(db, userId, 'history');
    await seedTurns(conversation.id, [['user', 'older question']]);
    await run(
      { id: conversation.id, message: userMessage('user-msg-new', 'newest question') },
      result,
    );
    expect(state.lastUiMessages.map((message) => message.parts)).toEqual([
      [{ type: 'text', text: 'older question' }],
      [{ type: 'text', text: 'newest question' }],
    ]);
  });

  it('4. trims history server-side to a chunked window of at most MAX_HISTORY_MESSAGES', async () => {
    const result = response();
    const conversation = await createConversation(db, userId, 'long');
    const turns: Array<[string, string]> = [];
    for (let index = 0; index < MAX_HISTORY_MESSAGES + 10; index += 1) {
      turns.push(['user', `q${index}`]);
    }
    await seedTurns(conversation.id, turns.slice(0, -1));
    await run({ id: conversation.id, message: userMessage('user-msg-last', 'final question') }, result);
    // 50 messages with this turn's: the window starts at 20 * ceil((50 - 40) / 20).
    expect(state.lastUiMessages.length).toBe(30);
    expect(state.lastUiMessages[0]!.parts).toEqual([{ type: 'text', text: `q20` }]);
  });

  it('5. persists the reply on stream end reusing the client message id', async () => {
    const result = response();
    await run({ message: userMessage('client-user-id-1', 'persist me') }, result);
    expect(result.writableEnded).toBe(true);
    const sse = result.chunks.join('');
    const match = sse.match(/"conversationId":"(cnv_[^"]+)"/)!;
    const detail = (await getConversation(db, userId, match[1]!))!;
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(detail.messages[0]!.id).toBe('client-user-id-1'); // reused, not regenerated
    // The SDK marks finished text parts with state:'done'; the store keeps
    // whatever part shape the stream produced (data-model.md, opaque JSON).
    expect(detail.messages[1]!.versions.at(-1)?.parts).toEqual([
      { type: 'text', state: 'done', text: 'done' },
    ]);
  });

  it('5a. a follow-up turn appends a NEW assistant message after the new question', async () => {
    const result = response();
    const conversation = await createConversation(db, userId, 'follow-up');
    await seedTurns(conversation.id, [
      ['user', 'first question'],
      ['assistant', 'first answer'],
    ]);
    await run(
      { id: conversation.id, message: userMessage('user-followup', 'second question') },
      result,
    );
    const detail = (await getConversation(db, userId, conversation.id))!;
    // Four turns in order: the reply to the SECOND question is its own
    // message after it, not a version of the first answer.
    expect(detail.messages.map((message) => message.role)).toEqual([
      'user', 'assistant', 'user', 'assistant',
    ]);
    expect(detail.messages[1]!.versions).toHaveLength(1);
    expect(detail.messages[3]!.versions.at(-1)?.parts).toEqual([
      { type: 'text', state: 'done', text: 'done' },
    ]);
  });

  it('6. regenerate adds a version without appending a user message', async () => {
    const result = response();
    const conversation = await createConversation(db, userId, 'regen');
    await seedTurns(conversation.id, [['user', 'same question'], ['assistant', 'original reply']]);
    await run({ id: conversation.id, message: userMessage('ignored', 'same question'), regenerate: true }, result);
    const detail = (await getConversation(db, userId, conversation.id))!;
    expect(detail.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    const replies = detail.messages.filter((message) => message.role === 'assistant');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.versions.length).toBe(2); // original + regenerated
  });

  it('7. makes the regenerated version the selected one', async () => {
    const result = response();
    const conversation = await createConversation(db, userId, 'selected');
    await seedTurns(conversation.id, [['user', 'ask'], ['assistant', 'v1']]);
    await run({ id: conversation.id, message: userMessage('x', 'ask'), regenerate: true }, result);
    const detail = (await getConversation(db, userId, conversation.id))!;
    const selected = detail.messages[1]!.versions.find((version) => version.selected)!;
    expect(selected.parts).toEqual([{ type: 'text', state: 'done', text: 'done' }]);
  });

  it('8. editFrom truncates the tail, then answers the edited turn', async () => {
    const result = response();
    const conversation = await createConversation(db, userId, 'edit');
    await seedTurns(conversation.id, [
      ['user', 'first question'],
      ['assistant', 'first answer'],
      ['user', 'second question'],
      ['assistant', 'second answer'],
    ]);
    const detailBefore = (await getConversation(db, userId, conversation.id))!;
    const anchor = detailBefore.messages[0]!.id;
    await run({ id: conversation.id, message: userMessage('u-edited', 'edited question'), editFrom: anchor }, result);
    const detailAfter = (await getConversation(db, userId, conversation.id))!;
    const texts = detailAfter.messages.map((message) =>
      JSON.stringify(message.versions.find((version) => version.selected)?.parts),
    );
    expect(texts.some((entry) => entry!.includes('first answer'))).toBe(false);
    expect(texts.some((entry) => entry!.includes('second answer'))).toBe(false);
    expect(texts.some((entry) => entry!.includes('edited question'))).toBe(true);
    expect(texts.some((entry) => entry!.includes('done'))).toBe(true);
  });

  describe('a Retry whose first attempt may not have stored the message (#1396)', () => {
    const rows = async (id: string) => (await getConversation(db, userId, id))!.messages;

    it('stores and answers the exact text when the first attempt stored nothing', async () => {
      const conversation = await createConversation(db, userId, 'resend-new');
      await seedTurns(conversation.id, [['user', 'old question'], ['assistant', 'old reply']]);
      await run({ id: conversation.id, message: userMessage('u-resend-1', 'the typed text'), resend: true }, response());
      const messages = await rows(conversation.id);
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(messages[2]!.id).toBe('u-resend-1');
      expect(messages[2]!.versions[0]!.parts).toEqual([{ type: 'text', text: 'the typed text' }]);
      expect(state.lastUiMessages.at(-1)!.parts).toEqual([{ type: 'text', text: 'the typed text' }]);
    });

    it('does not duplicate a message the first attempt did store, and answers it', async () => {
      const conversation = await createConversation(db, userId, 'resend-stored');
      await appendMessage(db, userId, conversation.id, { id: 'u-resend-2', role: 'user', parts: [{ type: 'text', text: 'once only' }] });
      const result = response();
      await run({ id: conversation.id, message: userMessage('u-resend-2', 'once only'), resend: true }, result);
      expect(result.statusCode).toBe(200);
      expect((await rows(conversation.id)).map((message) => message.role)).toEqual(['user', 'assistant']);
    });

    it('finds the conversation a first attempt created when the client never learned its id', async () => {
      const conversation = await createConversation(db, userId, 'resend-orphan');
      await appendMessage(db, userId, conversation.id, { id: 'u-resend-3', role: 'user', parts: [{ type: 'text', text: 'opening' }] });
      const result = response();
      await run({ message: userMessage('u-resend-3', 'opening'), resend: true }, result);
      expect(result.statusCode).toBe(200);
      expect(result.chunks.join('')).toContain(`"conversationId":"${conversation.id}"`);
      expect((await rows(conversation.id)).map((message) => message.role)).toEqual(['user', 'assistant']);
    });

    it('a regenerate with no conversation stores its message rather than opening an empty one', async () => {
      const result = response();
      await run({ message: userMessage('u-regen-new', 'never stored'), regenerate: true }, result);
      const id = result.chunks.join('').match(/"conversationId":"(cnv_[^"]+)"/)![1]!;
      const messages = await rows(id);
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(messages[0]!.versions[0]!.parts).toEqual([{ type: 'text', text: 'never stored' }]);
    });

    describe('with an id this conversation does not hold', () => {
      const SECRET = 'text only its owner may read';
      const count = async (owner: string, conversationId: string): Promise<number> =>
        (await withUserRaw(pg, owner, (tx) => tx.query('SELECT id FROM bob.messages WHERE conversation_id = $1', [conversationId]))).rows.length;
      const ownConversations = async (): Promise<string[]> =>
        (await withUserRaw(pg, userId, (tx) => tx.query<{ id: string }>('SELECT id FROM bob.conversations ORDER BY id'))).rows.map((row) => row.id);

      /** Sends the resend and proves it changed no conversation of the reader's and showed nothing. */
      const expectUntouched = async (body: Record<string, unknown>): Promise<void> => {
        const before = await ownConversations();
        const result = response();
        await run({ ...body, resend: true }, result).catch(() => undefined);
        const sent = result.chunks.join('');
        expect(sent).not.toContain(SECRET);
        expect(sent).not.toContain('conversationId');
        expect(await ownConversations()).toEqual(before);
      };

      it.each([['with', true], ['without', false]])('another account\'s message, %s a conversation id', async (name, withId) => {
        const other = await addAccount(pg);
        const theirs = await createConversation(db, other.userId, 'theirs');
        const messageId = `u-foreign-${name}`;
        await appendMessage(db, other.userId, theirs.id, { id: messageId, role: 'user', parts: [{ type: 'text', text: SECRET }] });
        const mine = await createConversation(db, userId, `mine-${name}`);
        await expectUntouched({ ...(withId ? { id: mine.id } : {}), message: userMessage(messageId, 'probe') });
        expect(await count(userId, mine.id)).toBe(0);
        expect(await count(other.userId, theirs.id)).toBe(1);
        const stored = (await getConversation(db, other.userId, theirs.id))!.messages[0]!;
        expect(stored.versions.map((version) => version.parts)).toEqual([[{ type: 'text', text: SECRET }]]);
      });

      it.each([['with', true], ['without', false]])('the reader\'s own message in a shared space, %s a conversation id', async (name, withId) => {
        const chat = await createGroupChat(db, userId, { requestId: randomUUID() });
        const { message: posted } = await postMessage(db, userId, { threadId: chat.id, body: SECRET, clientMessageId: randomUUID() });
        const before = await count(userId, chat.id);
        expect(before).toBeGreaterThan(0);
        const mine = await createConversation(db, userId, `mine-shared-${name}`);
        await expectUntouched({ ...(withId ? { id: mine.id } : {}), message: userMessage(posted.id, 'probe') });
        expect(await count(userId, mine.id)).toBe(0);
        expect(await count(userId, chat.id)).toBe(before);
      });

      it('a message in a different conversation of the reader\'s own', async () => {
        const holder = await createConversation(db, userId, 'holder');
        await appendMessage(db, userId, holder.id, { id: 'u-elsewhere', role: 'user', parts: [{ type: 'text', text: SECRET }] });
        const open = await createConversation(db, userId, 'open');
        await expectUntouched({ id: open.id, message: userMessage('u-elsewhere', 'probe') });
        expect(await count(userId, open.id)).toBe(0);
        expect(await count(userId, holder.id)).toBe(1);
      });
    });

    it('an ordinary first send that cannot store its message opens no conversation', async () => {
      const holder = await createConversation(db, userId, 'taken-id');
      await appendMessage(db, userId, holder.id, { id: 'u-taken-open', role: 'user', parts: [{ type: 'text', text: 'x' }] });
      const titled = async (): Promise<number> => (await withUserRaw(pg, userId, (tx) => tx.query('SELECT id FROM bob.conversations WHERE title = $1', ['opens nothing']))).rows.length;
      await run({ message: userMessage('u-taken-open', 'opens nothing') }, response()).catch(() => undefined);
      expect(await titled()).toBe(0);
    });

    it('a Retry racing its first attempt into the same conversation stores one message and no error', async () => {
      const conversation = await createConversation(db, userId, 'race');
      const body = { id: conversation.id, message: userMessage('u-race-1', 'raced'), resend: true };
      await Promise.all([run(body, response()), run(body, response())]);
      expect((await rows(conversation.id)).map((message) => message.role)).toEqual(['user', 'assistant']);
    });

    it('two id-less attempts at one message leave one conversation', async () => {
      const titled = async (): Promise<number> => (await withUserRaw(pg, userId, (tx) => tx.query('SELECT id FROM bob.conversations WHERE title = $1', ['raced opening']))).rows.length;
      const body = { message: userMessage('u-race-2', 'raced opening'), resend: true };
      await Promise.all([run(body, response()), run(body, response())]);
      expect(await titled()).toBe(1);
    });

    it('refuses resend next to an edit or a regenerate', () => {
      const message = userMessage('m', 'x');
      expect(webChatRequestSchema.safeParse({ id: 'c', message, resend: true, regenerate: true }).success).toBe(false);
      expect(webChatRequestSchema.safeParse({ id: 'c', message, resend: true, editFrom: 'a' }).success).toBe(false);
    });

    it('a retried edit that was already stored keeps one copy of the edited text', async () => {
      const conversation = await createConversation(db, userId, 'edit-replay');
      await seedTurns(conversation.id, [['user', 'q1'], ['assistant', 'a1'], ['user', 'q2'], ['assistant', 'a2']]);
      const anchor = (await rows(conversation.id))[1]!.id;
      const edit = { id: conversation.id, message: userMessage('u-edit-replay', 'edited'), editFrom: anchor };
      await run(edit, response());
      await run(edit, response());
      const messages = await rows(conversation.id);
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(messages[2]!.id).toBe('u-edit-replay');
    });

    it.each([
      ['editFrom', (anchor: string) => ({ editFrom: anchor })],
      ['editFromStart', () => ({ editFromStart: true as const })],
    ])('%s that cannot store the edited message leaves the thread whole', async (name, edit) => {
      const conversation = await createConversation(db, userId, `edit-fails-${name}`);
      await seedTurns(conversation.id, [['user', 'q1'], ['assistant', 'a1'], ['user', 'q2'], ['assistant', 'a2']]);
      // The edited message's id is already taken, so its append fails.
      const other = await createConversation(db, userId, `edit-fails-other-${name}`);
      await appendMessage(db, userId, other.id, { id: `u-taken-${name}`, role: 'user', parts: [{ type: 'text', text: 'x' }] });
      const anchor = (await rows(conversation.id))[1]!.id;
      await run({ id: conversation.id, message: userMessage(`u-taken-${name}`, 'edited'), ...edit(anchor) }, response()).catch(() => undefined);
      expect(await rows(conversation.id)).toHaveLength(4);
    });
  });

  it('9. rejects regenerate together with editFrom as a 400', async () => {
    const result = response();
    await run(
      { message: userMessage('msg-invalid-09', 'hi'), regenerate: true, editFrom: 'msg_1' },
      result,
    );
    expect(result.statusCode).toBe(400);
    expect(result.chunks.join('')).toContain('invalid_request');
  });

  it('10. persists the partial reply when the reader disconnects mid-stream', async () => {
    const result = response();
    result.disconnectOnFirstWrite();
    await run({ message: userMessage('user-msg-abort', 'tell me something long') }, result);
    // #466: the reader leaving no longer aborts the agent; only Stop does.
    expect(state.lastAbortSignal?.aborted).toBe(false);
    const sse = result.chunks.join('');
    const match = sse.match(/"conversationId":"(cnv_[^"]+)"/);
    // The partial text reached the reader before the disconnect, so the store
    // must hold it rather than losing the turn entirely (FR-032).
    if (match) {
      const detail = (await getConversation(db, userId, match[1]!))!;
      expect(JSON.stringify(detail.messages.at(-1))).toContain('done');
    }
  });

  it('11. returns 400 invalid_request for a malformed body', async () => {
    const result = response();
    await run({ messages: 'not-the-shape' }, result);
    expect(result.statusCode).toBe(400);
    expect(result.chunks.join('')).toContain('invalid_request');
  });

  it('12. journals counts and ids only - never message text or titles', async () => {
    const result = response();
    const secretText = 'private-question-content-xyz';
    await run({ message: userMessage('msg-secret-12', secretText) }, result);
    const { journal } = await import('../../src/platform/logger.ts');
    // turn_id carries the client message id (an identifier), never the text.
    const started = vi.mocked(journal).mock.calls
      .filter(([event]) => event === 'v2.turn_stage_agent_started')
      .at(-1)!;
    expect((started[1] as Record<string, unknown>).turn_id).toBe('msg-secret-12');
    expect(JSON.stringify(vi.mocked(journal).mock.calls)).not.toContain(secretText);
    expect(JSON.stringify(vi.mocked(journal).mock.calls)).not.toContain('private');
  });

  it('13. serves the system-test stub without touching the store', async () => {
    state.streamMode = 'system-test';
    const before = await pg.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM bob.conversations`,
    );
    const result = response();
    await run({ message: userMessage('msg-stub-13', 'anything') }, result);
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toBe('text/event-stream');
    expect(result.chunks.join('')).toContain('System test response');
    // The stub returns before getDb(): no conversation row was added.
    const after = await pg.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM bob.conversations`,
    );
    expect(after.rows[0]!.total).toBe(before.rows[0]!.total);
  });

  it('13a. #550 BOB_AI_STUB=scripted runs the real turn: a scripted sentence creates a real task', async () => {
    state.streamMode = 'system-test';
    const previous = process.env.BOB_AI_STUB;
    process.env.BOB_AI_STUB = 'scripted';
    try {
      const title = 'Scripted chip check 13a';
      const result = response();
      await run({ message: userMessage('msg-scripted-13a', `e2e add a task called ${title}`) }, result);
      expect(result.statusCode).toBe(200);
      const sse = result.chunks.join('');
      expect(sse).toContain('"toolName":"create_task"');
      expect(sse).toContain('Stub: create_task finished.');
      expect(sse).toMatch(/"conversationId":"cnv_[^"]+"/);
      const taskId = sse.match(/"taskId":"([0-9a-f-]{36})"/)?.[1];
      expect(taskId).toBeTruthy();
      const rows = await withUserRaw(pg, userId, (tx) =>
        tx.query<{ title: string }>(`SELECT title FROM bob.tasks WHERE id = $1`, [taskId]));
      expect(rows.rows.map((row) => row.title)).toEqual([title]);
    } finally {
      if (previous === undefined) delete process.env.BOB_AI_STUB;
      else process.env.BOB_AI_STUB = previous;
    }
  });

  it('13b. #550 the scripted stub is refused under BOB_PRODUCTION=1: the canned stub answers, no store', async () => {
    state.streamMode = 'system-test';
    const previous = { stub: process.env.BOB_AI_STUB, production: process.env.BOB_PRODUCTION };
    process.env.BOB_AI_STUB = 'scripted';
    process.env.BOB_PRODUCTION = '1';
    try {
      const before = await pg.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM bob.conversations`);
      const result = response();
      await run({ message: userMessage('msg-scripted-13b', 'e2e add a task called Never made') }, result);
      const sse = result.chunks.join('');
      expect(sse).toContain('System test response');
      expect(sse).not.toContain('create_task');
      const after = await pg.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM bob.conversations`);
      expect(after.rows[0]!.total).toBe(before.rows[0]!.total);
    } finally {
      for (const [key, value] of [['BOB_AI_STUB', previous.stub], ['BOB_PRODUCTION', previous.production]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('14. carries an image attachment through to the provider prompt as a file part', async () => {
    const result = response();
    await run(
      {
        message: {
          id: 'user-msg-img',
          role: 'user',
          parts: [
            { type: 'text', text: 'what is in this picture?' },
            {
              type: 'file',
              mediaType: 'image/png',
              filename: 'diagram.png',
              url: 'data:image/png;base64,iVBORw0KGgo=',
            },
          ],
        },
      },
      result,
    );
    expect(result.statusCode).toBe(200);
    // What the agent was handed, one step before the provider call: the SDK
    // converted the UI file part into a model file part rather than dropping it.
    const prompt = state.lastUiMessages.at(-1)!.parts as Array<Record<string, unknown>>;
    const file = prompt.find((part) => part.type === 'file')!;
    expect(file).toBeTruthy();
    expect(file.mediaType).toBe('image/png');
    expect(String((file.data as { url?: unknown }).url)).toContain('data:image/png;base64,');
    // ...and the store kept it, so a reload shows the same message (FR-046).
    const match = result.chunks.join('').match(/"conversationId":"(cnv_[^"]+)"/)!;
    const detail = (await getConversation(db, userId, match[1]!))!;
    expect(JSON.stringify(detail.messages[0]!.versions[0]!.parts)).toContain('diagram.png');
  });

  it('15. journals attachment counts and bytes - never a filename or its content', async () => {
    const result = response();
    const filename = 'private-holiday-photo-xyz.png';
    const body = Buffer.from('secret-image-bytes-abcdefghij').toString('base64');
    await run(
      {
        message: {
          id: 'user-msg-priv',
          role: 'user',
          parts: [
            { type: 'text', text: 'describe it' },
            { type: 'file', mediaType: 'image/png', filename, url: `data:image/png;base64,${body}` },
          ],
        },
      },
      result,
    );
    const { journal } = await import('../../src/platform/logger.ts');
    const journalled = JSON.stringify(vi.mocked(journal).mock.calls);
    expect(journalled).not.toContain(filename);
    expect(journalled).not.toContain('holiday');
    expect(journalled).not.toContain(body);
    expect(journalled).not.toContain('data:image');
    // Counts are fine and are what makes the turn diagnosable at all.
    // The mock accumulates across this file's tests, so read this turn's entry.
    const started = vi
      .mocked(journal)
      .mock.calls.filter(([event]) => event === 'v2.turn_stage_agent_started')
      .at(-1)!;
    expect((started[1] as Record<string, unknown>).interface).toBe('web');
    expect((started[1] as Record<string, unknown>).stage).toBe('agent');
    expect((started[1] as Record<string, unknown>).outcome).toBe('started');
    expect((started[1] as Record<string, unknown>).turn_id).toBe('user-msg-priv');
    expect((started[1] as Record<string, unknown>).attachments).toBe(1);
    expect((started[1] as Record<string, unknown>).attachment_bytes).toBe(29);
    // #416: the replayed image count -- an integer within the cap, no payload.
    const replayedCount = (started[1] as Record<string, unknown>).history_attachments;
    expect(Number.isInteger(replayedCount)).toBe(true);
    expect(replayedCount).toBe(1);
    expect(replayedCount as number).toBeLessThanOrEqual(4);
    expect(JSON.stringify(started)).not.toContain('data:');
  });

  it('16. rejects an unreadable document before the store is touched', async () => {
    const before = await pg.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM bob.conversations');
    const result = response();
    await run(
      {
        message: {
          id: 'u-pdf',
          role: 'user',
          parts: [
            { type: 'text', text: 'read this' },
            { type: 'file', mediaType: 'application/pdf', filename: 'x.pdf', url: 'data:application/pdf;base64,QUJDRA==' },
          ],
        },
      },
      result,
    );
    expect(result.statusCode).toBe(400);
    expect(result.chunks.join('')).toContain('invalid_document');
    const after = await pg.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM bob.conversations');
    expect(after.rows[0]?.total).toBe(before.rows[0]?.total);
  });

  it('stops during document preflight before persistence or model execution', async () => {
    let enteredResolve: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const parser = vi.spyOn(documents, 'prepareDocumentMessages').mockImplementationOnce(async (_messages, signal) => {
      enteredResolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const before = await pg.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM bob.conversations');
    const streamCalls = vi.mocked(bobAgent.stream).mock.calls.length;
    const result = response();
    try {
      const pending = run({ message: userMessage('stop-document', 'read this') }, result);
      await entered;
      const stopped = response();
      webChatStop({ body: { messageId: 'stop-document' }, account: { userId } } as never, stopped as never);
      expect(stopped.chunks.join('')).toContain('"stopped":true');
      await pending;
      expect(result.statusCode).toBe(409);
      expect(vi.mocked(bobAgent.stream).mock.calls.length).toBe(streamCalls);
      const after = await pg.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM bob.conversations');
      expect(after.rows[0]?.total).toBe(before.rows[0]?.total);
      const finished = response();
      webChatStop({ body: { messageId: 'stop-document' }, account: { userId } } as never, finished as never);
      expect(finished.chunks.join('')).toContain('"stopped":false');
    } finally { parser.mockRestore(); }
  });

  it('reports parser capacity as retryable instead of corrupt input', async () => {
    const parser = vi.spyOn(documents, 'prepareDocumentMessages').mockRejectedValueOnce(new Error('document_busy'));
    try {
      const result = response();
      await run({ message: userMessage('busy-document', 'read this') }, result);
      expect(result.statusCode).toBe(503);
      expect(result.headers['Retry-After']).toBe('5');
      expect(result.chunks.join('')).toContain('document_busy');
    } finally { parser.mockRestore(); }
  });

  it.each([
    ['doc', 'application/msword'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['txt', 'text/plain'],
  ])('passes %s document text to the agent and preserves the source file in history', async (extension, mediaType) => {
    const bytes = extension === 'txt' ? Buffer.from('Project code: ORBIT-42.') : readFileSync(new URL(`./fixtures/attachment.${extension}`, import.meta.url));
    const filename = `attachment.${extension}`;
    const source = { type: 'file', mediaType, filename, url: `data:${mediaType};base64,${bytes.toString('base64')}` };
    const result = response();
    await run({ message: { id: `user-${extension}`, role: 'user', parts: [source] } }, result);
    expect(result.statusCode).toBe(200);
    expect(JSON.stringify(state.agentUiMessages.at(-1)?.parts)).toContain('ORBIT-42');
    expect(state.agentUiMessages.at(-1)?.parts).not.toContainEqual(expect.objectContaining({ type: 'file' }));
    const match = result.chunks.join('').match(/"conversationId":"(cnv_[^"]+)"/);
    const detail = await getConversation(db, userId, match?.[1] ?? 'missing');
    expect(detail?.messages[0]?.versions[0]?.parts).toContainEqual(source);
  });

  it('schema parity: accepts the documented persistence shape', () => {
    expect(webChatRequestSchema.safeParse({ message: userMessage('m1', 'hi') }).success).toBe(true);
    expect(webChatRequestSchema.safeParse({}).success).toBe(false);
  });

  it('trims history to the provider safety bound (unit)', () => {
    expect(trimWebChatHistory(Array.from({ length: 45 }, (_, index) => index)))
      .toEqual(Array.from({ length: 40 }, (_, index) => index + 5));
  });

  it('trims through the shared core trimHistory, not a web-local copy (T021)', () => {
    const long = Array.from({ length: MAX_HISTORY_MESSAGES + 20 }, (_, index) => index);
    expect(trimHistory(long)).toEqual(trimWebChatHistory(long));
    expect(trimWebChatHistory(long)).toHaveLength(MAX_HISTORY_MESSAGES);
  });

  it('classifies an invalid-name failure as 400 invalid_request through Core (T021)', async () => {
    const result = response();
    const invalid = new Error('provider rejected the prompt');
    invalid.name = 'InvalidResponseError';
    vi.mocked(bobAgent.stream).mockRejectedValueOnce(invalid);
    await run({ message: userMessage('msg-fail-a', 'hi') }, result);
    expect(result.statusCode).toBe(400);
    expect(result.chunks.join('')).toContain('invalid_request');
  });

  it('classifies an ordinary failure as 502 upstream_error through Core (T021)', async () => {
    const result = response();
    vi.mocked(bobAgent.stream).mockRejectedValueOnce(new Error('boom'));
    await run({ message: userMessage('msg-fail-b', 'hi') }, result);
    expect(result.statusCode).toBe(502);
    expect(result.chunks.join('')).toContain('upstream_error');
  });

  // #1041: what the AI Gateway throws once the key's budget is spent.
  const budgetSpent = (): Error => Object.assign(new Error('API key budget exceeded'), { name: 'GatewayInternalServerError', statusCode: 402 });

  it('#1041: a spent budget (402) before the stream is 503 out_of_credit, alarmed once', async () => {
    const { journal } = await import('../../src/platform/logger.ts');
    const { resetBudgetAlarm } = await import('../../src/platform/observability/budget-alarm.ts');
    resetBudgetAlarm();
    vi.mocked(journal).mockClear();
    const result = response();
    vi.mocked(bobAgent.stream).mockRejectedValueOnce(budgetSpent());
    await run({ message: userMessage('msg-credit-a', 'hi') }, result);
    expect(result.statusCode).toBe(503);
    expect(result.chunks.join('')).toContain('"code":"out_of_credit"');
    expect(result.chunks.join('')).not.toContain('budget exceeded');
    const alarms = vi.mocked(journal).mock.calls.filter(([event]) => event === 'v2.ai_budget_exhausted');
    expect(alarms).toEqual([['v2.ai_budget_exhausted', { surface: 'web_text', stage: 'agent' }]]);
  });

  it('#1041: a spent budget (402) mid-stream ends with an out_of_credit error part', async () => {
    const { resetBudgetAlarm } = await import('../../src/platform/observability/budget-alarm.ts');
    resetBudgetAlarm();
    vi.mocked(bobAgent.stream).mockImplementationOnce((async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'assistant-credit-1' });
          controller.enqueue({ type: 'error', error: budgetSpent() });
          controller.close();
        },
      }),
    })) as never);
    const result = response();
    await run({ message: userMessage('msg-credit-b', 'hi') }, result);
    const sse = result.chunks.join('');
    expect(sse).toContain('"errorText":"out_of_credit"');
    expect(sse).not.toContain('budget exceeded');
  });

  it('journals agent_failed and no agent_completed when the stream fails', async () => {
    const { journal } = await import('../../src/platform/logger.ts');
    vi.mocked(journal).mockClear();
    const result = response();
    vi.mocked(bobAgent.stream).mockRejectedValueOnce(new Error('boom'));
    await run({ message: userMessage('msg-jrnl-c', 'hi') }, result);
    const events = vi.mocked(journal).mock.calls.map(([event]) => event);
    expect(events.filter((event) => event === 'v2.turn_stage_agent_failed')).toHaveLength(1);
    expect(events.filter((event) => event === 'v2.turn_stage_agent_completed')).toHaveLength(0);
  });

  it('journals agent_completed exactly once on a successful stream', async () => {
    const { journal } = await import('../../src/platform/logger.ts');
    vi.mocked(journal).mockClear();
    const result = response();
    await run({ message: userMessage('msg-jrnl-d', 'hi') }, result);
    const events = vi.mocked(journal).mock.calls.map(([event]) => event);
    expect(events.filter((event) => event === 'v2.turn_stage_agent_completed')).toHaveLength(1);
  });

  it('#396: the completed event carries all-step usage and prep/model/first-token timings', async () => {
    const { journal } = await import('../../src/platform/logger.ts');
    vi.mocked(journal).mockClear();
    const original = vi.mocked(bobAgent.stream).getMockImplementation()!;
    const step = (input: number, tools: string[], finishReason: string): Record<string, unknown> => ({
      toolCalls: tools.map((toolName) => ({ toolName, input: { note: 'private words' } })),
      finishReason,
      response: { modelId: 'openai/gpt-4o' },
      usage: { inputTokens: input, outputTokens: 5, totalTokens: input + 5, inputTokenDetails: { cacheReadTokens: 256 } },
    });
    vi.mocked(bobAgent.stream).mockImplementationOnce(((options: Parameters<typeof original>[0]) => {
      const onStepEnd = (options as { onStepEnd?: (step: unknown) => void }).onStepEnd;
      onStepEnd?.(step(1000, ['listTasks'], 'tool-calls'));
      onStepEnd?.(step(1030, [], 'stop'));
      return original(options);
    }) as typeof original);
    await run({ message: userMessage('msg-jrnl-usage', 'hi') }, response());
    const completed = vi.mocked(journal).mock.calls
      .find(([event]) => event === 'v2.turn_stage_agent_completed')![1] as Record<string, unknown>;
    expect(completed).toMatchObject({
      model: 'openai/gpt-4o', input_tokens: 2030, output_tokens: 10, tokens: 2040, cached_input_tokens: 512,
      steps: 2, tool_calls: 1, called_tools: 'listTasks', finish_reason: 'stop',
    });
    expect(completed.prep_ms).toEqual(expect.any(Number));
    expect(completed.model_ms).toEqual(expect.any(Number));
    expect(completed.first_token_ms).toEqual(expect.any(Number));
    expect(completed.duration_ms).toBe((completed.prep_ms as number) + (completed.model_ms as number));
    expect(JSON.stringify(vi.mocked(journal).mock.calls)).not.toContain('private words');
    const tools = vi.mocked(journal).mock.calls
      .find(([event]) => event === 'v2.agent_tools')![1] as Record<string, unknown>;
    expect(tools).toMatchObject({
      tool_count: expect.any(Number), tools_chars: expect.any(Number), instructions_chars: expect.any(Number),
      history_messages: expect.any(Number), history_chars: expect.any(Number), history_attachment_bytes: 0,
    });
  });

  it('rejects a message id longer than 128 chars with 400 and never journals it', async () => {
    const { journal } = await import('../../src/platform/logger.ts');
    vi.mocked(journal).mockClear();
    const result = response();
    const longId = 'x'.repeat(129);
    await run({ message: userMessage(longId, 'hi') }, result);
    expect(result.statusCode).toBe(400);
    expect(result.chunks.join('')).toContain('invalid_request');
    expect(JSON.stringify(vi.mocked(journal).mock.calls)).not.toContain(longId);
  });

  it('persists web turns with origin web_text (C-04/C-05 shape)', async () => {
    const result = response();
    await run({ message: userMessage('msg-origin-01', 'origin check') }, result);
    const sse = result.chunks.join('');
    const match = sse.match(/"conversationId":"(cnv_[^"]+)"/)!;
    const detail = (await getConversation(db, userId, match[1]!))!;
    expect(detail.messages[0]!.origin).toBe('web_text');
    expect(detail.messages[1]!.origin).toBe('web_text');
  });

  it('returns each message with the time it was appended', async () => {
    const before = Date.now();
    const result = response();
    await run({ message: userMessage('msg-time-01', 'what time') }, result);
    const match = result.chunks.join('').match(/"conversationId":"(cnv_[^"]+)"/)!;
    const detail = (await getConversation(db, userId, match[1]!))!;
    const [asked, answered] = detail.messages;
    expect(asked!.createdAt).toBeGreaterThanOrEqual(before - 1000);
    expect(answered!.createdAt).toBeGreaterThanOrEqual(asked!.createdAt);
    expect(ConversationDetailSchema.parse(detail).messages[0]!.createdAt).toBe(asked!.createdAt);
  });

  it('streams the reply with the time it began', async () => {
    const result = response();
    await run({ message: userMessage('msg-time-02', 'stamp me') }, result);
    expect(result.chunks.join('')).toMatch(/"messageMetadata":\{[^}]*"createdAt":\d+/);
  });
});

describe('active-conversation pointer from web turns (C-09, C-11)', () => {
  it('C-09: a web turn in conversation X sets the pointer to X (surface web_text)', async () => {
    const conversation = await createConversation(db, userId, 'existing chat');
    await withUser(db, userId, (tx) => setActive(tx, userId, conversation.id, 'picker'));
    const received: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(userId, (event) => received.push(event));

    const result = response();
    await run({ id: conversation.id, message: userMessage('msg-c09-01', 'follow me') }, result);
    expect(result.statusCode).toBe(200);

    const active = await getActive(db, userId);
    expect(active?.conversationId).toBe(conversation.id);
    expect(active?.surface).toBe('web_text');
    const changed = received.filter((event) => event.type === 'active.changed');
    expect(changed).toHaveLength(1);
    if (changed[0]!.type === 'active.changed') {
      expect(changed[0]!.conversation_id).toBe(conversation.id);
      expect(changed[0]!.surface).toBe('web_text');
      expect(changed[0]!.title).toBe('existing chat');
    }
    stop();
  });

  it('C-11: starting a new conversation sets the pointer to it and emits conversation.updated', async () => {
    const received: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(userId, (event) => received.push(event));

    const result = response();
    await run({ message: userMessage('msg-c11-01', 'brand new chat') }, result);
    expect(result.statusCode).toBe(200);
    const sse = result.chunks.join('');
    const match = sse.match(/"conversationId":"(cnv_[^"]+)"/)!;

    const active = await getActive(db, userId);
    expect(active?.conversationId).toBe(match[1]!);
    expect(active?.surface).toBe('web_text');
    expect(received.some((event) => event.type === 'conversation.updated')).toBe(true);
    expect(received.some((event) => event.type === 'active.changed')).toBe(true);
    stop();
  });
});

describe('additive chat-request fields: origin and editFromStart', () => {
  const conversationCount = async (): Promise<number> =>
    (await pg.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM bob.conversations`)).rows[0]!.total;

  it('origin web_voice on a new conversation is stored, returned on restore, and is the pointer surface', async () => {
    const result = response();
    await run({ message: userMessage('msg-voice-01', 'spoken opener'), origin: 'web_voice' }, result);
    expect(result.statusCode).toBe(200);
    const match = result.chunks.join('').match(/"conversationId":"(cnv_[^"]+)"/)!;
    const detail = (await getConversation(db, userId, match[1]!))!;
    expect(detail.messages[0]!.origin).toBe('web_voice');
    // The reply was read aloud, so it carries the spoken origin too.
    expect(detail.messages[1]!.role).toBe('assistant');
    expect(detail.messages[1]!.origin).toBe('web_voice');
    const active = await getActive(db, userId);
    expect(active?.conversationId).toBe(match[1]!);
    expect(active?.surface).toBe('web_voice');
  });

  it('origin web_voice on an existing conversation stamps the turn, the pointer, the event and the journal', async () => {
    const conversation = await createConversation(db, userId, 'voice follow-up');
    await withUser(db, userId, (tx) => setActive(tx, userId, conversation.id, 'picker'));
    const { journal } = await import('../../src/platform/logger.ts');
    vi.mocked(journal).mockClear();
    const received: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(userId, (event) => received.push(event));
    const result = response();
    await run({ id: conversation.id, message: userMessage('msg-voice-02', 'spoken follow-up'), origin: 'web_voice' }, result);
    stop();
    expect(result.statusCode).toBe(200);
    const detail = (await getConversation(db, userId, conversation.id))!;
    expect(detail.messages[0]!.origin).toBe('web_voice');
    expect((await getActive(db, userId))?.surface).toBe('web_voice');
    const changed = received.filter((event) => event.type === 'active.changed');
    expect(changed).toHaveLength(1);
    if (changed[0]!.type === 'active.changed') expect(changed[0]!.surface).toBe('web_voice');
    expect(vi.mocked(journal).mock.calls).toContainEqual(['v2.active_changed', { surface: 'web_voice' }]);
  });

  it('origin device is refused as a 400 and touches nothing', async () => {
    const before = await conversationCount();
    const result = response();
    await run({ message: userMessage('msg-device-01', 'hi'), origin: 'device' }, result);
    expect(result.statusCode).toBe(400);
    expect(result.chunks.join('')).toContain('invalid_request');
    expect(await conversationCount()).toBe(before);
  });

  it('editFromStart deletes every message, then stores and answers the edited turn', async () => {
    const conversation = await createConversation(db, userId, 'edit the opener');
    await seedTurns(conversation.id, [
      ['user', 'old opener'],
      ['assistant', 'old answer'],
      ['user', 'old follow-up'],
      ['assistant', 'old follow-up answer'],
    ]);
    const result = response();
    await run({ id: conversation.id, message: userMessage('u-edited-start', 'new opener'), editFromStart: true }, result);
    expect(result.statusCode).toBe(200);
    const detail = (await getConversation(db, userId, conversation.id))!;
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(detail.messages[0]!.id).toBe('u-edited-start');
    expect(detail.messages[0]!.position).toBe(0);
    expect(detail.messages[0]!.origin).toBe('web_text');
    expect(detail.messages[0]!.versions[0]!.parts).toEqual([{ type: 'text', text: 'new opener' }]);
    expect(detail.messages[1]!.versions.at(-1)?.parts).toEqual([{ type: 'text', state: 'done', text: 'done' }]);
    // The agent was shown only the edited turn, none of the deleted history.
    expect(state.lastUiMessages.map((message) => message.parts)).toEqual([[{ type: 'text', text: 'new opener' }]]);
  });

  it('editFromStart together with origin web_voice stamps the edited turn as spoken', async () => {
    const conversation = await createConversation(db, userId, 'spoken edit');
    await seedTurns(conversation.id, [['user', 'typed opener'], ['assistant', 'typed answer']]);
    const result = response();
    await run(
      { id: conversation.id, message: userMessage('u-spoken-edit', 'spoken opener'), editFromStart: true, origin: 'web_voice' },
      result,
    );
    expect(result.statusCode).toBe(200);
    const detail = (await getConversation(db, userId, conversation.id))!;
    expect(detail.messages[0]!.origin).toBe('web_voice');
    expect(detail.messages).toHaveLength(2);
  });

  it.each([
    ['regenerate', { regenerate: true }],
    ['editFrom', { editFrom: 'msg_1' }],
  ])('editFromStart together with %s is a 400 and leaves the conversation unchanged', async (_name, extra) => {
    const conversation = await createConversation(db, userId, 'exclusive');
    await seedTurns(conversation.id, [['user', 'keep me'], ['assistant', 'keep me too']]);
    const result = response();
    await run({ id: conversation.id, message: userMessage('u-excl', 'edited'), editFromStart: true, ...extra }, result);
    expect(result.statusCode).toBe(400);
    expect(result.chunks.join('')).toContain('invalid_request');
    expect((await getConversation(db, userId, conversation.id))!.messages).toHaveLength(2);
  });

  it('editFromStart on a new conversation is a 400 and creates nothing', async () => {
    const before = await conversationCount();
    const result = response();
    await run({ message: userMessage('u-new-edit', 'nothing to edit'), editFromStart: true }, result);
    expect(result.statusCode).toBe(400);
    expect(result.chunks.join('')).toContain('invalid_request');
    expect(await conversationCount()).toBe(before);
  });

  it('schema: editFromStart is the literal true; origin is web_text or web_voice', () => {
    const message = userMessage('m-schema', 'hi');
    expect(webChatRequestSchema.safeParse({ message, origin: 'web_voice' }).success).toBe(true);
    expect(webChatRequestSchema.safeParse({ id: 'cnv_x', message, editFromStart: true }).success).toBe(true);
    expect(webChatRequestSchema.safeParse({ id: 'cnv_x', message, editFromStart: false }).success).toBe(false);
    expect(webChatRequestSchema.safeParse({ message, origin: 'device' }).success).toBe(false);
  });
});

describe('app binding on /api/chat (U5a targeting, never authorization)', () => {
  const message = userMessage('m1', 'hi');
  const installationId = '6f1d2a3e-4b5c-4d6e-8f70-123456789abc';

  it('accepts run and refine and keeps the binding as sent', () => {
    for (const mode of ['run', 'refine'] as const) {
      const parsed = webChatRequestSchema.safeParse({ id: 'cnv_x', message, appBinding: { installationId, mode } });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.appBinding).toEqual({ installationId, mode });
    }
  });

  it('is absent unless sent, so an unbound request keeps its shape', () => {
    const parsed = webChatRequestSchema.safeParse({ id: 'cnv_x', message });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'appBinding' in parsed.data).toBe(false);
  });

  it('refuses fields beyond the known targeting fields', () => {
    for (const extra of ['owner', 'grant', 'campaign', 'tool', 'context', 'approval']) {
      expect(webChatRequestSchema.safeParse({ message, appBinding: { installationId, mode: 'run', [extra]: 'x' } }).success).toBe(false);
    }
  });

  it('refuses a non-UUID installation id, an unknown mode, a missing field or null', () => {
    expect(webChatRequestSchema.safeParse({ message, appBinding: { installationId: 'not-a-uuid', mode: 'run' } }).success).toBe(false);
    expect(webChatRequestSchema.safeParse({ message, appBinding: { installationId, mode: 'publish' } }).success).toBe(false);
    expect(webChatRequestSchema.safeParse({ message, appBinding: { mode: 'run' } }).success).toBe(false);
    expect(webChatRequestSchema.safeParse({ message, appBinding: null }).success).toBe(false);
  });

  it('accepts the requested network as optional context, and keeps it as sent', () => {
    for (const channel of ['instagram', 'linkedin'] as const) {
      const parsed = webChatRequestSchema.safeParse({ id: 'cnv_x', message, appBinding: { installationId, mode: 'run', channel } });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.appBinding).toEqual({ installationId, mode: 'run', channel });
    }
  });

  it('treats an omitted channel as all channels, with no channel key', () => {
    const parsed = webChatRequestSchema.safeParse({ id: 'cnv_x', message, appBinding: { installationId, mode: 'run' } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'channel' in (parsed.data.appBinding ?? {})).toBe(false);
  });

  it('refuses any channel other than instagram or linkedin', () => {
    for (const channel of ['facebook', 'all', 'Instagram', '', null, 7]) {
      expect(webChatRequestSchema.safeParse({ message, appBinding: { installationId, mode: 'run', channel } }).success).toBe(false);
    }
  });

  it('refuses a channel beside any extra field, so the channel never carries authority', () => {
    expect(webChatRequestSchema.safeParse({ message, appBinding: { installationId, mode: 'run', channel: 'linkedin', owner: 'x' } }).success).toBe(false);
  });

  it('accepts a requested campaign before a conversation exists, preserving channel and copy', () => {
    const campaignId = 'a3c14d67-7e9f-4a82-8b03-123456789abc';
    const original = userMessage('campaign-first', 'Spring  sale, teh post');
    for (const mode of ['run', 'refine'] as const) {
      const appBinding = { installationId, mode, channel: 'linkedin', campaignId };
      const parsed = webChatRequestSchema.safeParse({ message: original, appBinding });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.appBinding).toEqual(appBinding);
      expect(parsed.success && parsed.data.message).toEqual(original);
      expect(parsed.success && 'id' in parsed.data).toBe(false);
    }
  });

  it('omits campaignId unless explicitly requested, including when the copy names a UUID', () => {
    const parsed = webChatRequestSchema.safeParse({
      message: userMessage('campaign-copy', 'a3c14d67-7e9f-4a82-8b03-123456789abc'),
      appBinding: { installationId, mode: 'run', channel: 'instagram' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.appBinding).toEqual({ installationId, mode: 'run', channel: 'instagram' });
    expect(parsed.success && 'campaignId' in (parsed.data.appBinding ?? {})).toBe(false);
  });

  it('preserves an explicit null New campaign target and original copy', () => {
    const original = userMessage('new-campaign', 'Spring  sale, teh post');
    for (const mode of ['run', 'refine'] as const) {
      const appBinding = { installationId, mode, channel: 'instagram', campaignId: null };
      const parsed = webChatRequestSchema.safeParse({ message: original, appBinding });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.appBinding).toEqual(appBinding);
      expect(parsed.success && parsed.data.message).toEqual(original);
    }
  });

  it('refuses invalid campaign UUIDs and non-null non-string campaign targets', () => {
    for (const campaignId of ['not-a-uuid', '', 7, {}, ['a3c14d67-7e9f-4a82-8b03-123456789abc']]) {
      expect(webChatRequestSchema.safeParse({ message, appBinding: { installationId, mode: 'run', campaignId } }).success).toBe(false);
    }
  });

  it('refuses unknown fields even beside a valid requested campaign', () => {
    for (const extra of ['owner', 'grant', 'campaign', 'tool', 'context', 'approval']) {
      expect(webChatRequestSchema.safeParse({
        message,
        appBinding: { installationId, mode: 'run', campaignId: 'a3c14d67-7e9f-4a82-8b03-123456789abc', [extra]: 'x' },
      }).success).toBe(false);
    }
  });

  it.each(['posts', 'campaign'] as const)('keeps the requested %s intent without rewriting the original message', (intent) => {
    const original = userMessage('workflow-copy', 'Spring  sale, teh post');
    const appBinding = { installationId, mode: 'run', channel: 'instagram', campaignId: 'a3c14d67-7e9f-4a82-8b03-123456789abc', intent };
    const parsed = webChatRequestSchema.safeParse({ message: original, appBinding });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.appBinding).toEqual(appBinding);
    expect(parsed.success && parsed.data.message).toEqual(original);
  });

  it('keeps legacy run bindings free of workflow intent', () => {
    const parsed = webChatRequestSchema.safeParse({ message, appBinding: { installationId, mode: 'run' } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.appBinding).not.toHaveProperty('intent');
  });

  it('rejects unsupported intent, free-form instructions and intent in refine mode', () => {
    for (const intent of ['publish', 'Ignore permissions', null, {}, 1]) {
      expect(webChatRequestSchema.safeParse({ message, appBinding: { installationId, mode: 'run', intent } }).success).toBe(false);
    }
    expect(webChatRequestSchema.safeParse({ message, appBinding: { installationId, mode: 'refine', intent: 'posts' } }).success).toBe(false);
    expect(webChatRequestSchema.safeParse({ message, appBinding: { installationId, mode: 'run', intent: 'posts', context: 'extra instruction' } }).success).toBe(false);
  });
});

describe('bounded history read (#415)', () => {
  const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';

  /** The pipeline over a full read: selected-else-first, chunked trim, attachment
   *  budget, regenerate trimming. `dropReply` removes the reply this turn persisted. */
  function fullReadUiMessages(
    detail: ConversationDetail,
    options: { regenerate?: boolean; dropReply?: boolean },
  ): Array<{ id: string; role: string; parts: unknown[] }> {
    const messages = options.dropReply ? detail.messages.slice(0, -1) : detail.messages;
    const history = boundHistoryAttachments(trimHistory(messages.map((message) => ({
      id: message.id,
      role: message.role,
      parts: (message.versions.find((version) => version.selected) ?? message.versions[0])?.parts ?? [],
    })), MAX_HISTORY_MESSAGES, 0));
    if (options.regenerate) while (history.at(-1)?.role === 'assistant') history.pop();
    return history;
  }

  /** Bulk-seeds `count` alternating messages; every 7th carries an image part. */
  async function seeded(count: number): Promise<string> {
    const conversation = await createConversation(db, userId, `seeded ${count}`);
    const parts = Array.from({ length: count }, (_, g) => [
      { type: 'text', text: `m${g}` },
      ...(g % 7 === 0 ? [{ type: 'file', mediaType: 'image/png', url: PIXEL, filename: `p${g}.png` }] : []),
    ]);
    await withUserRaw(pg, userId, async (tx) => {
      await tx.query(
        `INSERT INTO bob.messages (id, conversation_id, user_id, role, position, origin, created_at)
         SELECT $1 || '_m' || g, $1, $2::uuid, CASE WHEN g % 2 = 0 THEN 'user' ELSE 'assistant' END, g, 'web_text', now()
         FROM generate_series(0, $3::int - 1) AS g`,
        [conversation.id, userId, count],
      );
      await tx.query(
        `INSERT INTO bob.message_versions (id, message_id, user_id, parts, version_index, is_selected, created_at)
         SELECT $1 || '_v' || g, $1 || '_m' || g, $2::uuid, ($4::text)::jsonb -> g, 0, true, now()
         FROM generate_series(0, $3::int - 1) AS g`,
        [conversation.id, userId, count, JSON.stringify(parts)],
      );
    });
    return conversation.id;
  }

  /** Runs one turn and asserts it never called the full-conversation read. */
  async function turn(body: Record<string, unknown>): Promise<void> {
    vi.mocked(getConversation).mockClear();
    const result = response();
    await run(body, result);
    expect(result.statusCode).toBe(200);
    expect(getConversation).not.toHaveBeenCalled();
  }

  for (const count of [0, 1, 40, 41, 200]) {
    it(`a normal turn shows the agent what the full read did, M = ${count}, images included`, async () => {
      const id = await seeded(count);
      await turn({ id, message: userMessage(`u-415-normal-${count}`, 'next question') });
      const expected = fullReadUiMessages((await getConversation(db, userId, id))!, { dropReply: true });
      expect(state.agentUiMessages).toEqual(expected);
      expect(state.agentUiMessages.length).toBeGreaterThan(0);
      expect(state.agentUiMessages.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    });
  }

  // #413: the window is chunked on absolute position -- n messages (history +
  // this turn's) start at 20 * ceil((n - 40) / 20) -- the read takes 59 rows and
  // the conversation id is the cache key.
  for (const [count, first, kept] of [[39, 0, 40], [40, 20, 21], [59, 20, 40], [60, 40, 21], [99, 60, 40]] as const) {
    it(`M = ${count} shows the agent a chunked window from message ${first}`, async () => {
      const id = await seeded(count);
      vi.mocked(loadRecentHistory).mockClear();
      vi.mocked(createBobAgent).mockClear();
      vi.mocked(journal).mockClear();
      await turn({ id, message: userMessage(`u-413-${count}`, 'next question') });
      expect(state.agentUiMessages).toHaveLength(kept);
      expect(state.agentUiMessages[0]?.id).toBe(`${id}_m${first}`);
      expect(state.agentUiMessages.at(-1)?.id).toBe(`u-413-${count}`);
      expect(vi.mocked(loadRecentHistory).mock.calls[0]?.[3]).toBe(MAX_HISTORY_MESSAGES + 19);
      expect(vi.mocked(createBobAgent).mock.calls[0]?.[0]).toMatchObject({ cacheKey: id });
      // The key actually sent is checked against the journal in
      // web-chat-prompt-layout.test.ts, which runs the real agent.
      expect(JSON.stringify(vi.mocked(journal).mock.calls)).not.toMatch(/cache_?key/i);
    });
  }

  it('keeps a mid-history regenerated message on its selected (non-first) version', async () => {
    const id = await seeded(40);
    const answer = `${id}_m39`;
    await addReplyVersion(db, userId, id, [{ type: 'text', text: 'v1' }]);
    await addReplyVersion(db, userId, id, [{ type: 'text', text: 'v2' }]);
    await selectVersion(db, userId, answer, 1);
    await seedTurns(id, [['user', 'later'], ['assistant', 'later answer']]);
    await turn({ id, message: userMessage('u-415-mid', 'and now') });
    const expected = fullReadUiMessages((await getConversation(db, userId, id))!, { dropReply: true });
    expect(state.agentUiMessages).toEqual(expected);
    expect(state.agentUiMessages.find((message) => message.id === answer)?.parts).toEqual([{ type: 'text', text: 'v1' }]);
  });

  it('regenerate shows the agent the same history, trailing assistant dropped', async () => {
    const id = await seeded(42);
    await addReplyVersion(db, userId, id, [{ type: 'text', text: 'v1' }]);
    await selectVersion(db, userId, `${id}_m41`, 0);
    await turn({ id, message: userMessage('ignored-415', 'm40'), regenerate: true });
    const expected = fullReadUiMessages((await getConversation(db, userId, id))!, { regenerate: true });
    expect(state.agentUiMessages).toEqual(expected);
    expect(state.agentUiMessages.at(-1)?.role).toBe('user');
  });

  it('editFrom shows the agent the same history as the full read', async () => {
    const id = await seeded(200);
    await turn({ id, message: userMessage('u-415-edit', 'edited'), editFrom: `${id}_m150` });
    const expected = fullReadUiMessages((await getConversation(db, userId, id))!, { dropReply: true });
    expect(state.agentUiMessages).toEqual(expected);
    expect(state.agentUiMessages.at(-1)?.id).toBe('u-415-edit');
  });

  it('editFromStart shows the agent only the edited turn', async () => {
    const id = await seeded(41);
    await turn({ id, message: userMessage('u-415-start', 'fresh start'), editFromStart: true });
    const expected = fullReadUiMessages((await getConversation(db, userId, id))!, { dropReply: true });
    expect(state.agentUiMessages).toEqual(expected);
    expect(state.agentUiMessages).toHaveLength(1);
  });

  it('probes the conversation and reads history in one call per turn', async () => {
    const id = await seeded(3);
    vi.mocked(getConversationSummary).mockClear();
    vi.mocked(loadRecentHistory).mockClear();
    await turn({ id, message: userMessage('u-415-once', 'once') });
    // The resolve step is the only summary read; the history read carries the probe.
    expect(getConversationSummary).toHaveBeenCalledTimes(1);
    expect(loadRecentHistory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadRecentHistory).mock.calls[0]![4]).toEqual({ requireConversation: true });
  });

  it('answers store_error when the conversation vanishes before the history read', async () => {
    const id = await seeded(3);
    const actual = await vi.importActual<typeof import('../../src/conversations/store.ts')>(
      '../../src/conversations/store.ts',
    );
    vi.mocked(loadRecentHistory).mockClear();
    // The store runs beside the history read (SIMPLIFY-U2B): the deletion lands once the message is committed
    // (message.appended is published after the commit), as when the store ran first.
    const committed = new Promise<void>((resolve) => {
      const stop = getAccountEvents().subscribe(userId, (event) => { if (event.type === 'message.appended') { stop(); resolve(); } });
    });
    vi.mocked(loadRecentHistory).mockImplementationOnce((async (...args: Parameters<typeof actual.loadRecentHistory>) => {
      await committed;
      await withUserRaw(pg, userId, (tx) => tx.query(`DELETE FROM bob.conversations WHERE id = $1`, [id]));
      return actual.loadRecentHistory(...args);
    }) as never);
    vi.mocked(bobAgent.stream).mockClear();
    const result = response();
    await run({ id, message: userMessage('u-415-gone', 'gone') }, result);
    expect(result.statusCode).toBe(500);
    expect(result.chunks.join('')).toContain('store_error');
    expect(loadRecentHistory).toHaveBeenCalledTimes(1);
    expect(bobAgent.stream).not.toHaveBeenCalled();
  });

  it('throws the store\'s own error when the conversation vanishes before the message is stored', async () => {
    const id = await seeded(3);
    const actual = await vi.importActual<typeof import('../../src/conversations/store.ts')>('../../src/conversations/store.ts');
    vi.mocked(appendMessage).mockImplementationOnce((async (...args: Parameters<typeof actual.appendMessage>) => {
      await withUserRaw(pg, userId, (tx) => tx.query(`DELETE FROM bob.conversations WHERE id = $1`, [id]));
      return actual.appendMessage(...args);
    }) as never);
    const result = response();
    await expect(run({ id, message: userMessage('u-415-gone-first', 'gone first') }, result)).rejects.toThrow(/not found/);
    expect(result.chunks.join('')).toBe('');
  });
});

// The guard has verified the bearer before the route runs, so the route only
// decodes it; an unsigned token is enough to exercise that read.
function bearerWith(userMetadata: unknown): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `Bearer ${part({ alg: 'none' })}.${part({ sub: 'u', user_metadata: userMetadata })}.`;
}

describe('account timezone (/api/chat)', () => {
  const asRequest = (authorization?: string) =>
    ({ headers: authorization === undefined ? {} : { authorization } }) as never;

  it('reads user_metadata.time_zone from the verified bearer', () => {
    expect(accountTimeZone(asRequest(bearerWith({ time_zone: 'America/Los_Angeles' })))).toBe('America/Los_Angeles');
  });

  it('falls back to UTC for an invalid, absent or unreadable zone', () => {
    expect(accountTimeZone(asRequest(bearerWith({ time_zone: 'Mars/Olympus' })))).toBe('UTC');
    expect(accountTimeZone(asRequest(bearerWith({ time_zone: 42 })))).toBe('UTC');
    expect(accountTimeZone(asRequest(bearerWith({})))).toBe('UTC');
    expect(accountTimeZone(asRequest('Bearer not-a-jwt'))).toBe('UTC');
    expect(accountTimeZone(asRequest())).toBe('UTC');
  });

  it('builds the turn agent with the account zone', async () => {
    vi.mocked(createBobAgent).mockClear();
    const result = response();
    await webChat(appDeps)(
      {
        body: { message: userMessage('msg-zone-01', 'what is due today') },
        headers: { authorization: bearerWith({ time_zone: 'Asia/Kolkata' }) },
        on: vi.fn(),
        account: { userId, sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 },
      } as never,
      result as never,
    );
    expect(result.statusCode).toBe(200);
    expect(createBobAgent).toHaveBeenCalledWith(expect.objectContaining({ timeZone: 'Asia/Kolkata' }));
  });

  it('keeps the voice style for native app requests through the proxy', async () => {
    vi.mocked(createBobAgent).mockClear();
    const result = response();
    await webChat(appDeps)(
      {
        body: { message: userMessage('msg-brand-native-voice', 'hello'), origin: 'web_voice' },
        headers: {
          authorization: bearerWith({}),
          host: 'api.example.test',
          'x-forwarded-host': 'app.heybob.xyz',
          'x-bob-app-host': 'app.heybob.xyz',
        },
        on: vi.fn(),
        account: { userId, sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 },
      } as never,
      result as never,
    );
    expect(result.statusCode).toBe(200);
    const agentOptions = vi.mocked(createBobAgent).mock.calls.at(-1)?.[0];
    expect(agentOptions?.mode).toBe('web_voice');
  });
});

import { bindPrivateCallbacks } from '../../src/tasks/agent-callbacks.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
describe('tool output links the written item (#517)', () => {
  it('create/update/complete task and create event name the item, its Space and its title', async () => {
    const spaceId = (await ensurePrivateSpace(db, userId)).id;
    const scope = { timeZone: 'Asia/Kolkata', localTimeDues: false };
    const tools = createProductivityTools(bindPrivateCallbacks(db, userId, spaceId, scope), { localTimeDues: false });
    const run = async (name: string, input: unknown): Promise<unknown> =>
      tools[name]!.execute!(input as never, { toolCallId: 't', messages: [], context: {} });

    const created = (await run('create_task', { title: 'Milk' })) as { taskId: string };
    expect(created).toEqual({ ok: true, taskId: expect.any(String), spaceId, title: 'Milk' });
    expect(await run('update_task', { taskId: created.taskId, title: 'Oat milk' }))
      .toEqual({ ok: true, taskId: created.taskId, spaceId, title: 'Oat milk' });
    expect(await run('complete_task', { taskId: created.taskId }))
      .toEqual({ ok: true, taskId: created.taskId, spaceId, title: 'Oat milk' });
    expect(await run('create_event', {
      title: 'Dentist',
      startIso: '2026-10-01T10:00:00+05:30',
      endIso: '2026-10-01T11:00:00+05:30',
      zone: 'Asia/Kolkata',
    })).toEqual({ ok: true, eventId: expect.any(String), spaceId, title: 'Dentist' });
  });
});
