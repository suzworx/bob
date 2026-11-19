/**
 * MEM-SAFE: the remember callback runs the server's own checks instead of
 * trusting the model. A secret-like content is refused before any store call
 * (as extraction drops it), and a sensitive category is stored with
 * sensitive=true whatever flag the model passed. Default suite: the store
 * modules are fakes, no DB.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryCallbacks } from '../../src/memory/callbacks.ts';
import type { Db } from '../../src/platform/db/db.ts';

const memoriesStore = vi.hoisted(() => ({
  deleteMemory: vi.fn(),
  findBestMatch: vi.fn(),
  applyExtractionOps: vi.fn(),
}));
let nextMemoryId = 0;
vi.mock('../../src/memory/store.ts', () => memoriesStore);

const USER_ID = randomUUID();
const db = {
  tx: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn({ query: async () => ({ rows: [] }) } as unknown as Db),
} as unknown as Db;

type JournalCall = [string, Record<string, string | number | boolean | undefined>];

function callbacks(journalCalls: JournalCall[] = []): ReturnType<typeof createMemoryCallbacks> {
  return createMemoryCallbacks(db, USER_ID, {
    isAvailable: async () => true,
    journal: (event, fields) => journalCalls.push([event, fields]),
  });
}

/** The `sensitive` flag of the single add op the store received. */
function storedSensitive(): unknown {
  const ops = memoriesStore.applyExtractionOps.mock.calls[0]![2] as Array<{ sensitive?: boolean }>;
  return ops[0]!.sensitive;
}

beforeEach(() => {
  vi.resetAllMocks();
  nextMemoryId = 0;
  // remember goes through applyExtractionOps directly (#758): the store
  // decides add vs. duplicate, so this fake always reports a fresh add.
  memoriesStore.applyExtractionOps.mockImplementation(async () => {
    nextMemoryId += 1;
    return [{ op: 'add', memoryId: `mem_${nextMemoryId}`, targetId: null, dupOf: null, guard: 'none' }];
  });
});

describe('remember callback server-side checks (MEM-SAFE)', () => {
  it.each([
    'My Visa number is 4111 1111 1111 1111',
    'My SSN: 123-45-6789',
    'my bank login is bob and hunter2',
    'my PIN is 4821',
  ])('refuses a secret before any store call: %s', async (content) => {
    const journalCalls: JournalCall[] = [];
    const result = await callbacks(journalCalls).remember({ content, sensitive: false });
    expect(result).toEqual({ stored: false, memory_id: null, sensitive: false });
    expect(memoriesStore.findBestMatch).not.toHaveBeenCalled();
    expect(memoriesStore.applyExtractionOps).not.toHaveBeenCalled();
    const refused = journalCalls.find(([event]) => event === 'v2.memory_refused');
    expect(refused?.[1].route).toBe('remember');
    expect(JSON.stringify(journalCalls)).not.toContain(content);
  });

  it('forces sensitive=true for a sensitive category the model did not flag', async () => {
    const result = await callbacks().remember({ content: 'Has diabetes and takes insulin', sensitive: false });
    expect(result).toEqual({ stored: true, memory_id: 'mem_1', sensitive: true });
    expect(storedSensitive()).toBe(true);
  });

  it('keeps an ordinary preference non-sensitive', async () => {
    const result = await callbacks().remember({ content: 'Prefers chai over coffee' });
    expect(result).toEqual({ stored: true, memory_id: 'mem_1', sensitive: false });
    expect(storedSensitive()).toBe(false);
  });

  it("a duplicate (the store's noop) reports stored:false with the existing id", async () => {
    memoriesStore.applyExtractionOps.mockResolvedValueOnce([
      { op: 'noop', memoryId: 'mem_existing', targetId: null, dupOf: 'mem_existing', guard: 'find_duplicate' },
    ]);
    const result = await callbacks().remember({ content: 'Prefers chai over coffee' });
    expect(result).toEqual({ stored: false, memory_id: 'mem_existing', sensitive: false });
  });

  it('still honours a sensitive flag the model did set', async () => {
    await callbacks().remember({ content: 'Is seeing a new doctor', sensitive: true });
    expect(storedSensitive()).toBe(true);
  });
});
