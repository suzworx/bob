import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// #466: the fake agent calls its tool only after the response delivers its first byte.
const state = vi.hoisted(() => ({ tool: vi.fn(), releaseFirstWrite: (): void => undefined, signal: undefined as AbortSignal | undefined, failMidStream: false, traceActive: false, preparationActive: false, traceFinished: 0, journalScope: [] as Array<{ event: string; active: boolean }> }));

vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock(vi.fn((event: string) => { state.journalScope.push({ event, active: state.traceActive }); })));
// Memory is on in real Postgres, so the per-turn factory must be mocked too.
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const { createHash } = await import('node:crypto');
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const traceScope = new AsyncLocalStorage<boolean>();
  // A child retrieval span ending must not clear its enclosing chat scope.
  // Async-local state also models overlapping siblings without a global flag.
  Object.defineProperty(state, 'traceActive', { get: () => traceScope.getStore() === true });
  const factories: Factory[] = [
    ((() => {
  const agent = {
    version: 'agent-v1' as const,
    id: 'test-agent',
    tools: {},
    stream: vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      state.signal = abortSignal;
      const firstWrite = new Promise<void>((resolve) => { state.releaseFirstWrite = resolve; });
      let sent = false;
      return {
        // Eager prefetch exercises the race: pulling ahead must not outrun Stop.
        stream: new ReadableStream({
          async pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue({ type: 'start', messageId: 'assistant-1' });
              controller.enqueue({ type: 'text-start', id: 't1', text: '' });
              controller.enqueue({ type: 'text-delta', id: 't1', text: 'Setting it. ' });
              return;
            }
            await firstWrite;
            if (abortSignal?.aborted) { controller.error(abortSignal.reason); return; }
            // streamText reports a provider failure as an `error` part, not a throw.
            if (state.failMidStream) { controller.enqueue({ type: 'error', error: new Error('provider dropped') }); controller.close(); return; }
            expect(state.traceActive).toBe(true);
            state.tool();
            controller.enqueue({ type: 'text-delta', id: 't1', text: 'Timer set for 10 minutes.' });
            controller.enqueue({ type: 'text-end', id: 't1' });
            controller.enqueue({ type: 'finish', finishReason: 'stop' });
            controller.close();
          },
        }, { highWaterMark: 8 }),
      };
    }),
  };
  return {
    audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
    bobAgent: agent,
    AI_STUB_MODE: false,
    isProviderError: () => false,
    providerErrorStatus: () => undefined,
  };
} ) as Factory),
    ((async (importOriginal) => {
  const { bobAgent: mockAgent } = await importOriginal<typeof import('@bob/ai')>();
  return {
    createBobAgent: vi.fn(() => { state.preparationActive = state.traceActive; return mockAgent; }),
    bobAgent: mockAgent,
    assistantAgent: mockAgent,
    chatModel: {},
    gateway: Object.assign(vi.fn(() => ({})), { embeddingModel: vi.fn(() => ({})) }),
    logAgentConfig: vi.fn(),
  };
} ) as Factory),
  ];
  let current: object = { ...original, workflowTraceId: async (attrs: Parameters<typeof original.workflowTraceId>[0]): Promise<string> => createHash('sha256').update(JSON.stringify([attrs.workflowNamespace, attrs.workflowId ?? attrs.turnId])).digest('hex').slice(0, 32), traceSpan: vi.fn(async (_name: string, _attrs: unknown, run: () => Promise<unknown>) => {
    return traceScope.run(true, async () => {
      try { return await run(); } finally { state.traceFinished += 1; }
    });
  }) };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

import { traceSpan } from '@bob/ai';
import { webChat, webChatStop } from '../../src/conversations/chat-http.ts';
import { journal } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createConversation, getConversation } from '../../src/conversations/store.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
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
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

// A response whose client leaves (or presses Stop) right after the first byte.
function response(onFirstWrite: (close: () => void) => void) {
  let close = (): void => undefined;
  let first = true;
  return {
    statusCode: 200, headersSent: false, writableEnded: false, writes: 0, chunks: [] as string[],
    status(code: number) { this.statusCode = code; return this; },
    setHeader() { this.headersSent = true; },
    write(chunk: unknown) { this.chunks.push(String(chunk)); this.writes += 1; if (first) { first = false; onFirstWrite(close); state.releaseFirstWrite(); } },
    end() { this.writableEnded = true; },
    json() { return this; },
    on(event: string, handler: () => void) { if (event === 'close') close = handler; return this; },
  };
}

const account = () => ({ userId, sessionId: '11111111-1111-4111-8111-111111111111', exp: Math.floor(Date.now() / 1000) + 3600 });
const ask = (id: string, messageId: string) => ({ id, message: { id: messageId, role: 'user', parts: [{ type: 'text', text: 'Set a timer for 10 minutes' }] } });
const events = (name: string) => vi.mocked(journal).mock.calls.filter(([event]) => event === name).map(([, fields]) => fields as Record<string, unknown>);

describe('#466: a web turn survives the client leaving', () => {
  it('runs the tool, persists the reply and journals client_gone when the tab closes mid-stream', async () => {
    state.tool.mockClear(); vi.mocked(journal).mockClear();
    const conversation = await createConversation(db, userId, 'timer');
    const result = response((close) => close());
    await webChat(appDeps)({ body: ask(conversation.id, 'msg-detach-1'), account: account() } as never, result as never);
    expect(state.tool).toHaveBeenCalledTimes(1);
    expect(state.preparationActive).toBe(true);
    expect(state.traceFinished).toBeGreaterThan(0);
    expect(state.traceActive).toBe(false);
    expect(state.signal?.aborted).toBe(false);
    expect(result.writes).toBe(1);
    expect(result.chunks.join('')).toMatch(/"traceId":"[a-f0-9]{32}"/);
    const detail = (await getConversation(db, userId, conversation.id))!;
    expect(JSON.stringify(detail.messages.at(-1))).toContain('Timer set for 10 minutes.');
    expect(events('v2.turn_stage_agent_completed').at(-1)).toMatchObject({ client_gone: true });
    expect(state.journalScope.filter(({ event }) => event === 'v2.messages_persisted').at(-1)?.active).toBe(true);
  });

  it('regeneration keeps the message correlation but starts a new workflow attempt', async () => {
    vi.mocked(traceSpan).mockClear();
    const conversation = await createConversation(db, userId, 'regenerate');
    const body = ask(conversation.id, 'msg-regenerate-1');
    await webChat(appDeps)({ body, account: account() } as never, response(() => undefined) as never);
    await webChat(appDeps)({ body: { ...body, regenerate: true }, account: account() } as never, response(() => undefined) as never);
    const roots = vi.mocked(traceSpan).mock.calls.filter(([name]) => name === 'web-chat-turn');
    expect(roots).toHaveLength(2);
    const first = roots[0]?.[1];
    const second = roots[1]?.[1];
    expect(first?.turnId).toBe('msg-regenerate-1');
    expect(second?.turnId).toBe(first?.turnId);
    expect(first).toHaveProperty('workflowNamespace', expect.any(String));
    expect(second).toHaveProperty('workflowNamespace', expect.any(String));
    expect(first?.workflowId).toEqual(expect.any(String));
    expect(second?.workflowId).toEqual(expect.any(String));
    expect(second?.workflowId).not.toBe(first?.workflowId);
    expect(first?.metadata?.turn_id).toBe('msg-regenerate-1');
    expect(second?.metadata?.turn_id).toBe('msg-regenerate-1');
  });

  it('an explicit Stop still cancels the turn before the tool runs', async () => {
    state.tool.mockClear(); vi.mocked(journal).mockClear();
    const conversation = await createConversation(db, userId, 'stop');
    const stopped = { status: vi.fn(() => stopped), json: vi.fn() };
    const result = response(() => webChatStop({ body: { messageId: 'msg-stop-1' }, account: account() } as never, stopped as never));
    await webChat(appDeps)({ body: ask(conversation.id, 'msg-stop-1'), account: account() } as never, result as never);
    expect(stopped.json).toHaveBeenCalledWith({ stopped: true });
    expect(state.tool).not.toHaveBeenCalled();
    const ended = [...events('v2.turn_stage_agent_completed'), ...events('v2.turn_stage_agent_failed')];
    expect(ended.at(-1)).toMatchObject({ stopped: true });
    expect(state.journalScope.filter(({ event }) => event.startsWith('v2.turn_stage_agent_')).at(-1)?.active).toBe(true);
    expect(state.traceActive).toBe(false);
  });

  it('a provider error mid-stream journals agent_failed with reason stream_error', async () => {
    state.failMidStream = true; vi.mocked(journal).mockClear();
    const conversation = await createConversation(db, userId, 'diet');
    await webChat(appDeps)({ body: ask(conversation.id, 'msg-stream-err-1'), account: account() } as never, response(() => undefined) as never);
    state.failMidStream = false;
    expect(events('v2.turn_stage_agent_failed').at(-1)).toMatchObject({ reason: 'stream_error' });
    expect(events('v2.turn_stage_agent_completed')).toHaveLength(0);
    expect(state.journalScope.filter(({ event }) => event === 'v2.turn_stage_agent_failed').at(-1)?.active).toBe(true);
    expect(state.traceActive).toBe(false);
  });
});
