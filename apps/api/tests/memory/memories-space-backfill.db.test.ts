// test:db suite for #756 PR1 (local Supabase stack only): memory scope is the
// conversation's space, so 20261001100100_memories_space_id gives every
// existing memory its owner's private space, never overwrites a space already
// set, and changes nothing on a re-run. Runs inside a superuser transaction
// that is rolled back. Skips cleanly when Docker is not available.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureLocalStack, setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

const BACKFILL = readFileSync(
  new URL('../../../../supabase/migrations/20261001100100_memories_space_id.sql', import.meta.url),
  'utf8',
);

const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;

/** Rolls back the superuser transaction once the assertions have run. */
class Rollback extends Error {}

type Row = { id: string; space_id: string | null };

describe.skipIf(!dockerUp)('memories.space_id backfill (#756, test:db)', () => {
  let env: MemoryTestDb;
  let admin: postgres.Sql;

  beforeAll(async () => {
    const status = await ensureLocalStack();
    env = await setupMemoryTestDb();
    admin = postgres(status.DB_URL!, { max: 1, prepare: true });
  });

  afterAll(async () => {
    await admin?.end();
    await env?.cleanup();
  });

  it('every memory gets its owner private space, a set space is kept, and a re-run changes nothing', async () => {
    const outcome = await admin
      .begin(async (tx) => {
        // Idempotent DDL: makes the column exist even on a stack built before this file.
        await tx.unsafe(BACKFILL);
        // The harness seeds A's private space only; B's comes the EXPAND way.
        await tx.unsafe(
          `insert into bob.spaces (kind, name, owner_user_id) values ('private', 'Private', $1)
           on conflict (owner_user_id) where kind = 'private' do nothing`,
          [env.b.userId],
        );
        const privateB = await tx.unsafe<Array<{ id: string }>>(
          `select id::text as id from bob.spaces where kind = 'private' and owner_user_id = $1`,
          [env.b.userId],
        );
        const inserted = await tx.unsafe<Row[]>(
          `insert into bob.memories (user_id, kind, content, confidence, space_id)
           values ($1, 'fact', 'likes tea', 0.9, null),
                  ($1, 'preference', 'metric units', 0.8, null),
                  ($2, 'fact', 'has a cat', 0.7, null),
                  ($1, 'fact', 'family dinner on fridays', 0.9, $3::uuid)
           returning id, space_id::text as space_id`,
          [env.a.userId, env.b.userId, env.spaces.groupABC],
        );
        const ids = inserted.map((row) => row.id);
        const read = (): Promise<Row[]> =>
          tx.unsafe<Row[]>(
            `select id, space_id::text as space_id from bob.memories where id = any($1::text[]) order by created_at, id`,
            [ids],
          );
        await tx.unsafe(BACKFILL);
        const first = await read();
        await tx.unsafe(BACKFILL);
        const second = await read();
        const leftNull = await tx.unsafe<Array<{ n: number }>>(
          `select count(*)::int as n from bob.memories m
            where m.space_id is null
              and exists (select 1 from bob.spaces s where s.kind = 'private' and s.owner_user_id = m.user_id)`,
        );
        throw new Rollback(JSON.stringify({
          byId: Object.fromEntries(first.map((row) => [row.id, row.space_id])),
          ids,
          privateB: privateB[0]?.id ?? null,
          rerunSame: JSON.stringify(first) === JSON.stringify(second),
          leftNull: leftNull[0]?.n,
        }));
      })
      .catch((err: unknown) => {
        if (err instanceof Rollback) return JSON.parse(err.message) as {
          byId: Record<string, string | null>;
          ids: string[];
          privateB: string | null;
          rerunSame: boolean;
          leftNull: number;
        };
        throw err;
      });

    const [a1, a2, b1, aGroup] = outcome.ids as [string, string, string, string];
    expect(outcome.privateB).not.toBeNull();
    expect(outcome.byId[a1]).toBe(env.spaces.privateA);
    expect(outcome.byId[a2]).toBe(env.spaces.privateA);
    expect(outcome.byId[b1]).toBe(outcome.privateB);
    expect(outcome.byId[aGroup]).toBe(env.spaces.groupABC);
    expect(outcome.rerunSame).toBe(true);
    expect(outcome.leftNull).toBe(0);
  });
});
