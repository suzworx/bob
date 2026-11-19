/**
 * T012 turn-path memory hooks (specs/010-cross-session-memory): wiring memory
 * retrieval + system-context injection + post-persist extraction into the real
 * web (web-chat.ts) and device (turn.ts) turn paths, with the whole memory
 * layer faked and no network. Covers: block reaches createBobAgent as
 * memoryContext (never a user message), the memory tools are present, enqueue
 * runs only after persist, retrieval starts before the history load resolves,
 * the unavailable path makes zero memory calls (and, since #409, still builds a
 * per-turn agent with the capability tools), and a retrieval rejection/timeout still completes the turn (FR-008).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { tool } from 'ai';
import type { WebSocket } from 'ws';

const state = vi.hoisted(() => ({
  available: true,
  retrievalRejects: false,
  historyMs: 0,
  scopeOverride: null as 'pair' | 'group' | null,
  /** A canned live private scope (no database), for the prep-seam ordering test. */
  scopeCanned: false,
  retrievalBlock: '[BOB MEMORY] the user prefers chai over coffee',
  tools: { remember: { t: 'r' }, forget: { t: 'f' }, list_actions: { t: 'l' }, complete_action: { t: 'c' } },
  order: [] as string[],
  agentOpts: [] as Array<Record<string, unknown>>,
  callbacksTurn: [] as unknown[],
  streamedPrompt: [] as unknown[],
  generatedMessages: [] as unknown[],
  enqueued: [] as string[],
  history: [] as Array<{ role: string; content: string }>,
  persistResult: { conversationId: 'cnv_device_1', created: false, title: 't', userMessageId: 'msg_device_1', changedAt: 1 },
}));


vi.mock('../../src/memory/available.ts', () => ({
  memoryAvailable: vi.fn(() => Promise.resolve(state.available)),
}));

// The web path's per-message search (startMemoryRetrieval) and the device's memory pack (startMemoryPack) return the same block.
vi.mock('../../src/memory/retrieval.ts', () => {
  const recall = (step: string) => vi.fn(() => {
    state.order.push(step);
    if (state.retrievalRejects) {
      return { result: Promise.reject(new Error('retrieval timeout')) };
    }
    return {
      result: Promise.resolve({
        block: state.retrievalBlock,
        memories: [],
        dueSoon: [],
        degraded: false,
        latencyMs: 1,
        sourceFullText: 0,
        sourceSemantic: 0,
        sourceBoth: 0,
      }),
    };
  });
  return { startMemoryRetrieval: recall('retrieval'), startMemoryPack: recall('pack') };
});

vi.mock('../../src/memory/callbacks.ts', () => ({
  createMemoryCallbacks: vi.fn((_db: unknown, _userId: string, turn: unknown) => {
    state.callbacksTurn.push(turn);
    return { listActions: vi.fn(), completeAction: vi.fn(), remember: vi.fn(), forget: vi.fn() };
  }),
}));


const createdAgent = vi.hoisted(() => ({
  stream: vi.fn(async ({ prompt }: { prompt?: unknown }) => {
    state.streamedPrompt = prompt as unknown[];
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'a' });
          controller.enqueue({ type: 'text-start', id: 't', text: '' });
          controller.enqueue({ type: 'text-delta', id: 't', text: 'reply' });
          controller.enqueue({ type: 'text-end', id: 't' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    };
  }),
  generate: vi.fn(async ({ messages }: { messages: unknown }) => {
    state.generatedMessages = messages as unknown[];
    return { text: 'reply', toolCalls: [], modelId: 'm', usage: {} };
  }),
}));

vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  AI_STUB_MODE: false,
  audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
  bobAgent: {
    stream: vi.fn(async ({ prompt }: { prompt?: unknown }) => {
      state.streamedPrompt = prompt as unknown[];
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'start', messageId: 'a' });
            controller.enqueue({ type: 'text-start', id: 't', text: '' });
            controller.enqueue({ type: 'text-delta', id: 't', text: 'reply' });
            controller.enqueue({ type: 'text-end', id: 't' });
            controller.enqueue({ type: 'finish', finishReason: 'stop' });
            controller.close();
          },
        }),
      };
    }),
    generate: vi.fn(async ({ messages }: { messages: unknown }) => {
      state.generatedMessages = messages as unknown[];
      return { text: 'reply', toolCalls: [], modelId: 'm', usage: {} };
    }),
  },
  isProviderError: () => false,
  providerErrorStatus: () => undefined,
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
}) ) as Factory),
    ((() => ({
  createMemoryTools: vi.fn(() => state.tools),
}) ) as Factory),
    ((() => ({
  createBobAgent: vi.fn((opts: unknown) => {
    state.agentOpts.push(opts as Record<string, unknown>);
    return createdAgent;
  }),
}) ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

// Ordering probe: web-chat loads history via loadRecentHistory. Wrapping it to
// record call order lets a test assert retrieval started before that load
// resolved, without changing the real store behaviour.
vi.mock('../../src/conversations/store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/conversations/store.ts')>();
  return {
    ...actual,
    loadRecentHistory: vi.fn(async (...args: Parameters<typeof actual.loadRecentHistory>) => {
      state.order.push('history');
      // historyMs: a canned load (no database) that takes that long, on the fake clock in the ordering test.
      const rows = state.historyMs > 0
        ? await new Promise<[]>((resolve) => { setTimeout(() => resolve([]), state.historyMs); })
        : await actual.loadRecentHistory(...args);
      state.order.push('history-resolved');
      return rows;
    }),
  };
});

// scopeOverride: the scope read answers this kind instead (a pair or group conversation); unset reads the store.
vi.mock('../../src/conversations/scope.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/conversations/scope.ts')>();
  return {
    ...actual,
    getConversationScope: vi.fn(async (...args: Parameters<typeof actual.getConversationScope>) => {
      if (state.scopeCanned) {
        return { conversationId: args[2], spaceId: 'spc_order', spaceKind: 'private' as const, spaceName: null, spaceArchived: false, archivedAt: null, title: 'Order' };
      }
      const read = await actual.getConversationScope(...args);
      return state.scopeOverride && read ? { ...read, spaceKind: state.scopeOverride, spaceId: 'spc_shared' } : read;
    }),
  };
});

vi.mock('../../src/voice/audio/stt-tts.ts', () => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: () => false,
  transcribePcm: vi.fn(async () => ({ text: 'remember chai', model: 'stt', seconds: 1 })),
  synthesizePcm: vi.fn(async () => ({ pcm: Buffer.alloc(3200), sourceRateHz: 44100 })),
  synthesizeMp3: vi.fn(async () => ({ mp3: Buffer.alloc(1024) })),
  downlinkFrames: vi.fn(() => [Buffer.alloc(340), Buffer.alloc(340)]),
  downlinkMp3Frames: vi.fn(() => []),
}));

vi.mock('../../src/voice/cardputer-conversation.ts', () => ({
  loadCardputerHistory: vi.fn(async () => {
    state.order.push('history');
    return state.history;
  }),
  persistDeviceTurn: vi.fn(async () => state.persistResult),
}));

import { webChat } from '../../src/conversations/chat-http.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { setSharedDb, withUser, type Db } from '../../src/platform/db/db.ts';
import * as conversationScope from '../../src/conversations/scope.ts';
import { startWebPrep } from '../../src/turn/chat-agent.ts';
import { createGameSession } from '../../src/voice/games-store.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { createThread } from '../../src/conversations/thread-store.ts';
import { appendMessage, createConversation, loadRecentHistory } from '../../src/conversations/store.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { bobAgent, createMemoryTools, createBobAgent } from '@bob/ai';
import { setJournalSink } from '../../src/platform/logger.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
/** Memory off: no retrieval, no memory tools or callbacks, no extraction, no v2.memory_* events. */
function expectZeroMemoryCalls(journal: string[]): void {
  expect(createMemoryTools).not.toHaveBeenCalled();
  expect(state.callbacksTurn).toHaveLength(0);
  expect(state.enqueued).not.toContain(userId);
  expect(state.order).not.toContain('retrieval');
  expect(journal.length).toBeGreaterThan(0);
  expect(journal.join('\n')).not.toContain('"event":"v2.memory_');
}

const worker = {
  enqueue: vi.fn((userId: string) => state.enqueued.push(userId)),
  scanUnprocessed: vi.fn(async () => 0),
  idle: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
};

function resetState(): void {
  state.order.length = 0;
  state.agentOpts.length = 0;
  state.callbacksTurn.length = 0;
  state.enqueued.length = 0;
  state.streamedPrompt = [];
  state.generatedMessages = [];
  state.available = true;
  state.retrievalRejects = false;
  state.retrievalBlock = '[BOB MEMORY] the user prefers chai over coffee';
  vi.mocked(worker.enqueue).mockClear();
  vi.mocked(createdAgent.stream).mockClear();
  vi.mocked(createdAgent.generate).mockClear();
  vi.mocked(bobAgent.stream).mockClear();
  vi.mocked(bobAgent.generate).mockClear();
  vi.mocked(createMemoryTools).mockClear();
  vi.mocked(createBobAgent).mockClear();
}

function response() {
  const listeners: Record<string, () => void> = {};
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    writableEnded: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    write(chunk: Buffer | string) { this.chunks.push(String(chunk)); },
    end() { this.writableEnded = true; listeners.close?.(); },
    json(body: unknown) { this.chunks.push(JSON.stringify(body)); },
    on(event: string, handler: () => void) { listeners[event] = handler; return this; },
    emit(event: string) { listeners[event]?.(); },
  };
}

function deviceSession(userId: string, conversationId: string): DeviceSession {
  const session = createSession({ kind: 'device', userId, deviceId: 'dev', name: 'cardputer' });
  session.stage = 'responding';
  session.turnRef = 'turn_dev';
  session.activeConversationId = conversationId;
  session.formatId = 1;
  session.audioChunks = [Buffer.alloc(320)];
  return session;
}

function fakeSocket(): WebSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket;
}

let pg: TestDb;
let db: Db;
let userId: string;
let deviceConversationId: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  userId = await resolveDevAccount(db);
  deviceConversationId = (await createConversation(db, userId, 'Device memory hooks')).id;
  state.persistResult.conversationId = deviceConversationId;
  setSharedDb(Promise.resolve(db));
});

afterAll(async () => {
  const { closeDb } = await import('../../src/platform/db/db.ts');
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

afterEach(() => {
  resetState();
});

function userMessage(id: string, text: string) {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

function userTexts(messages: unknown[]): string[] {
  return messages.flatMap((m) => {
    const msg = m as { role?: string; content?: unknown };
    if (typeof msg.content === 'string') return [msg.content];
    const parts = (msg.content as Array<{ text?: string }> | undefined) ?? [];
    return parts.map((p) => p.text).filter((t): t is string => t !== undefined);
  });
}

describe('web path (web-chat.ts)', () => {
  it.each(['archived', 'unknown', 'shared', 'active-game'] as const)('never constructs Google tools for a %s web context', async (mode) => {
    const googleTools = vi.fn(async () => ({}));
    const deps = createAppDeps({ googleTools });
    let conversationId = (await createConversation(db, userId, 'Denied')).id;
    await appendMessage(db, userId, conversationId, { role: 'user', parts: [{ type: 'text', text: 'Read mail' }] });
    if (mode === 'shared') {
      const space = await createSpace(db, userId, { name: 'Shared' });
      conversationId = (await createThread(db, userId, { spaceId: space.id, title: 'Shared' })).id;
    }
    if (mode === 'archived') await withUser(db, userId, (tx) => tx.query('update bob.conversations set archived_at=now() where id=$1', [conversationId]));
    if (mode === 'active-game') await createGameSession(db, userId, { conversationId, game: 'animal_riddles', players: [{ name: 'Sam', band: 'grown' }], state: {} });
    const scopeRead = mode === 'unknown' ? vi.spyOn(conversationScope, 'getConversationScope').mockRejectedValueOnce(new Error('scope unavailable')) : null;
    try {
      const res = response();
      await webChat(deps)({ body: { id: conversationId, regenerate: true, message: userMessage('untrusted', 'Read mail') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, res as never);
      expect(googleTools).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(mode === 'shared' ? 404 : 200);
      if (mode !== 'shared') expect(createBobAgent).toHaveBeenCalled();
    } finally { scopeRead?.mockRestore(); }
  });
  it('offers configured Google tools with a durable anchor when automatic memory is off', async () => {
    state.available = false;
    const googleTools = vi.fn(async () => ({ google_list_accounts: tool({ description: 'Accounts', inputSchema: z.object({}), execute: async () => ({ ok: true }) }) }));
    const deps = createAppDeps({ googleTools });
    const conversation = await createConversation(db, userId, 'Google');
    await webChat(deps)({ body: { id: conversation.id, message: userMessage('google-anchor', 'my calendars') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, response() as never);
    const saved = (await loadRecentHistory(db, userId, conversation.id, 20))?.findLast((row) => row.role === 'user');
    expect(googleTools).toHaveBeenCalledWith(expect.objectContaining({ userId, conversationId: conversation.id, messageId: saved?.id, allowNewOperations: true, signal: expect.any(AbortSignal) }));
    expect(state.agentOpts[0]?.capabilityTools).toHaveProperty('google_list_accounts');
  });
  it('marks regeneration as replay and ignores its browser-supplied user anchor', async () => {
    const googleTools = vi.fn(async () => ({}));
    const deps = createAppDeps({ googleTools });
    const conversation = await createConversation(db, userId, 'Google replay');
    const saved = await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'my calendars' }] });
    await webChat(deps)({ body: { id: conversation.id, regenerate: true, message: userMessage('untrusted-anchor', 'ignored') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, response() as never);
    expect(googleTools).toHaveBeenCalledWith(expect.objectContaining({ messageId: saved?.id, allowNewOperations: false }));
  });
  it.each([false, true])('uses the persisted message anchor when editFromStart=%s', async (editFromStart) => {
    const conversation = await createConversation(db, userId, 'anchor');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'old' }] });
    const res = response();
    await webChat(appDeps)({ body: {
      id: conversation.id, ...(editFromStart ? { editFromStart: true } : {}),
      message: userMessage(`anchor-${conversation.id}`, 'new'),
    }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, res as never);
    const rows = await loadRecentHistory(db, userId, conversation.id, 20);
    const saved = rows?.findLast((row) => row.role === 'user');
    expect(saved?.id).toEqual(expect.any(String));
    expect(state.callbacksTurn[0]).toMatchObject({ turn: { conversationId: conversation.id, messageId: saved?.id } });
  });

  it('regeneration anchors the stored question instead of a client-supplied foreign message id', async () => {
    const conversation = await createConversation(db, userId, 'anchor');
    const other = await createConversation(db, userId, 'other');
    const stored = await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'question' }] });
    await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'reply' }] });
    const foreign = await appendMessage(db, userId, other.id, { role: 'user', parts: [{ type: 'text', text: 'other' }] });
    await webChat(appDeps)({ body: {
      id: conversation.id, regenerate: true, message: userMessage(foreign?.id ?? '', 'untrusted'),
    }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, response() as never);
    expect(state.callbacksTurn[0]).toMatchObject({ turn: { conversationId: conversation.id, messageId: stored?.id } });
  });

  it('does not invent a regeneration anchor when the stored conversation has no question', async () => {
    const conversation = await createConversation(db, userId, 'empty');
    await webChat(appDeps)({ body: {
      id: conversation.id, regenerate: true, message: userMessage('client-only-id', 'untrusted'),
    }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, response() as never);
    expect(state.callbacksTurn[0]).toMatchObject({ turn: { conversationId: conversation.id, messageId: null } });
  });

  it('injects the block as memoryContext (never a user message), adds tools, and enqueues after persist', async () => {
    appDeps.memoryWorker = worker;
    const conversation = await createConversation(db, userId, 'web memory');
    const res = response();
    await webChat(appDeps)(
      { body: { id: conversation.id, message: userMessage('msg-web-1', 'what do I prefer to drink?') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never,
      res as never,
    );

    expect(createMemoryTools).toHaveBeenCalledTimes(1);
    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    expect(opts.memoryContext).toBe(state.retrievalBlock);
    expect(opts.memoryTools).toBe(state.tools);
    // The block is a system section only; it never lands in a user message.
    expect(userTexts(state.streamedPrompt)).not.toContain(state.retrievalBlock);
    // Memory callbacks carried the web turn source.
    expect(state.callbacksTurn[0]).toMatchObject({ turn: { surface: 'web_text' } });
    // Extraction is scheduled after persist, off the reply path.
    expect(state.enqueued).toContain(userId);
  });

  // The turn's prep seam (startWebPrep) on canned reads (no database) and the fake clock: the history load takes
  // 200 ms, and retrieval must start while it is still unresolved.
  it('starts retrieval before the history load resolves', async () => {
    vi.useFakeTimers();
    state.scopeCanned = true;
    state.historyMs = 200;
    try {
      const prep = startWebPrep({
        deps: appDeps, db: {} as Db, userId, conversationId: 'cnv_order', regenerate: undefined, signal: new AbortController().signal,
        timeZone: 'UTC', timings: {}, app: Promise.resolve(null), stored: Promise.resolve('msg-order'),
        pending: { id: 'msg-order', parts: [{ type: 'text', text: 'order check' }], origin: 'web_text' },
      }, 'order check');
      await vi.advanceTimersByTimeAsync(0);
      expect(state.order).toContain('retrieval');
      expect(state.order).not.toContain('history-resolved');
      await vi.advanceTimersByTimeAsync(200);
      expect(await prep.history).toHaveLength(1);
      expect(state.order.indexOf('retrieval')).toBeLessThan(state.order.indexOf('history-resolved'));
    } finally {
      vi.useRealTimers();
      state.scopeCanned = false;
      state.historyMs = 0;
    }
  });

  it.each(['pair', 'group'] as const)('a %s conversation never starts personal retrieval or the Google tools', async (spaceKind) => {
    const googleTools = vi.fn(async () => ({}));
    const deps = createAppDeps({ googleTools });
    const conversation = await createConversation(db, userId, `web ${spaceKind}`);
    state.scopeOverride = spaceKind;
    try {
      await webChat(deps)({ body: { id: conversation.id, message: userMessage(`msg-web-${spaceKind}`, 'remember this') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, response() as never);
    } finally { state.scopeOverride = null; }
    expect(vi.mocked(conversationScope.getConversationScope)).toHaveBeenCalled();
    expect(state.order).not.toContain('retrieval');
    expect(googleTools).not.toHaveBeenCalled();
  });

  it.each(['archived', 'unknown'] as const)('a plain new message in a %s web context never calls the Google tools factory', async (mode) => {
    const googleTools = vi.fn(async () => ({}));
    const deps = createAppDeps({ googleTools });
    const conversation = await createConversation(db, userId, `plain ${mode}`);
    if (mode === 'archived') await withUser(db, userId, (tx) => tx.query('update bob.conversations set archived_at=now() where id=$1', [conversation.id]));
    const scopeRead = mode === 'unknown' ? vi.spyOn(conversationScope, 'getConversationScope').mockRejectedValueOnce(new Error('scope unavailable')) : null;
    try {
      await webChat(deps)({ body: { id: conversation.id, message: userMessage(`msg-plain-${mode}`, 'read my mail') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, response() as never);
    } finally { scopeRead?.mockRestore(); }
    expect(googleTools).not.toHaveBeenCalled();
  });

  it('memory unavailable: a per-turn agent with the capability tools, zero memory calls (#409)', async () => {
    state.available = false;
    appDeps.memoryWorker = worker;
    const conversation = await createConversation(db, userId, 'web off');
    const res = response();
    const journal: string[] = [];
    setJournalSink((line) => journal.push(line));
    try {
      await webChat(appDeps)(
        { body: { id: conversation.id, message: userMessage('msg-web-3', 'plain turn') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never,
        res as never,
      );
    } finally {
      setJournalSink(null);
    }
    expectZeroMemoryCalls(journal);
    // One per-turn agent carrying the capability tools, no memory tools or block.
    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    expect(opts.memoryTools).toBeUndefined();
    expect(String(opts.memoryContext ?? '')).not.toContain('[BOB MEMORY');
    expect(Object.keys(opts.capabilityTools as Record<string, unknown>)).toEqual(expect.arrayContaining(['create_task', 'set_timer']));
    expect(createdAgent.stream).toHaveBeenCalledTimes(1);
    expect(bobAgent.stream).not.toHaveBeenCalled();
  });

  it('completes the turn when retrieval rejects (FR-008)', async () => {
    state.retrievalRejects = true;
    appDeps.memoryWorker = worker;
    const conversation = await createConversation(db, userId, 'web reject');
    const res = response();
    await webChat(appDeps)(
      { body: { id: conversation.id, message: userMessage('msg-web-4', 'reject turn') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    // Memory is still on, so the tools are present even though the block is dropped.
    expect(createBobAgent).toHaveBeenCalledTimes(1);
    expect(state.agentOpts[0]!.memoryContext).toBeUndefined();
    expect(state.agentOpts[0]!.memoryTools).toBe(state.tools);
    expect(res.chunks.join('')).toContain('reply');
  });
});

describe('device path (turn.ts)', () => {
  it('injects the block as memoryContext, adds tools, and enqueues after persist', async () => {
    const session = deviceSession(userId, deviceConversationId);
    await runTurn(appDeps.turn, fakeSocket(), session, 'turn_dev', worker);

    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    expect(opts.memoryContext).toBe(state.retrievalBlock);
    expect(opts.memoryTools).toBe(state.tools);
    expect(state.callbacksTurn[0]).toMatchObject({ turn: { surface: 'device' } });
    // The block is a system section only; it never lands in a user message.
    expect(userTexts(state.generatedMessages)).not.toContain(state.retrievalBlock);
    expect(state.enqueued).toContain(userId);
  });

  it('starts the memory pack before the history load resolves', async () => {
    const session = deviceSession(userId, deviceConversationId);
    await runTurn(appDeps.turn, fakeSocket(), session, 'turn_dev', worker);
    const packAt = state.order.indexOf('pack');
    const historyAt = state.order.indexOf('history');
    expect(packAt).toBeGreaterThanOrEqual(0);
    expect(packAt).toBeLessThan(historyAt);
    // No per-turn query search on the device.
    expect(state.order).not.toContain('retrieval');
  });

  it('memory unavailable: a per-turn agent with the capability tools, zero memory calls (#409)', async () => {
    state.available = false;
    const session = deviceSession(userId, deviceConversationId);
    const journal: string[] = [];
    setJournalSink((line) => journal.push(line));
    try {
      await runTurn(appDeps.turn, fakeSocket(), session, 'turn_dev', worker);
    } finally {
      setJournalSink(null);
    }
    expectZeroMemoryCalls(journal);
    // One per-turn agent carrying the capability tools, no memory tools or block.
    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    expect(opts.memoryTools).toBeUndefined();
    expect(String(opts.memoryContext ?? '')).not.toContain('[BOB MEMORY');
    expect(Object.keys(opts.capabilityTools as Record<string, unknown>)).toEqual(expect.arrayContaining(['create_task', 'set_timer']));
    expect(Object.keys(opts.lateTools as Record<string, unknown>)).toContain('set_volume');
    expect(createdAgent.generate).toHaveBeenCalledTimes(1);
    expect(bobAgent.generate).not.toHaveBeenCalled();
  });

  it('completes the turn when retrieval rejects (FR-008)', async () => {
    state.retrievalRejects = true;
    const session = deviceSession(userId, deviceConversationId);
    await runTurn(appDeps.turn, fakeSocket(), session, 'turn_dev', worker);
    expect(createBobAgent).toHaveBeenCalledTimes(1);
    expect(state.agentOpts[0]!.memoryContext).toBeUndefined();
    expect(state.agentOpts[0]!.memoryTools).toBe(state.tools);
  });
});
