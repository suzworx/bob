// #413: the device turn's wiring of the prompt layout. The agent gets the
// conversation id as its cache key and the tools in the cache order (timers,
// productivity; voice and device last). The digested key is never
// journalled. Mirrors turn-space.test.ts's store-backed setup and mocks.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';

vi.mock('../../src/voice/audio/stt-tts.ts', () => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: () => false,
  transcribePcm: vi.fn(async () => ({ text: 'add milk', model: 'stt-1', seconds: 1 })),
  synthesizePcm: vi.fn(async () => ({ pcm: Buffer.alloc(3200), sourceRateHz: 44100 })),
  synthesizeMp3: vi.fn(async () => ({ mp3: Buffer.alloc(1024) })),
  downlinkFrames: vi.fn(() => [Buffer.alloc(340)]),
  downlinkMp3Frames: vi.fn(() => []),
}));
// The REAL createBobAgent runs every paired turn; only its model is swapped
// for a MockLanguageModelV4, so the providerOptions it actually sends are
// recorded (no network).
const sent = vi.hoisted((): { model: unknown } => ({ model: undefined }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  const MockedToolLoopAgent = new Proxy(actual.ToolLoopAgent, {
    construct(target, args, newTarget): object {
      const settings = args[0] as Record<string, unknown>;
      return Reflect.construct(target, [{ ...settings, model: sent.model ?? settings.model }], newTarget) as object;
    },
  });
  return { ...actual, ToolLoopAgent: MockedToolLoopAgent };
});
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  bobAgent: { generate: vi.fn(async () => ({ text: 'done', toolCalls: [] })) },
  BOB_SYSTEM_TEST_MODE: false,
  AI_STUB_MODE: false,
  isProviderError: () => false,
  providerErrorStatus: () => undefined,
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
}) ) as Factory),
    ((async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/ai')>();
  const { bobAgent: mockAgent } = await importOriginal<typeof import('@bob/ai')>();
  return {
    ...actual,
    createBobAgent: vi.fn(actual.createBobAgent),
    bobAgent: mockAgent,
    assistantAgent: mockAgent,
    logAgentConfig: vi.fn(),
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});
vi.mock('../../src/memory/available.ts', () => ({
  memoryAvailable: vi.fn(async () => true),
  resetMemoryAvailability: vi.fn(),
}));
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: '[BOB MEMORY]\n- tea\n[END BOB MEMORY]' }) })),
}));

import { MockLanguageModelV4 } from 'ai/test';
import { createBobAgent } from '@bob/ai';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
let model: MockLanguageModelV4;

/** Every promptCacheKey the real agent sent to the model, in call order. */
function sentCacheKeys(): unknown[] {
  return model.doGenerateCalls.map((call) => (call.providerOptions?.openai as { promptCacheKey?: unknown } | undefined)?.promptCacheKey);
}

let pg: TestDb;
let db: Db;
const journals: string[] = [];

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
});
afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});
beforeEach(() => {
  journals.length = 0;
  setJournalSink((line) => journals.push(line));
  model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'done' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0, text: 1, reasoning: 0 },
        totalTokens: 5,
      },
      warnings: [],
    }),
  });
  sent.model = model;
});
afterEach(() => {
  setJournalSink(null);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/** Runs two device turns; preparation gives both the same durable conversation id. */
async function twoTurns(userId: string): Promise<DeviceSession> {
  const session = createSession() as DeviceSession;
  session.auth = { kind: 'device', userId, deviceId: '11111111-1111-4111-8111-111111111111', name: 'Test Card' };
  const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  for (const ref of ['turn_layout1', 'turn_layout2']) {
    session.stage = 'responding';
    session.turnRef = ref;
    session.audioChunks = [Buffer.alloc(320)];
    await runTurn(appDeps.turn, socket, session, ref);
  }
  return session;
}

describe('device turn prompt layout (#413)', () => {
  it('cache key and tool order; the key is never journalled', async () => {
    const a = await addAccount(pg);
    const session = await twoTurns(a.userId);
    const calls = vi.mocked(createBobAgent).mock.calls.map((call) => call[0]!);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cacheKey).toBe(session.activeConversationId);
    expect(calls[1]!.cacheKey).toBe(session.activeConversationId);
    const capability = Object.keys(calls[1]!.capabilityTools ?? {});
    const late = Object.keys(calls[1]!.lateTools ?? {});
    expect(capability[0]).toBe('set_timer');
    expect(capability).toContain('create_task');
    expect(late).toContain('set_volume');
    expect(capability.some((name) => late.includes(name))).toBe(false);
    const tools = (JSON.parse(journals.find((line) => line.includes('"v2.agent_tools"'))!) as { tools: string }).tools.split(',');
    expect(tools.indexOf('set_timer')).toBeGreaterThan(-1);
    expect(tools.indexOf('set_timer')).toBeLessThan(tools.indexOf('create_task'));
    expect(tools.indexOf('create_task')).toBeLessThan(tools.indexOf('remember'));
    expect(tools.indexOf('remember')).toBeLessThan(tools.indexOf('set_volume'));
    // Preparation gives the provider a stable, private key from the first turn.
    const keys = sentCacheKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    const key = keys[1];
    expect(typeof key).toBe('string');
    expect((key as string).length).toBeGreaterThan(0);
    for (const line of journals) expect(line).not.toContain(key as string);
    expect(journals.join('\n')).not.toMatch(/cache_?key/i);
  });

  it('stored history, 45 messages: the first history message the model sees is m20 then m20', async () => {
    const a = await addAccount(pg);
    const conversation = await createConversation(db, a.userId, 'long voice');
    for (let index = 0; index < 45; index += 1) {
      await appendMessage(db, a.userId, conversation.id, {
        role: index % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `m${index}` }],
      });
    }
    const session = createSession() as DeviceSession;
    session.auth = { kind: 'device', userId: a.userId, deviceId: '11111111-1111-4111-8111-111111111111', name: 'Test Card' };
    session.activeConversationId = conversation.id;
    const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
    for (const ref of ['turn_stored1', 'turn_stored2']) {
      session.stage = 'responding';
      session.turnRef = ref;
      session.audioChunks = [Buffer.alloc(320)];
      await runTurn(appDeps.turn, socket, session, ref);
    }
    expect(session.activeConversationId).toBe(conversation.id);
    const [one, two] = model.doGenerateCalls.map((call) => call.prompt);
    const text = (message: unknown): unknown => (message as { content: Array<{ text?: string }> }).content[0]?.text;
    expect(text(one![1])).toBe('m20');
    expect(text(two![1])).toBe('m20');
    // The previous turn's system prompt and history are the new prompt's byte-identical prefix.
    const prefix = one!.length - 2;
    expect(JSON.stringify(two!.slice(0, prefix))).toBe(JSON.stringify(one!.slice(0, prefix)));
    expect(two!.slice(prefix).map((message) => message.role)).toEqual(['user', 'assistant', 'system', 'user']);
  });

  it('in-memory fallback: 40 kept messages + one turn keeps 22, first m20', async () => {
    const session = createSession() as DeviceSession;
    session.messages = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `m${index}`,
    }));
    session.stage = 'responding';
    session.turnRef = 'turn_fallback';
    session.audioChunks = [Buffer.alloc(320)];
    await runTurn(appDeps.turn, { readyState: 1, send: vi.fn() } as unknown as WebSocket, session, 'turn_fallback');
    expect(session.messages).toHaveLength(22);
    expect(session.messages[0]?.content).toBe('m20');
  });
});
