// test:db suite for startMemoryRetrieval (spec 010, T011). Runs against the
// LOCAL Supabase stack only -- it needs the `vector` extension -- so it is
// excluded from the default run and executes under `npm run
// test:db`. A fake deterministic embedder drives the real hybrid store path,
// and a rejecting embedder pins the degraded full-text+recency path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';
import {
  applyExtractionOps,
  deleteAllMemories,
  insertMemory,
  listStandingMemories,
  type MemoryEmbedding,
} from '../../src/memory/store.ts';
import {
  startMemoryRetrieval,
  type MemoryRetrievalDeps,
  type RetrievalResult,
} from '../../src/memory/retrieval.ts';
import { memoryAvailable } from '../../src/memory/available.ts';
import { matchMemories, matchMemoriesFullText } from '../../src/memory/store.ts';
import { listDueSoon } from '../../src/tasks/action-items-store.ts';

const DIMS = 1536;

/** Deterministic 1536-dim pseudo-random vector, every axis near 0.5, so any
 *  two generated vectors are cosine-close and the semantic arm returns every
 *  seeded row for a same-shape query vector (store-memories.db.test.ts). */
function vec(seed: number): number[] {
  const values: number[] = new Array(DIMS);
  for (let i = 0; i < DIMS; i += 1) {
    values[i] = 0.5 + Math.sin(seed * 7919 + i * 12.9898) * 0.01;
  }
  return values;
}

function embed(seed: number): MemoryEmbedding {
  return { values: vec(seed), model: 'text-embedding-3-small', dim: DIMS };
}

describe('startMemoryRetrieval (test:db)', () => {
  let env: MemoryTestDb;
  let a: { userId: string };

  beforeAll(async () => {
    env = await setupMemoryTestDb();
    a = { userId: env.a.userId };
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('with a deterministic embedder, the real hybrid match returns the seeded top-k and builds the block', async () => {
    await deleteAllMemories(env.db, a.userId);
    const contents = ['the user prefers chai over coffee', 'the user is allergic to peanuts'];
    for (let i = 0; i < contents.length; i += 1) {
      await insertMemory(env.db, a.userId, {
        kind: i % 2 === 0 ? 'preference' : 'fact',
        content: contents[i]!,
        confidence: 0.9,
        embedding: embed(i + 1),
      });
    }
    // A due-soon open action item (FR-015) should surface in the block.
    await applyExtractionOps(
      env.db,
      a.userId,
      [{ op: 'add', kind: 'action_item', content: 'Email Dana', confidence: 0.95, dueAt: Date.now() + 3_600_000 }],
      { source: { conversationId: null, messageId: null, surface: 'web_text' } },
    );

    expect(await memoryAvailable(env.db)).toBe(true);
    const deps: MemoryRetrievalDeps = {
      embedder: {
        embed: async () => vec(5),
        embedMany: async () => [vec(5)],
        modelId: 'text-embedding-3-small',
        dim: DIMS,
      },
      memoryAvailable,
      matchMemories,
      matchMemoriesFullText,
      listDueSoon,
      journal: () => undefined,
      clock: Date.now,
      timeoutMs: 5000,
      topK: 8,
    };
    const { result } = startMemoryRetrieval(env.db, a.userId, 'chai coffee', deps);
    const res: RetrievalResult = await result;
    expect(res.degraded).toBe(false);
    expect(res.memories.length).toBeLessThanOrEqual(8);
    const returned = res.memories.map((m) => m.content);
    expect(returned).toContain('the user prefers chai over coffee');
    expect(res.dueSoon).toHaveLength(1);
    expect(res.dueSoon[0]!.content).toBe('Email Dana');
    expect(res.block).toContain('Open action items:');
    expect(res.block).toContain('the user prefers chai over coffee');
  });

  it('a rejecting embedder degrades to full-text only hits', async () => {
    await deleteAllMemories(env.db, a.userId);
    await insertMemory(env.db, a.userId, {
      kind: 'fact',
      content: 'the user is allergic to peanuts',
      confidence: 0.92,
      embedding: embed(2),
    });
    const deps: MemoryRetrievalDeps = {
      embedder: {
        embed: async () => {
          throw new Error('embed provider down');
        },
        embedMany: async () => {
          throw new Error('embed provider down');
        },
        modelId: 'text-embedding-3-small',
        dim: DIMS,
      },
      memoryAvailable,
      matchMemories,
      matchMemoriesFullText,
      listDueSoon,
      journal: () => undefined,
      clock: Date.now,
      timeoutMs: 5000,
      topK: 8,
    };
    const { result } = startMemoryRetrieval(env.db, a.userId, 'peanuts', deps);
    const res: RetrievalResult = await result;
    expect(res.degraded).toBe(true);
    expect(res.memories.length).toBeGreaterThan(0);
    expect(res.memories.every((m) => m.matchSource === 'full_text')).toBe(true);
    expect(res.block).toContain('the user is allergic to peanuts');
  });

  it('with BOB_MEMORY_MAX_DISTANCE set, an unrelated query yields no memory block (#405)', async () => {
    await deleteAllMemories(env.db, a.userId);
    const axis = (i: number): number[] => {
      const values = new Array<number>(DIMS).fill(0);
      values[i] = 1;
      return values;
    };
    await insertMemory(env.db, a.userId, {
      kind: 'fact',
      content: 'the user is allergic to peanuts',
      confidence: 0.92,
      embedding: { values: axis(0), model: 'text-embedding-3-small', dim: DIMS },
    });
    const deps: MemoryRetrievalDeps = {
      embedder: {
        embed: async () => axis(1),
        embedMany: async () => [axis(1)],
        modelId: 'text-embedding-3-small',
        dim: DIMS,
      },
      memoryAvailable,
      matchMemories,
      matchMemoriesFullText,
      listDueSoon,
      journal: () => undefined,
      clock: Date.now,
      timeoutMs: 5000,
      topK: 8,
    };
    const previous = process.env.BOB_MEMORY_MAX_DISTANCE;
    try {
      delete process.env.BOB_MEMORY_MAX_DISTANCE;
      const today = await startMemoryRetrieval(env.db, a.userId, 'what is the weather tomorrow', deps).result;
      expect(today.memories).toHaveLength(1); // flag unset: the orthogonal row is injected, as today

      process.env.BOB_MEMORY_MAX_DISTANCE = '0.5'; // a test floor, not the shipped D (#404)
      const floored = await startMemoryRetrieval(env.db, a.userId, 'what is the weather tomorrow', deps).result;
      expect(floored.degraded).toBe(false);
      expect(floored.memories).toHaveLength(0);
      expect(floored.block).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.BOB_MEMORY_MAX_DISTANCE;
      else process.env.BOB_MEMORY_MAX_DISTANCE = previous;
    }
  });

  it('#458 listStandingMemories returns current, non-sensitive facts and preferences, most confident first', async () => {
    await deleteAllMemories(env.db, a.userId);
    const add = (kind: 'fact' | 'preference' | 'intent', content: string, confidence: number, sensitive = false) =>
      insertMemory(env.db, a.userId, { kind, content, confidence, sensitive });
    await add('fact', 'The user is Indian and vegetarian', 0.8);
    await add('preference', 'The user is a vegetarian and does not eat meat', 0.95);
    await add('intent', 'The user is looking for ideas on what to eat for dinner', 0.99);
    await add('fact', 'A sensitive fact', 0.99, true);
    const old = await add('preference', 'The user loves steak', 0.9);
    await applyExtractionOps(
      env.db,
      a.userId,
      [{ op: 'supersede', id: old.id, content: 'The user no longer eats steak', confidence: 0.7 }],
      { source: { conversationId: null, messageId: null, surface: 'web_text' } },
    );
    const standing = await listStandingMemories(env.db, a.userId);
    expect(standing.map((m) => m.content)).toEqual([
      'The user is a vegetarian and does not eat meat',
      'The user is Indian and vegetarian',
      'The user no longer eats steak',
    ]);
    expect(await listStandingMemories(env.db, a.userId, 1)).toHaveLength(1);
    expect(await listStandingMemories(env.db, env.b.userId)).toEqual([]);
  });
});