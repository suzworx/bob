import { afterEach, expect, it, vi } from 'vitest';
import { recordObservationMetrics, traceSpan, updateActiveSpanMetadata } from '@bob/ai';
import { createMemoryExtractionWorker } from '../../src/memory/extract.ts';

vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, fn: () => unknown) => fn()),
  recordObservationMetrics: vi.fn(), updateActiveSpanMetadata: vi.fn(),
}));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

type Deps = Parameters<typeof createMemoryExtractionWorker>[0];
function dependencies(overrides: Partial<Deps> = {}): Deps {
  return { db: {} as Deps['db'], extractor: vi.fn(async () => ({ ops: [], dropped: { secret: 0, sensitive: 0 } })),
    embedder: { modelId: 'test', dim: 1, embed: vi.fn(async () => [1]), embedMany: vi.fn(async () => [[1]]) },
    listUnextracted: vi.fn(async () => [{ messageId: 'message_0001', conversationId: 'conversation_0001', surface: 'web_text' as const, userText: 'private-content', assistantText: 'private-content' }]),
    listAccounts: vi.fn(async () => [{ userId: 'account_0001' }]), matchMemories: vi.fn(async () => []),
    applyExtractionOps: vi.fn(async () => undefined), memoryAvailable: vi.fn(async () => true), journal: vi.fn(), clock: Date.now,
    debounceMs: 1, maxAttempts: 1, ...overrides };
}

it('covers scan/account/extraction and records privacy skips without calling models', async () => {
  vi.useFakeTimers();
  const deps = dependencies({ turnSpace: async () => ({ id: 'private-id', kind: 'group' }) });
  const worker = createMemoryExtractionWorker(deps);
  expect(await worker.scanUnprocessed()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await worker.idle();
  await worker.stop();
  expect(deps.extractor).not.toHaveBeenCalled();
  for (const name of ['memory-scan', 'memory-account', 'memory-extract']) {
    expect(traceSpan).toHaveBeenCalledWith(name, expect.objectContaining({ detached: true }), expect.any(Function));
  }
  expect(updateActiveSpanMetadata).toHaveBeenCalledWith({ reason: 'shared_space' });
  expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private-');
});

it('reports account and startup store failures without throwing to callers', async () => {
  vi.useFakeTimers();
  const deps = dependencies({ listAccounts: async () => { throw new Error('private-db'); }, listUnextracted: async () => { throw new Error('private-db'); } });
  const worker = createMemoryExtractionWorker(deps);
  expect(await worker.scanUnprocessed()).toBe(0);
  worker.enqueue('account_0001');
  await vi.advanceTimersByTimeAsync(1);
  await worker.stop();
  expect(recordObservationMetrics).toHaveBeenCalledTimes(2);
  expect(vi.mocked(recordObservationMetrics).mock.calls.every((call) => call[0].some((sample) => sample.name === 'workflow.failed' && sample.value === 1))).toBe(true);
});
