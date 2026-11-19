// test:db suite for the memory-extraction worker (010, T010). Runs against the
// LOCAL Supabase stack only -- it needs the `vector` extension -- so it is excluded from the default run and executes under `npm run
// test:db` (db-harness brings the stack up, applies the migrations, and creates
// two throwaway accounts). The extractor and embedder are deterministic fakes;
// the store functions, the real match_memories/applyExtractionOps, and the real
// worker wiring are exercised against real persisted rows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { createMemoryExtractionWorker } from '../../src/memory/extract.ts';
import { memoryAvailable } from '../../src/memory/available.ts';
import { listAccountsWithUnextracted, listUnextracted } from '../../src/memory/extract-queue.ts';
import { applyExtractionOps, matchMemories } from '../../src/memory/store.ts';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

const DIMS = 1536;

/** Deterministic 1536-dim pseudo-random vector near 0.5 on every axis, so any
 *  two generated vectors are cosine-close and the semantic arm returns rows. */
function vec(seed: number): number[] {
  const values: number[] = new Array(DIMS);
  for (let i = 0; i < DIMS; i += 1) {
    values[i] = 0.5 + Math.sin(seed * 7919 + i * 12.9898) * 0.01;
  }
  return values;
}

/** A deterministic fake embedder: returns a stable vector per input. */
function fakeEmbedder() {
  let seed = 1;
  return {
    modelId: 'text-embedding-3-small',
    dim: DIMS,
    async embed(text: string): Promise<number[]> {
      return vec(seed + text.length);
    },
    async embedMany(texts: string[]): Promise<number[][]> {
      return texts.map((text) => vec(seed++ + text.length));
    },
  };
}

describe('memory extraction worker (test:db)', () => {
  let env: MemoryTestDb;

  beforeAll(async () => {
    env = await setupMemoryTestDb();
    expect(await memoryAvailable(env.db)).toBe(true);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('extracts a real persisted turn, writes memories, sets the marker, and is a no-op on re-run', async () => {
    const conversation = await createConversation(env.db, env.a.userId, 'extraction source');
    const userMessage = (await appendMessage(env.db, env.a.userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'I work from home on Fridays.' }],
    }))!;
    await appendMessage(env.db, env.a.userId, conversation.id, {
      role: 'assistant',
      parts: [{ type: 'text', text: 'Noted.' }],
    });

    // Deterministic extractor: one add op drawn from the user text.
    const extractor = async (input: { userText: string }) => ({
      ops: [
        {
          op: 'add',
          kind: 'fact',
          content: `the user ${input.userText.replace('I ', '')}`,
          confidence: 0.9,
        },
      ],
      dropped: { secret: 0, sensitive: 0 },
    });

    const worker = createMemoryExtractionWorker({
      db: env.db,
      extractor: extractor as never,
      embedder: fakeEmbedder(),
      listUnextracted,
      listAccounts: listAccountsWithUnextracted,
      matchMemories,
      applyExtractionOps,
      memoryAvailable,
      journal: () => undefined,
      clock: () => Date.now(),
      debounceMs: 0,
    });

    worker.enqueue(env.a.userId);
    await worker.idle();

    // The memory row exists with the source and confidence (FR-004, FR-006).
    const matches = await matchMemories(env.db, env.a.userId, {
      queryText: 'work from home Friday',
      queryEmbedding: vec(1),
      matchCount: 8,
    });
    expect(matches.some((match) => match.content.includes('work from home on Fridays'))).toBe(true);

    // memory_extracted_at is set on the user message (R11, same transaction).
    const unextracted = await listUnextracted(env.db, env.a.userId, 200);
    expect(unextracted.some((turn) => turn.messageId === userMessage.id)).toBe(false);

    // A second run extracts nothing new (no-op).
    await worker.enqueue(env.a.userId);
    await worker.idle();
    const still = await listUnextracted(env.db, env.a.userId, 200);
    expect(still).toEqual([]);
  });

  it('the startup scan finds unextracted messages for BOTH accounts (R11)', async () => {
    // Two accounts, each with an unextracted user message. The old base-store
    // query ran outside withUser with auth.uid() null, so FORCE RLS returned
    // zero rows -- the startup scan silently enqueued nobody. The fix routes
    // the scan through bob_private.accounts_with_unextracted (SECURITY
    // DEFINER) via asServer, which must see both accounts.
    for (const account of [env.a, env.b]) {
      const conversation = await createConversation(env.db, account.userId, 'scan source');
      await appendMessage(env.db, account.userId, conversation.id, {
        role: 'user',
        parts: [{ type: 'text', text: 'untouched scan turn' }],
      });
    }

    const accounts = await listAccountsWithUnextracted(env.db, 0, 100);
    const ids = accounts.map((row) => row.userId);
    expect(ids).toContain(env.a.userId);
    expect(ids).toContain(env.b.userId);
  });
});