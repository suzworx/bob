/**
 * docs/observability/supabase-report.md (ANL-SBR1): every SQL block the owner
 * pastes into the Supabase custom report runs here against a real Postgres, as
 * the admin role, inside a read-only transaction, and is checked statically to
 * be aggregates only over an allowlist of relations.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const DOC = new URL('../../../../docs/observability/supabase-report.md', import.meta.url);
const CHARTS = ['line', 'stacked bar', 'bar', 'table', 'number'];
const ALLOWED = new Set([
  'bob.messages', 'bob.turn_metrics', 'bob.devices', 'bob.outbox', 'bob.reminders',
  'bob.reminder_occurrences', 'auth.users', 'pg_stat_user_tables', 'pg_class', 'pg_namespace',
]);
const FENCE = '`'.repeat(3);

interface Block { n: number; title: string; chart: string | undefined; sqls: string[]; sql: string }

function parse(document = readFileSync(DOC, 'utf8')): Block[] {
  const parts = document.replace(/\r\n/g, '\n').split(/^### (?=\d+\. )/m).slice(1);
  return parts.map((part) => {
    const head = /^(\d+)\. (.+)$/m.exec(part);
    const sqls = [...part.matchAll(new RegExp(`${FENCE}sql\\n([\\s\\S]*?)${FENCE}`, 'g'))].map((m) => m[1] ?? '');
    return {
      n: Number(head?.[1]), title: head?.[2] ?? '', sqls, sql: sqls[0] ?? '',
      chart: /^Chart: ([a-z ]+)\./m.exec(part)?.[1],
    };
  });
}

/** Comments and string literals removed, so words inside them never trip a check. */
const code = (sql: string): string => sql.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''").toLowerCase();

describe('Supabase report SQL (ANL-SBR1)', () => {
  it('parses the same report with LF and CRLF line endings', () => {
    const document = readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
    expect(parse(document.replace(/\n/g, '\r\n'))).toEqual(parse(document));
  });
  let db: TestDb;
  let url: string;
  const blocks = (): Block[] => parse();
  const run = (sql: string): Promise<Record<string, unknown>[]> =>
    withAdmin(url, (s) => s.begin('read only', async (tx) => [...(await tx.unsafe<Record<string, unknown>[]>(sql))]));

  beforeAll(async () => {
    db = await createTestDb();
    url = await adminDatabaseUrl((db as unknown as { databaseName: string }).databaseName);
    const [a, b] = [await addAccount(db), await addAccount(db)];
    const turn = (p: Record<string, unknown>): Promise<unknown> => db.query('select bob_private.record_turn_metric($1::jsonb)', [p]);
    await turn({ surface: 'device', outcome: 'completed', intent: 'timer_reminder', fw_version: '1.2.3', input_tokens: 100,
      output_tokens: 20, cached_input_tokens: 50, called_tools: ['set_timer'], first_audio_ms: 900, total_ms: 1500 });
    await turn({ surface: 'device', outcome: 'failed', failed_stage: 'tts', intent: 'chat', first_audio_ms: 1400, total_ms: 2000 });
    await turn({ surface: 'web_text', outcome: 'cancelled', called_tools: ['get_time', 'set_timer'] });
    await turn({ surface: 'web_voice', outcome: 'empty' });
    const conv = 'conv_seed0001';
    const row = (userId: string, role: string, pos: number, origin: string, ago: number): string =>
      `('${conv}', '${userId}', '${role}', ${pos}, '${origin}', now() - interval '${ago} days')`;
    await withAdmin(url, async (s) => {
      await s.unsafe(`insert into bob.conversations (id, user_id, title) values ('${conv}', '${a.userId}', 'seed')`);
      await s.unsafe(`insert into bob.messages (conversation_id, user_id, role, position, origin, created_at) values
        ${[row(a.userId, 'user', 0, 'device', 1), row(a.userId, 'user', 1, 'web_voice', 1), row(b.userId, 'user', 2, 'web_text', 2),
          row(a.userId, 'assistant', 3, 'device', 1)].join(', ')}`);
      await s.unsafe(`insert into bob.devices (user_id, name, model, fw_version) values ('${a.userId}', 'seed', 'cardputer', '1.2.3')`);
      await s.unsafe(`insert into bob.outbox (event_type, resource_type, resource_id, effect_key)
        values ('task.created', 'task', '${randomUUID()}', 'seed-1')`);
      await s.unsafe(`with s as (insert into bob.spaces (kind, name, owner_user_id) values ('private', 'seed', '${a.userId}') returning id),
        r as (insert into bob.reminders (space_id, title, due_at, due_zone, created_by)
              select id, 'seed', now() + interval '1 day', 'UTC', '${a.userId}' from s returning id)
        insert into bob.reminder_occurrences (reminder_id, user_id, occurrence_at, schedule_revision, delivered_at, acknowledged_at, snoozed_until)
        select id, '${a.userId}', now() - interval '1 day', 1, now(), now(), now() from r`);
    });
  }, 120_000);

  afterAll(async () => { await closeTestDb(db); });

  it('has 15 sections numbered 1 to 15, each with one sql block and a chart type', () => {
    const all = blocks();
    expect(all.map((b) => b.n)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    for (const b of all) {
      expect(b.sqls, `block ${b.n}`).toHaveLength(1);
      expect(CHARTS, `block ${b.n} chart`).toContain(b.chart);
    }
  });

  it('runs every block as admin without error', async () => {
    for (const b of blocks()) await expect(run(b.sql), `block ${b.n} ${b.title}`).resolves.toBeInstanceOf(Array);
  });

  it('returns the expected columns for the seeded data', async () => {
    const want: Record<number, string[]> = {
      1: ['day', 'device', 'web_voice', 'web_text'], 4: ['day', 'completed', 'failed', 'cancelled', 'empty'],
      5: ['day', 'p50_ms', 'p95_ms'], 7: ['day', 'input_tokens', 'output_tokens', 'cached_input_tokens'],
      9: ['tool', 'calls'], 12: ['backlog', 'oldest_minutes'],
    };
    for (const b of blocks().filter((x) => x.n in want)) {
      const rows = await run(b.sql);
      expect(rows.length, `block ${b.n} rows`).toBeGreaterThan(0);
      expect(Object.keys(rows[0] ?? {}), `block ${b.n} columns`).toEqual(want[b.n]);
    }
  });

  it('is static-safe: SELECT or WITH only, no select *, no identifying columns', () => {
    for (const b of blocks()) {
      const c = code(b.sql);
      expect(c.trim(), `block ${b.n}`).toMatch(/^(select|with)\b/);
      expect(c, `block ${b.n}`).not.toMatch(/\bselect\s+\*/);
      expect(c, `block ${b.n}`).not.toMatch(/\b(insert|update|delete|alter|drop|create|grant|truncate|call|do)\b/);
      const bare = c.replace(/count\(\s*distinct\s+user_id\s*\)/g, '');
      expect(bare, `block ${b.n}`).not.toMatch(/\b(email|name|title|body|token_hash|user_id)\b/);
    }
  });

  it('reads only allowlisted relations', () => {
    for (const b of blocks()) {
      const c = code(b.sql);
      const ctes = new Set([...c.matchAll(/\b([a-z_]\w*)\s+as\s*\(/g)].map((m) => m[1] ?? ''));
      const rels = [...c.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)(\s*\()?/g)].filter((m) => !m[2]).map((m) => m[1] ?? '');
      for (const r of rels) expect(ALLOWED.has(r) || ctes.has(r) || r.startsWith('pg_catalog.'), `block ${b.n} reads ${r}`).toBe(true);
    }
  });
});
