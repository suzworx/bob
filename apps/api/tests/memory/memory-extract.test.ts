// Default-suite tests for the memory-extraction worker (010, T010 apps/api
// half). No DB and no network: the store functions, extractor, embedder, and
// memoryAvailable are fakes, and vitest fake timers drive the per-account
// debounce and the retry backoff deterministically. The DB-backed behaviour
// lives in memory-extract.db.test.ts under `npm run test:db`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import { createMigratedDb } from '../support/pg-template.ts';
import { asDb, closeTestDb, type TestDb } from '../support/test-db.ts';
import {
  createMemoryExtractionWorker,
  RUN_BATCH_LIMIT,
  STARTUP_SCAN_WINDOW_MS,
} from '../../src/memory/extract.ts';
import { PREFILTER_VERSION } from '../../src/memory/prefilter.ts';
import {
  createMemoryCallbacks,
} from '../../src/memory/callbacks.ts';
import type {
  ApplyExtractionOptions,
  ExtractionOp,
  MemoryEmbedding,
  MemorySurface,
} from '../../src/memory/store.ts';
import type { UnextractedTurn } from '../../src/memory/extract-queue.ts';
import { listAccountsWithUnextracted } from '../../src/memory/extract-queue.ts';
import { traceSpan, type ExtractInput, type ExtractResult } from '@bob/ai';

vi.mock('@bob/ai', async (orig) => ({
  ...(await orig<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, run) => run()),
}));

const memoriesStore = vi.hoisted(() => ({
  findBestMatch: vi.fn(),
  applyExtractionOps: vi.fn(),
}));
const actionItemsStore = vi.hoisted(() => ({
  listActionItems: vi.fn(),
  setActionItemStatus: vi.fn(),
  completeBestMatch: vi.fn(),
}));
vi.mock('../../src/memory/store.ts', () => memoriesStore);
vi.mock('../../src/tasks/action-items-store.ts', () => actionItemsStore);

const EMBEDDING_DIM = 4;

type JournalCall = [string, Record<string, unknown>];

/** A fake embedder with injectable throw points. */
function fakeEmbedder(embedThrow = false, embedManyThrow = false) {
  return {
    modelId: 'text-embedding-3-small',
    dim: EMBEDDING_DIM,
    embed: vi.fn(async () => new Array(EMBEDDING_DIM).fill(0.1)),
    embedMany: vi.fn(async (texts: string[]) => texts.map(() => new Array(EMBEDDING_DIM).fill(0.2))),
    _embedThrow: embedThrow,
    _embedManyThrow: embedManyThrow,
  };
}

type WorkerDeps = Parameters<typeof createMemoryExtractionWorker>[0];

/** Assembles a full deps object with defaults, all fakes settable after. */
function makeDeps(overrides: Partial<WorkerDeps> = {}) {
  const listUnextracted = vi.fn<WorkerDeps['listUnextracted']>(async () => []);
  const listAccounts = vi.fn<WorkerDeps['listAccounts']>(async () => []);
  const matchMemories = vi.fn<WorkerDeps['matchMemories']>(async () => []);
  const applyExtractionOps = vi.fn<WorkerDeps['applyExtractionOps']>(async () => undefined);
  const memoryAvailable = vi.fn<WorkerDeps['memoryAvailable']>(async () => true);
  const journal = vi.fn<(event: string, fields?: Record<string, unknown>) => void>();
  const extractor = vi.fn<WorkerDeps['extractor']>(async () => ({
    ops: [{ op: 'noop', id: 'mem_one' }],
    dropped: { secret: 0, sensitive: 0 },
  }));

  const deps = {
    db: {} as never,
    extractor,
    embedder: fakeEmbedder(),
    listUnextracted,
    listAccounts,
    matchMemories,
    applyExtractionOps,
    memoryAvailable,
    journal,
    clock: () => 1_700_000_000_000,
    debounceMs: 2000,
    maxAttempts: 3,
  };
  return { deps, listUnextracted, listAccounts, matchMemories, applyExtractionOps, memoryAvailable, journal, extractor, embedder: deps.embedder };
}

/** A persisted user turn as listUnextracted would return it. */
function turn(overrides: Partial<UnextractedTurn> = {}): UnextractedTurn {
  return {
    messageId: 'msg_one',
    conversationId: 'cnv_one',
    surface: 'web_text' as MemorySurface,
    userText: 'I like dark roast coffee.',
    assistantText: 'Got it.',
    ...overrides,
  };
}

/** Advances fake timers enough for the debounce and any backoff to fire. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(50_000);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('memory extraction worker (default suite)', () => {
  it('debounce coalesces 3 enqueues into 1 run', async () => {
    const { deps, listUnextracted, applyExtractionOps } = makeDeps();
    listUnextracted.mockResolvedValue([turn()]);
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    worker.enqueue('user-a');
    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    expect(listUnextracted).toHaveBeenCalledTimes(1);
    expect(applyExtractionOps).toHaveBeenCalledTimes(1);
    expect(traceSpan).toHaveBeenCalledWith('memory-extract', expect.objectContaining({
      turnId: 'msg_one', conversationId: 'cnv_one', userId: 'user-a',
    }), expect.any(Function));
    expect(JSON.stringify(vi.mocked(traceSpan).mock.calls.map((call) => call[1]))).not.toContain('dark roast');
  });

  it('ops are applied with markMessageId set to the turn message', async () => {
    const { deps, listUnextracted, applyExtractionOps, extractor } = makeDeps();
    listUnextracted.mockResolvedValue([
      turn({ messageId: 'msg_abc', conversationId: 'cnv_abc', surface: 'device' }),
    ]);
    extractor.mockResolvedValue({
      ops: [
        { op: 'add', kind: 'fact', content: 'Likes dark roast.', confidence: 0.9 },
        { op: 'noop', id: 'mem_existing' },
      ],
      dropped: { secret: 0, sensitive: 0 },
    });
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    expect(applyExtractionOps).toHaveBeenCalledTimes(1);
    const call = applyExtractionOps.mock.calls[0]!;
    expect(call[1]).toBe('user-a');
    const options = call[3] as ApplyExtractionOptions;
    expect(options.markMessageId).toBe('msg_abc');
    expect(options.source).toEqual({
      conversationId: 'cnv_abc',
      messageId: 'msg_abc',
      surface: 'device',
    });
    const ops = call[2] as ExtractionOp[];
    expect(ops[0]).toMatchObject({ op: 'add', kind: 'fact', content: 'Likes dark roast.', confidence: 0.9 });
    expect((ops[0] as { embedding: { model: string; dim: number } }).embedding).toEqual({
      values: new Array(EMBEDDING_DIM).fill(0.2),
      model: 'text-embedding-3-small',
      dim: EMBEDDING_DIM,
    });
  });

  it('a retry happens and then the skip is journaled', async () => {
    const { deps, listUnextracted, applyExtractionOps, extractor, journal } = makeDeps();
    listUnextracted.mockResolvedValue([turn()]);
    // Always throws: each attempt fails, the last one journals the skip.
    extractor.mockRejectedValue(new Error('model down'));
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    expect(extractor).toHaveBeenCalledTimes(3); // maxAttempts
    expect(applyExtractionOps).toHaveBeenCalledTimes(0);
    const skip = journal.mock.calls.find((call) => call[0] === 'v2.memory_skipped');
    expect(skip).toBeDefined();
    expect(skip![1]?.reason).toBe('extract_failed');
  });

  it('after retries are exhausted the skip event carries the error class name, status, and attempt count', async () => {
    const { deps, listUnextracted, extractor, journal } = makeDeps();
    listUnextracted.mockResolvedValue([turn()]);
    const boom = new Error('model down') as Error & { statusCode: number };
    boom.name = 'AI_APICallError';
    boom.statusCode = 400;
    extractor.mockRejectedValue(boom);
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    const skip = journal.mock.calls.find((call) => call[0] === 'v2.memory_skipped');
    expect(skip).toBeDefined();
    expect(skip![1]).toMatchObject({
      reason: 'extract_failed',
      error_name: 'AI_APICallError',
      error_status: 400,
      attempts: 3,
    });
  });

  it('the skip event never carries the error message, user text, or memory content', async () => {
    const { deps, listUnextracted, extractor, journal } = makeDeps();
    const secretText = 'the user likes very specific dark roast beans';
    listUnextracted.mockResolvedValue([turn({ userText: secretText, assistantText: secretText })]);
    // A failure whose message quotes the user text must not leak it to the journal.
    extractor.mockRejectedValue(new Error(`Invalid schema for response_format: ${secretText}`));
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    const skip = journal.mock.calls.find((call) => call[0] === 'v2.memory_skipped');
    expect(skip).toBeDefined();
    for (const call of journal.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain(secretText);
      expect(JSON.stringify(call[1])).not.toContain('dark roast');
      expect(JSON.stringify(call[1])).not.toContain('Invalid schema');
    }
  });

  it('memoryAvailable false makes enqueue a no-op', async () => {
    const { deps, listUnextracted, applyExtractionOps, memoryAvailable } = makeDeps();
    listUnextracted.mockResolvedValue([turn()]);
    memoryAvailable.mockResolvedValue(false);
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    expect(listUnextracted).toHaveBeenCalledTimes(0);
    expect(applyExtractionOps).toHaveBeenCalledTimes(0);
  });

  it('the dropped secret and sensitive counts reach the journal', async () => {
    const { deps, listUnextracted, extractor, journal } = makeDeps();
    listUnextracted.mockResolvedValue([turn()]);
    extractor.mockResolvedValue({
      ops: [{ op: 'add', kind: 'fact', content: 'kept', confidence: 0.9 }],
      dropped: { secret: 2, sensitive: 1 },
    });
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    const extracted = journal.mock.calls.find((call) => call[0] === 'v2.memory_extracted');
    expect(extracted).toBeDefined();
    expect(extracted![1]).toMatchObject({ dropped_secret: 2, dropped_sensitive: 1 });
  });

  it('#396: journals extract_model, tokens and extract_ms apart from embed_model', async () => {
    const { deps, listUnextracted, extractor, journal } = makeDeps();
    listUnextracted.mockResolvedValue([turn()]);
    extractor.mockResolvedValue({
      ops: [{ op: 'add', kind: 'fact', content: 'kept', confidence: 0.9 }],
      dropped: { secret: 0, sensitive: 0 },
      usage: { inputTokens: 812, outputTokens: 41 },
      modelId: 'openai/gpt-4o-mini',
    });
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    const fields = journal.mock.calls.find((call) => call[0] === 'v2.memory_extracted')![1] as Record<string, unknown>;
    expect(fields).toMatchObject({
      embed_model: deps.embedder.modelId,
      extract_model: 'openai/gpt-4o-mini',
      extract_input_tokens: 812,
      extract_output_tokens: 41,
      extract_ms: expect.any(Number),
    });
    expect(fields.extract_model).not.toBe(fields.embed_model);
    expect(fields).not.toHaveProperty('model');
  });

  it('#396: a model id that is not an id is never journaled', async () => {
    const { deps, listUnextracted, extractor, journal } = makeDeps();
    listUnextracted.mockResolvedValue([turn()]);
    extractor.mockResolvedValue({ ops: [], dropped: { secret: 0, sensitive: 0 }, modelId: 'free text from the user' });
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    const fields = journal.mock.calls.find((call) => call[0] === 'v2.memory_extracted')![1] as Record<string, unknown>;
    expect(fields).not.toHaveProperty('extract_model');
  });

  it('#406: journals the four prefilter fields on every extraction', async () => {
    const { deps, listUnextracted, journal } = makeDeps();
    listUnextracted.mockResolvedValue([turn({ userText: 'I like dark roast coffee.' })]);
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    const fields = journal.mock.calls.find((call) => call[0] === 'v2.memory_extracted')![1] as Record<string, unknown>;
    expect(fields).toMatchObject({
      prefilter_version: PREFILTER_VERSION,
      prefilter_verdict: 'keep',
      prefilter_reason: 'none',
      user_chars_bucket: '11-40',
    });
  });

  it.each([
    ['ack', 'Thanks!'],
    ['control', 'Stop'],
    ['empty', '...'],
    ['short', 'z'],
  ])('#406 enforced: a %s skip verdict skips extraction entirely (no embed, no extractor call)', async (reason, userText) => {
    const { deps, listUnextracted, extractor, embedder, applyExtractionOps, journal } = makeDeps();
    listUnextracted.mockResolvedValue([turn({ messageId: 'msg_skip', userText })]);
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    expect(extractor).not.toHaveBeenCalled();
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(applyExtractionOps).toHaveBeenCalledTimes(1);
    expect(applyExtractionOps.mock.calls[0]![2]).toEqual([]);
    expect((applyExtractionOps.mock.calls[0]![3] as ApplyExtractionOptions).markMessageId).toBe('msg_skip');
    const skip = journal.mock.calls.find((call) => call[0] === 'v2.memory_skipped');
    expect(skip).toBeDefined();
    expect(skip![1]).toMatchObject({
      reason: 'prefiltered',
      prefilter_version: PREFILTER_VERSION,
      prefilter_reason: reason,
    });
    expect(journal.mock.calls.find((call) => call[0] === 'v2.memory_extracted')).toBeUndefined();
  });

  it('#406: BOB_MEMORY_PREFILTER_ENFORCE=0 restores shadow-mode extraction for a skip verdict', async () => {
    const original = process.env.BOB_MEMORY_PREFILTER_ENFORCE;
    process.env.BOB_MEMORY_PREFILTER_ENFORCE = '0';
    try {
      const { deps, listUnextracted, extractor, applyExtractionOps, journal } = makeDeps();
      listUnextracted.mockResolvedValue([turn({ messageId: 'msg_ack', userText: 'Thanks!' })]);
      extractor.mockResolvedValue({
        ops: [{ op: 'add', kind: 'fact', content: 'Likes dark roast.', confidence: 0.9 }],
        dropped: { secret: 0, sensitive: 0 },
      });
      const worker = createMemoryExtractionWorker(deps);

      worker.enqueue('user-a');
      await settle();
      await worker.idle();

      expect(extractor).toHaveBeenCalledTimes(1);
      expect(applyExtractionOps).toHaveBeenCalledTimes(1);
      expect((applyExtractionOps.mock.calls[0]![3] as ApplyExtractionOptions).markMessageId).toBe('msg_ack');
      const fields = journal.mock.calls.find((call) => call[0] === 'v2.memory_extracted')![1] as Record<string, unknown>;
      expect(fields).toMatchObject({
        prefilter_verdict: 'skip',
        prefilter_reason: 'ack',
        user_chars_bucket: '0-10',
        ops_add: 1,
      });
    } finally {
      if (original === undefined) delete process.env.BOB_MEMORY_PREFILTER_ENFORCE;
      else process.env.BOB_MEMORY_PREFILTER_ENFORCE = original;
    }
  });

  describe('memory gate', () => {
    async function runWithGate(memoryGate: WorkerDeps['memoryGate'], userText = 'hey Bob, thanks a lot!') {
      const made = makeDeps();
      made.listUnextracted.mockResolvedValue([turn({ messageId: 'msg_gate', userText, assistantText: 'Any time.' })]);
      const worker = createMemoryExtractionWorker({ ...made.deps, memoryGate });
      worker.enqueue('user-a');
      await settle();
      await worker.idle();
      return made;
    }

    it('on: a low score skips the embed and extractor and marks the turn done', async () => {
      const score = vi.fn(async () => 0.04);
      const { extractor, embedder, applyExtractionOps, journal } = await runWithGate({ score, enforce: true });

      expect(score).toHaveBeenCalledWith({ userText: 'hey Bob, thanks a lot!', assistantText: 'Any time.', userId: 'user-a' });
      expect(extractor).not.toHaveBeenCalled();
      expect(embedder.embed).not.toHaveBeenCalled();
      expect(applyExtractionOps.mock.calls[0]![2]).toEqual([]);
      expect((applyExtractionOps.mock.calls[0]![3] as ApplyExtractionOptions).markMessageId).toBe('msg_gate');
      expect(journal.mock.calls.find((call) => call[0] === 'v2.memory_skipped')![1]).toEqual({ reason: 'gated', gate_score: 0.04 });
    });

    it('on: a high score extracts and journals the score', async () => {
      const { extractor, journal } = await runWithGate({ score: async () => 0.976, enforce: true }, "I'm allergic to peanuts.");

      expect(extractor).toHaveBeenCalledTimes(1);
      expect(journal.mock.calls.find((call) => call[0] === 'v2.memory_extracted')![1]).toMatchObject({ gate_score: 0.98 });
    });

    it('shadow: a low score still extracts, with the score journaled', async () => {
      const { extractor, journal } = await runWithGate({ score: async () => 0.04, enforce: false });

      expect(extractor).toHaveBeenCalledTimes(1);
      expect(journal.mock.calls.find((call) => call[0] === 'v2.memory_extracted')![1]).toMatchObject({ gate_score: 0.04 });
      expect(journal.mock.calls.find((call) => call[0] === 'v2.memory_skipped')).toBeUndefined();
    });

    it('fails open: a gate error extracts and journals only the error class', async () => {
      const boom = new Error('quota for hey Bob, thanks a lot!');
      boom.name = 'AI_APICallError';
      const { extractor, journal } = await runWithGate({ score: async () => { throw boom; }, enforce: true });

      expect(extractor).toHaveBeenCalledTimes(1);
      expect(journal.mock.calls.find((call) => call[0] === 'v2.memory_gate_failed')![1]).toEqual({ error_name: 'AI_APICallError' });
      expect(journal.mock.calls.find((call) => call[0] === 'v2.memory_extracted')![1]).not.toHaveProperty('gate_score');
      for (const call of journal.mock.calls) expect(JSON.stringify(call[1])).not.toContain('thanks');
    });
  });

  it('#406: v2.memory_extracted has exactly this key set (a new text-bearing field must fail here)', async () => {
    const { deps, listUnextracted, extractor, journal } = makeDeps();
    listUnextracted.mockResolvedValue([turn({ userText: 'Sure' })]);
    extractor.mockResolvedValue({
      ops: [
        { op: 'add', kind: 'action_item', content: 'Call Dana at 5pm.', confidence: 0.9 },
        { op: 'add', kind: 'preference', content: 'Uses metric units.', confidence: 0.8 },
        { op: 'add', kind: 'preference', content: 'Prefers short answers.', confidence: 0.8 },
      ],
      dropped: { secret: 0, sensitive: 0 },
      usage: { inputTokens: 500, outputTokens: 30 },
      modelId: 'openai/gpt-4o-mini',
    });
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    const fields = journal.mock.calls.find((call) => call[0] === 'v2.memory_extracted')![1] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual([
      'adds_action_item', 'adds_duplicate', 'adds_fact', 'adds_intent', 'adds_preference', 'adds_ungrounded',
      'changes_narrowed', 'changes_ungrounded', 'confidence_bucket', 'conversation_id', 'count', 'dropped_secret',
      'dropped_sensitive', 'embed_model', 'extract_input_tokens', 'extract_model', 'extract_ms',
      'extract_output_tokens', 'message_id', 'ops_add', 'ops_deduped', 'ops_noop', 'ops_supersede', 'ops_update',
      'prefilter_reason', 'prefilter_verdict', 'prefilter_version', 'reason', 'user_chars_bucket',
    ]);
    expect(fields).toMatchObject({
      adds_action_item: 1,
      adds_preference: 2,
      adds_fact: 0,
      adds_intent: 0,
      prefilter_verdict: 'keep',
      prefilter_reason: 'confirmation',
    });
  });

  it('MEM-ECHO: an add duplicating a live memory near its own vector is applied as a noop on it', async () => {
    const { deps, listUnextracted, extractor, matchMemories, applyExtractionOps, journal } = makeDeps();
    listUnextracted.mockResolvedValue([turn({ userText: 'Can I have chicken tonight?' })]);
    extractor.mockResolvedValue({
      ops: [{ op: 'add', kind: 'fact', content: 'The user is vegetarian.', confidence: 0.9 }],
      dropped: { secret: 0, sensitive: 0 },
      rejected: { ungrounded: 1, duplicate: 0 },
    });
    // The first lookup is for the user's words (it misses); the second is the add's own vector.
    matchMemories
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'mem_veg', kind: 'preference', content: 'The user is a vegetarian and does not eat meat.' }]);
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    expect(matchMemories.mock.calls[1]![2]).toMatchObject({ queryText: 'The user is vegetarian.', queryEmbedding: new Array(EMBEDDING_DIM).fill(0.2) });
    expect(applyExtractionOps.mock.calls[0]![2]).toEqual([{ op: 'noop', id: 'mem_veg' }]);
    const fields = journal.mock.calls.find((call) => call[0] === 'v2.memory_extracted')![1] as Record<string, unknown>;
    expect(fields).toMatchObject({ ops_add: 0, ops_noop: 1, adds_duplicate: 1, adds_ungrounded: 1 });
  });

  it('MEM-EVIDENCE: journals the updates/supersedes the extractor turned into noops', async () => {
    const { deps, listUnextracted, extractor, applyExtractionOps, journal } = makeDeps();
    listUnextracted.mockResolvedValue([turn({ userText: 'can I have chicken tonight' })]);
    extractor.mockResolvedValue({
      ops: [{ op: 'noop', id: 'mem_d02' }],
      dropped: { secret: 0, sensitive: 0 },
      rejected: { ungrounded: 0, duplicate: 0, changesUngrounded: 0, narrowed: 1 },
    });
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    expect(applyExtractionOps.mock.calls[0]![2]).toEqual([{ op: 'noop', id: 'mem_d02' }]);
    const fields = journal.mock.calls.find((call) => call[0] === 'v2.memory_extracted')![1] as Record<string, unknown>;
    expect(fields).toMatchObject({ ops_supersede: 0, ops_noop: 1, changes_narrowed: 1, changes_ungrounded: 0 });
  });

  it('MEM-ECHO: a new user statement near a live memory still adds', async () => {
    const { deps, listUnextracted, extractor, matchMemories, applyExtractionOps } = makeDeps();
    listUnextracted.mockResolvedValue([turn({ userText: 'My brother lives in Berlin.' })]);
    extractor.mockResolvedValue({
      ops: [{ op: 'add', kind: 'fact', content: "The user's brother lives in Berlin.", confidence: 0.9 }],
      dropped: { secret: 0, sensitive: 0 },
    });
    matchMemories.mockResolvedValue([{ id: 'mem_sis', kind: 'fact', content: "The user's sister lives in Berlin." }]);
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    expect(applyExtractionOps.mock.calls[0]![2]).toEqual([
      expect.objectContaining({ op: 'add', content: "The user's brother lives in Berlin." }),
    ]);
  });

  it('the journal JSON contains no memory or message text (T-13 style)', async () => {
    const { deps, listUnextracted, extractor, journal } = makeDeps();
    const secretText = 'the user likes very specific dark roast beans';
    listUnextracted.mockResolvedValue([turn({ userText: secretText, assistantText: secretText })]);
    extractor.mockResolvedValue({
      ops: [{ op: 'add', kind: 'fact', content: secretText, confidence: 0.9 }],
      dropped: { secret: 0, sensitive: 0 },
    });
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await settle();
    await worker.idle();

    for (const call of journal.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain(secretText);
      expect(JSON.stringify(call[1])).not.toContain('dark roast');
    }
  });

  it('the startup scan enqueues the accounts it finds', async () => {
    const { deps, listAccounts, listUnextracted, applyExtractionOps, memoryAvailable } = makeDeps();
    listAccounts.mockResolvedValue([{ userId: 'account-1' }, { userId: 'account-2' }]);
    listUnextracted.mockResolvedValue([turn()]);
    const worker = createMemoryExtractionWorker(deps);

    const found = await worker.scanUnprocessed();
    expect(found).toBe(2);
    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect(listAccounts.mock.calls[0]![1]).toBe(1_700_000_000_000 - STARTUP_SCAN_WINDOW_MS);
    await settle();
    await worker.idle();
    expect(listUnextracted).toHaveBeenCalledTimes(2); // one per account
    expect(applyExtractionOps).toHaveBeenCalledTimes(2);
    expect(memoryAvailable).toHaveBeenCalled();
  });

  it('scanUnprocessed is a no-op and journals nothing when memory is disabled', async () => {
    const { deps, listAccounts, journal } = makeDeps();
    listAccounts.mockResolvedValue([{ userId: 'account-1' }]);
    deps.memoryAvailable = vi.fn(async () => false);
    const worker = createMemoryExtractionWorker(deps);

    const found = await worker.scanUnprocessed();
    expect(found).toBe(0);
    expect(listAccounts).toHaveBeenCalledTimes(0);
    expect(journal).not.toHaveBeenCalled();
  });

  it('stop cancels pending timers and stays quiet', async () => {
    const { deps, listUnextracted } = makeDeps();
    listUnextracted.mockResolvedValue([turn()]);
    const worker = createMemoryExtractionWorker(deps);

    worker.enqueue('user-a');
    await worker.stop();
    await settle();

    expect(listUnextracted).toHaveBeenCalledTimes(0);
  });
});

describe('memory extraction worker batch limit', () => {
  it('passes RUN_BATCH_LIMIT to listUnextracted', async () => {
    const { deps, listUnextracted } = makeDeps();
    listUnextracted.mockResolvedValue([]);
    const worker = createMemoryExtractionWorker(deps);
    worker.enqueue('user-a');
    await settle();
    await worker.idle();
    expect(listUnextracted.mock.calls[0]![2]).toBe(RUN_BATCH_LIMIT);
  });
});

describe('startup scan with the bob_private helper missing (unmigrated memory schema)', () => {
  let pg: TestDb;
  let db: Db;

  beforeAll(async () => {
    // Migrated only up to the first memory migration: the memory schema (the
    // scan helper among it) was never migrated, as on a partially migrated
    // database. The scan must return an empty list without throwing, never fail boot.
    pg = await createMigratedDb({ before: '20260915200000_memory_init.sql' });
    db = asDb(pg);
  });

  // The file-level beforeEach installs fake timers; the postgres driver needs
  // real ones, or its socket timers never fire and the query hangs.
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await closeTestDb(pg).catch(() => undefined);
  });

  it('listAccountsWithUnextracted returns [] and does not throw when the helper is missing', async () => {
    const accounts = await listAccountsWithUnextracted(db, 0, 100);
    expect(accounts).toEqual([]);
  });
});

describe('remember callback embed failure', () => {
  const USER_ID = '11111111-2222-4333-8444-555555555555';

  beforeEach(() => {
    memoriesStore.findBestMatch.mockReset();
    memoriesStore.applyExtractionOps.mockReset();
  });

  it('journals v2.memory_embed_failed with the error class name and still stores without a vector', async () => {
    const boom = new Error('embedder down') as Error & { name: string };
    boom.name = 'AI_APICallError';
    // remember goes through applyExtractionOps directly (#758): a fresh add.
    memoriesStore.applyExtractionOps.mockResolvedValue([
      { op: 'add', memoryId: 'mem_new', targetId: null, dupOf: null, guard: 'none' },
    ]);
    const journal = vi.fn<(event: string, fields?: Record<string, unknown>) => void>();
    const callbackDb: Db = {
      async query<T>(): Promise<T[]> {
        return [];
      },
      async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
        return fn(callbackDb);
      },
    };

    const callbacks = createMemoryCallbacks(callbackDb, USER_ID, {
      isAvailable: async () => true,
      embedder: async () => {
        throw boom;
      },
      journal,
    });
    const result = await callbacks.remember({ content: 'Likes dark roast.' });

    expect(result).not.toMatchObject({ disabled: true });
    const embedFailed = journal.mock.calls.find((call) => call[0] === 'v2.memory_embed_failed');
    expect(embedFailed).toBeDefined();
    expect(embedFailed![1]).toMatchObject({ error_name: 'AI_APICallError' });
    // Stored without a vector, as before.
    const add = memoriesStore.applyExtractionOps.mock.calls[0]![2] as ExtractionOp[];
    expect((add[0] as { embedding: MemoryEmbedding | null }).embedding).toBeNull();
    // The failure message never reaches the journal.
    for (const call of journal.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain('embedder down');
      expect(JSON.stringify(call[1])).not.toContain('dark roast');
    }
  });
});
