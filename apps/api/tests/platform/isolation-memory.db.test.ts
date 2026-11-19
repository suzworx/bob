// test:db suite (010, T009): the two-account isolation matrix for the memory
// objects (SC-003, M-15). Runs against the LOCAL Supabase stack only (it needs
// the `vector` extension, research R6), so it is excluded from the
// default vitest run and only runs under `npm run test:db` (db-harness brings
// the stack up, applies migrations, and creates two throwaway accounts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

const DIMS = 1536;

/** Deterministic 1536-dim pseudo-random vector, every axis near 0.5, so any
 *  two generated vectors are cosine-close and the semantic arm of
 *  match_memories returns every seeded row for a same-shape query vector. */
function vec(seed: number): string {
  const values: string[] = new Array(DIMS);
  for (let i = 0; i < DIMS; i += 1) {
    values[i] = (0.5 + Math.sin(seed * 7919 + i * 12.9898) * 0.01).toFixed(6);
  }
  return `[${values.join(',')}]`;
}

interface SeedMemory {
  id: string;
  kind: string;
  content: string;
}

const A_MEMORIES: SeedMemory[] = [
  { id: 'mem_a_peanut', kind: 'fact', content: 'the user is allergic to peanuts' },
  { id: 'mem_a_garden', kind: 'preference', content: 'the user prefers a shady garden' },
  { id: 'mem_a_friday', kind: 'intent', content: 'the user has a meeting on Friday' },
  { id: 'mem_a_email', kind: 'action_item', content: 'the user must email Dana by Friday' },
];

const B_MEMORY: SeedMemory = { id: 'mem_b_peanut', kind: 'fact', content: 'the user hates peanuts' };

async function insertMemory(
  db: Db,
  seed: number,
  memory: SeedMemory,
  userId: string,
): Promise<void> {
  await db.query(
    `insert into bob.memories
       (id, user_id, kind, content, confidence, embedding, embedding_model, embedding_dim)
     values ($1, $2, $3, $4, $5, $6::extensions.vector, $7, $8)`,
    [memory.id, userId, memory.kind, memory.content, 0.9, vec(seed), 'text-embedding-3-small', DIMS],
  );
}

describe('test:db two-account isolation matrix (SC-003, M-15)', () => {
  let env: MemoryTestDb;

  beforeAll(async () => {
    env = await setupMemoryTestDb();
    // A's four memories plus one action item, through raw SQL under withUser.
    await withUser(env.db, env.a.userId, async (db) => {
      for (let i = 0; i < A_MEMORIES.length; i += 1) {
        await insertMemory(db, i, A_MEMORIES[i]!, env.a.userId);
      }
      await db.query(
        `insert into bob.action_items (id, memory_id, user_id, due_at, status)
         values ($1, $2, $3, now() + interval '1 day', 'open')`,
        ['act_a_email', 'mem_a_email', env.a.userId],
      );
    });
    // B's own memory (its content also matches the shared query, so any leak
    // of A's rows would show up in B's retrieval).
    await withUser(env.db, env.b.userId, async (db) => {
      await insertMemory(db, 100, B_MEMORY, env.b.userId);
    });
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("account B selects, updates, and deletes zero of A's rows", async () => {
    const aIds = A_MEMORIES.map((memory) => memory.id);
    await withUser(env.db, env.b.userId, async (db) => {
      const seen = await db.query<{ id: string }>(
        `select id from bob.memories where id = any($1)`,
        [aIds],
      );
      expect(seen).toEqual([]);

      const updated = await db.query<{ id: string }>(
        `update bob.memories set content = 'hacked' where id = any($1) returning id`,
        [aIds],
      );
      expect(updated).toEqual([]);

      const deleted = await db.query<{ id: string }>(
        `delete from bob.memories where id = any($1) returning id`,
        [aIds],
      );
      expect(deleted).toEqual([]);

      const itemSeen = await db.query<{ id: string }>(
        `select id from bob.action_items where id = $1`,
        ['act_a_email'],
      );
      expect(itemSeen).toEqual([]);

      const itemUpdated = await db.query<{ id: string }>(
        `update bob.action_items set status = 'done' where id = $1 returning id`,
        ['act_a_email'],
      );
      expect(itemUpdated).toEqual([]);

      const itemDeleted = await db.query<{ id: string }>(
        `delete from bob.action_items where id = $1 returning id`,
        ['act_a_email'],
      );
      expect(itemDeleted).toEqual([]);
    });

    // A's rows are untouched by B's attempts.
    await withUser(env.db, env.a.userId, async (db) => {
      const rows = await db.query<{ id: string; content: string }>(
        `select id, content from bob.memories where id = any($1) order by id`,
        [aIds],
      );
      expect(rows).toHaveLength(A_MEMORIES.length);
      expect(rows.map((row) => row.content)).not.toContain('hacked');
    });
  });

  it("account B cannot insert rows claiming A's user_id (WITH CHECK)", async () => {
    // FORCE RLS rejects the violating insert outright with a PostgresError.
    // Each insert runs in its own transaction so one rejection cannot abort
    // the other via the aborted-transaction state.
    await expect(
      withUser(env.db, env.b.userId, async (db) => {
        await db.query(
          `insert into bob.memories (id, user_id, kind, content, confidence)
           values ('mem_b_forge', $1, 'fact', 'forged', 1.0) returning id`,
          [env.a.userId],
        );
      }),
    ).rejects.toThrow(/row-level security/);

    await expect(
      withUser(env.db, env.b.userId, async (db) => {
        await db.query(
          `insert into bob.action_items (id, memory_id, user_id, status)
           values ('act_b_forge', 'mem_a_peanut', $1, 'open') returning id`,
          [env.a.userId],
        );
      }),
    ).rejects.toThrow(/row-level security/);

    // A's rows are unchanged: no forged row exists, the count is untouched.
    await withUser(env.db, env.a.userId, async (db) => {
      const count = await db.query<{ total: number }>(
        `select count(*)::int as total from bob.memories where user_id = $1`,
        [env.a.userId],
      );
      expect(count[0]?.total).toBe(A_MEMORIES.length);
    });
  });

  it("match_memories under B returns none of A's rows; under A it returns A's seeded top-k (M-15)", async () => {
    const query = 'peanuts garden meeting email';
    const embedding = vec(1000);
    const aIds = A_MEMORIES.map((memory) => memory.id);

    await withUser(env.db, env.b.userId, async (db) => {
      const rows = await db.query<{ id: string; content: string }>(
        `select id, content from bob.match_memories($1, $2::extensions.vector)`,
        [query, embedding],
      );
      expect(rows.length).toBeGreaterThan(0); // B's own memory matches
      for (const row of rows) {
        expect(aIds).not.toContain(row.id);
      }
    });

    await withUser(env.db, env.a.userId, async (db) => {
      const rows = await db.query<{ id: string; content: string }>(
        `select id, content from bob.match_memories($1, $2::extensions.vector)`,
        [query, embedding],
      );
      expect(rows.map((row) => row.id).sort()).toEqual([...aIds].sort());
    });
  });
});