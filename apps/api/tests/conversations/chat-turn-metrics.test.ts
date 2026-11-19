// ANL-WEB1: each web chat turn records exactly one privacy-safe metrics row.
// The real createBobAgent runs; only its model is a MockLanguageModelV4. No network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { tool } from 'ai';
import { z } from 'zod';
import { createConversation, loadRecentHistory } from '../../src/conversations/store.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import type { TurnMetricRow } from '../../src/platform/observability/turn-metrics.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { createAgentHarness } from '../support/agent-harness.ts';

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
vi.mock('../../src/memory/available.ts', () => ({
  memoryAvailable: vi.fn(async () => true),
  resetMemoryAvailability: vi.fn(),
}));
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: null }) })),
}));
// SIMPLIFY-U2B: with slow.ms set, each prep step the chat waits on takes that long first (on the fake clock in the seam
// test). With slow.state.canned set, a read answers a canned value and never reaches the database.
const slow = vi.hoisted(() => {
  const state = {
    ms: 0, storeExtraMs: 0, storeSettledAt: 0, canned: false, historyGate: null as null | Promise<void>,
  };
  const lag = <A extends unknown[], R>(work: (...args: A) => Promise<R>, canned?: () => R) => async (...args: A): Promise<R> => {
    if (state.ms > 0) await new Promise((resolve) => setTimeout(resolve, state.ms));
    return state.canned && canned ? canned() : work(...args);
  };
  return { state, lag };
});
vi.mock('../../src/conversations/store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/conversations/store.ts')>();
  const append = slow.lag(actual.appendMessage);
  return {
    ...actual,
    appendMessage: async (...args: Parameters<typeof actual.appendMessage>) => {
      // storeExtraMs: a store slower than every other step, so the model is sure to start before it lands.
      if (slow.state.storeExtraMs > 0) await new Promise((resolve) => setTimeout(resolve, slow.state.storeExtraMs));
      const stored = await append(...args);
      slow.state.storeSettledAt = performance.now();
      return stored;
    },
    // historyGate: every history read waits for it (the two-sends test opens it once both messages are stored).
    loadRecentHistory: slow.lag(async (...args: Parameters<typeof actual.loadRecentHistory>) => {
      await slow.state.historyGate;
      return actual.loadRecentHistory(...args);
    }, () => []),
  };
});
vi.mock('../../src/conversations/scope.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/conversations/scope.ts')>();
  const canned = { conversationId: 'cnv_seam', spaceId: 'spc_seam', spaceKind: 'private', spaceName: null, spaceArchived: false, archivedAt: null, title: 'Seam' };
  return { ...actual, getConversationScope: slow.lag(actual.getConversationScope, () => canned as never) };
});
vi.mock('../../src/voice/game-tools.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/voice/game-tools.ts')>();
  return { ...actual, resolveGameScope: vi.fn(slow.lag(actual.resolveGameScope, () => ({ mode: 'none', tools: {}, turn: actual.newGameTurnState() }) as never)) };
});
vi.mock('../../src/spaces/store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/spaces/store.ts')>();
  return { ...actual, ensurePrivateSpace: vi.fn(slow.lag(actual.ensurePrivateSpace, () => ({ id: 'spc_seam' }) as never)) };
});
vi.mock('../../src/tools/policy.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/policy.ts')>();
  return { ...actual, prepareToolPolicyFilter: slow.lag(actual.prepareToolPolicyFilter, () => ((tools: unknown) => tools) as never) };
});

import { webChat, webChatStop } from '../../src/conversations/chat-http.ts';
import { createAppDeps } from '../../src/app-deps.ts';
import { buildTurnAgent, startWebPrep } from '../../src/turn/chat-agent.ts';
import { resolveGameScope } from '../../src/voice/game-tools.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';

const SECRET = 'SECRET TRANSCRIPT TEXT';
const USAGE = {
  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0, text: 1, reasoning: 0 },
  totalTokens: 5,
};
const ROW_KEYS: ReadonlySet<string> = new Set([
  'surface', 'outcome', 'failed_stage', 'failure_kind', 'upstream_status', 'intent', 'model', 'provider', 'fw_version',
  'input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens', 'reasoning_tokens', 'steps', 'tool_calls',
  'called_tools', 'streamed', 'interrupted', 'tts_cache_hit', 'stt_ms', 'prep_ms', 'model_ms', 'first_token_ms', 'tts_ms',
  'first_audio_ms', 'total_ms', 'user_bucket', 'arrival_ms',
]);
// SIMPLIFY-U0B/U2B: the web prep event's own step durations, and its critical-path waits (with build_ms and other_ms
// they sum to prep_ms). A new conversation keeps the serial order, so its store is awaited and timed.
const OWN = ['locate_ms', 'app_preflight_ms', 'store_ms', 'scope_ms', 'history_ms', 'app_tools_ms', 'game_ms', 'capabilities_ms', 'policy_ms'];
// app_preflight_wait_ms: only a request that names an app waits on its preflight.
const WAITS = ['document_wait_ms', 'store_wait_ms', 'history_wait_ms', 'scope_wait_ms', 'app_tools_wait_ms', 'game_wait_ms', 'capabilities_wait_ms', 'policy_wait_ms', 'build_ms'];
const ALWAYS = [...OWN, ...WAITS, 'arrival_ms', 'prep_ms', 'other_ms'];

type Mode = 'complete' | 'error' | 'hang';
let mode: Mode = 'complete';
let pg: TestDb;
let db: Db;
let userId: string;
const rows: TurnMetricRow[] = [];
let recorder: (row: TurnMetricRow) => void = (row) => { rows.push(row); };
const deps = { ...createAppDeps(), recordTurnMetric: (row: TurnMetricRow): void => recorder(row) };
const realAppTurnTools = deps.appTurnTools;

const model = new MockLanguageModelV4({
  doStream: async (options) => ({
    stream: new ReadableStream({
      start(controller): void {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 't' });
        controller.enqueue({ type: 'text-delta', id: 't', delta: SECRET });
        if (mode === 'hang') {
          options.abortSignal?.addEventListener('abort', () => controller.error(options.abortSignal?.reason));
          return;
        }
        if (mode === 'error') {
          controller.enqueue({ type: 'error', error: new Error(SECRET) });
        } else {
          controller.enqueue({ type: 'text-end', id: 't' });
          controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE });
        }
        controller.close();
      },
    }),
  }),
});

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  userId = await resolveDevAccount(db);
  setSharedDb(Promise.resolve(db));
  sent.model = model;
});
afterAll(async () => {
  sent.model = undefined;
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});
beforeEach(() => {
  rows.length = 0;
  mode = 'complete';
  recorder = (row) => { rows.push(row); };
});

function response(onFirstWrite?: (close: () => void) => void): Record<string, unknown> & { statusCode: number; chunks: string[] } {
  let first = true;
  let close = (): void => undefined;
  return {
    statusCode: 200, chunks: [] as string[], writableEnded: false, headersSent: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(): void { this.headersSent = true; },
    write(chunk: Buffer | string) { (this.chunks as string[]).push(String(chunk)); if (first) { first = false; onFirstWrite?.(close); } },
    end() { this.writableEnded = true; },
    json(body: unknown) { (this.chunks as string[]).push(JSON.stringify(body)); return this; },
    on(event: string, handler: () => void): unknown { if (event === 'close') close = handler; return this; },
  };
}
const account = (): { userId: string; sessionId: string; exp: number } => ({ userId, sessionId: '11111111-1111-4111-8111-111111111111', exp: Math.floor(Date.now() / 1000) + 3600 });
const turn = (messageId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ message: { id: `msg-${messageId}`, role: 'user', parts: [{ type: 'text', text: `${SECRET} please` }] }, ...extra });
const run = (body: unknown, onFirstWrite?: (close: () => void) => void, withAccount = true) => {
  const result = response(onFirstWrite);
  return webChat(deps)({ body, on: vi.fn(), ...(withAccount ? { account: account() } : {}) } as never, result as never).then(() => result);
};

describe('a web chat turn records one metrics row (ANL-WEB1)', () => {
  it('a completed typed turn', async () => {
    const result = await run(turn('m-ok'));
    expect(result.chunks.join('')).toContain(SECRET);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: 'web_text', outcome: 'completed', streamed: true, intent: 'chat' });
    expect(rows[0]!.total_ms).toBeGreaterThanOrEqual(0);
    // Measured from the turn start, like the device writer: it includes prep and cannot exceed the total.
    expect(rows[0]!.first_token_ms).toBeGreaterThanOrEqual(rows[0]!.prep_ms!);
    expect(rows[0]!.first_token_ms).toBeLessThanOrEqual(rows[0]!.total_ms!);
    expect(rows[0]!.user_bucket).toBeGreaterThanOrEqual(0);
  });

  it('SIMPLIFY-U0B: arrival_ms covers the whole wait and one web prep event names its steps', async () => {
    const lines: string[] = [];
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setJournalSink((line) => lines.push(line));
    try {
      await run(turn('m-prep'));
    } finally {
      setJournalSink(null);
      quiet.mockRestore();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.arrival_ms).toBeGreaterThanOrEqual(rows[0]!.prep_ms!);
    const preps = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === 'v2.turn_stage_prep_completed' && entry.interface === 'web');
    expect(preps).toHaveLength(1);
    const prep = preps[0]! as Record<string, number | string>;
    expect(prep.turn_id).toBe('msg-m-prep');
    expect(typeof prep.conversation_id).toBe('string');
    for (const key of ALWAYS) expect(Number.isInteger(prep[key]), key).toBe(true);
    expect(prep.app_preflight_wait_ms).toBeUndefined();
    expect(prep.arrival_ms).toBeGreaterThanOrEqual(prep.prep_ms as number);
    expect(prep.prep_source).toBe('inline');
    const waited = Object.keys(prep).filter((key) => key.endsWith('_wait_ms') || key === 'build_ms').reduce((total, key) => total + Number(prep[key]), 0);
    expect(Math.abs(waited + Number(prep.other_ms) - Number(prep.prep_ms))).toBeLessThanOrEqual(2);
    expect(JSON.stringify(preps)).not.toContain(SECRET);
  });

  it('#898: first_token_ms measures the first reply text, not a tool step or the stream start', async () => {
    const DELAY_MS = 80;
    const harness = createAgentHarness([
      [{ type: 'tool', name: 'currentDateTime' }],
      [{ type: 'delay', ms: DELAY_MS }, { type: 'text', text: 'All set.' }],
    ]);
    sent.model = harness.model;
    try {
      const result = await run(turn('m-tool-delay'));
      expect(result.chunks.join('')).toContain('All set.');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.first_token_ms).not.toBeNull();
      expect(rows[0]!.first_token_ms!).toBeGreaterThanOrEqual(DELAY_MS);
    } finally {
      sent.model = model;
    }
  });

  it('origin web_voice gives surface web_voice', async () => {
    await run(turn('m-voice', { origin: 'web_voice' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: 'web_voice', outcome: 'completed' });
  });

  it('a provider error is a failed agent stage', async () => {
    mode = 'error';
    await run(turn('m-fail'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: 'web_text', outcome: 'failed', failed_stage: 'agent' });
  });

  it('a user Stop mid-stream is cancelled and interrupted', async () => {
    mode = 'hang';
    await run(turn('m-stop'), () => webChatStop({ body: { messageId: 'msg-m-stop' }, account: account() } as never, { status: () => ({ json: vi.fn() }) } as never));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'cancelled', interrupted: true });
  });

  it('a reader leaving mid-reply while the turn completes is completed and interrupted', async () => {
    await run(turn('m-gone'), (close) => close());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'completed', interrupted: true });
  });

  it('a reader leaving before a provider error is still a failure, not interrupted', async () => {
    mode = 'error';
    await run(turn('m-gone-fail'), (close) => close());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'failed', failed_stage: 'agent' });
    expect(rows[0]!.interrupted).toBe(false);
  });

  it('a 401 or an invalid request records no row', async () => {
    expect((await run(turn('m-401'), undefined, false)).statusCode).toBe(401);
    expect((await run({ nonsense: true })).statusCode).toBe(400);
    expect(rows).toHaveLength(0);
  });

  it('a recorder that throws leaves the streamed response unchanged', async () => {
    const ok = await run(turn('m-baseline'));
    recorder = () => { throw new Error('recorder down'); };
    const result = await run(turn('m-throw'));
    expect(result.statusCode).toBe(ok.statusCode);
    expect(result.chunks.join('')).toContain(SECRET);
  });

  describe('SIMPLIFY-U2B: a plain new message preps in parallel', () => {
    const STEP_MS = 200;
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    afterEach(() => {
      vi.useRealTimers();
      Object.assign(slow.state, { ms: 0, storeExtraMs: 0, canned: false, historyGate: null });
      deps.googleTools = undefined;
      deps.appTurnTools = realAppTurnTools;
      sent.model = model;
      vi.mocked(resolveGameScope).mockClear();
      vi.mocked(ensurePrivateSpace).mockClear();
    });

    // Google starts only once the scope reads live private, so scope then Google (2 steps) is the critical path (the
    // serial order was 7 steps, about 1.4 s). The reads are canned (no database) and the clock is fake.
    it('the agent is built 400 ms in when store, scope, history, game, capabilities, policy and Google each take 200 ms', async () => {
      vi.useFakeTimers();
      slow.state.ms = STEP_MS;
      slow.state.canned = true;
      const t0 = Date.now();
      const stored = new Promise<string | null>((resolve) => { setTimeout(() => resolve('msg-seam'), STEP_MS); });
      const googleTools = vi.fn(async () => { await sleep(STEP_MS); return {}; });
      const seam = { deps: { ...deps, googleTools }, db: {} as Db, userId, conversationId: 'cnv_seam', timeZone: 'UTC' };
      const prep = startWebPrep({
        ...seam, regenerate: undefined, signal: new AbortController().signal, timings: {}, app: Promise.resolve(null), stored,
        pending: { id: 'msg-seam', parts: [{ type: 'text', text: 'hi' }], origin: 'web_text' },
      }, 'hi');
      // What answerTurn waits on before the model starts: history, scope, memory, retrieval, app tools, then the build.
      const ready = (async () => {
        const [scope, retrieval, appTools] = await Promise.all([prep.scope, prep.retrieval, prep.appTools, prep.history, prep.memoryOn]);
        await buildTurnAgent({
          ...seam, turnId: 't-seam', surface: 'web_text', agentSignal: new AbortController().signal,
          reads: prep.reads, waits: {}, toolGate: stored, scope, retrieval, block: null, userMessageAnchor: await prep.anchor,
          onGameTurn: () => undefined, appTools: appTools.tools,
        });
        return Date.now() - t0;
      })();
      await vi.advanceTimersByTimeAsync(10 * STEP_MS);
      const builtAt = await ready;
      expect(googleTools).toHaveBeenCalledTimes(1);
      expect(builtAt).toBeGreaterThanOrEqual(2 * STEP_MS);
      expect(builtAt).toBeLessThan(500);
    });

    it('a tool the model calls before the store settles runs once, after it, on the stored message id', async () => {
      const conversation = await createConversation(db, userId, 'Gated tool');
      const ran: Array<{ at: number; messageId: string }> = [];
      deps.googleTools = async (context) => ({
        google_list_accounts: tool({ description: 'Accounts', inputSchema: z.object({}), execute: async () => {
          const anchor = 'anchor' in context ? await context.anchor() : context;
          ran.push({ at: performance.now(), messageId: anchor.messageId });
          return { ok: true };
        } }),
      });
      const harness = createAgentHarness([[{ type: 'tool', name: 'google_list_accounts' }], [{ type: 'text', text: 'Done.' }]]);
      sent.model = harness.model;
      slow.state.ms = STEP_MS;
      slow.state.storeExtraMs = 2 * STEP_MS;
      const result = await run(turn('m-gate', { id: conversation.id }));
      slow.state.ms = 0;
      slow.state.storeExtraMs = 0;
      expect(result.chunks.join('')).toContain('Done.');
      const modelStart = harness.timeline.find((mark) => mark.step === 0 && mark.event === 'start')!.at;
      expect(modelStart).toBeLessThan(slow.state.storeSettledAt);
      expect(ran).toHaveLength(1);
      expect(ran[0]!.messageId).toBe('msg-m-gate');
      expect(ran[0]!.at).toBeGreaterThanOrEqual(slow.state.storeSettledAt);
    });

    // A plain message's memory reads on the scope alone; only a named app (it alone can be generic) holds it.
    it.each([[false, 'resolves'], [true, 'waits']] as const)('explicitApp %s: memory %s while the preflight is still running', async (explicitApp, outcome) => {
      vi.useFakeTimers();
      const never = new Promise<null>(() => undefined);
      const prep = startWebPrep({
        deps, db: {} as Db, userId, conversationId: 'cnv_pre', timeZone: 'UTC', regenerate: undefined, signal: new AbortController().signal,
        timings: {}, app: never, stored: Promise.resolve('msg-pre'), explicitApp,
      }, 'hi');
      const settled = Promise.race([prep.memoryOn.then(() => 'resolves'), sleep(300).then(() => 'waits')]);
      await vi.advanceTimersByTimeAsync(300);
      expect(await settled).toBe(outcome);
    });

    it('a slow preflight on a plain message does not hold the store', async () => {
      const conversation = await createConversation(db, userId, 'Slow preflight');
      const real = realAppTurnTools!;
      let preflightDone = 0;
      slow.state.storeSettledAt = 0;
      deps.appTurnTools = { ...real, preflight: async (...args) => {
        await sleep(400);
        preflightDone = performance.now();
        return real.preflight(...args);
      } };
      const result = await run(turn('m-slow-pre', { id: conversation.id }));
      expect(result.chunks.join('')).toContain(SECRET);
      expect(slow.state.storeSettledAt).toBeGreaterThan(0);
      expect(slow.state.storeSettledAt).toBeLessThan(preflightDone);
    });

    it('a Stop during a slow preflight of a named app answers 409 cancelled and stores nothing', async () => {
      const conversation = await createConversation(db, userId, 'Stopped in prep');
      deps.appTurnTools = { ...realAppTurnTools!, preflight: async () => {
        await webChatStop({ body: { messageId: 'msg-m-stop-prep' }, account: account() } as never, { status: () => ({ json: vi.fn() }) } as never);
        return { binding: BINDING as never, generic: true };
      }, tools: async () => ({ tools: {}, contextToolNames: [] }) };
      const result = await run(turn('m-stop-prep', { id: conversation.id, appBinding: BINDING }));
      expect(result.statusCode).toBe(409);
      expect(result.chunks.join('')).toContain('"cancelled"');
      expect(await loadRecentHistory(db, userId, conversation.id, 10)).toEqual([]);
      expect(rows).toHaveLength(0);
    });

    const BINDING = { installationId: '00000000-0000-4000-8000-0000000000b1', mode: 'refine' };
    const notStarted = (googleTools: ReturnType<typeof vi.fn>): void => {
      expect(resolveGameScope).not.toHaveBeenCalled();
      expect(ensurePrivateSpace).not.toHaveBeenCalled();
      expect(googleTools).not.toHaveBeenCalled();
    };

    it('a generic bound-app turn reads only the policy: no game read, capability groups or Google tools', async () => {
      const conversation = await createConversation(db, userId, 'Bound app');
      const googleTools = vi.fn(async () => ({}));
      deps.googleTools = googleTools;
      deps.appTurnTools = { ...realAppTurnTools!, preflight: async () => ({ binding: BINDING as never, generic: true }), tools: async () => ({ tools: {}, contextToolNames: [] }) };
      vi.mocked(resolveGameScope).mockClear();
      vi.mocked(ensurePrivateSpace).mockClear();
      const result = await run(turn('m-bound', { id: conversation.id, appBinding: BINDING }));
      expect(result.chunks.join('')).toContain(SECRET);
      notStarted(googleTools);
    });

    it.each([404, 409] as const)('a refused binding (%s) starts none of them and stores nothing', async (status) => {
      const conversation = await createConversation(db, userId, `Refused ${status}`);
      const googleTools = vi.fn(async () => ({}));
      deps.googleTools = googleTools;
      deps.appTurnTools = {
        ...realAppTurnTools!, preflight: async () => { throw new Error('refused'); },
        refusal: () => ({ status, body: { error: { code: 'app_unavailable', message: 'No.' } } }),
      };
      vi.mocked(resolveGameScope).mockClear();
      vi.mocked(ensurePrivateSpace).mockClear();
      const result = await run(turn(`m-refused-${status}`, { id: conversation.id, appBinding: BINDING }));
      expect(result.statusCode).toBe(status);
      notStarted(googleTools);
      expect(await loadRecentHistory(db, userId, conversation.id, 10)).toEqual([]);
    });

    it('two quick sends to one conversation: each model sees the history in the saved order', async () => {
      const conversation = await createConversation(db, userId, 'Two sends');
      const prompts: string[][] = [];
      sent.model = new MockLanguageModelV4({ doStream: async (options) => {
        prompts.push(options.prompt.filter((entry) => entry.role === 'user')
          .map((entry) => (entry.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('')));
        return model.doStream(options);
      } });
      // Both history reads wait until both messages are committed (message.appended is published after the commit), so
      // each read holds both, whichever landed first.
      let open = (): void => undefined;
      slow.state.historyGate = new Promise<void>((resolve) => { open = resolve; });
      let appended = 0;
      const stop = getAccountEvents().subscribe(userId, (event) => { if (event.type === 'message.appended' && ++appended === 2) open(); });
      const send = (name: string) => run({ id: conversation.id, message: { id: `msg-two-${name}`, role: 'user', parts: [{ type: 'text', text: `send ${name}` }] } });
      try {
        await Promise.all([send('a'), send('b')]);
      } finally { stop(); }
      const saved = (await loadRecentHistory(db, userId, conversation.id, 10))!
        .filter((row) => row.role === 'user').map((row) => String((row.parts[0] as { text?: string }).text));
      expect(saved).toHaveLength(2);
      expect(prompts).toEqual([saved, saved]);
    });
  });

  it('privacy: no text and no unknown key reaches a row', async () => {
    await run(turn('m-priv-1'));
    mode = 'error';
    await run(turn('m-priv-2', { origin: 'web_voice' }));
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    for (const row of rows) for (const key of Object.keys(row)) expect(ROW_KEYS.has(key)).toBe(true);
  });
});
