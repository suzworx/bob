// Memories + action-items API tests (010, T017, contracts/memories-api.md).
// Two halves. (1) A real HTTP server over real Postgres, with memoryAvailable()
// injected as false: every route answers 503
// memory_unavailable (M-16), 401 without a token, and 400 for bad bodies,
// queries and ids. (2) A router with an injected fake store (mocked store
// functions + memoryAvailable true) for the pagination cursor (M-02), the
// filters (M-03), a correct whose embedder fails (M-06), and the journal
// carrying no content (M-17). The store-SQL behaviour behind the routes lives
// in memories-api.db.test.ts under `npm run test:db`.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import type { Db } from '../../src/platform/db/db.ts';
import type { MemoryEmbedding, StoredMemory } from '../../src/memory/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createMemoriesRouter } from '../../src/memory/http.ts';
import { createActionItemsRouter } from '../../src/tasks/action-items-http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import {
  addAccount,
  asDb,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

// The store modules are replaced with controllable fakes so the route layer is
// exercised without a database. The memory-unavailable half never calls them
// (it short-circuits on memoryAvailable false / auth / validation); the
// injected-store half sets the implementations it needs.
const memoriesStore = vi.hoisted(() => ({
  listMemories: vi.fn(),
  correctMemory: vi.fn(),
  deleteMemory: vi.fn(),
  deleteAllMemories: vi.fn(),
}));
const actionItemsStore = vi.hoisted(() => ({
  listActionItems: vi.fn(),
  setActionItemStatus: vi.fn(),
}));
vi.mock('../../src/memory/store.ts', () => memoriesStore);
vi.mock('../../src/tasks/action-items-store.ts', () => actionItemsStore);

/** A dummy Db the injected-store router passes to memoryAvailable (unused). */
const dummyDb = { query: async (): Promise<never> => { throw new Error('unused'); }, tx: async <T>(): Promise<T> => { throw new Error('unused'); } } as unknown as Db;

/** A StoredMemory-shaped fixture whose content is never a real secret shape. */
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

function failingEmbed(): (content: string) => Promise<MemoryEmbedding> {
  return async () => {
    throw new Error('embed provider down');
  };
}

function okEmbed(): (content: string) => Promise<MemoryEmbedding> {
  return async () => ({ values: [0.5, -0.5], model: 'text-embedding-3-small', dim: 2 });
}

type ActiveSessionMiddleware = (request: Request, response: ExpressResponse, next: NextFunction) => Promise<void>;

/** Boots an HTTP server mounting the memories + action-items routers. */
async function bootServer(options: {
  getDb: () => Promise<Db>;
  memoryAvailable?: (db: Db) => Promise<boolean>;
  embed?: (content: string) => Promise<MemoryEmbedding>;
  requireActiveSession: ActiveSessionMiddleware;
}): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use(
    '/api/memories',
    createMemoriesRouter({
      getDb: options.getDb,
      memoryAvailable: options.memoryAvailable,
      embed: options.embed,
      requireActiveSession: options.requireActiveSession,
    }),
  );
  app.use('/api/action-items', createActionItemsRouter({ getDb: options.getDb, memoryAvailable: options.memoryAvailable }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function tokenFor(account: TestAccount): Promise<string> {
  return signToken({ userId: account.userId, sessionId: account.sessionId });
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

describe('memory API on a memory-disabled server (M-16, 401, 400)', () => {
  let pg: TestDb;
  let db: Db;
  let server: Server;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    token = await tokenFor(await addAccount(pg));
    const boot = await bootServer({
      getDb: () => Promise.resolve(db),
      requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
      // Memory is unavailable by DECLARATION, not by accident. This block used
      // to reach the 503 branch only because the old in-process test database
      // had no `vector` extension, so the memory migration was skipped and
      // memoryAvailable() came back false on its own. The suite now runs on real Postgres, where `vector`
      // exists and memory is available, so the premise has to be stated. The
      // second half of this file injects `true` the same way.
      memoryAvailable: () => Promise.resolve(false),
    });
    server = boot.server;
    baseUrl = boot.baseUrl;
  });

  afterAll(async () => {
    server?.close();
    await closeTestDb(pg);
  });

  it('M-16: every route answers 503 memory_unavailable, never an empty list', async () => {
    const list = await send(baseUrl, 'GET', '/api/memories', token);
    expect(list.status).toBe(503);
    expect(await list.json()).toEqual({ error: { code: 'memory_unavailable' } });

    const correct = await send(baseUrl, 'PATCH', '/api/memories/mem_abcdef01', token, { content: 'x' });
    expect(correct.status).toBe(503);

    const delOne = await send(baseUrl, 'DELETE', '/api/memories/mem_abcdef01', token);
    expect(delOne.status).toBe(503);

    const delAll = await send(baseUrl, 'DELETE', '/api/memories', token);
    expect(delAll.status).toBe(503);

    const items = await send(baseUrl, 'GET', '/api/action-items', token);
    expect(items.status).toBe(503);

    const itemPatch = await send(baseUrl, 'PATCH', '/api/action-items/ai_abcdef01', token, { status: 'done' });
    expect(itemPatch.status).toBe(503);
  });

  it('401 without a token on every route', async () => {
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/memories'],
      ['PATCH', '/api/memories/mem_abcdef01', { content: 'x' }],
      ['DELETE', '/api/memories/mem_abcdef01'],
      ['DELETE', '/api/memories'],
      ['GET', '/api/action-items'],
      ['PATCH', '/api/action-items/ai_abcdef01', { status: 'done' }],
    ];
    for (const [method, path, body] of routes) {
      const res = await send(baseUrl, method, path, null, body);
      expect(res.status).toBe(401);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'missing_token' } });
    }
  });

  it('400 for bad queries, bodies and ids', async () => {
    // bad query params
    for (const qs of ['limit=0', 'limit=101', 'kind=bogus', 'current_only=maybe', `q=${'x'.repeat(201)}`]) {
      const res = await send(baseUrl, 'GET', `/api/memories?${qs}`, token);
      expect(res.status).toBe(400);
    }
    for (const qs of ['status=bogus', 'due_before=-1', 'limit=0']) {
      const res = await send(baseUrl, 'GET', `/api/action-items?${qs}`, token);
      expect(res.status).toBe(400);
    }
    // bad bodies
    const emptyCorrect = await send(baseUrl, 'PATCH', '/api/memories/mem_abcdef01', token, { content: '   ' });
    expect(emptyCorrect.status).toBe(400);
    const badConfidence = await send(baseUrl, 'PATCH', '/api/memories/mem_abcdef01', token, { content: 'x', confidence: 1.5 });
    expect(badConfidence.status).toBe(400);
    const badStatus = await send(baseUrl, 'PATCH', '/api/action-items/ai_abcdef01', token, { status: 'nope' });
    expect(badStatus.status).toBe(400);
    // bad ids
    const badIdCorrect = await send(baseUrl, 'PATCH', '/api/memories/bad', token, { content: 'x' });
    expect(badIdCorrect.status).toBe(400);
    const badIdDelete = await send(baseUrl, 'DELETE', '/api/memories/bad', token);
    expect(badIdDelete.status).toBe(400);
    const badIdItem = await send(baseUrl, 'PATCH', '/api/action-items/bad', token, { status: 'done' });
    expect(badIdItem.status).toBe(400);
  });
});

describe('injected fake store (pagination, filters, correct, journal)', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;
  let journalLines: string[] = [];
  let currentEmbed: ((content: string) => Promise<MemoryEmbedding>) | undefined;

  beforeAll(async () => {
    token = await tokenFor({ userId: randomUUID(), sessionId: randomUUID() });
    const boot = await bootServer({
      getDb: () => Promise.resolve(dummyDb),
      memoryAvailable: () => Promise.resolve(true),
      embed: (content) => currentEmbed!(content),
      requireActiveSession: async (_request, _response, next) => { next(); },
    });
    server = boot.server;
    baseUrl = boot.baseUrl;
    setJournalSink((line) => journalLines.push(line));
    memoriesStore.correctMemory.mockImplementation(async (_db, _uid, id, update, embed) => {
      let embeddingModel: string | null = null;
      let embeddingDim: number | null = null;
      if (embed) {
        try {
          await embed(update.content);
          embeddingModel = 'text-embedding-3-small';
          embeddingDim = 1536;
        } catch {
          // embed failure: the correction persists, the embedding stays null
        }
      }
      return storedMemory({ id: String(id), content: update.content, embeddingModel, embeddingDim });
    });
    memoriesStore.deleteMemory.mockResolvedValue(true);
    memoriesStore.deleteAllMemories.mockResolvedValue(2);
    actionItemsStore.listActionItems.mockResolvedValue([]);
    actionItemsStore.setActionItemStatus.mockImplementation(async (_db, _uid, id, status) => ({
      id: String(id),
      memory_id: 'mem_abcdef01',
      content: 'water the plants',
      confidence: 0.9,
      status,
      due_at: null,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    }));
  });

  beforeEach(() => {
    journalLines = [];
    currentEmbed = okEmbed();
  });

  afterAll(async () => {
    setJournalSink(null);
    server?.close();
  });

  it('M-02: limit + cursor walk the pages and the cursor is forwarded', async () => {
    memoriesStore.listMemories
      .mockResolvedValueOnce({ memories: [storedMemory({ id: 'mem_aaaa0001' })], nextCursor: 'cur_page1' })
      .mockResolvedValueOnce({ memories: [storedMemory({ id: 'mem_bbbb0002' })], nextCursor: null });

    const page1 = await send(baseUrl, 'GET', '/api/memories?limit=1', token);
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.memories).toHaveLength(1);
    expect(body1.next_cursor).toBe('cur_page1');

    const page2 = await send(baseUrl, 'GET', `/api/memories?limit=1&cursor=${encodeURIComponent('cur_page1')}`, token);
    expect(page2.status).toBe(200);
    const body2 = await page2.json();
    expect(body2.memories).toHaveLength(1);
    expect(body2.next_cursor).toBeNull();

    expect(memoriesStore.listMemories).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ cursor: 'cur_page1', limit: 1 }),
    );
  });

  it('M-03: kind, sensitive, current_only and q filters are forwarded', async () => {
    memoriesStore.listMemories.mockResolvedValue({ memories: [], nextCursor: null });
    await send(baseUrl, 'GET', '/api/memories?kind=fact&sensitive=true&current_only=true&q=peanut', token);
    expect(memoriesStore.listMemories).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ kind: 'fact', sensitive: true, currentOnly: true, q: 'peanut' }),
    );
  });

  it('M-06: a failing embedder still corrects and journals reembedded:false', async () => {
    currentEmbed = failingEmbed();
    const res = await send(baseUrl, 'PATCH', '/api/memories/mem_abcdef01', token, { content: 'the user now likes rooibos' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe('the user now likes rooibos');
    const corrected = journalLines.map((line) => JSON.parse(line) as { event: string }).find((entry) => entry.event === 'v2.memory_corrected');
    expect(corrected).toBeDefined();
    const entry = journalLines.map((line) => JSON.parse(line) as Record<string, unknown>).find((e) => e.event === 'v2.memory_corrected')!;
    expect(entry).toMatchObject({ memory_id: 'mem_abcdef01', kind: 'fact', reembedded: false });
  });

  it('M-17: a full CRUD run journals metadata only, never content', async () => {
    const secretContent = 'the user prefers jasmine tea with lemon';
    memoriesStore.listMemories.mockResolvedValue({ memories: [storedMemory({ content: secretContent })], nextCursor: null });

    await send(baseUrl, 'GET', '/api/memories', token);
    await send(baseUrl, 'PATCH', '/api/memories/mem_abcdef01', token, { content: secretContent });
    await send(baseUrl, 'DELETE', '/api/memories/mem_abcdef01', token);
    await send(baseUrl, 'DELETE', '/api/memories', token);
    await send(baseUrl, 'GET', '/api/action-items', token);
    await send(baseUrl, 'PATCH', '/api/action-items/ai_abcdef01', token, { status: 'done' });

    const joined = journalLines.join('\n');
    expect(joined).not.toContain(secretContent);
    expect(joined).not.toContain('jasmine');
    expect(joined).not.toContain('lemon');
    const events = journalLines.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toEqual(expect.arrayContaining([
      'v2.memory_listed', 'v2.memory_corrected', 'v2.memory_deleted',
      'v2.memories_deleted', 'v2.action_items_listed', 'v2.action_item_updated',
    ]));
  });
});