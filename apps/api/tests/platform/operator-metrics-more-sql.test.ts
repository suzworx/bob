/**
 * Operator metrics, three more aggregates (20261004120000_operator_metrics_more,
 * ANL-AGG2): AI and cost, devices, features. Read-only security definers that
 * return one jsonb document each, counts and percentiles only, never a person.
 * Fixtures bob_server cannot write go through an admin connection, exactly like
 * operator-metrics-sql.test.ts.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { addAccount, closeTestDb, createTestDb, withAdminAuth, type TestDb } from '../support/test-db.ts';

const FILE = new URL('../../../../supabase/migrations/20261004120000_operator_metrics_more.sql', import.meta.url);
const FROM = '2026-09-10T00:00:00Z';
const TO = '2026-09-13T00:00:00Z';
const D1 = '2026-09-11T12:00:00Z';
const D2 = '2026-09-12T12:00:00Z';
const FNS = ['ai', 'devices', 'features'] as const;
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('operator metrics, more aggregates (ANL-AGG2)', () => {
  let db: TestDb;
  let ids: string[] = [];
  const emails = ['more-a@example.test', 'more-b@example.test', 'more-c@example.test'];
  const admin = async <T,>(sql: string): Promise<T[]> =>
    withAdmin(await adminDatabaseUrl((db as unknown as { databaseName: string }).databaseName), async (s) => [
      ...(await s.unsafe<T[]>(sql)),
    ]);
  const need = <T,>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`missing ${what}`);
    return value;
  };
  const uid = (n: number): string => need(ids[n], `account ${n}`);
  const call = async (fn: string, from = FROM, to = TO, bucket = 'day'): Promise<Doc> => {
    const res = await db.query<{ r: Doc }>(
      `select bob_private.operator_metrics_${fn}($1::timestamptz, $2::timestamptz, $3::text) as r`,
      [from, to, bucket]);
    return need(res.rows[0], `${fn} result row`).r;
  };
  const asAuthenticated = (sql: string): Promise<unknown> =>
    db.transaction(async (tx) => {
      await tx.exec('set local role authenticated');
      return tx.query(sql);
    });
  const metric = async (p: Record<string, unknown>, at: string): Promise<void> => {
    await db.query('select bob_private.record_turn_metric($1::jsonb)', [p]);
    await admin(`update bob.turn_metrics set occurred_at = '${at}' where id = (select max(id) from bob.turn_metrics)`);
  };

  // 21 in-window turns: model-a x4, b x3, c x3, d-g x2, h, i, and one with no model.
  const models: (string | null)[] = [
    ...Array<string>(4).fill('model-a'), ...Array<string>(3).fill('model-b'), ...Array<string>(3).fill('model-c'),
    ...['model-d', 'model-e', 'model-f', 'model-g'].flatMap((m) => [m, m]), 'model-h', 'model-i', null,
  ];
  const BULK = Array.from({ length: 26 }, (_, i) => `bulk_${String(i).padStart(2, '0')}`);
  const seedAi = async (): Promise<void> => {
    await admin('delete from bob.turn_metrics');
    const base = { surface: 'web_text', outcome: 'completed', intent: 'chat', input_tokens: 100, output_tokens: 10,
      cached_input_tokens: 40, cache_write_tokens: 5, reasoning_tokens: 2, steps: 2, total_ms: 1000 };
    const over: Record<number, Record<string, unknown>> = {
      0: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 20, steps: 5, intent: 'calendar', called_tools: ['create_event', 'search_web'] },
      1: { steps: 3, output_tokens: 6, interrupted: true, intent: 'calendar', called_tools: ['search_web'] },
      2: { interrupted: true, intent: 'calendar', called_tools: ['create_event'] },
      3: { outcome: 'cancelled', input_tokens: null, output_tokens: null, cached_input_tokens: null, cache_write_tokens: null,
        reasoning_tokens: null, steps: null, total_ms: null },
      4: { outcome: 'failed', failed_stage: 'agent', failure_kind: 'internal', intent: 'calendar', total_ms: 3000 },
      5: { outcome: 'failed', failed_stage: 'agent', failure_kind: 'internal' },
      6: { intent: 'task_note', total_ms: null },
      7: { called_tools: ['search_web', 'set_timer'] },
      8: { called_tools: BULK },
    };
    for (const [i, model] of models.entries()) await metric({ ...base, model, ...over[i] }, i % 2 === 0 ? D1 : D2);
    await admin(`update bob.turn_metrics set occurred_at = '2026-09-11T13:00:00Z' where model is null`);
    const out = { ...base, model: 'model-z', input_tokens: 99999, output_tokens: 99999, called_tools: ['outside_tool'] };
    await metric(out, TO);
    await metric(out, '2026-09-09T23:59:59Z');
  };
  const ts = (iso: string): string => (iso === 'null' ? 'null' : `'${iso}'`);
  const device = (n: number, model: string, fw: string, seen: string, revoked = 'null'): string =>
    `insert into bob.devices (user_id, name, model, fw_version, paired_at, last_seen_at, revoked_at)
     values ('${ids[n % 3]}', 'Device Secret ${n}', '${model}', '${fw}', '2026-08-01T00:00:00Z', ${ts(seen)}, ${ts(revoked)});`;
  const pairing = (n: number, status: string, at: string): string =>
    `insert into bob.pairing_requests (code_hash, claim_hash, device_model, fw_version, requested_ip_hash, created_at, expires_at, status)
     values (convert_to('code${n}', 'UTF8'), convert_to('claim${n}', 'UTF8'), 'cardputer', '1.0.0', 'iphash${n}',
       '${at}', '${at}'::timestamptz + interval '10 minutes', '${status}');`;
  // Six live devices (3 on 1.2.3, 2 on 2.0.0, 1 with a malformed version), one revoked in the
  // window and one revoked before it. Freshness is measured against TO.
  const seedDevices = async (): Promise<void> => {
    await admin('delete from bob.pairing_requests; delete from bob.devices;');
    await admin([
      device(1, 'cardputer', '1.2.3', '2026-09-12T23:30:00Z'), device(2, 'cardputer', '1.2.3', '2026-09-12T19:00:00Z'),
      device(3, 'cardputer', '1.2.3', '2026-09-10T00:00:00Z'), device(4, 'cardputer', '2.0.0', '2026-09-03T00:00:00Z'),
      device(5, 'cardputer', '2.0.0', 'null'), device(6, 'stick-s3', 'bad version!!', '2026-09-12T01:00:00Z'),
      device(7, 'cardputer', '1.2.3', '2026-09-12T10:00:00Z', '2026-09-12T11:00:00Z'),
      device(8, 'cardputer', '1.2.3', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z'),
    ].join('\n'));
    await admin([
      pairing(1, 'pending', '2026-09-11T08:00:00Z'), pairing(2, 'pending', '2026-09-12T08:00:00Z'),
      pairing(3, 'approved', '2026-09-11T09:00:00Z'), pairing(4, 'delivered', '2026-09-11T10:00:00Z'),
      pairing(5, 'expired', '2026-09-11T11:00:00Z'), pairing(6, 'denied', '2026-09-11T12:00:00Z'),
      pairing(7, 'pending', '2026-09-20T08:00:00Z'),
    ].join('\n'));
  };
  const spaceId = (n: number): string => `00000000-0000-4000-8000-0000000000b${n}`;
  const SP_PRIV = spaceId(1);
  const SP_PAIR = spaceId(2);
  const SP_GRP = spaceId(3);
  const SP_OLD = spaceId(4);
  const REM = '00000000-0000-4000-8000-0000000000c1';
  const CAL = '00000000-0000-4000-8000-0000000000c2';
  // Rows created on 09-11 and 09-12 inside the window, one older row per table outside it.
  const seedFeatures = async (): Promise<void> => {
    const space = (id: string, kind: string, owner: string | null, at: string): string =>
      `insert into bob.spaces (id, kind, name, owner_user_id, created_at) values ('${id}', '${kind}', 'Secret space ${kind}', ${owner ? `'${owner}'` : 'null'}, '${at}');`;
    const task = (n: number, at: string, done: boolean): string =>
      `insert into bob.tasks (space_id, title, order_key, created_by, status, completed_at, created_at)
       values ('${SP_GRP}', 'secret task title ${n}', 'k${n}', '${ids[0]}', '${done ? 'completed' : 'open'}', ${done ? "'2026-09-11T12:00:00Z'" : 'null'}, '${at}');`;
    const note = (n: number, at: string): string =>
      `insert into bob.notes (space_id, title, body, created_by, updated_by, created_at)
       values ('${SP_GRP}', 'secret note title ${n}', 'secret note text ${n}', '${ids[0]}', '${ids[0]}', '${at}');`;
    const rem = (id: string, kind: string, at: string): string =>
      `insert into bob.reminders (id, space_id, kind, title, status, created_by, due_at, due_zone, duration_ms, created_at)
       values ('${id}', '${SP_GRP}', '${kind}', ${kind === 'reminder' ? "'secret reminder'" : 'null'}, '${kind === 'reminder' ? 'active' : 'pending'}',
         '${ids[0]}', '2026-12-01T10:00:00Z', 'UTC', ${kind === 'reminder' ? 'null' : '1000'}, '${at}');`;
    const occ = (at: string, delivered: boolean, ack: boolean, snoozed: boolean): string =>
      `insert into bob.reminder_occurrences (reminder_id, user_id, occurrence_at, schedule_revision, delivered_at, acknowledged_at, snoozed_until)
       values ('${REM}', '${ids[0]}', '${at}', 1, ${delivered ? `'${at}'` : 'null'}, ${ack ? `'${at}'` : 'null'}, ${snoozed ? `'${at}'` : 'null'});`;
    const event =(n: number, at: string): string =>
      `insert into bob.calendar_events (calendar_id, space_id, uid, organizer_user_id, title, all_day, start_at, end_at, zone, created_at)
       values ('${CAL}', '${SP_PRIV}', 'uid-more-${n}', '${ids[0]}', 'secret event ${n}', false, '2026-12-01T10:00:00Z', '2026-12-01T11:00:00Z', 'UTC', '${at}');`;
    await admin([
      space(SP_PRIV, 'private', uid(0), D1), space(SP_PAIR, 'pair', null, D1), space(SP_GRP, 'group', uid(1), D2),
      space(SP_OLD, 'private', uid(1), '2026-09-01T08:00:00Z'),
      task(1, D1, false), task(2, D1, true), task(3, D2, false), task(4, '2026-09-01T08:00:00Z', true),
      note(1, D1), note(2, D2), note(3, '2026-09-01T08:00:00Z'),
      rem(REM, 'reminder', D1), rem('00000000-0000-4000-8000-0000000000c3', 'reminder', D2),
      rem('00000000-0000-4000-8000-0000000000c4', 'timer', D2), rem('00000000-0000-4000-8000-0000000000c5', 'reminder', '2026-09-01T08:00:00Z'),
      occ('2026-09-11T10:00:00Z', true, false, false), occ('2026-09-11T11:00:00Z', true, true, false),
      occ('2026-09-12T10:00:00Z', true, false, true), occ('2026-09-01T10:00:00Z', true, true, true),
      `insert into bob.calendars (id, space_id, name, zone, created_by) values ('${CAL}', '${SP_PRIV}', 'Secret calendar', 'UTC', '${ids[0]}');`,
      event(1, D1), event(2, D2), event(3, '2026-09-01T08:00:00Z'),
      `insert into bob.game_usage (user_id, day, seconds) values ('${ids[0]}', '2026-09-11', 600), ('${ids[0]}', '2026-09-12', 120),
         ('${ids[1]}', '2026-09-11', 150), ('${ids[0]}', '2026-09-20', 6000);`,
    ].join('\n'));
  };
  const seedNotifications = async (): Promise<void> => {
    const notif = (n: number, type: string, at: string, read: boolean): string =>
      `insert into bob.notifications (recipient_user_id, type, resource_type, resource_id, effect_key, read_at, created_at)
       values ('${ids[0]}', '${type}', 'task', gen_random_uuid(), 'more:${n}', ${read ? `'${at}'` : 'null'}, '${at}');`;
    await admin(['delete from bob.notifications;', notif(1, 'mention', D1, false), notif(2, 'mention', D2, true),
      notif(3, 'assignment', D1, false), notif(4, 'reminder', D2, false), notif(5, 'mention', '2026-09-01T08:00:00Z', true)].join('\n'));
  };

  beforeAll(async () => {
    db = await createTestDb();
    ids = (await Promise.all(emails.map(() => addAccount(db)))).map((a) => a.userId);
    for (const [i, id] of ids.entries()) {
      await withAdminAuth(db, (a) => a.setProfile(id, { email: need(emails[i], `email ${i}`), name: `More ${i}` }));
    }
    await seedAi();
    await seedDevices();
    await seedFeatures();
    await seedNotifications();
  }, 180_000);

  afterAll(async () => {
    await admin('delete from bob.turn_metrics').catch(() => undefined);
    await closeTestDb(db);
  });

  it('ai: documented shape, token sums, ratios and the window echo', async () => {
    const r = await call('ai');
    expect(r.window).toEqual({ from: FROM, to: TO, bucket: 'day' });
    expect(r).toMatchObject({
      turns: 21,
      tokens: { input: 2100, output: 206, cached_input: 860, cache_write: 100, reasoning: 40 },
      cache_hit_ratio: 0.4095, avg_steps: 2.2, avg_output_tokens: 10.3, interrupted_rate: 0.1111,
    });
    expect(Object.keys(r).sort()).toEqual(['avg_output_tokens', 'avg_steps', 'by_model', 'cache_hit_ratio', 'intents',
      'interrupted_rate', 'tokens', 'tokens_by_bucket', 'tools', 'turns', 'window']);
  });

  it('ai: top 7 models by turns, then one "other" row; no model counts as unknown', async () => {
    const r = await call('ai');
    expect(r.by_model.map((m: Doc) => m.model)).toEqual(
      ['model-a', 'model-b', 'model-c', 'model-d', 'model-e', 'model-f', 'model-g', 'other']);
    expect(r.by_model[0]).toEqual({ model: 'model-a', turns: 4, input: 400, output: 36, cached_input: 180 });
    expect(r.by_model[7]).toEqual({ model: 'other', turns: 3, input: 300, output: 30, cached_input: 120 });
    expect(r.by_model.reduce((n: number, m: Doc) => n + m.turns, 0)).toBe(21);
    const one = await call('ai', '2026-09-11T13:00:00Z', '2026-09-11T14:00:00Z', 'hour');
    expect(one.by_model).toEqual([{ model: 'unknown', turns: 1, input: 100, output: 10, cached_input: 40 }]);
    expect(one.tokens_by_bucket).toEqual([{ t: '2026-09-11T13:00:00Z', input: 100, output: 10, cached_input: 40 }]);
  });

  it('ai: top 25 tools by count then name, intents with success rate and p95', async () => {
    const r = await call('ai');
    expect(r.tools).toHaveLength(25);
    expect(r.tools.slice(0, 3)).toEqual([{ tool: 'search_web', count: 3 }, { tool: 'create_event', count: 2 }, { tool: 'bulk_00', count: 1 }]);
    expect(r.tools[24]).toEqual({ tool: 'bulk_22', count: 1 });
    expect(r.intents).toEqual([
      { intent: 'chat', turns: 16, success_rate: 0.9333, p95_total_ms: 1000 },
      { intent: 'calendar', turns: 4, success_rate: 0.75, p95_total_ms: 2700 },
      { intent: 'task_note', turns: 1, success_rate: 1, p95_total_ms: null },
    ]);
  });

  it('ai: zero-filled token buckets, and null ratios with no rows', async () => {
    const r = await call('ai');
    expect(r.tokens_by_bucket).toEqual([
      { t: '2026-09-10T00:00:00Z', input: 0, output: 0, cached_input: 0 },
      { t: '2026-09-11T00:00:00Z', input: 1200, output: 120, cached_input: 500 },
      { t: '2026-09-12T00:00:00Z', input: 900, output: 86, cached_input: 360 },
    ]);
    const e = await call('ai', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
    expect(e).toMatchObject({ turns: 0, tokens: { input: 0, output: 0, cached_input: 0, cache_write: 0, reasoning: 0 },
      cache_hit_ratio: null, avg_steps: null, avg_output_tokens: null, interrupted_rate: null,
      by_model: [], tools: [], intents: [], tokens_by_bucket: [{ t: '2026-01-01T00:00:00Z', input: 0, output: 0, cached_input: 0 }] });
  });

  it('devices: counts, folded versions and models, freshness, pairing outcomes', async () => {
    const r = await call('devices');
    expect(r.window).toEqual({ from: FROM, to: TO, bucket: 'day' });
    expect(r.devices).toEqual({ paired: 6, active_in_window: 4, revoked: 1 });
    expect(r.by_fw_version).toEqual([{ fw_version: '1.2.3', count: 3 }, { fw_version: 'other (fewer than 3)', count: 3 }]);
    expect(r.by_model).toEqual([{ model: 'cardputer', count: 5 }, { model: 'other (fewer than 3)', count: 1 }]);
    expect(r.freshness).toEqual({ under_1h: 1, under_24h: 2, under_7d: 1, older: 1, never: 1 });
    expect(r.pairing).toEqual({ requested: 2, approved: 2, expired: 1, other: 1 });
  });

  it('devices: a firmware version with 2 devices is folded into other, with 3 it is named', async () => {
    const extra = (n: number): string => device(n, 'cardputer', '9.9.9', '2026-09-12T12:00:00Z');
    try {
      await admin([extra(91), extra(92)].join('\n'));
      const two = await call('devices');
      expect(two.by_fw_version).toEqual([{ fw_version: '1.2.3', count: 3 }, { fw_version: 'other (fewer than 3)', count: 5 }]);
      await admin(extra(93));
      const three = await call('devices');
      expect(three.by_fw_version).toEqual([
        { fw_version: '1.2.3', count: 3 }, { fw_version: '9.9.9', count: 3 }, { fw_version: 'other (fewer than 3)', count: 3 }]);
    } finally {
      await admin(`delete from bob.devices where fw_version = '9.9.9'`);
    }
  });

  it('features: counts of rows created, zero-filled buckets, never content', async () => {
    const r = await call('features');
    expect(r.window).toEqual({ from: FROM, to: TO, bucket: 'day' });
    expect(r.created_by_bucket).toEqual([
      { t: '2026-09-10T00:00:00Z', tasks: 0, notes: 0, reminders: 0 },
      { t: '2026-09-11T00:00:00Z', tasks: 2, notes: 1, reminders: 1 },
      { t: '2026-09-12T00:00:00Z', tasks: 1, notes: 1, reminders: 1 },
    ]);
    expect(r.tasks).toEqual({ created: 3, completed: 1 });
    expect(r.reminders).toEqual({ created: 2, delivered: 3, acknowledged: 1, snoozed: 1 });
    expect(r.notifications).toEqual({ created: 4, read: 1,
      by_type: [{ type: 'mention', count: 2 }, { type: 'assignment', count: 1 }, { type: 'reminder', count: 1 }] });
    expect(r.calendar).toEqual({ events_created: 2, by_origin: [] });
    expect(r.spaces).toEqual({ created: 3, by_kind: { private: 1, pair: 1, group: 1 } });
    expect(r.game_minutes).toBe(14);
  });

  it('rejects an invalid window with invalid_window', async () => {
    const bad: [string, string, string][] = [
      [FROM, TO, 'month'], [FROM, FROM, 'day'], [TO, FROM, 'day'],
      ['2026-01-01T00:00:00Z', '2026-04-05T00:00:00Z', 'day'], ['2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z', 'hour'],
    ];
    for (const fn of FNS) for (const [f, t, b] of bad) await expect(call(fn, f, t, b)).rejects.toThrow(/invalid_window/);
  });

  it('never returns an id, an email, a name, a title or text', async () => {
    const outs = [await call('ai'), await call('devices'), await call('features'), await call('ai', FROM, '2026-09-11T00:00:00Z')];
    const secrets = [...ids, ...emails, 'More 0', 'Device Secret', 'secret task', 'secret note', 'secret reminder',
      'secret event', 'Secret space', 'Secret calendar', 'iphash', 'outside_tool', 'model-z'];
    for (const text of outs.map((o) => JSON.stringify(o))) {
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(text).not.toContain('@');
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  });

  it('denies authenticated on the three functions', async () => {
    for (const fn of FNS) {
      await expect(asAuthenticated(`select bob_private.operator_metrics_${fn}('${FROM}', '${TO}', 'day')`))
        .rejects.toThrow(/permission denied/i);
    }
  });

  it('is idempotent and keeps its grants when applied twice', async () => {
    const sql = readFileSync(FILE, 'utf8');
    await admin(sql);
    await admin(sql);
    expect((await call('ai')).turns).toBe(21);
    await expect(asAuthenticated(`select bob_private.operator_metrics_ai('${FROM}', '${TO}', 'day')`))
      .rejects.toThrow(/permission denied/i);
  });
});
