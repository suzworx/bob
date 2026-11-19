/**
 * Outbox lanes (S1 of #1322): the 6-argument bob_private.outbox_claim_batch
 * overload and the per-event-type partial index, on real Postgres. Every
 * earlier migration is applied by the template (before: MARKER), then this
 * migration runs TWICE by hand, like outbox-email-marker.test.ts. The
 * 4-argument claim the rest of the system uses stays byte-identical.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from '../support/pg-template.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const MARKER = '20261028050000_outbox_lanes.sql';
const OVERLOAD = 'bob_private.outbox_claim_batch(text,integer,integer,timestamptz,text[],text[])';
const dueClaim = (owner: string, minutes: number): string =>
  `select "effectKey" as k from bob_private.outbox_claim_batch('${owner}', 100, 1000, now() + interval '${minutes} minutes')`;
/** A filtered (6-argument) claim; an empty side passes NULL so the predicate
 *  treats it as "no filter on this side". */
const sqlArray = (values: string[]): string =>
  values.length === 0 ? `null::text[]` : `array[${values.map((value) => `'${value}'`).join(',')}]::text[]`;
const dueFilteredClaim = (owner: string, minutes: number, include: string[], exclude: string[]): string =>
  `select "effectKey" as k from bob_private.outbox_claim_batch('${owner}', 100, 1000,
      now() + interval '${minutes} minutes', ${sqlArray(include)}, ${sqlArray(exclude)})`;
const seed = (key: string, eventType: string): string =>
  `insert into bob.outbox (event_type, resource_type, resource_id, effect_key, payload)
   values ('${eventType}', 'task', gen_random_uuid(), '${key}',
           '{"resource_type":"task","event_type":"${eventType}"}')`;

describe('outbox lanes migration (#1322 S1)', () => {
  let db: TestDb;
  const rows = async <T,>(sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;
  const one = async <T,>(sql: string): Promise<T> => (await rows<{ v: T }>(`select (${sql}) as v`))[0]!.v;
  const apply = async (): Promise<void> =>
    void (await db.transaction(async (tx) => void (await tx.exec(readFileSync(new URL(MARKER, dir), 'utf8')))));

  beforeAll(async () => {
    db = await createMigratedDb({ before: MARKER });
    await apply();
    await apply();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('adds the 6-argument overload beside the untouched 4-argument claim, and re-runs cleanly', async () => {
    for (const args of [4, 6]) {
      expect(await one<number>(
        `select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'bob_private' and p.proname = 'outbox_claim_batch' and p.pronargs = ${args}`,
      )).toBe(1);
    }
  });

  it('the filtered claim honours include and exclude; the 4-argument claim stays unfiltered', async () => {
    await db.exec(`${seed('lanes-a', 'lane.a')}; ${seed('lanes-b', 'lane.b')}`);

    // A lane that includes one type claims only that type...
    expect((await rows<{ k: string }>(dueFilteredClaim('include-only-a', 1, ['lane.a'], []))).map((r) => r.k).sort()).toEqual(['lanes-a']);
    await db.exec(`select bob_private.outbox_reclaim_expired(now() + interval '5 minutes')`);
    // ...and its complement claims only the rest.
    expect((await rows<{ k: string }>(dueFilteredClaim('exclude-a', 2, [], ['lane.a'])))).toEqual([{ k: 'lanes-b' }]);
    await db.exec(`select bob_private.outbox_reclaim_expired(now() + interval '10 minutes')`);

    // The original signature claims every due row, exactly as before.
    expect((await rows<{ k: string }>(dueClaim('all-rows', 22))).map((r) => r.k).sort()).toEqual(['lanes-a', 'lanes-b']);
    await db.exec(`select bob_private.outbox_reclaim_expired(now() + interval '30 minutes')`);
  });

  it('grants EXECUTE on the overload to bob_server only', async () => {
    expect(await one<boolean>(`has_function_privilege('bob_server', '${OVERLOAD}', 'EXECUTE')`)).toBe(true);
    expect(await one<boolean>(`has_function_privilege('authenticated', '${OVERLOAD}', 'EXECUTE')`)).toBe(false);
    expect(await one<boolean>(`has_function_privilege('anon', '${OVERLOAD}', 'EXECUTE')`)).toBe(false);
  });

  it('an authenticated account cannot even call the filtered overload (server-only definer discipline)', async () => {
    await db.exec('set role authenticated');
    try {
      await expect(
        db.query(
          `select count(*) from bob_private.outbox_claim_batch
             ('intruder', 100, 1000, now(), '{}'::text[], '{}'::text[])`,
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec('reset role');
    }
  });

  it('adds the per-event-type partial index the lane claim scans need', async () => {
    const indexdef = await one<string>(`select indexdef from pg_indexes where indexname = 'outbox_pending_event_idx'`);
    expect(indexdef).toContain('(event_type, available_at, created_at)');
    expect(indexdef).toContain('delivered_at IS NULL');
  });
});
