// test:db suite for #756 PR4 (local Supabase stack only): personal memory is
// extracted only from private-space conversations. Shared (pair/group) user
// turns never reach listUnextracted or the startup scan, a private turn next to
// a shared one is the only one extracted, and every new memory (extracted,
// remembered, added by hand) carries the private space_id. Skips without Docker.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { memoryAvailable } from '../../src/memory/available.ts';
import { resetMemorySpaceColumn } from '../../src/memory/space-column.ts';
import { createMemoryCallbacks } from '../../src/memory/callbacks.ts';
import { createMemoryExtractionWorker } from '../../src/memory/extract.ts';
import { listAccountsWithUnextracted, listUnextracted } from '../../src/memory/extract-queue.ts';
import { createMemoriesRouter } from '../../src/memory/http.ts';
import { applyExtractionOps, matchMemories } from '../../src/memory/store.ts';
import { ensureLocalStack, setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

const MIGRATION = readFileSync(
  new URL('../../../../supabase/migrations/20261002130000_memory_extract_private_only.sql', import.meta.url),
  'utf8',
);
const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
const vec = (): number[] => new Array(1536).fill(0.5);
const embedder = { modelId: 'text-embedding-3-small', dim: 1536, embed: async () => vec(), embedMany: async (t: string[]) => t.map(vec) };

describe.skipIf(!dockerUp)('memory space gate (#756, test:db)', () => {
  let env: MemoryTestDb;
  let admin: postgres.Sql;

  /** A user turn in a shared space, seeded as the server path (RLS bypassed). */
  async function seedShared(spaceId: string, authorId: string, text: string): Promise<string> {
    const conversationId = `cnv_${randomUUID()}`;
    const messageId = `msg_${randomUUID()}`;
    await admin.unsafe(
      `insert into bob.conversations (id, user_id, space_id, created_by, title) values ($1, $2, $3, $2, 'Family')`,
      [conversationId, authorId, spaceId],
    );
    await admin.unsafe(
      `insert into bob.messages (id, conversation_id, space_id, user_id, author_user_id, role, position, sequence, origin)
       values ($1, $2, $3, $4, $4, 'user', 0, 1, 'web_text')`,
      [messageId, conversationId, spaceId, authorId],
    );
    await admin.unsafe(
      `insert into bob.message_versions (id, message_id, user_id, space_id, parts, version_index, is_selected)
       values ('ver_' || $1, $1, $2, $3, $4::jsonb, 0, true)`,
      [messageId, authorId, spaceId, JSON.stringify([{ type: 'text', text }])],
    );
    return messageId;
  }

  const spaceOf = async (userId: string, content: string): Promise<string | null> =>
    (await admin.unsafe<Array<{ s: string | null }>>(
      `select space_id::text as s from bob.memories where user_id = $1 and content = $2`, [userId, content],
    ))[0]?.s ?? null;

  beforeAll(async () => {
    const status = await ensureLocalStack();
    env = await setupMemoryTestDb();
    admin = postgres(status.DB_URL!, { max: 1, prepare: true });
    await admin.unsafe(MIGRATION);
    resetMemorySpaceColumn();
    expect(await memoryAvailable(env.db)).toBe(true);
  });

  afterAll(async () => {
    await admin?.end();
    await env?.cleanup();
  });

  it('shared pair and group turns are not unextracted work and their authors are not scanned', async () => {
    const group = await seedShared(env.spaces.groupABC, env.c.userId, 'our family trip is in May');
    const pair = await seedShared(env.spaces.pairAB, env.b.userId, 'we share the car on Sundays');
    expect((await listUnextracted(env.db, env.c.userId, 200)).map((t) => t.messageId)).not.toContain(group);
    expect((await listUnextracted(env.db, env.b.userId, 200)).map((t) => t.messageId)).not.toContain(pair);
    const scanned = (await listAccountsWithUnextracted(env.db, Date.now() - 600_000, 100)).map((r) => r.userId);
    expect(scanned).not.toContain(env.c.userId);
    expect(scanned).not.toContain(env.b.userId);
  });

  it('extracts only the private turn next to an unextracted shared one, stamped with the private space', async () => {
    const shared = await seedShared(env.spaces.groupABC, env.a.userId, 'the family wifi password is in the drawer');
    const conversation = await createConversation(env.db, env.a.userId, 'General');
    await appendMessage(env.db, env.a.userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'I like green tea' }] });
    const extractor = vi.fn(async (input: { userText: string }) => ({
      ops: [{ op: 'add', kind: 'preference', content: `the user said ${input.userText}`, confidence: 0.9 }],
      dropped: { secret: 0, sensitive: 0 },
    }));
    const worker = createMemoryExtractionWorker({
      db: env.db, extractor: extractor as never, embedder, listUnextracted, listAccounts: listAccountsWithUnextracted,
      matchMemories, applyExtractionOps, memoryAvailable, journal: () => undefined, clock: () => Date.now(), debounceMs: 0,
    });
    worker.enqueue(env.a.userId);
    await worker.idle();
    expect(extractor.mock.calls.map(([input]) => input.userText)).toEqual(['I like green tea']);
    expect(await spaceOf(env.a.userId, 'the user said I like green tea')).toBe(env.spaces.privateA);
    const marker = await admin.unsafe<Array<{ at: unknown }>>(`select memory_extracted_at as at from bob.messages where id = $1`, [shared]);
    expect(marker[0]?.at).toBeNull();
  });

  it('remember and a manual add carry the private space', async () => {
    await createMemoryCallbacks(env.db, env.a.userId).remember({ content: 'my bike is blue', kind: 'fact' } as never);
    // remember stores the canonical voice (#767): "my bike" is kept as "User's bike".
    expect(await spaceOf(env.a.userId, "User's bike is blue")).toBe(env.spaces.privateA);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { account: { userId: string } }).account = { userId: env.a.userId }; next(); });
    app.use('/api/memories', createMemoriesRouter({ getDb: async () => env.db, requireActiveSession: async (_q, _s, next) => next() }));
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/memories`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'I run on Tuesdays' }),
      });
      expect(res.status).toBe(201);
    } finally {
      server.close();
    }
    expect(await spaceOf(env.a.userId, 'I run on Tuesdays')).toBe(env.spaces.privateA);
  });
});
