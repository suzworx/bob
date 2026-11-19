// Memories + action-items API tests against the LOCAL Supabase stack (010,
// T017, contracts/memories-api.md). Real routes + the real store on the local
// stack (vector extension present, so memoryAvailable() is true): M-01..M-05,
// M-07..M-16, M-18. M-06 (re-embed fallback), M-17 (journal privacy) and the
// memory-disabled 503 path live in the default suite memories-api.test.ts;
// M-15's store-level isolation matrix is isolation-memory.db.test.ts (T009).
// Rows are seeded through the store functions under withUser; the HTTP routes
// are exercised with test-issuer JWTs. DELETE /api/memories runs
// requireActiveSession, so the active-account session is inserted into
// auth.sessions as the postgres superuser (bob_server cannot).
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import type { Db } from '../../src/platform/db/db.ts';
import {
  applyExtractionOps,
  deleteAllMemories,
  insertMemory,
  listMemories,
} from '../../src/memory/store.ts';
import { listActionItems, setActionItemStatus } from '../../src/tasks/action-items-store.ts';
import { createConversation, deleteConversation } from '../../src/conversations/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createMemoriesRouter, type MemoriesRouterDeps } from '../../src/memory/http.ts';
import { createActionItemsRouter } from '../../src/tasks/action-items-http.ts';
import { ensureLocalStack, setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';

const DIMS = 1536;

/** Deterministic 1536-dim vector so PATCH re-embedding needs no gateway call. */
function vec(seed: number): number[] {
  const values: number[] = new Array(DIMS);
  for (let i = 0; i < DIMS; i += 1) {
    values[i] = 0.5 + Math.sin(seed * 7919 + i * 12.9898) * 0.01;
  }
  return values;
}

const embed = async (content: string) => ({ values: vec(content.length), model: 'text-embedding-3-small', dim: DIMS });

/** Inserts an active auth.sessions row for the account as postgres superuser. */
async function createActiveSession(dbUrl: string, userId: string): Promise<string> {
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const sessionId = randomUUID();
    await sql`insert into auth.sessions (id, user_id) values (${sessionId}, ${userId})`;
    return sessionId;
  } finally {
    await sql.end();
  }
}

async function bootServer(deps: Partial<MemoriesRouterDeps> & { getDb: () => Promise<Db>; requireActiveSession: MemoriesRouterDeps['requireActiveSession'] }): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api/memories', createMemoriesRouter({ ...deps, memoryAvailable: deps.memoryAvailable }));
  app.use('/api/action-items', createActionItemsRouter({ getDb: deps.getDb, memoryAvailable: deps.memoryAvailable }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function send(baseUrl: string, method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('memory API (test:db, real routes + local stack)', () => {
  let env: MemoryTestDb;
  let db: Db;
  let dbUrl: string;
  let baseUrl: string;
  let server: Server;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    env = await setupMemoryTestDb();
    db = env.db;
    const statusEnv = await ensureLocalStack();
    dbUrl = statusEnv.DB_URL!;
    const sessionA = await createActiveSession(dbUrl, env.a.userId);
    tokenA = await signToken({ userId: env.a.userId, sessionId: sessionA });
    tokenB = await signToken({ userId: env.b.userId, sessionId: randomUUID() });
    const boot = await bootServer({
      getDb: () => Promise.resolve(db),
      embed,
      requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
    });
    server = boot.server;
    baseUrl = boot.baseUrl;
  });

  afterAll(async () => {
    server?.close();
    await env.cleanup();
  });

  // Each test is self-contained: account a's memories/action items are wiped
  // first so ordering and page-count assertions stay exact.
  async function resetAccount(): Promise<void> {
    await deleteAllMemories(db, env.a.userId);
  }

  it('M-01: GET returns own rows newest first, with source and sensitive', async () => {
    await resetAccount();
    const conversation = await createConversation(db, env.a.userId, 'src');
    await insertMemory(db, env.a.userId, {
      kind: 'fact', content: 'first memory', confidence: 0.8,
      conversationId: conversation.id, surface: 'web_text',
    });
    await insertMemory(db, env.a.userId, {
      kind: 'preference', content: 'second memory', confidence: 0.7, sensitive: true, surface: 'device',
    });
    const res = await send(baseUrl, 'GET', '/api/memories', tokenA);
    expect(res.status).toBe(200);
    const body = await res.json();
    const own = body.memories as Array<{ content: string; sensitive: boolean; source: { conversation_id: string | null; surface: string }; kind: string }>;
    expect(own.map((m) => m.content)).toEqual(['second memory', 'first memory']); // newest first
    expect(own[0]!.sensitive).toBe(true);
    expect(own[1]!.source.conversation_id).toBe(conversation.id);
    expect(own[1]!.source.surface).toBe('web_text');
    expect(own[1]!.kind).toBe('fact');
  });

  it('M-04: empty store → 200 { memories: [], next_cursor: null }, never 404', async () => {
    await resetAccount();
    const res = await send(baseUrl, 'GET', '/api/memories', tokenA);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memories: [], next_cursor: null });
  });

  it('M-02: limit + cursor walk the full set exactly once, no dupes or gaps', async () => {
    await resetAccount();
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const memory = await insertMemory(db, env.a.userId, {
        kind: 'fact', content: `fact number ${i}`, confidence: 0.5,
      });
      ids.push(memory.id);
    }
    const walked: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const qs = cursor ? `?limit=3&cursor=${encodeURIComponent(cursor)}` : '?limit=3';
      const res = await send(baseUrl, 'GET', `/api/memories${qs}`, tokenA);
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const m of body.memories) walked.push(m.id);
      cursor = body.next_cursor;
      if (cursor === null) break;
    }
    expect(walked).toHaveLength(7);
    expect(new Set(walked).size).toBe(7);
  });

  it('M-03: kind, sensitive, current_only and q filters narrow correctly', async () => {
    await resetAccount();
    await insertMemory(db, env.a.userId, { kind: 'fact', content: 'the user is allergic to peanuts', confidence: 0.9 });
    await insertMemory(db, env.a.userId, { kind: 'preference', content: 'the user likes gardening', confidence: 0.8 });
    await insertMemory(db, env.a.userId, { kind: 'fact', content: 'the user is allergic to cats', confidence: 0.7, sensitive: true });
    const car = await insertMemory(db, env.a.userId, { kind: 'fact', content: 'the user drives a blue car', confidence: 0.6 });

    const kind = await (await send(baseUrl, 'GET', '/api/memories?kind=fact', tokenA)).json();
    expect(kind.memories.map((m: { content: string }) => m.content).sort()).toEqual([
      'the user drives a blue car', 'the user is allergic to cats', 'the user is allergic to peanuts',
    ]);

    const sensitive = await (await send(baseUrl, 'GET', '/api/memories?sensitive=true', tokenA)).json();
    expect(sensitive.memories.map((m: { content: string }) => m.content)).toEqual(['the user is allergic to cats']);

    const q = await (await send(baseUrl, 'GET', '/api/memories?q=PEANUT', tokenA)).json();
    expect(q.memories.map((m: { content: string }) => m.content)).toEqual(['the user is allergic to peanuts']);

    // Supersede the car fact: default keeps it, current_only drops it.
    await applyExtractionOps(db, env.a.userId,
      [{ op: 'supersede', id: car.id, content: 'the user drives a red car', confidence: 0.6 }],
      { source: { conversationId: null, messageId: null, surface: 'web_text' } });
    const all = await (await send(baseUrl, 'GET', '/api/memories', tokenA)).json();
    const current = await (await send(baseUrl, 'GET', '/api/memories?current_only=true', tokenA)).json();
    expect(all.memories.some((m: { content: string }) => m.content === 'the user drives a blue car')).toBe(true);
    expect(current.memories.some((m: { content: string }) => m.content === 'the user drives a blue car')).toBe(false);
  });

  it('M-05: PATCH updates content and bumps updated_at', async () => {
    await resetAccount();
    const memory = await insertMemory(db, env.a.userId, { kind: 'fact', content: 'the user prefers tea', confidence: 0.8 });
    const res = await send(baseUrl, 'PATCH', `/api/memories/${memory.id}`, tokenA, { content: 'the user prefers green tea', confidence: 0.9 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe('the user prefers green tea');
    expect(body.confidence).toBe(0.9);
    expect(body.updated_at).toBeGreaterThanOrEqual(memory.updatedAt);
  });

  it('M-07: DELETE /api/memories/:id → 204, row gone from a later GET', async () => {
    await resetAccount();
    const memory = await insertMemory(db, env.a.userId, { kind: 'fact', content: 'delete me once', confidence: 0.5 });
    const res = await send(baseUrl, 'DELETE', `/api/memories/${memory.id}`, tokenA);
    expect(res.status).toBe(204);
    const list = await (await send(baseUrl, 'GET', '/api/memories', tokenA)).json();
    expect(list.memories.some((m: { id: string }) => m.id === memory.id)).toBe(false);
  });

  it('M-08: DELETE /api/memories/:id twice → 204 both times (idempotent)', async () => {
    await resetAccount();
    const memory = await insertMemory(db, env.a.userId, { kind: 'fact', content: 'delete twice', confidence: 0.5 });
    const first = await send(baseUrl, 'DELETE', `/api/memories/${memory.id}`, tokenA);
    expect(first.status).toBe(204);
    const second = await send(baseUrl, 'DELETE', `/api/memories/${memory.id}`, tokenA);
    expect(second.status).toBe(204);
  });

  it('M-09: DELETE /api/memories → 204 deletes all; action items cascade', async () => {
    await resetAccount();
    await applyExtractionOps(db, env.a.userId,
      [
        { op: 'add', kind: 'action_item', content: 'book a dentist appointment', confidence: 0.95, dueAt: Date.now() + 86_400_000 },
        { op: 'add', kind: 'fact', content: 'the user prefers mornings', confidence: 0.8 },
      ],
      { source: { conversationId: null, messageId: null, surface: 'web_text' } });
    const res = await send(baseUrl, 'DELETE', '/api/memories', tokenA);
    expect(res.status).toBe(204);
    expect((await listMemories(db, env.a.userId, {})).memories).toEqual([]);
    expect((await listActionItems(db, env.a.userId))).toEqual([]);
  });

  it('M-10: DELETE /api/memories with an inactive session → 401 invalid_token', async () => {
    const inactive = await signToken({ userId: env.a.userId, sessionId: randomUUID() });
    const res = await send(baseUrl, 'DELETE', '/api/memories', inactive);
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'invalid_token' } });
  });

  it('M-11: GET /api/action-items lists open first, due ascending, hides nothing by default', async () => {
    await resetAccount();
    const late = await applyActionItem('email Dana', Date.now() + 86_400_000);
    const early = await applyActionItem('water the plants', Date.now() + 3_600_000);
    await applyActionItem('book a dentist appointment', Date.now() + 172_800_000);
    await setActionItemStatus(db, env.a.userId, late.id, 'done');
    await applyActionItem('walk the dog', null);

    const res = await send(baseUrl, 'GET', '/api/action-items', tokenA);
    expect(res.status).toBe(200);
    const body = await res.json();
    const open = body.action_items.filter((i: { status: string }) => i.status === 'open').map((i: { content: string }) => i.content);
    expect(open[0]).toBe('water the plants'); // earliest due first among open
    expect(open).toContain('walk the dog');
    // done is hidden by default ordering but present when not filtered out
    expect(body.action_items.some((i: { content: string }) => i.content === 'email Dana')).toBe(true);
  });

  it('M-12: PATCH {status:"done"} → the item is not listed as open', async () => {
    await resetAccount();
    const item = await applyActionItem('file the report', null);
    const res = await send(baseUrl, 'PATCH', `/api/action-items/${item.id}`, tokenA, { status: 'done' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('done');
    const list = await (await send(baseUrl, 'GET', '/api/action-items', tokenA)).json();
    const open = list.action_items.filter((i: { status: string }) => i.status === 'open');
    expect(open.some((i: { id: string }) => i.id === item.id)).toBe(false);
  });

  it('M-13: PATCH {status:"dropped"} → terminal, not listed as open', async () => {
    await resetAccount();
    const item = await applyActionItem('skip the meeting', null);
    const res = await send(baseUrl, 'PATCH', `/api/action-items/${item.id}`, tokenA, { status: 'dropped' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('dropped');
    const list = await (await send(baseUrl, 'GET', '/api/action-items?status=open', tokenA)).json();
    expect(list.action_items.some((i: { id: string }) => i.id === item.id)).toBe(false);
  });

  it('M-14: another account\'s id answers 404 (PATCH) / 204 (DELETE), identical to unknown', async () => {
    await resetAccount();
    const memory = await insertMemory(db, env.a.userId, { kind: 'fact', content: 'A memory', confidence: 0.8 });
    const item = await applyActionItem('A task', null);

    const theirCorrect = await send(baseUrl, 'PATCH', `/api/memories/${memory.id}`, tokenB, { content: 'hijacked' });
    const unknownCorrect = await send(baseUrl, 'PATCH', '/api/memories/mem_unknown00', tokenB, { content: 'hijacked' });
    expect(theirCorrect.status).toBe(404);
    expect(unknownCorrect.status).toBe(404);
    expect(await theirCorrect.text()).toBe(await unknownCorrect.text());

    const theirItem = await send(baseUrl, 'PATCH', `/api/action-items/${item.id}`, tokenB, { status: 'done' });
    const unknownItem = await send(baseUrl, 'PATCH', '/api/action-items/ai_unknown00', tokenB, { status: 'done' });
    expect(theirItem.status).toBe(404);
    expect(unknownItem.status).toBe(404);

    const theirDelete = await send(baseUrl, 'DELETE', `/api/memories/${memory.id}`, tokenB);
    expect(theirDelete.status).toBe(204); // no oracle on delete
    // A's memory is untouched.
    expect((await listMemories(db, env.a.userId, {})).memories.some((m) => m.id === memory.id)).toBe(true);
  });

  it('M-15: two-account matrix — B sees and changes nothing of A\'s (HTTP half)', async () => {
    await resetAccount();
    const memory = await insertMemory(db, env.a.userId, { kind: 'fact', content: 'the user has a garden', confidence: 0.7 });
    await applyActionItem('mow the lawn', null);
    const bList = await (await send(baseUrl, 'GET', '/api/memories', tokenB)).json();
    expect(bList.memories).toEqual([]);
    const bItems = await (await send(baseUrl, 'GET', '/api/action-items', tokenB)).json();
    expect(bItems.action_items).toEqual([]);
    // B cannot read A's memory by id either (no oracle).
    const readById = await send(baseUrl, 'PATCH', `/api/memories/${memory.id}`, tokenB, { content: 'tampered' });
    expect(readById.status).toBe(404);
  });

  it('M-16: memory disabled → 503 memory_unavailable, never an empty list', async () => {
    const off = await bootServer({
      getDb: () => Promise.resolve(db),
      memoryAvailable: async () => false,
      requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
    });
    try {
      const res = await send(off.baseUrl, 'GET', '/api/memories', tokenA);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { code: 'memory_unavailable' } });
    } finally {
      off.server.close();
    }
  });

  it('M-18: a deleted source conversation leaves conversation_id null, memory still listed', async () => {
    await resetAccount();
    const conversation = await createConversation(db, env.a.userId, 'source conversation');
    const memory = await insertMemory(db, env.a.userId, {
      kind: 'fact', content: 'the user keeps a journal', confidence: 0.7, conversationId: conversation.id,
    });
    await deleteConversation(db, env.a.userId, conversation.id);
    const res = await send(baseUrl, 'GET', '/api/memories', tokenA);
    const body = await res.json();
    const found = body.memories.find((m: { id: string }) => m.id === memory.id);
    expect(found).toBeDefined();
    expect(found.source.conversation_id).toBeNull();
  });

  /** Seeding helper: creates an action item for account a and returns its row. */
  async function applyActionItem(content: string, dueAt: number | null): Promise<{ id: string }> {
    const ops = [{ op: 'add' as const, kind: 'action_item' as const, content, confidence: 0.9, ...(dueAt !== null ? { dueAt } : {}) }];
    const created = await applyExtractionOps(db, env.a.userId, ops, { source: { conversationId: null, messageId: null, surface: 'web_text' } });
    void created;
    const items = await listActionItems(db, env.a.userId, {});
    return { id: items.find((i) => i.content === content)!.id };
  }
});