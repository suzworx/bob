// test:db suite for store/memories.ts (010, T006). Runs against the LOCAL
// Supabase stack only -- it needs the `vector` extension -- so
// this file is excluded from the default run and executes under `npm run
// test:db` (apps/api/vitest.db.config.ts; db-harness brings the stack up,
// applies the migrations, and creates two throwaway accounts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TARGET_FLOOR } from '../../src/memory/callbacks.ts';
import { appendMessage, createConversation, deleteConversation } from '../../src/conversations/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import {
  applyExtractionOps,
  correctMemory,
  deleteAllMemories,
  deleteMemory,
  findBestMatch,
  findCurrentMemoryByContent,
  getMemory,
  insertMemory,
  listMemories,
  matchMemories,
  matchMemoriesFullText,
  type MemoryEmbedding,
} from '../../src/memory/store.ts';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

const DIMS = 1536;

/** Deterministic 1536-dim pseudo-random vector, every axis near 0.5, so any
 *  two generated vectors are cosine-close and the semantic arm of
 *  match_memories returns every seeded row for a same-shape query vector. */
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

describe('store/memories (test:db)', () => {
  let env: MemoryTestDb;
  let a: { userId: string };

  beforeAll(async () => {
    env = await setupMemoryTestDb();
    a = { userId: env.a.userId };
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('inserts, reads, lists, and deletes a memory (CRUD round-trip)', async () => {
    const memory = await insertMemory(env.db, a.userId, {
      kind: 'fact',
      content: 'the user likes chai',
      confidence: 0.9,
    });
    expect(memory.id).toMatch(/^mem_/);

    const got = await getMemory(env.db, a.userId, memory.id);
    expect(got).toMatchObject({
      id: memory.id,
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
    });
    expect(typeof got!.createdAt).toBe('number');
    expect(typeof got!.updatedAt).toBe('number');

    const list = await listMemories(env.db, a.userId, {});
    expect(list.memories.map((entry) => entry.id)).toContain(memory.id);

    expect(await deleteMemory(env.db, a.userId, memory.id)).toBe(true);
    expect(await getMemory(env.db, a.userId, memory.id)).toBeNull();
  });

  it('pagination walks the full set exactly once on (created_at desc, id desc)', async () => {
    await deleteAllMemories(env.db, a.userId); // self-contained: exact page count below
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const memory = await insertMemory(env.db, a.userId, {
        kind: 'fact',
        content: `fact number ${i}`,
        confidence: 0.5,
      });
      ids.push(memory.id);
    }
    // Force an exact created_at tie among three rows so the id tie-break runs.
    await withUser(env.db, a.userId, async (db) => {
      await db.query(
        `UPDATE bob.memories SET created_at = to_timestamp($1 / 1000.0)
         WHERE id = ANY($2)`,
        [1_700_000_000_000, [ids[0]!, ids[1]!, ids[2]!]],
      );
    });
    const truth = await withUser(env.db, a.userId, async (db) => {
      const rows = await db.query<{ id: string }>(
        `SELECT id FROM bob.memories WHERE user_id = $1
         ORDER BY created_at DESC, id DESC`,
        [a.userId],
      );
      return rows.map((row) => row.id);
    });

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page = await listMemories(env.db, a.userId, {
        limit: 4,
        cursor: cursor ?? undefined,
      });
      walked.push(...page.memories.map((entry) => entry.id));
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(walked).toEqual(truth);
    expect(new Set(walked).size).toBe(truth.length);
    expect(pages).toBe(Math.ceil(10 / 4));
  });

  it('applies each list filter: kind, sensitive, q, current_only', async () => {
    await deleteAllMemories(env.db, a.userId); // self-contained: exact kind set below
    const peanut = await insertMemory(env.db, a.userId, {
      kind: 'fact',
      content: 'the user is allergic to peanuts',
      confidence: 0.9,
    });
    await insertMemory(env.db, a.userId, {
      kind: 'preference',
      content: 'the user likes gardening',
      confidence: 0.8,
    });
    await applyExtractionOps(
      env.db,
      a.userId,
      [{ op: 'add', kind: 'action_item', content: 'email Dana', confidence: 0.95 }],
      { source: { conversationId: null, messageId: null, surface: 'web_text' } },
    );
    const cat = await insertMemory(env.db, a.userId, {
      kind: 'fact',
      content: 'the user is allergic to cats',
      confidence: 0.7,
      sensitive: true,
    });
    const car = await insertMemory(env.db, a.userId, {
      kind: 'fact',
      content: 'the user drives a blue car',
      confidence: 0.6,
    });

    const facts = await listMemories(env.db, a.userId, { kind: 'fact' });
    expect(facts.memories.map((entry) => entry.content).sort()).toEqual([
      'the user drives a blue car',
      'the user is allergic to cats',
      'the user is allergic to peanuts',
    ]);

    const sensitive = await listMemories(env.db, a.userId, { sensitive: true });
    expect(sensitive.memories.map((entry) => entry.id)).toEqual([cat.id]);

    const q = await listMemories(env.db, a.userId, { q: 'PEANUT' });
    expect(q.memories.map((entry) => entry.id)).toEqual([peanut.id]);

    // Supersede the car fact: the default listing keeps it, current_only drops it.
    await applyExtractionOps(
      env.db,
      a.userId,
      [{ op: 'supersede', id: car.id, content: 'the user drives a red car', confidence: 0.6 }],
      { source: { conversationId: null, messageId: null, surface: 'web_text' } },
    );
    const all = await listMemories(env.db, a.userId, {});
    const current = await listMemories(env.db, a.userId, { currentOnly: true });
    expect(all.memories.some((entry) => entry.id === car.id)).toBe(true);
    expect(current.memories.some((entry) => entry.id === car.id)).toBe(false);
  });

  it('correct rewrites content, bumps updated_at, and nulls embedding on embed failure', async () => {
    const memory = await insertMemory(env.db, a.userId, {
      kind: 'fact',
      content: 'the user prefers tea',
      confidence: 0.8,
      embedding: embed(1),
    });
    const before = (await getMemory(env.db, a.userId, memory.id))!;
    const failingEmbed = async (): Promise<MemoryEmbedding> => {
      throw new Error('embed provider down');
    };
    const corrected = await correctMemory(
      env.db,
      a.userId,
      memory.id,
      { content: 'the user prefers green tea', confidence: 0.9 },
      failingEmbed,
    );
    expect(corrected.content).toBe('the user prefers green tea');
    expect(corrected.confidence).toBe(0.9);
    expect(corrected.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);

    await withUser(env.db, a.userId, async (db) => {
      const rows = await db.query<{ embedding: unknown; model: unknown; dim: unknown }>(
        `SELECT embedding, embedding_model AS model, embedding_dim AS dim
         FROM bob.memories WHERE id = $1`,
        [memory.id],
      );
      expect(rows[0]!.embedding).toBeNull();
      expect(rows[0]!.model).toBeNull();
      expect(rows[0]!.dim).toBeNull();
    });

    // The success path writes the vector provenance.
    await correctMemory(env.db, a.userId, memory.id, { content: 'the user prefers green tea' }, () =>
      Promise.resolve(embed(2)),
    );
    await withUser(env.db, a.userId, async (db) => {
      const rows = await db.query<{ model: unknown; dim: unknown }>(
        `SELECT embedding_model AS model, embedding_dim AS dim
         FROM bob.memories WHERE id = $1`,
        [memory.id],
      );
      expect(rows[0]!.model).toBe('text-embedding-3-small');
      expect(Number(rows[0]!.dim)).toBe(DIMS);
    });

    await expect(
      correctMemory(env.db, a.userId, 'mem_unknown', { content: 'x' }),
    ).rejects.toThrow(/not found/);
  });

  it('delete is idempotent and unknown ids answer false (no oracle)', async () => {
    const memory = await insertMemory(env.db, a.userId, {
      kind: 'fact',
      content: 'delete me once',
      confidence: 0.5,
    });
    expect(await deleteMemory(env.db, a.userId, memory.id)).toBe(true);
    expect(await deleteMemory(env.db, a.userId, memory.id)).toBe(false);
    expect(await deleteMemory(env.db, a.userId, 'mem_unknown')).toBe(false);
  });

  it('delete-all removes every memory and cascades action items', async () => {
    await applyExtractionOps(
      env.db,
      a.userId,
      [
        {
          op: 'add',
          kind: 'action_item',
          content: 'book a dentist appointment',
          confidence: 0.95,
          dueAt: Date.now() + 86_400_000,
        },
        { op: 'add', kind: 'fact', content: 'the user prefers mornings', confidence: 0.8 },
      ],
      { source: { conversationId: null, messageId: null, surface: 'web_text' } },
    );
    await withUser(env.db, a.userId, async (db) => {
      const items = await db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM bob.action_items WHERE user_id = $1`,
        [a.userId],
      );
      expect(items[0]!.total).toBeGreaterThan(0);
    });

    const deleted = await deleteAllMemories(env.db, a.userId);
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect((await listMemories(env.db, a.userId, {})).memories).toEqual([]);
    await withUser(env.db, a.userId, async (db) => {
      const items = await db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM bob.action_items WHERE user_id = $1`,
        [a.userId],
      );
      expect(items[0]!.total).toBe(0);
    });
  });

  it('supersede sets superseded_by and both match arms exclude the old row', async () => {
    const old = await insertMemory(env.db, a.userId, {
      kind: 'fact',
      content: 'the user loves rainy days',
      confidence: 0.8,
      embedding: embed(10),
    });
    await applyExtractionOps(
      env.db,
      a.userId,
      [
        {
          op: 'supersede',
          id: old.id,
          content: 'the user now loves sunny days',
          confidence: 0.9,
          embedding: embed(11),
        },
      ],
      { source: { conversationId: null, messageId: null, surface: 'web_text' } },
    );

    const oldRow = (await getMemory(env.db, a.userId, old.id))!;
    expect(oldRow.supersededBy).toBeTruthy();
    const replacement = (await getMemory(env.db, a.userId, oldRow.supersededBy!))!;
    expect(replacement.kind).toBe('fact'); // inherited from the old row
    expect(replacement.content).toBe('the user now loves sunny days');

    const hybrid = await matchMemories(env.db, a.userId, {
      queryText: 'rainy sunny days',
      queryEmbedding: vec(12),
      matchCount: 8,
    });
    expect(hybrid.some((match) => match.id === old.id)).toBe(false);
    expect(hybrid.some((match) => match.id === replacement.id)).toBe(true);

    const fullText = await matchMemoriesFullText(env.db, a.userId, {
      queryText: 'rainy',
      matchCount: 8,
    });
    expect(fullText.some((match) => match.id === old.id)).toBe(false);
  });

  it('applyExtractionOps writes the message marker and action-item due_at in one transaction', async () => {
    const conversation = await createConversation(env.db, a.userId, 'extraction source');
    const message = (await appendMessage(env.db, a.userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'remind me to water the plants tomorrow' }],
    }))!;
    const dueAt = Date.now() + 86_400_000;
    await applyExtractionOps(
      env.db,
      a.userId,
      [{ op: 'add', kind: 'action_item', content: 'water the plants', confidence: 0.9, dueAt }],
      {
        source: { conversationId: conversation.id, messageId: message.id, surface: 'web_text' },
        markMessageId: message.id,
      },
    );
    await withUser(env.db, a.userId, async (db) => {
      const marker = await db.query<{ extracted: unknown }>(
        `SELECT memory_extracted_at AS extracted FROM bob.messages WHERE id = $1`,
        [message.id],
      );
      expect(marker[0]!.extracted).not.toBeNull();
      const items = await db.query<{ due: unknown; status: unknown }>(
        `SELECT floor(extract(epoch from due_at) * 1000)::bigint AS due, status
         FROM bob.action_items JOIN bob.memories m ON m.id = memory_id
         WHERE m.user_id = $1`,
        [a.userId],
      );
      const item = items.find((row) => Number(row.due) === dueAt);
      expect(item?.status).toBe('open');
    });
  });

  it('findBestMatch returns a match above the floor and top-3 candidates below it', async () => {
    await deleteAllMemories(env.db, a.userId); // self-contained: exactly three candidates
    const contents = [
      'meeting with Dana',
      'the user has a meeting on Friday',
      'schedule a team meeting',
    ];
    const ids: string[] = [];
    for (const content of contents) {
      const memory = await insertMemory(env.db, a.userId, {
        kind: 'fact',
        content,
        confidence: 0.8,
      });
      ids.push(memory.id);
    }

    // The 'remember' path (duplicate check / post-add lookup): the top row clears
    // floor 0 even on a tie.
    const above = await findBestMatch(env.db, a.userId, 'meeting', 0, 'remember');
    expect('match' in above).toBe(true);
    if ('match' in above) expect(ids).toContain(above.match.id);

    const below = await findBestMatch(env.db, a.userId, 'meeting', 1000);
    expect('candidates' in below).toBe(true);
    if ('candidates' in below) {
      expect(below.candidates).toHaveLength(3);
      expect(below.candidates.map((candidate) => candidate.id).sort()).toEqual([...ids].sort());
    }

    const none = await findBestMatch(env.db, a.userId, 'zebra', 0);
    expect('candidates' in none && none.candidates.length === 0).toBe(true);
  });

  it('findBestMatch never picks on recency: a T2 tie is candidates at any age, "Goa trip" is the match (#401)', async () => {
    /** Seeds the evidence T2 rows with the given ages (days before now()). */
    async function seedT2(goaDays: number, photosDays: number): Promise<void> {
      await deleteAllMemories(env.db, a.userId);
      await withUser(env.db, a.userId, async (db) => {
        await db.query(
          `INSERT INTO bob.memories (id, user_id, kind, content, confidence, created_at)
           VALUES ('mem_t2_goa', $1, 'intent', 'Planning a trip to Goa in December', 0.9,
                   now() - make_interval(days => $2)),
                  ('mem_t2_photos', $1, 'intent', 'Share the trip photos with Priya', 0.9,
                   now() - make_interval(days => $3))`,
          [a.userId, goaDays, photosDays],
        );
      });
    }

    for (const [goaDays, photosDays] of [[20, 0], [0, 20]] as const) {
      await seedT2(goaDays, photosDays);
      const trip = await findBestMatch(env.db, a.userId, 'trip', DEFAULT_TARGET_FLOOR);
      expect('candidates' in trip).toBe(true);
      if ('candidates' in trip) {
        expect(trip.candidates.map((c) => c.id).sort()).toEqual(['mem_t2_goa', 'mem_t2_photos']);
        // Rank only: the recency term (<= 0.15) is gone, both score the bare text rank.
        expect(trip.candidates[0]!.score).toBeCloseTo(trip.candidates[1]!.score, 9);
      }

      const goa = await findBestMatch(env.db, a.userId, 'Goa trip', DEFAULT_TARGET_FLOOR);
      expect('match' in goa && goa.match.id).toBe('mem_t2_goa');
    }
  });

  it('a deleted source conversation leaves conversation_id null and the memory listed (M-18)', async () => {
    const conversation = await createConversation(env.db, a.userId, 'source conversation');
    const memory = await insertMemory(env.db, a.userId, {
      kind: 'fact',
      content: 'the user has a garden',
      confidence: 0.7,
      conversationId: conversation.id,
    });
    expect((await getMemory(env.db, a.userId, memory.id))!.conversationId).toBe(conversation.id);

    await deleteConversation(env.db, a.userId, conversation.id);
    const after = await getMemory(env.db, a.userId, memory.id);
    expect(after).not.toBeNull();
    expect(after!.conversationId).toBeNull();
    const list = await listMemories(env.db, a.userId, {});
    expect(list.memories.some((entry) => entry.id === memory.id)).toBe(true);
  });

  it('findCurrentMemoryByContent finds an exact match beyond a 100-row fuzzy page, skips superseded rows, and stays account-scoped', async () => {
    await deleteAllMemories(env.db, a.userId); // self-contained: exact row beyond 100 below
    const first = await insertMemory(env.db, a.userId, {
      kind: 'fact',
      content: 'milk',
      confidence: 0.8,
    });
    for (let i = 1; i <= 101; i += 1) {
      await insertMemory(env.db, a.userId, {
        kind: 'fact',
        content: `milk ${i}`,
        confidence: 0.5,
      });
    }
    expect((await findCurrentMemoryByContent(env.db, a.userId, 'milk'))?.id).toBe(first.id);

    const superseded = await insertMemory(env.db, a.userId, {
      kind: 'fact',
      content: 'oat milk',
      confidence: 0.8,
    });
    await applyExtractionOps(
      env.db,
      a.userId,
      [{ op: 'supersede', id: superseded.id, content: 'oat milk replacement', confidence: 0.8 }],
      { source: { conversationId: null, messageId: null, surface: 'web_text' } },
    );
    expect(await findCurrentMemoryByContent(env.db, a.userId, 'oat milk')).toBeNull();

    const other = await insertMemory(env.db, env.b.userId, {
      kind: 'fact',
      content: 'milk',
      confidence: 0.8,
    });
    expect((await findCurrentMemoryByContent(env.db, a.userId, 'milk'))?.id).toBe(first.id);
    expect((await findCurrentMemoryByContent(env.db, env.b.userId, 'milk'))?.id).toBe(other.id);
  });
});