/**
 * bob.turn_metrics (20261004100000_turn_metrics, ANL-DB1): a server-only,
 * metadata-only table written and purged through bob_private definers. Runs
 * on the real local Postgres as bob_server; rows are read back through an
 * admin connection because no select definer exists by design.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const FILE = new URL('../../../../supabase/migrations/20261004100000_turn_metrics.sql', import.meta.url);
const ARRIVAL_FILE = new URL('../../../../supabase/migrations/20261107000000_turn_metrics_arrival.sql', import.meta.url);
const MIN = { surface: 'web_text', outcome: 'completed' };

describe('bob.turn_metrics (ANL-DB1)', () => {
  let db: TestDb;
  const record = (p: Record<string, unknown>): Promise<unknown> =>
    db.query('select bob_private.record_turn_metric($1::jsonb)', [p]);
  const admin = async <T,>(sql: string): Promise<T[]> =>
    withAdmin(await adminDatabaseUrl((db as unknown as { databaseName: string }).databaseName), async (s) => [
      ...(await s.unsafe<T[]>(sql)),
    ]);
  const asAuthenticated = (sql: string): Promise<unknown> =>
    db.transaction(async (tx) => {
      await tx.exec('set local role authenticated');
      return tx.query(sql);
    });

  beforeAll(async () => {
    db = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await admin('delete from bob.turn_metrics').catch(() => undefined);
    await closeTestDb(db);
  });

  it('forces RLS with zero policies', async () => {
    const [t] = await admin<{ on: boolean; forced: boolean }>(
      `select relrowsecurity as on, relforcerowsecurity as forced from pg_class
        where oid = 'bob.turn_metrics'::regclass`);
    expect(t).toEqual({ on: true, forced: true });
    expect(await admin(`select 1 from pg_policies where schemaname = 'bob' and tablename = 'turn_metrics'`)).toEqual([]);
  });

  it('denies authenticated select, insert and both definers', async () => {
    const denied = [
      'select * from bob.turn_metrics',
      `insert into bob.turn_metrics (surface, outcome) values ('device', 'completed')`,
      `select bob_private.record_turn_metric('{"surface":"device","outcome":"completed"}'::jsonb)`,
      'select bob_private.purge_turn_metrics(now())',
    ];
    for (const sql of denied) await expect(asAuthenticated(sql)).rejects.toThrow(/permission denied/i);
  });

  it('records a minimal and a full payload through the definer', async () => {
    await admin('delete from bob.turn_metrics');
    await record(MIN);
    await record({
      surface: 'device', outcome: 'completed', intent: 'timer_reminder', model: 'google/gemini-2.5-flash',
      provider: 'vertex', fw_version: '1.2.3+rc.1', input_tokens: 120, output_tokens: 40, cached_input_tokens: 10,
      cache_write_tokens: 5, reasoning_tokens: 7, steps: 2, tool_calls: 1, called_tools: ['set_timer', 'get-time'],
      streamed: true, interrupted: false, tts_cache_hit: true, stt_ms: 300, prep_ms: 20, model_ms: 900,
      first_token_ms: 400, tts_ms: 250, first_audio_ms: 1100, total_ms: 1800, user_bucket: 1023, bogus_key: 'ignored',
    });
    const rows = await admin<Record<string, unknown>>('select * from bob.turn_metrics order by id');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ surface: 'web_text', outcome: 'completed', called_tools: [], streamed: false, input_tokens: null });
    expect(rows[1]).toMatchObject({
      surface: 'device', intent: 'timer_reminder', model: 'google/gemini-2.5-flash', fw_version: '1.2.3+rc.1',
      input_tokens: 120, reasoning_tokens: 7, tool_calls: 1, called_tools: ['set_timer', 'get-time'],
      streamed: true, tts_cache_hit: true, stt_ms: 300, total_ms: 1800, user_bucket: 1023,
    });
  });

  it('rejects out-of-contract values', async () => {
    const bad: Record<string, unknown>[] = [
      { ...MIN, model: 'has space' },
      { ...MIN, called_tools: ['bad tool'] },
      { ...MIN, stt_ms: -1 },
      { surface: 'device', outcome: 'failed' },
      { ...MIN, failed_stage: 'stt' },
      { ...MIN, user_bucket: 1024 },
      { ...MIN, surface: 'toaster' },
    ];
    for (const p of bad) await expect(record(p)).rejects.toThrow(/violates check constraint/i);
  });

  it('never lets a payload control id or occurred_at', async () => {
    await admin('delete from bob.turn_metrics');
    await record({ ...MIN, id: 987654, occurred_at: '2001-01-01T00:00:00Z' });
    const [r] = await admin<{ id: string; age: number }>(
      'select id::text, extract(epoch from now() - occurred_at)::float as age from bob.turn_metrics');
    expect(r!.id).not.toBe('987654');
    expect(Math.abs(r!.age)).toBeLessThan(60);
  });

  it('purges only rows older than the cutoff and returns the count', async () => {
    await admin('delete from bob.turn_metrics');
    await record(MIN);
    await admin(`insert into bob.turn_metrics (surface, outcome, occurred_at) values
      ('device', 'completed', now() - interval '100 days'), ('web_voice', 'empty', now() - interval '95 days')`);
    const [r] = (await db.query<{ n: number }>(
      `select bob_private.purge_turn_metrics(now() - interval '90 days') as n`)).rows;
    expect(r!.n).toBe(2);
    expect(await admin<{ n: number }>('select count(*)::int as n from bob.turn_metrics')).toEqual([{ n: 1 }]);
  });

  it('keeps identity and text words out of the migration files', () => {
    for (const file of [FILE, ARRIVAL_FILE]) {
      const sql = readFileSync(file, 'utf8');
      for (const word of ['user_id', 'device_id', 'conversation_id', 'transcript']) expect(sql).not.toContain(word);
    }
  });

  // SIMPLIFY-U0B (20261107000000_turn_metrics_arrival): request receipt to model start, nullable and bounded.
  it('adds a nullable, checked arrival_ms that the definer records', async () => {
    const [col] = await admin<{ is_nullable: string; data_type: string }>(
      `select is_nullable, data_type from information_schema.columns
        where table_schema = 'bob' and table_name = 'turn_metrics' and column_name = 'arrival_ms'`);
    expect(col).toEqual({ is_nullable: 'YES', data_type: 'integer' });
    await admin('delete from bob.turn_metrics');
    await record(MIN);
    await record({ ...MIN, arrival_ms: 1500 });
    const rows = await admin<{ arrival_ms: number | null }>('select arrival_ms from bob.turn_metrics order by id');
    expect(rows).toEqual([{ arrival_ms: null }, { arrival_ms: 1500 }]);
    for (const bad of [-1, 600001]) await expect(record({ ...MIN, arrival_ms: bad })).rejects.toThrow(/violates check constraint/i);
  });
});
