// #413: a web turn through the REAL createBobAgent, with only the
// model swapped for a MockLanguageModelV4. The promptCacheKey the provider
// actually receives is recorded and must appear in no journal line, and the
// captured prompt keeps the cache order. No network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

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
// Memory on, so the memory tools join the tool list; retrieval is stubbed, so
// no query embed (the real Gateway) is attempted.
vi.mock('../../src/memory/available.ts', () => ({
  memoryAvailable: vi.fn(async () => true),
  resetMemoryAvailability: vi.fn(),
}));
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: null }) })),
}));

import { webChat } from '../../src/conversations/chat-http.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const USAGE = {
  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0, text: 1, reasoning: 0 },
  totalTokens: 5,
};

let pg: TestDb;
let db: Db;
let userId: string;
let model: MockLanguageModelV4;
const journals: string[] = [];

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
  journals.length = 0;
  setJournalSink((line) => journals.push(line));
  model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller): void {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 't' });
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'done' });
          controller.enqueue({ type: 'text-end', id: 't' });
          controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE });
          controller.close();
        },
      }),
    }),
  });
  sent.model = model;
});
afterEach(() => {
  setJournalSink(null);
  vi.unstubAllEnvs();
  sent.model = undefined;
});

/** Minimal Express response: records chunks, ends once. */
function response(): Record<string, unknown> & { statusCode: number; chunks: string[] } {
  const listeners: Record<string, () => void> = {};
  return {
    statusCode: 200,
    chunks: [] as string[],
    writableEnded: false,
    headersSent: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader: (): void => undefined,
    write(chunk: Buffer | string) { (this.chunks as string[]).push(String(chunk)); },
    end() { this.writableEnded = true; listeners.close?.(); },
    json(body: unknown) { (this.chunks as string[]).push(JSON.stringify(body)); },
    on(event: string, handler: () => void) { listeners[event] = handler; return this; },
  };
}

describe('web turn prompt layout through the real agent (#413)', () => {
  it('the promptCacheKey actually sent is in no journal line', async () => {
    const result = response();
    await webChat(appDeps)({
      body: { message: { id: 'u-413-real', role: 'user', parts: [{ type: 'text', text: 'hello there' }] } },
      on: vi.fn(),
      account: { userId, sessionId: '11111111-1111-4111-8111-111111111111', exp: Math.floor(Date.now() / 1000) + 3600 },
    } as never, result as never);
    expect(result.statusCode).toBe(200);
    expect(model.doStreamCalls).toHaveLength(1);
    const call = model.doStreamCalls[0]!;
    const key = (call.providerOptions?.openai as { promptCacheKey?: unknown } | undefined)?.promptCacheKey;
    expect(typeof key).toBe('string');
    expect((key as string).length).toBeGreaterThan(0);
    expect(journals.some((line) => line.includes('"v2.turn_stage_agent_completed"'))).toBe(true);
    for (const line of journals) expect(line).not.toContain(key as string);
    expect(call.prompt.map((message) => message.role)).toEqual(['system', 'system', 'user']);
    // Tool order as sent: timers, productivity, memory, then the voice tools.
    const names = toolNames(call);
    expect(names.indexOf('set_timer')).toBeGreaterThan(-1);
    expect(names.indexOf('set_timer')).toBeLessThan(names.indexOf('create_task'));
    expect(names.indexOf('create_task')).toBeLessThan(names.indexOf('remember'));
    expect(names.indexOf('remember')).toBeLessThan(names.indexOf('create_note'));
    expect(names.indexOf('forget')).toBeLessThan(names.indexOf('create_reminder'));
  });
});

/** The tool names the model received, in order. */
function toolNames(call: MockLanguageModelV4['doStreamCalls'][number]): string[] {
  return (call.tools ?? []).map((entry) => entry.name);
}
