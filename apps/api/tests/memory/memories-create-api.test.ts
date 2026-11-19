// POST /api/memories tests (G18, contracts/memories-api.md "POST /api/memories
// (add by hand)"), plus the PATCH /api/memories/:id secret guard (FR-018).
// DB-free: a pass-through Db drives withUser's set_config/set-role calls (no
// real rows), and the store module is mocked so applyExtractionOps/getMemory
// calls are asserted directly. The store's own duplicate check (advisory lock,
// findStoredDuplicate, the unique-index backstop) is store-internal and real
// against the local stack in memories-api.db.test.ts and
// memory-callbacks.db.test.ts; this file only proves the route wires the right
// op and reads the route's response off the store's decision.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import { StoreError, type Db } from '../../src/platform/db/db.ts';
import type { AppliedOp, MemoryEmbedding, StoredMemory } from '../../src/memory/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createMemoriesRouter } from '../../src/memory/http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';

const memoriesStore = vi.hoisted(() => ({
  listMemories: vi.fn(),
  correctMemory: vi.fn(),
  deleteMemory: vi.fn(),
  deleteAllMemories: vi.fn(),
  getMemory: vi.fn(),
  findBestMatch: vi.fn(),
  findCurrentMemoryByContent: vi.fn(),
  applyExtractionOps: vi.fn(),
}));
vi.mock('../../src/memory/store.ts', () => memoriesStore);

const passthroughDb: Db = {
  query: async <T>(): Promise<T[]> => [],
  tx: async <T>(fn: (db: Db) => Promise<T>): Promise<T> => fn(passthroughDb),
};

function storedMemory(overrides: Partial<StoredMemory> = {}): StoredMemory {
  return {
    id: 'mem_abcdef01',
    kind: 'fact',
    content: 'the user likes chai',
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

/** The store's decision for a fresh add: the row named by `memoryId`, not a duplicate. */
function addedOp(memoryId: string): AppliedOp {
  return { op: 'add', memoryId, targetId: null, dupOf: null, guard: 'none' };
}

/** The store's decision when it found the content already current: a noop pointing at `dupOf`. */
function dedupedOp(dupOf: string): AppliedOp {
  return { op: 'noop', memoryId: dupOf, targetId: null, dupOf, guard: 'find_duplicate' };
}

function okEmbed(): (content: string) => Promise<MemoryEmbedding> {
  return async () => ({ values: [0.5, -0.5], model: 'text-embedding-3-small', dim: 2 });
}

async function bootServer(options: {
  memoryAvailable: () => Promise<boolean>;
  embed: (content: string) => Promise<MemoryEmbedding>;
}): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use(
    '/api/memories',
    createMemoriesRouter({
      getDb: () => Promise.resolve(passthroughDb),
      memoryAvailable: options.memoryAvailable,
      embed: options.embed,
      requireActiveSession: async (_request: Request, _response: ExpressResponse, next: NextFunction): Promise<void> => {
        next();
      },
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function tokenFor(userId: string): Promise<string> {
  return signToken({ userId, sessionId: randomUUID() });
}

async function send(baseUrl: string, method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('POST /api/memories (add by hand, G18) and the PATCH secret guard (FR-018)', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;
  let userId: string;
  let available: boolean;
  let embedSpy: ReturnType<typeof vi.fn<(content: string) => Promise<MemoryEmbedding>>>;
  let journalLines: string[];

  beforeAll(async () => {
    userId = randomUUID();
    token = await tokenFor(userId);
    available = true;
    embedSpy = vi.fn(okEmbed());
    const boot = await bootServer({
      memoryAvailable: () => Promise.resolve(available),
      embed: (content: string) => embedSpy(content),
    });
    server = boot.server;
    baseUrl = boot.baseUrl;
  });

  afterAll(async () => {
    setJournalSink(null);
    server?.close();
  });

  beforeEach(() => {
    memoriesStore.listMemories.mockReset();
    memoriesStore.correctMemory.mockReset();
    memoriesStore.deleteMemory.mockReset();
    memoriesStore.deleteAllMemories.mockReset();
    memoriesStore.getMemory.mockReset();
    memoriesStore.findBestMatch.mockReset();
    memoriesStore.findCurrentMemoryByContent.mockReset();
    memoriesStore.applyExtractionOps.mockReset();

    memoriesStore.listMemories.mockResolvedValue({ memories: [], nextCursor: null });
    memoriesStore.findCurrentMemoryByContent.mockResolvedValue(null);
    memoriesStore.applyExtractionOps.mockImplementation(async (_db, _uid, ops) => [addedOp('mem_new0001')]);
    memoriesStore.getMemory.mockImplementation(async (_db, _uid, id) => storedMemory({ id }));
    memoriesStore.correctMemory.mockResolvedValue(storedMemory());

    available = true;
    embedSpy = vi.fn(okEmbed());
    journalLines = [];
    setJournalSink((line) => journalLines.push(line));
  });

  it('201: adds a memory by hand, trimmed content, preference kind', async () => {
    const res = await send(baseUrl, 'POST', '/api/memories', token, { content: '  likes window seats  ', kind: 'preference' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.source).toEqual({ conversation_id: null, message_id: null, surface: 'web_text' });

    expect(memoriesStore.applyExtractionOps).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      [
        expect.objectContaining({
          op: 'add',
          kind: 'preference',
          content: 'likes window seats',
          confidence: 1,
          sensitive: false,
          embedding: { values: [0.5, -0.5], model: 'text-embedding-3-small', dim: 2 },
        }),
      ],
      expect.objectContaining({ path: 'manual' }),
    );
    expect(memoriesStore.findCurrentMemoryByContent).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      'likes window seats',
    );
  });

  it('kind omitted defaults to fact', async () => {
    const res = await send(baseUrl, 'POST', '/api/memories', token, { content: 'no kind here' });
    expect(res.status).toBe(201);
    expect(memoriesStore.applyExtractionOps).toHaveBeenCalledWith(
      expect.anything(), userId, [expect.objectContaining({ kind: 'fact' })], expect.anything(),
    );
  });

  it('kind action_item: the op sent to the store carries the action_item kind', async () => {
    const res = await send(baseUrl, 'POST', '/api/memories', token, { content: 'call the dentist', kind: 'action_item' });
    expect(res.status).toBe(201);
    expect(memoriesStore.applyExtractionOps).toHaveBeenCalledWith(
      expect.anything(), userId, [expect.objectContaining({ op: 'add', kind: 'action_item' })], expect.anything(),
    );
    // The action_items row this op would create is a store-internal concern,
    // covered against the real database by memories-api.db.test.ts and
    // memory-callbacks.db.test.ts ("remember of an action item...").
  });

  it('exact duplicate: the pre-check answers 200 with the existing row, no embed, no store write', async () => {
    const existing = storedMemory({ id: 'mem_existing1', content: 'likes window seats' });
    memoriesStore.findCurrentMemoryByContent.mockResolvedValue(existing);

    const res = await send(baseUrl, 'POST', '/api/memories', token, { content: 'likes window seats' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('mem_existing1');
    expect(memoriesStore.applyExtractionOps).not.toHaveBeenCalled();
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('a fresh POST calls the pre-check, then embeds, then asks the store to write', async () => {
    const order: string[] = [];
    memoriesStore.findCurrentMemoryByContent.mockImplementation(async () => {
      order.push('findCurrentMemoryByContent');
      return null;
    });
    embedSpy = vi.fn(async () => {
      order.push('embed');
      return { values: [0.5, -0.5], model: 'text-embedding-3-small', dim: 2 };
    });
    memoriesStore.applyExtractionOps.mockImplementationOnce(async () => {
      order.push('applyExtractionOps');
      return [addedOp('mem_new0001')];
    });

    const res = await send(baseUrl, 'POST', '/api/memories', token, { content: 'fresh content' });
    expect(res.status).toBe(201);
    expect(order).toEqual(['findCurrentMemoryByContent', 'embed', 'applyExtractionOps']);
  });

  it('the store finding a duplicate under its own lock (the race) answers 200, not 201', async () => {
    memoriesStore.applyExtractionOps.mockResolvedValueOnce([dedupedOp('mem_race0001')]);
    memoriesStore.getMemory.mockImplementationOnce(async (_db, _uid, id) => storedMemory({ id, content: 'raced content' }));

    const res = await send(baseUrl, 'POST', '/api/memories', token, { content: 'raced content' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('mem_race0001');
  });

  it('different case is not an exact duplicate at the pre-check: the store still gets asked to add', async () => {
    memoriesStore.findCurrentMemoryByContent.mockResolvedValue(null);
    const res = await send(baseUrl, 'POST', '/api/memories', token, { content: 'likes window seats' });
    expect(res.status).toBe(201);
    expect(memoriesStore.applyExtractionOps).toHaveBeenCalled();
  });

  it('embed failure: 201 with embedding null and embedded:false journaled', async () => {
    embedSpy = vi.fn(async () => {
      throw new Error('embed provider down');
    });
    const res = await send(baseUrl, 'POST', '/api/memories', token, { content: 'embed will fail' });
    expect(res.status).toBe(201);
    expect(memoriesStore.applyExtractionOps).toHaveBeenCalledWith(
      expect.anything(), userId, [expect.objectContaining({ embedding: null })], expect.anything(),
    );
    const created = journalLines.map((line) => JSON.parse(line) as Record<string, unknown>).find((e) => e.event === 'v2.memory_created')!;
    expect(created).toMatchObject({ embedded: false });
  });

  it('secret on POST: 422 secret_refused, no store or embed call, journal has no text', async () => {
    const res = await send(baseUrl, 'POST', '/api/memories', token, { content: 'my PIN is 4821' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: 'secret_refused' } });
    expect(memoriesStore.applyExtractionOps).not.toHaveBeenCalled();
    expect(memoriesStore.listMemories).not.toHaveBeenCalled();
    expect(embedSpy).not.toHaveBeenCalled();
    const refused = journalLines.map((line) => JSON.parse(line) as Record<string, unknown>).find((e) => e.event === 'v2.memory_refused')!;
    expect(refused).toMatchObject({ route: 'create', reason: 'labelled' });
    expect(journalLines.join('\n')).not.toContain('4821');
  });

  it('secret on PATCH: 422, correctMemory not called; a non-secret PATCH still succeeds', async () => {
    const secretRes = await send(baseUrl, 'PATCH', '/api/memories/mem_abcdef01', token, { content: 'the password is hunter2' });
    expect(secretRes.status).toBe(422);
    expect(await secretRes.json()).toEqual({ error: { code: 'secret_refused' } });
    expect(memoriesStore.correctMemory).not.toHaveBeenCalled();

    const okRes = await send(baseUrl, 'PATCH', '/api/memories/mem_abcdef01', token, { content: 'the user now likes rooibos' });
    expect(okRes.status).toBe(200);
  });

  it('400 without any store call for invalid bodies', async () => {
    const cases: unknown[] = [
      {},
      { content: '   ' },
      { content: 'x'.repeat(2001) },
      { content: 'ok', kind: 'bogus' },
      { content: 'ok', due: '2026-01-01T00:00:00Z' },
    ];
    for (const body of cases) {
      const res = await send(baseUrl, 'POST', '/api/memories', token, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(memoriesStore.applyExtractionOps).not.toHaveBeenCalled();
    expect(memoriesStore.listMemories).not.toHaveBeenCalled();
  });

  it('503 when memory is unavailable, nothing called', async () => {
    available = false;
    const res = await send(baseUrl, 'POST', '/api/memories', token, { content: 'unreachable' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'memory_unavailable' } });
    expect(memoriesStore.applyExtractionOps).not.toHaveBeenCalled();
    expect(memoriesStore.listMemories).not.toHaveBeenCalled();
  });

  it('401 without a token', async () => {
    const res = await send(baseUrl, 'POST', '/api/memories', null, { content: 'no token' });
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'missing_token' } });
  });

  it('500 store_error when applyExtractionOps rejects with a StoreError', async () => {
    memoriesStore.applyExtractionOps.mockRejectedValue(new StoreError('x'));
    const res = await send(baseUrl, 'POST', '/api/memories', token, { content: 'this will blow up' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'store_error' } });
  });

  it('journal privacy: no journal line contains the posted content', async () => {
    const canary = `canary-create-${randomUUID().slice(0, 8)}`;
    const res = await send(baseUrl, 'POST', '/api/memories', token, { content: canary });
    expect(res.status).toBe(201);
    const joined = journalLines.join('\n');
    expect(joined).not.toContain(canary);
    const events = journalLines.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toContain('v2.memory_created');
  });
});
