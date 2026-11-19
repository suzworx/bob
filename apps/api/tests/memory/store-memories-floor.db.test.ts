// test:db suite for the #405 match_memories distance floor (local Supabase
// stack only; it needs `vector`). The floor ships dark: with no
// maxDistance the function must return exactly what the pre-#405 SQL returned.
// 0.5 below is a TEST floor, not the shipped D (#404 calibrates that).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withUser } from '../../src/platform/db/db.ts';
import { deleteAllMemories, insertMemory, matchMemories, matchMemoriesFullText } from '../../src/memory/store.ts';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

const DIMS = 1536;
const TEST_FLOOR = 0.5;

/** A 1536-dim vector with the given leading components, zeros elsewhere. */
function vec(...head: number[]): number[] {
  return [...head, ...new Array<number>(DIMS - head.length).fill(0)];
}

function literal(values: number[]): string {
  return `[${values.join(',')}]`;
}

/** The 20260915200000 match_memories body, verbatim, with its defaults inlined. */
const OLD_BODY = `
with full_text as (
  select m.id, row_number() over (order by ts_rank_cd(m.fts, websearch_to_tsquery('english', $1)) desc) as rank_ix
    from bob.memories m
   where m.superseded_by is null and m.user_id = (select auth.uid())
     and m.fts @@ websearch_to_tsquery('english', $1)
   order by rank_ix limit least($3::int, 30) * 2
),
semantic as (
  select m.id, row_number() over (order by m.embedding operator(extensions.<=>) $2::extensions.vector) as rank_ix
    from bob.memories m
   where m.superseded_by is null and m.user_id = (select auth.uid()) and m.embedding is not null
   order by rank_ix limit least($3::int, 30) * 2
)
select m.id,
       case when ft.id is not null and se.id is not null then 'both'
            when ft.id is not null then 'full_text' else 'semantic' end as match_source,
       (coalesce(1.0 / (50 + ft.rank_ix), 0.0) * 1.0::double precision
        + coalesce(1.0 / (50 + se.rank_ix), 0.0) * 1.0::double precision
        + 0.15::double precision * exp(- ln(2.0) * extract(epoch from (now() - m.created_at)) / (30.0::double precision * 86400.0))
       )::double precision as score
  from full_text ft full outer join semantic se on ft.id = se.id
  join bob.memories m on m.id = coalesce(ft.id, se.id)
 order by score desc limit least($3::int, 30)`;

type Row = { id: string; match_source: string; score: number };

describe('match_memories distance floor (#405, test:db)', () => {
  let env: MemoryTestDb;
  let userId: string;

  beforeAll(async () => {
    env = await setupMemoryTestDb();
    userId = env.a.userId;
  });

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await deleteAllMemories(env.db, userId);
  });

  async function seed(content: string, embedding: number[], ageDays: number): Promise<string> {
    const memory = await insertMemory(env.db, userId, {
      kind: 'fact',
      content,
      confidence: 0.9,
      embedding: { values: embedding, model: 'text-embedding-3-small', dim: DIMS },
    });
    await setAge(memory.id, ageDays);
    return memory.id;
  }

  async function setAge(id: string, ageDays: number): Promise<void> {
    await withUser(env.db, userId, async (db) => {
      await db.query(`UPDATE bob.memories SET created_at = now() - make_interval(days => $1) WHERE id = $2`, [ageDays, id]);
    });
  }

  /** T1 (docs/perf/394/evidence/ranking-tests.sql): A identical to the query, 60 days old; B orthogonal, today. */
  async function seedT1(): Promise<{ perfect: string; unrelated: string }> {
    const perfect = await seed('The user loved the restaurant Trattoria Roma on Fifth Street', vec(1), 60);
    const unrelated = await seed('The user has a dentist appointment on Monday', vec(0, 1), 0);
    return { perfect, unrelated };
  }

  it('flag off: the new function returns exactly the old SQL rows and scores on T1', async () => {
    await seedT1();
    const { next, old } = await withUser(env.db, userId, async (db) => {
      const params = ['restaurant I liked', literal(vec(1)), 8];
      return {
        next: await db.query<Row>(`select id, match_source, score from bob.match_memories($1, $2::extensions.vector, $3)`, params),
        old: await db.query<Row>(OLD_BODY, params),
      };
    });
    expect(next).toEqual(old);
    expect(next.map((row) => row.id)).toHaveLength(2); // both returned, as today
  });

  it('flag off via matchMemories: T1 still ranks the new unrelated row first (today)', async () => {
    const { perfect, unrelated } = await seedT1();
    const matches = await matchMemories(env.db, userId, {
      queryText: 'restaurant I liked', queryEmbedding: vec(1), matchCount: 8, maxDistance: null,
    });
    expect(matches.map((match) => match.id)).toEqual([unrelated, perfect]);
  });

  it('the new 10-argument signature is executable by authenticated only (anon and public have no execute)', async () => {
    const signature =
      'bob.match_memories(text, extensions.vector, integer, double precision, double precision, integer, double precision, double precision, double precision, boolean)';
    const rows = await env.db.query<{ anon: boolean; authenticated: boolean; public_grant: boolean }>(
      `select has_function_privilege('anon', $1, 'execute') as anon,
              has_function_privilege('authenticated', $1, 'execute') as authenticated,
              exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_grant`,
      [signature],
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: true, public_grant: false });
  });

  it('with BOB_MEMORY_MAX_DISTANCE set, matchMemories without maxDistance is not floored (extraction dedup)', async () => {
    const { perfect, unrelated } = await seedT1();
    const previous = process.env.BOB_MEMORY_MAX_DISTANCE;
    try {
      process.env.BOB_MEMORY_MAX_DISTANCE = String(TEST_FLOOR);
      const matches = await matchMemories(env.db, userId, {
        queryText: 'restaurant I liked', queryEmbedding: vec(1), matchCount: 8,
      });
      expect(matches.map((match) => match.id)).toEqual([unrelated, perfect]);
    } finally {
      if (previous === undefined) delete process.env.BOB_MEMORY_MAX_DISTANCE;
      else process.env.BOB_MEMORY_MAX_DISTANCE = previous;
    }
  });

  it('flag on: T1 returns only the perfect match (orthogonal row filtered)', async () => {
    const { perfect } = await seedT1();
    const matches = await matchMemories(env.db, userId, {
      queryText: 'restaurant I liked', queryEmbedding: vec(1), matchCount: 8, maxDistance: TEST_FLOOR,
    });
    expect(matches.map((match) => match.id)).toEqual([perfect]);
  });

  it('flag on: a full-text-only hit whose vector is beyond the floor is still returned', async () => {
    const far = await seed('Trattoria Roma closes early on Tuesdays', vec(0, 0, 1), 5);
    const matches = await matchMemories(env.db, userId, {
      queryText: 'Trattoria Roma', queryEmbedding: vec(1), matchCount: 8, maxDistance: TEST_FLOOR,
    });
    expect(matches.map((match) => [match.id, match.matchSource])).toEqual([[far, 'full_text']]);
  });

  it('flag on: equal fused scores come back newest first, whichever row is newer', async () => {
    // X wins the text arm, Y the semantic arm: 1/51 + 1/52 each, an exact tie.
    const x = await seed('chai chai chai every morning', vec(1, 0.3), 90);
    const y = await seed('a cup of chai with a long walk before the office meeting starts', vec(1, 0.1), 1);
    const query = { queryText: 'chai', queryEmbedding: vec(1), matchCount: 8, maxDistance: TEST_FLOOR };

    const first = await matchMemories(env.db, userId, query);
    expect(first.map((match) => match.matchSource)).toEqual(['both', 'both']);
    expect(first[0]!.score).toBe(first[1]!.score);
    expect(first.map((match) => match.id)).toEqual([y, x]);

    await setAge(x, 0);
    await setAge(y, 90);
    const flipped = await matchMemories(env.db, userId, query);
    expect(flipped.map((match) => match.id)).toEqual([x, y]);
  });

  it('flag on: an older, closer row is never ranked below a newer, farther one', async () => {
    const olderCloser = await seed('The user prefers window seats', vec(1, 0.1), 120);
    const newerFarther = await seed('The user bought new headphones', vec(1, 0.4), 0);
    const matches = await matchMemories(env.db, userId, {
      queryText: 'aisle', queryEmbedding: vec(1), matchCount: 8, maxDistance: TEST_FLOOR,
    });
    expect(matches.map((match) => match.matchSource)).toEqual(['semantic', 'semantic']);
    expect(matches.map((match) => match.id)).toEqual([olderCloser, newerFarther]);
  });

  it('degraded path with the tie-break: text rank alone, equal ranks newest first', async () => {
    const older = await seed('Planning a trip to Goa in December', vec(1), 20);
    const newer = await seed('Share the trip photos with Priya', vec(1), 0);
    const tieBreak = await matchMemoriesFullText(env.db, userId, {
      queryText: 'trip', matchCount: 8, recencyTieBreak: true,
    });
    expect(tieBreak[0]!.score).toBe(tieBreak[1]!.score);
    expect(tieBreak.map((match) => match.id)).toEqual([newer, older]);

    await setAge(older, 0);
    await setAge(newer, 20);
    const flipped = await matchMemoriesFullText(env.db, userId, {
      queryText: 'trip', matchCount: 8, recencyTieBreak: true,
    });
    expect(flipped.map((match) => match.id)).toEqual([older, newer]);

    const today = await matchMemoriesFullText(env.db, userId, {
      queryText: 'trip', matchCount: 8, recencyTieBreak: false,
    });
    expect(today[0]!.score).toBeGreaterThan(today[1]!.score); // additive recency, as before
  });
});
