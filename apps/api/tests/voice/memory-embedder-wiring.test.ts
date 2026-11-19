/**
 * T014c regression: BOTH memory turn paths (device turn.ts and web
 * web-chat.ts) must pass an `embedder` into createMemoryCallbacks, or every
 * remembered memory is stored with a NULL embedding and semantic retrieval can
 * never find it (full-text ANDs every word of the query, so it cannot match a
 * short memory either). This suite runs the real turn paths against a fake
 * embedder (no network) and asserts that the deps handed to the memory
 * callbacks carry a callable embedder on BOTH surfaces. It fails if either
 * call site drops the dep again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { WebSocket } from 'ws';

const state = vi.hoisted(() => ({
  available: true,
  retrievalBlock: '[BOB MEMORY] the user prefers chai over coffee',
  deps: [] as unknown[],
  createdAgent: {
    stream: vi.fn(async ({ prompt }: { prompt?: unknown }) => {
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
    generate: vi.fn(async () => ({ text: 'reply', toolCalls: [], modelId: 'm', usage: {} })),
  },
}));


vi.mock('../../src/memory/available.ts', () => ({
  memoryAvailable: vi.fn(() => Promise.resolve(state.available)),
}));

vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({
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
  })),
}));

// The seam under test: capture the deps argument each call site passes.
vi.mock('../../src/memory/callbacks.ts', () => ({
  createMemoryCallbacks: vi.fn((_db: unknown, _userId: string, deps: unknown) => {
    state.deps.push(deps);
    return { listActions: vi.fn(), completeAction: vi.fn(), remember: vi.fn(), forget: vi.fn() };
  }),
}));



// A fake embedder so the lazy getEmbedder() path never touches the network or
// the gateway (the pattern of e2e-memory-parity.db.test.ts).
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  AI_STUB_MODE: false,
  audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
  bobAgent: state.createdAgent,
  isProviderError: () => false,
  providerErrorStatus: () => undefined,
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
}) ) as Factory),
    ((() => ({
  createMemoryTools: vi.fn(() => ({ remember: {}, forget: {}, list_actions: {}, complete_action: {} })),
}) ) as Factory),
    ((() => ({
  createBobAgent: vi.fn(() => state.createdAgent),
}) ) as Factory),
    ((() => ({
  EMBEDDING_MODEL_ID: 'text-embedding-3-small',
  EMBEDDING_DIM: 1536,
  createEmbedder: () => ({
    modelId: 'text-embedding-3-small',
    dim: 1536,
    embed: async (text: string) => new Array(1536).fill(0.1),
    embedMany: async (texts: string[]) => texts.map(() => new Array(1536).fill(0.1)),
  }),
}) ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

vi.mock('../../src/voice/audio/stt-tts.ts', () => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: () => false,
  transcribePcm: vi.fn(async () => ({ text: 'remember my daughter is Asha', model: 'stt', seconds: 1 })),
  synthesizePcm: vi.fn(async () => ({ pcm: Buffer.alloc(3200), sourceRateHz: 44100 })),
  synthesizeMp3: vi.fn(async () => ({ mp3: Buffer.alloc(1024) })),
  downlinkFrames: vi.fn(() => [Buffer.alloc(340), Buffer.alloc(340)]),
  downlinkMp3Frames: vi.fn(() => []),
}));

vi.mock('../../src/voice/cardputer-conversation.ts', () => ({
  loadCardputerHistory: vi.fn(async () => []),
  persistDeviceTurn: vi.fn(async () => ({
    conversationId: 'cnv_device_1', created: false, title: 't', userMessageId: 'm', changedAt: 1,
  })),
}));

import { webChat } from '../../src/conversations/chat-http.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const worker = { enqueue: vi.fn(), scanUnprocessed: vi.fn(async () => 0), idle: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };

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

function userMessage(id: string, text: string) {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

let pg: TestDb;
let db: Db;
let userId: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  userId = await resolveDevAccount(db);
  setSharedDb(Promise.resolve(db));
});

afterAll(async () => {
  const { closeDb } = await import('../../src/platform/db/db.ts');
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('memory embedder wiring (T014c)', () => {
  it('web-chat passes a callable embedder into the memory callbacks', async () => {
    appDeps.memoryWorker = worker;
    state.deps.length = 0;
    const conversation = await createConversation(db, userId, 'web embed');
    const res = response();
    await webChat(appDeps)(
      { body: { id: conversation.id, message: userMessage('msg-web-1', 'what do I prefer to drink?') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never,
      res as never,
    );
    expect(state.deps).toHaveLength(1);
    const deps = state.deps[0] as { embedder?: unknown; journal?: unknown };
    expect(typeof deps.embedder).toBe('function');
    expect(typeof deps.journal).toBe('function');
  });

  it('device turn.ts passes a callable embedder into the memory callbacks', async () => {
    state.deps.length = 0;
    const session = deviceSession(userId, 'cnv_device_1');
    await runTurn(appDeps.turn, fakeSocket(), session, 'turn_dev', worker);
    expect(state.deps).toHaveLength(1);
    const deps = state.deps[0] as { embedder?: unknown; journal?: unknown };
    expect(typeof deps.embedder).toBe('function');
    expect(typeof deps.journal).toBe('function');
  });
});