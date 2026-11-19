/**
 * Operator metrics aggregates (20261004110000_operator_metrics, ANL-AGG1): three
 * read-only security definers that return one jsonb document each, counts and
 * percentiles only, never a person. Runs on the real local Postgres as
 * bob_server; fixtures that bob_server cannot write go through an admin
 * connection exactly like turn-metrics-migration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { addAccount, closeTestDb, createTestDb, withAdminAuth, type TestDb } from '../support/test-db.ts';

const FILE = new URL('../../../../supabase/migrations/20261004110000_operator_metrics.sql', import.meta.url);
const FROM = '2026-09-10T00:00:00Z';
const TO = '2026-09-13T00:00:00Z';
const FNS = ['usage', 'voice', 'platform'] as const;
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('operator metrics aggregates (ANL-AGG1)', () => {
  let db: TestDb;
  let ids: string[] = [];
  const emails = ['agg-a@example.test', 'agg-b@example.test', 'agg-c@example.test'];
  const admin = async <T,>(sql: string): Promise<T[]> =>
    withAdmin(await adminDatabaseUrl((db as unknown as { databaseName: string }).databaseName), async (s) => [
      ...(await s.unsafe<T[]>(sql)),
    ]);
  const call = async (fn: string, from = FROM, to = TO, bucket = 'day'): Promise<Doc> =>
    (await db.query<{ r: Doc }>(
      `select bob_private.operator_metrics_${fn}($1::timestamptz, $2::timestamptz, $3::text) as r`,
      [from, to, bucket])).rows[0]!.r;
  const asAuthenticated = (sql: string): Promise<unknown> =>
    db.transaction(async (tx) => {
      await tx.exec('set local role authenticated');
      return tx.query(sql);
    });
  const msg = (n: number, role: string, origin: string, at: string, extra = ''): string => {
    const conv = `conv_agg_${n}`;
    return `insert into bob.messages (conversation_id, user_id, role, origin, position, created_at ${extra ? ', tombstoned_at' : ''})
      values ('${conv}', '${ids[n]}', '${role}', '${origin}',
        (select coalesce(max(position), 0) + 1 from bob.messages where conversation_id = '${conv}'),
        '${at}' ${extra ? `, '${at}'` : ''});`;
  };
  const metric = async (p: Record<string, unknown>, at: string): Promise<void> => {
    await db.query('select bob_private.record_turn_metric($1::jsonb)', [p]);
    await admin(`update bob.turn_metrics set occurred_at = '${at}' where id = (select max(id) from bob.turn_metrics)`);
  };

  beforeAll(async () => {
    db = await createTestDb();
    ids = (await Promise.all(emails.map(() => addAccount(db)))).map((a) => a.userId);
    for (const [i, id] of ids.entries()) await withAdminAuth(db, (a) => a.setProfile(id, { email: emails[i]!, name: `Agg ${i}` }));
    const made = ['2026-09-11T08:00:00Z', '2026-09-12T05:00:00Z', '2026-09-01T08:00:00Z'];
    await admin(ids.map((id, i) => `update auth.users set created_at = '${made[i]}' where id = '${id}';
      insert into bob.conversations (id, user_id, title, created_at) values ('conv_agg_${i}', '${id}', 'secret title ${i}',
        '${['2026-09-11T08:00:00Z', '2026-09-12T05:00:00Z', '2026-09-02T08:00:00Z'][i]}');`).join('\n'));
    await admin([
      msg(0, 'user', 'device', '2026-09-11T10:00:00Z'), msg(0, 'user', 'web_text', '2026-09-11T11:00:00Z'),
      msg(0, 'user', 'web_voice', '2026-09-12T12:00:00Z'), msg(0, 'assistant', 'device', '2026-09-11T10:00:01Z'),
      msg(0, 'user', 'device', '2026-09-13T00:00:00Z'), msg(0, 'user', 'device', '2026-08-01T10:00:00Z'),
      msg(1, 'user', 'web_text', '2026-09-11T09:00:00Z'), msg(1, 'user', 'device', '2026-09-12T23:30:00Z'),
      msg(1, 'user', 'web_text', '2026-09-11T09:30:00Z', 'tombstoned'),
      msg(2, 'user', 'web_voice', '2026-09-12T20:00:00Z'), msg(2, 'user', 'web_text', '2026-09-06T10:00:00Z'),
    ].join('\n'));
    await admin('delete from bob.turn_metrics');
    const D = '2026-09-11T12:00:00Z';
    const dev = (n: number): Record<string, unknown> => ({ surface: 'device', outcome: 'completed', first_audio_ms: n * 1000,
      stt_ms: n * 100, model_ms: 300 + n * 100, tts_ms: n * 50, total_ms: 500 + n * 1000 });
    for (const n of [1, 2, 3]) await metric(dev(n), D);
    await metric({ surface: 'device', outcome: 'failed', failed_stage: 'stt', failure_kind: 'upstream_error' }, D);
    await metric({ surface: 'device', outcome: 'cancelled' }, D);
    await metric({ surface: 'device', outcome: 'empty' }, D);
    await metric({ surface: 'web_voice', outcome: 'completed', first_audio_ms: 1500 }, '2026-09-12T12:00:00Z');
    await metric({ surface: 'web_voice', outcome: 'failed', failed_stage: 'tts', failure_kind: 'upstream_error' }, '2026-09-12T12:00:00Z');
    await metric({ surface: 'web_voice', outcome: 'failed', failed_stage: 'agent', failure_kind: 'internal' }, '2026-09-12T12:00:00Z');
    await metric({ surface: 'web_text', outcome: 'completed' }, D);
    await metric({ surface: 'web_text', outcome: 'failed', failed_stage: 'input', failure_kind: 'invalid_input' }, D);
    await metric({ surface: 'analytics', outcome: 'completed' }, D);
    await metric({ surface: 'device', outcome: 'completed', first_audio_ms: 9000 }, '2026-09-14T00:00:00Z');
    const ob = (key: string, type: string, at: string, att: number, err: string | null, delivered: boolean): string =>
      `insert into bob.outbox (event_type, resource_type, resource_id, effect_key, created_at, attempts, last_error_code, delivered_at)
       values ('${type}', 'notification', gen_random_uuid(), '${key}', ${at}, ${att}, ${err ? `'${err}'` : 'null'}, ${delivered ? 'now()' : 'null'});`;
    await admin([
      ob('agg:pending', 'email.notification', "now() - interval '10 minutes'", 0, null, false),
      ob('agg:b', 'email.notification', "'2026-09-11T10:00:00Z'", 3, 'smtp_timeout', true),
      ob('agg:c', 'email.notification', "'2026-09-11T11:00:00Z'", 2, 'smtp_timeout', true),
      ob('agg:d', 'space.invited', "'2026-09-12T10:00:00Z'", 1, 'rejected', true),
      ob('agg:e', 'space.invited', "'2026-09-12T11:00:00Z'", 1, null, true),
      ob('agg:f', 'space.invited', "'2026-09-01T11:00:00Z'", 5, 'old', true),
    ].join('\n'));
  }, 120_000);

  afterAll(async () => {
    await admin('delete from bob.turn_metrics').catch(() => undefined);
    await closeTestDb(db);
  });

  it('usage: documented shape, counts by origin, zero-filled buckets', async () => {
    const r = await call('usage');
    expect(r.window).toEqual({ from: FROM, to: TO, bucket: 'day' });
    expect(r.turns_by_bucket).toEqual([
      { t: '2026-09-10T00:00:00Z', device: 0, web_voice: 0, web_text: 0 },
      { t: '2026-09-11T00:00:00Z', device: 1, web_voice: 0, web_text: 2 },
      { t: '2026-09-12T00:00:00Z', device: 1, web_voice: 2, web_text: 0 },
    ]);
    expect(r).toMatchObject({ turns_total: 6, conversations_created: 2, signups: 2 });
    expect(r.active_users).toEqual({ day: 3, week: 3, month: 3, in_window: 3 });
  });

  it('suppresses distinct-user counts under 3', async () => {
    const r = await call('usage', '2026-09-09T00:00:00Z', '2026-09-12T00:00:00Z');
    expect(r.active_users).toEqual({ day: null, week: 3, month: 3, in_window: null });
  });

  it('voice: per-surface outcomes, success rate, percentiles, failed stages', async () => {
    const r = await call('voice');
    expect(Object.keys(r.by_surface).sort()).toEqual(['analytics', 'device', 'web_text', 'web_voice']);
    const none = { p50: null, p95: null };
    expect(r.by_surface.device).toEqual({
      turns: 6, outcomes: { completed: 3, failed: 1, cancelled: 1, empty: 1 }, success_rate: 0.75,
      latency_ms: { first_audio: { p50: 2000, p95: 2900 }, stt: { p50: 200, p95: 290 }, model: { p50: 500, p95: 590 },
        tts: { p50: 100, p95: 145 }, total: { p50: 2500, p95: 3400 } },
    });
    expect(r.by_surface.web_voice).toMatchObject({ turns: 3, success_rate: 0.3333,
      outcomes: { completed: 1, failed: 2, cancelled: 0, empty: 0 }, latency_ms: { first_audio: { p50: 1500, p95: 1500 }, stt: none } });
    expect(r.by_surface.web_text).toMatchObject({ turns: 2, success_rate: 0.5,
      latency_ms: { first_audio: none, stt: none, model: none, tts: none, total: none } });
    expect(r.by_surface.analytics).toMatchObject({ turns: 1, success_rate: 1 });
    expect(r.failed_by_stage).toEqual({ input: 1, stt: 1, agent: 1, tts: 1 });
    expect(r.first_audio_p95_by_bucket).toEqual([
      { t: '2026-09-10T00:00:00Z', device: null, web_voice: null },
      { t: '2026-09-11T00:00:00Z', device: 2900, web_voice: null },
      { t: '2026-09-12T00:00:00Z', device: null, web_voice: 1500 },
    ]);
  });

  it('voice: always lists the three surfaces, with a null rate and no rows', async () => {
    const r = await call('voice', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
    expect(Object.keys(r.by_surface).sort()).toEqual(['device', 'web_text', 'web_voice']);
    expect(r.by_surface.device).toMatchObject({ turns: 0, success_rate: null });
    expect(r.failed_by_stage).toEqual({ input: 0, stt: 0, agent: 0, tts: 0 });
  });

  it('platform: backlog, oldest pending, retried, failures by event type', async () => {
    const r = await call('platform');
    expect(r).toMatchObject({ window: { from: FROM, to: TO, bucket: 'day' }, backlog: 1, retried: 2 });
    expect(r.oldest_pending_seconds).toBeGreaterThanOrEqual(600);
    expect(r.oldest_pending_seconds).toBeLessThan(900);
    expect(r.failed_by_event_type).toEqual([
      { event_type: 'email.notification', count: 2 }, { event_type: 'space.invited', count: 1 }]);
    expect((await call('platform', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')).failed_by_event_type).toEqual([]);
  });

  it('rejects an invalid window with invalid_window', async () => {
    const bad: [string, string, string][] = [
      [FROM, TO, 'month'], [FROM, FROM, 'day'], [TO, FROM, 'day'],
      ['2026-01-01T00:00:00Z', '2026-04-05T00:00:00Z', 'day'], ['2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z', 'hour'],
    ];
    for (const fn of FNS) for (const [f, t, b] of bad) await expect(call(fn, f, t, b)).rejects.toThrow(/invalid_window/);
    await expect(db.query(`select bob_private.operator_metrics_window('${FROM}', '${TO}', 'week')`)).resolves.toBeDefined();
  });

  it('never returns an id, an email, a name or a title', async () => {
    const outs = [await call('usage'), await call('voice'), await call('platform'), await call('usage', '2026-09-09T00:00:00Z', '2026-09-12T00:00:00Z')];
    for (const text of outs.map((o) => JSON.stringify(o))) {
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(text).not.toContain('@');
      for (const secret of [...ids, ...emails, 'Agg 0', 'secret title']) expect(text).not.toContain(secret);
    }
  });

  it('denies authenticated on the three functions and the validator', async () => {
    for (const fn of FNS) {
      await expect(asAuthenticated(`select bob_private.operator_metrics_${fn}('${FROM}', '${TO}', 'day')`))
        .rejects.toThrow(/permission denied/i);
    }
    await expect(asAuthenticated(`select bob_private.operator_metrics_window('${FROM}', '${TO}', 'day')`))
      .rejects.toThrow(/permission denied/i);
  });

  it('is idempotent and keeps its grants when applied twice', async () => {
    const sql = readFileSync(FILE, 'utf8');
    await admin(sql);
    await admin(sql);
    expect((await call('usage')).turns_total).toBe(6);
  });
});
