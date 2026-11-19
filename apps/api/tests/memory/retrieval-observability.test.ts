import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordObservationMetrics, traceSpan } from '@bob/ai';
import { startMemoryRecall, startMemoryRetrieval, type MemoryRetrievalDeps } from '../../src/memory/retrieval.ts';
import type { Db } from '../../src/platform/db/db.ts';

vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(), recordObservationMetrics: vi.fn(),
}));
const scope = new AsyncLocalStorage<string>();
const samples: Array<{ stage: string | undefined; name: string; value: number }> = [];
function deps(): MemoryRetrievalDeps {
  vi.mocked(traceSpan).mockImplementation((name, _attrs, run) => scope.run(name, async () => run()));
  vi.mocked(recordObservationMetrics).mockImplementation((values) => { samples.push(...values.map((sample) => ({ stage: scope.getStore(), ...sample }))); });
  return {
    embedder: { embed: async () => [1], embedMany: async () => [[1]], modelId: 'fake', dim: 1 },
    memoryAvailable: async () => true, matchMemories: async () => [], matchMemoriesFullText: async () => [],
    listDueSoon: async () => [], listStandingMemories: async () => [],
    journal: vi.fn(), clock: () => Date.now(), timeoutMs: 100, topK: 8,
  };
}
const db = {} as Db;
const has = (stage: string, name: string, value: number): void => {
  expect(samples).toContainEqual({ stage, name, value });
};
afterEach(() => { samples.length = 0; vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('memory retrieval diagnostics', () => {
  it('attributes empty search and parallel stages without capturing private data', async () => {
    const injected = deps();
    await startMemoryRetrieval(db, 'private-account', 'private-query', injected).result;
    for (const stage of ['memory-retrieval', 'memory-availability', 'memory-embedding', 'memory-hybrid-search', 'memory-due-soon', 'memory-standing']) {
      has(stage, 'rag.failed', 0);
      expect(samples).toContainEqual(expect.objectContaining({ stage, name: 'rag.duration_ms' }));
    }
    has('memory-hybrid-search', 'rag.empty', 1);
    has('memory-retrieval', 'rag.fallback', 0);
    expect(JSON.stringify(vi.mocked(traceSpan).mock.calls.map(([name, attrs]) => [name, attrs]))).not.toContain('private-');
  });
  it('a partial recall adds its search stages but no second root sample, and marks its journal line', async () => {
    const injected = deps();
    await startMemoryRecall(db, 'private-account', 'private-query', injected).result;
    has('memory-hybrid-search', 'rag.empty', 1);
    expect(samples.filter((sample) => sample.stage === 'memory-retrieval' && ['rag.skipped', 'rag.fallback', 'rag.result_count'].includes(sample.name))).toEqual([]);
    expect(samples.some((sample) => sample.stage === 'memory-due-soon')).toBe(false);
    expect(vi.mocked(injected.journal)).toHaveBeenCalledWith('v2.memory_retrieved', expect.objectContaining({ partial: true }));
  });
  it('keeps skipped retrieval distinct from a successful empty search', async () => {
    const injected = deps();
    injected.memoryAvailable = async () => false;
    await startMemoryRetrieval(db, 'private-account', 'private-query', injected).result;
    has('memory-retrieval', 'rag.skipped', 1);
    expect(samples.some((sample) => sample.name === 'rag.empty')).toBe(false);
  });
  it('marks proven embedding deadline separately from provider failure and uses full-text fallback', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const injected = deps();
    injected.embedder.embed = async (_text, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('private-provider-error')));
    });
    const result = startMemoryRetrieval(db, 'private-account', 'private-query', injected).result;
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new DOMException('deadline', 'TimeoutError'));
    expect((await result).degraded).toBe(true);
    has('memory-embedding', 'rag.timeout', 1);
    has('memory-embedding', 'rag.failed', 1);
    has('memory-retrieval', 'rag.fallback', 1);
    expect(samples).toContainEqual(expect.objectContaining({ stage: 'memory-fulltext-search', name: 'rag.result_count' }));
  });
  it('exposes tolerated store and auxiliary failures without pretending they were empty successes', async () => {
    const injected = deps();
    injected.matchMemories = async () => { throw new Error('private-store-error'); };
    injected.listDueSoon = async () => { throw new Error('private-store-error'); };
    injected.listStandingMemories = async () => { throw new Error('private-store-error'); };
    const result = await startMemoryRetrieval(db, 'private-account', 'private-query', injected).result;
    expect(result.block).toBeNull();
    for (const stage of ['memory-hybrid-search', 'memory-due-soon', 'memory-standing']) has(stage, 'rag.failed', 1);
    expect(samples.some((sample) => sample.name === 'rag.empty')).toBe(false);
    has('memory-retrieval', 'rag.fallback', 1);
  });
  it('preserves parallel latency rather than summing embedding and side lookups', async () => {
    vi.useFakeTimers();
    const injected = deps();
    const delay = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
    injected.embedder.embed = () => delay(40, [1]);
    injected.listDueSoon = () => delay(80, []);
    injected.listStandingMemories = () => delay(60, []);
    injected.matchMemories = () => delay(10, []);
    const result = startMemoryRetrieval(db, 'private-account', 'private-query', injected).result;
    await vi.advanceTimersByTimeAsync(80);
    expect((await result).latencyMs).toBe(80);
    has('memory-embedding', 'rag.duration_ms', 40);
    has('memory-due-soon', 'rag.duration_ms', 80);
    has('memory-standing', 'rag.duration_ms', 60);
    has('memory-hybrid-search', 'rag.duration_ms', 10);
    has('memory-retrieval', 'rag.duration_ms', 80);
  });
  it('does not call a generic abort a deadline or expose exception text', async () => {
    const injected = deps();
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    injected.embedder.embed = async () => { throw new DOMException('private-abort', 'AbortError'); };
    const result = await startMemoryRetrieval(db, 'private-account', 'private-query', injected).result;
    expect(result.degraded).toBe(true);
    has('memory-embedding', 'rag.timeout', 0);
    expect(JSON.stringify(samples)).not.toContain('private-');
  });
  it('keeps prefilter skip distinct while still retrieving standing and due context', async () => {
    const injected = deps();
    vi.stubEnv('BOB_MEMORY_PREFILTER_ENFORCE', '1');
    try {
      await startMemoryRetrieval(db, 'private-account', 'hello', injected).result;
      has('memory-retrieval', 'rag.skipped', 1);
      expect(vi.mocked(traceSpan).mock.calls.map(([name]) => name)).not.toContain('memory-embedding');
      expect(vi.mocked(traceSpan).mock.calls.map(([name]) => name)).not.toContain('memory-hybrid-search');
      has('memory-standing', 'rag.result_count', 0);
    } finally { vi.unstubAllEnvs(); }
  });
  it('counts successful results without copying IDs or content into observations', async () => {
    const injected = deps();
    injected.matchMemories = async () => [{ id: 'private-id', content: 'private-document', kind: 'fact', confidence: 1,
      sensitive: false, conversationId: null, messageId: null, surface: 'web_text', createdAt: 0, matchSource: 'both', score: 1 }];
    const result = await startMemoryRetrieval(db, 'private-account', 'private-query', injected).result;
    expect(result.memories).toHaveLength(1);
    has('memory-hybrid-search', 'rag.result_count', 1);
    has('memory-hybrid-search', 'rag.empty', 0);
    has('memory-retrieval', 'rag.result_count', 1);
    expect(JSON.stringify({ samples, spans: vi.mocked(traceSpan).mock.calls.map(([name, attrs]) => [name, attrs]) })).not.toContain('private-');
  });
});
