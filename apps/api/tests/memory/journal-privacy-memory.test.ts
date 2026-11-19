/**
 * Journal privacy scan for cross-session memory (010, T024; FR-013, SC-006,
 * contracts/memories-api.md "Journal events"). Proves that no journal line --
 * across the extraction worker, retrieval, the remember/forget/complete_action
 * tools and their callbacks, and the /api/memories handlers -- ever carries
 * user text, assistant text, corrected text, or memory content. Each path runs
 * with journal capture on and a distinctive canary in every piece of
 * user-facing text; the captured journal is asserted to contain no canary
 * anywhere, and each path must emit at least one expected metadata event so the
 * scan cannot pass vacuously. Default suite: injected fakes, no DB, no network.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { journal, setJournalSink } from '../../src/platform/logger.ts';
import { createMemoryExtractionWorker } from '../../src/memory/extract.ts';
import { PREFILTER_VERSION } from '../../src/memory/prefilter.ts';
import { createMemoryCallbacks } from '../../src/memory/callbacks.ts';
import { createMemoryTools, type Embedder, type ExtractResult } from '@bob/ai';
import { startMemoryRetrieval } from '../../src/memory/retrieval.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createMemoriesRouter } from '../../src/memory/http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import type { Db } from '../../src/platform/db/db.ts';
import type { MemoryEmbedding, StoredMemory } from '../../src/memory/store.ts';
import type { MemoryRetrievalDeps } from '../../src/memory/retrieval.ts';
import type { UnextractedTurn } from '../../src/memory/extract-queue.ts';
import type { MemorySurface } from '../../src/memory/store.ts';

// The store modules are replaced with controllable fakes so the callbacks and
// the /api/memories handlers can be driven without a database.
const memoriesStore = vi.hoisted(() => ({
  listMemories: vi.fn(),
  correctMemory: vi.fn(),
  deleteMemory: vi.fn(),
  deleteAllMemories: vi.fn(),
  findBestMatch: vi.fn(),
  applyExtractionOps: vi.fn(),
  matchMemories: vi.fn(),
  matchMemoriesFullText: vi.fn(),
}));
const actionItemsStore = vi.hoisted(() => ({
  listActionItems: vi.fn(),
  setActionItemStatus: vi.fn(),
  completeBestMatch: vi.fn(),
  listDueSoon: vi.fn(),
}));
vi.mock('../../src/memory/store.ts', () => memoriesStore);
vi.mock('../../src/tasks/action-items-store.ts', () => actionItemsStore);

const CANARY = `canary-mem-${randomUUID().slice(0, 8)}`;
const USER_ID = randomUUID();

const journalLines: string[] = [];
const joined = (): string => journalLines.join('\n');
function hasEvent(event: string): boolean {
  return journalLines.some((line) => (JSON.parse(line) as { event: string }).event === event);
}
function expectNoCanary(): void {
  expect(joined()).not.toContain(CANARY);
}

function fakeEmbedder(): Embedder {
  return {
    modelId: 'text-embedding-3-small',
    dim: 4,
    embed: vi.fn(async () => [0.1, 0.1, 0.1, 0.1]),
    embedMany: vi.fn(async (texts: string[]) => texts.map(() => [0.2, 0.2, 0.2, 0.2])),
  };
}

const dummyDb = {
  query: async (): Promise<never> => {
    throw new Error('unused');
  },
  tx: async <T>(): Promise<T> => {
    throw new Error('unused');
  },
} as unknown as Db;

function storedMemory(overrides: Partial<StoredMemory> = {}): StoredMemory {
  return {
    id: 'mem_canary0001',
    kind: 'fact',
    content: 'x',
    confidence: 0.9,
    sensitive: false,
    conversationId: null,
    messageId: null,
    surface: 'web_text',
    supersededBy: null,
    embeddingModel: null,
    embeddingDim: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const okEmbed = async (content: string): Promise<MemoryEmbedding> => ({
  values: [0.5, -0.5],
  model: 'text-embedding-3-small',
  dim: 2,
});

function retrievalDeps(overrides: Partial<MemoryRetrievalDeps> = {}): MemoryRetrievalDeps {
  return {
    embedder: fakeEmbedder(),
    memoryAvailable: async () => true,
    matchMemories: async () => [],
    matchMemoriesFullText: async () => [],
    listDueSoon: async () => [],
    journal,
    clock: () => 1_700_000_000_000,
    timeoutMs: 1200,
    topK: 8,
    ...overrides,
  };
}

describe('journal privacy: memory (T024, FR-013, SC-006)', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    setJournalSink((line) => journalLines.push(line));
    token = await signToken({ userId: randomUUID(), sessionId: randomUUID() });
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use(
      '/api/memories',
      createMemoriesRouter({
        getDb: () => Promise.resolve(dummyDb),
        memoryAvailable: () => Promise.resolve(true),
        embed: okEmbed,
        requireActiveSession: async (_request: Request, _response: ExpressResponse, next: NextFunction): Promise<void> => {
          next();
        },
      }),
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setJournalSink(null);
    server?.close();
  });

  it('path 1: extraction worker journals metadata only, never the canary turn text or op content', async () => {
    vi.useFakeTimers();
    try {
      memoriesStore.applyExtractionOps.mockResolvedValue(undefined);
      const listUnextracted = vi.fn<() => Promise<UnextractedTurn[]>>(async () => [
        {
          messageId: 'msg_canary',
          conversationId: 'cnv_canary',
          surface: 'web_text' as MemorySurface,
          userText: `user said ${CANARY}`,
          assistantText: `assistant replied ${CANARY}`,
        },
      ]);
      const extractor = vi.fn<() => Promise<ExtractResult>>(async () => ({
        ops: [
          { op: 'add', kind: 'fact', content: `extracted op ${CANARY}`, confidence: 0.9 },
          { op: 'noop', id: 'mem_keep' },
        ],
        // One dropped secret op and one dropped sensitive op, both canary-shaped.
        dropped: { secret: 1, sensitive: 1 },
      }));
      const worker = createMemoryExtractionWorker({
        db: {} as never,
        extractor,
        embedder: fakeEmbedder(),
        listUnextracted,
        listAccounts: async () => [],
        matchMemories: async () => [],
        applyExtractionOps: memoriesStore.applyExtractionOps,
        memoryAvailable: async () => true,
        journal,
        clock: () => 1_700_000_000_000,
      });

      worker.enqueue(USER_ID);
      await vi.advanceTimersByTimeAsync(50_000);
      await worker.idle();
      await worker.stop();

      expect(hasEvent('v2.memory_extracted')).toBe(true);
      const extracted = journalLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.event === 'v2.memory_extracted')!;
      expect(extracted).toMatchObject({
        ops_add: 1,
        ops_noop: 1,
        dropped_secret: 1,
        dropped_sensitive: 1,
        confidence_bucket: 'high',
      });
      // #406: the prefilter fields are a constant and enums only, never the turn text.
      expect(extracted.prefilter_version).toBe(PREFILTER_VERSION);
      expect(['skip', 'keep']).toContain(extracted.prefilter_verdict);
      expect(['ack', 'control', 'confirmation', 'empty', 'short', 'none']).toContain(extracted.prefilter_reason);
      for (const key of ['adds_fact', 'adds_preference', 'adds_intent', 'adds_action_item']) {
        expect(typeof extracted[key]).toBe('number');
      }
      expect(['0-10', '11-40', '41-120', '120+']).toContain(extracted.user_chars_bucket);
      for (const key of ['prefilter_version', 'prefilter_verdict', 'prefilter_reason', 'user_chars_bucket']) {
        expect(String(extracted[key])).not.toContain(CANARY);
        expect(String(extracted[key])).not.toContain('user said');
      }
      expectNoCanary();
    } finally {
      vi.useRealTimers();
    }
  });

  it('path 2: retrieval journals metadata only, never memory content, on the happy and degraded paths', async () => {
    const { result } = startMemoryRetrieval(
      dummyDb,
      USER_ID,
      `query ${CANARY}`,
      retrievalDeps({
        matchMemories: async () => [
          {
            id: 'mem_1', kind: 'fact', content: `stored fact ${CANARY}`, confidence: 0.9, sensitive: false,
            conversationId: null, messageId: null, surface: 'web_text', createdAt: 0, matchSource: 'both', score: 1,
          },
        ],
        listDueSoon: async () => [
          { id: 'act_1', content: `open todo ${CANARY}`, confidence: 0.8, due_at: Date.parse('2026-09-16T13:00:00Z'), status: 'open' },
        ],
      }),
    );
    const happy = await result;
    expect(happy.block).toContain('BOB MEMORY');
    expect(happy.degraded).toBe(false);
    expect(hasEvent('v2.memory_retrieved')).toBe(true);
    expectNoCanary();
  });

  it('path 2 degraded: an embed timeout degrades to full-text and still never leaks the canary', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const timeoutEmbedder: Embedder = {
        modelId: 'fake',
        dim: 3,
        embed: (_text) =>
          new Promise<number[]>((_resolve, reject) => {
            setTimeout(() => reject(new Error('timeout')), 5000);
          }),
        embedMany: async () => [],
      };
      const { result } = startMemoryRetrieval(
        dummyDb,
        USER_ID,
        `degraded ${CANARY}`,
        retrievalDeps({
          embedder: timeoutEmbedder,
          timeoutMs: 5000,
          matchMemoriesFullText: async () => [
            {
              id: 'mem_2', kind: 'preference', content: `full-text ${CANARY}`, confidence: 0.7, sensitive: false,
              conversationId: null, messageId: null, surface: 'web_text', createdAt: 0, matchSource: 'full_text', score: 1,
            },
          ],
        }),
      );
      await vi.advanceTimersByTimeAsync(5000);
      const res = await result;
      expect(res.degraded).toBe(true);
      expect(hasEvent('v2.memory_retrieved')).toBe(true);
      expectNoCanary();
    } finally {
      vi.useRealTimers();
    }
  });

  it('path 3: remember/forget/complete_action tools and callbacks journal metadata only; a secret is refused', async () => {
    memoriesStore.findBestMatch.mockResolvedValue({ candidates: [] });
    // remember goes through applyExtractionOps directly (#758): a fresh add.
    memoriesStore.applyExtractionOps.mockResolvedValue([
      { op: 'add', memoryId: 'mem_canary', targetId: null, dupOf: null, guard: 'none' },
    ]);
    memoriesStore.deleteMemory.mockResolvedValue(true);
    actionItemsStore.completeBestMatch.mockResolvedValue({
      completed: false,
      candidates: [{ id: 'act_1', content: `todo ${CANARY}` }],
    });
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
      journal,
      turn: { conversationId: null, messageId: null, surface: 'web_text' },
    });
    const tools = createMemoryTools(callbacks) as unknown as {
      remember: { execute: (i: unknown, o: unknown) => Promise<unknown> };
      forget: { execute: (i: unknown, o: unknown) => Promise<unknown> };
      complete_action: { execute: (i: unknown, o: unknown) => Promise<unknown> };
    };

    await tools.remember.execute({ content: `remember ${CANARY}` }, {});
    await tools.forget.execute({ id: 'mem_canary' }, {});
    await tools.complete_action.execute({ query: `todo ${CANARY}` }, {});
    // A refused secret (FR-018) never reaches a callback or the journal.
    await tools.remember.execute({ content: `sk-${CANARY}${'a'.repeat(20)}` }, {});

    expect(hasEvent('v2.memory_remembered')).toBe(true);
    expect(hasEvent('v2.memory_forgotten')).toBe(true);
    expectNoCanary();
  });

  it('path 4: the /api/memories handlers journal metadata only, never the canary content', async () => {
    memoriesStore.listMemories.mockResolvedValue({
      memories: [storedMemory({ content: `stored ${CANARY}` })],
      nextCursor: null,
    });
    memoriesStore.correctMemory.mockImplementation(async (_db, _uid, id, update, embed) => {
      await embed?.(update.content);
      return storedMemory({ id: String(id), content: update.content });
    });
    memoriesStore.deleteMemory.mockResolvedValue(true);
    memoriesStore.deleteAllMemories.mockResolvedValue(3);

    const send = async (method: string, path: string, body?: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    await send('GET', '/api/memories');
    await send('PATCH', '/api/memories/mem_canary0001', { content: `corrected ${CANARY}` });
    await send('DELETE', '/api/memories/mem_canary0001');
    await send('DELETE', '/api/memories');

    for (const event of ['v2.memory_listed', 'v2.memory_corrected', 'v2.memory_deleted', 'v2.memories_deleted']) {
      expect(hasEvent(event), `expected ${event}`).toBe(true);
    }
    expectNoCanary();
  });
});