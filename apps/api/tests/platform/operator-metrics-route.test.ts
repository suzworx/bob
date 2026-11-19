import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createV2Server } from '../../src/server.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createOperatorMetricsRouter } from '../../src/platform/observability/operator-metrics.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { SCHEMAS } from '../../src/platform/observability/operator-metrics-schemas.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let server: Server;
/** Every booted server's extraction worker: server.close() does not stop it. */
const workers: Array<{ stop(): Promise<void> }> = [];
let baseUrl: string;
let operatorId: string;
let ordinaryId: string;
let operatorToken: string;
let ordinaryToken: string;
const lines: string[] = [];
const PAGES = ['users', 'usage', 'voice', 'platform', 'ai', 'devices', 'features'] as const;
const KEYS: Record<(typeof PAGES)[number], string[]> = {
  users: ['accounts', 'activated_users', 'active_users', 'signups', 'signups_by_bucket', 'waitlist', 'window'],
  usage: ['active_users', 'conversations_created', 'signups', 'turns_by_bucket', 'turns_total', 'window'],
  voice: ['by_surface', 'failed_by_stage', 'first_audio_p95_by_bucket', 'window'],
  platform: ['backlog', 'failed_by_event_type', 'oldest_pending_seconds', 'retried', 'window'],
  ai: ['avg_output_tokens', 'avg_steps', 'by_model', 'cache_hit_ratio', 'intents', 'interrupted_rate', 'tokens', 'tokens_by_bucket', 'tools', 'turns', 'window'],
  devices: ['by_fw_version', 'by_model', 'devices', 'freshness', 'pairing', 'window'],
  features: ['calendar', 'created_by_bucket', 'game_minutes', 'notifications', 'reminders', 'spaces', 'tasks', 'window'],
};
const SEEDED = {
  space: '00000000-0000-4000-8000-0000000000e1',
  reminder: '00000000-0000-4000-8000-0000000000e2',
  names: ['Seeded Device Secret', 'Seeded Space Secret', 'seeded secret task', 'seeded secret note', 'seeded secret reminder'],
};

async function tokenFor(base: string, userId: string): Promise<string> {
  const issued = await fetch(`${base}/api/test-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  expect(issued.status).toBe(200);
  return ((await issued.json()) as { token: string }).token;
}

const get = (path: string, token?: string): Promise<Response> =>
  fetch(`${baseUrl}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

const readLines = (): string[] => lines.filter((l) => l.includes('v2.operator_metrics_read'));

async function boot(operatorId: string | undefined): Promise<void> {
  if (operatorId) process.env.BOB_OPERATOR_USER_IDS = operatorId;
  else delete process.env.BOB_OPERATOR_USER_IDS;
  const created = await createV2Server();
  server = created.server;
  workers.push(created.memoryWorker);
  await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
}

const stop = (): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

describe('operator metrics routes', () => {
  beforeAll(async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    setJournalSink((line) => lines.push(line));
    pg = await createTestDb();
    const db = asDb(pg);
    setSharedDb(Promise.resolve(db));
    const operator = await addAccount(pg);
    const ordinary = await addAccount(pg);
    operatorId = operator.userId;
    ordinaryId = ordinary.userId;
    for (const [i, account] of [operator, ordinary].entries()) {
      const conversation = await createConversation(db, account.userId, `Chat ${i}`);
      await appendMessage(db, account.userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'hello' }] });
      for (const outcome of ['completed', 'failed']) {
        await db.query('SELECT bob_private.record_turn_metric($1::jsonb)', [{
          surface: 'device', outcome, failed_stage: outcome === 'failed' ? 'stt' : null, first_audio_ms: 900, user_bucket: i,
        }]);
      }
    }
    for (const [i, model] of ['seeded-model-a', 'seeded-model-a', 'seeded-model-b'].entries()) {
      await db.query('SELECT bob_private.record_turn_metric($1::jsonb)', [{
        surface: 'web_text', outcome: 'completed', intent: 'chat', model, input_tokens: 100, output_tokens: 10, cached_input_tokens: 40,
        steps: 2, total_ms: 900, called_tools: i === 2 ? ['seeded_tool_b'] : ['seeded_tool_a'],
      }]);
    }
    const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
    const owner = operator.userId;
    // Postgres and Node clocks can differ; fixtures belong inside the queried window,
    // never on its live upper boundary. No wall-clock sleep is needed.
    const seededAt = new Date(Date.now() - 86_400_000).toISOString();
    await withAdmin(url, async (s) => {
      await s.unsafe(`
        update bob.turn_metrics set occurred_at = '${seededAt}';
        insert into bob.spaces (id, kind, name, owner_user_id) values ('${SEEDED.space}', 'group', 'Seeded Space Secret', '${owner}');
        insert into bob.devices (user_id, name, model, fw_version, paired_at, last_seen_at)
          values ('${owner}', 'Seeded Device Secret', 'cardputer', '1.2.3', '${seededAt}', '${seededAt}');
        insert into bob.tasks (space_id, title, order_key, created_by, status, created_at) values ('${SEEDED.space}', 'seeded secret task', 'k1', '${owner}', 'open', '${seededAt}');
        insert into bob.notes (space_id, title, body, created_by, updated_by) values ('${SEEDED.space}', 'seeded secret note', 'seeded secret note body', '${owner}', '${owner}');
        insert into bob.reminders (id, space_id, kind, title, status, created_by, due_at, due_zone)
          values ('${SEEDED.reminder}', '${SEEDED.space}', 'reminder', 'seeded secret reminder', 'active', '${owner}', now() + interval '1 day', 'UTC');
        insert into bob.notifications (recipient_user_id, type, resource_type, resource_id, effect_key, created_at)
          values ('${owner}', 'mention', 'task', gen_random_uuid(), 'route:1', '${seededAt}');`);
      return [];
    });
    await boot(operator.userId);
    operatorToken = await tokenFor(baseUrl, operator.userId);
    ordinaryToken = await tokenFor(baseUrl, ordinary.userId);
  });

  afterAll(async () => {
    setJournalSink(null);
    if (server) await stop();
    await Promise.all(workers.splice(0).map((worker) => worker.stop().catch(() => undefined)));
    await closeTestDb(pg).catch(() => undefined);
    await closeDb().catch(() => undefined);
    for (const key of ['BOB_SYSTEM_TEST', 'BOB_V2_HOST', 'BOB_OPERATOR_USER_IDS']) delete process.env[key];
  });

  it('lets the operator in and returns the documented keys', async () => {
    expect((await get('/api/operator/access', operatorToken)).status).toBe(204);
    for (const page of PAGES) {
      const response = await get(`/api/operator/metrics/${page}`, operatorToken);
      expect(response.status).toBe(200);
      expect(Object.keys(await response.json()).sort()).toEqual(KEYS[page]);
    }
  });

  it('answers 404 to an ordinary account and 401 without a token', async () => {
    for (const path of ['/api/operator/access', ...PAGES.map((p) => `/api/operator/metrics/${p}`)]) {
      expect((await get(path, ordinaryToken)).status).toBe(404);
      expect((await get(path)).status).toBe(401);
    }
  });

  it('rejects bad queries with 400 and unknown pages with 404', async () => {
    for (const query of ['range=1y', 'bucket=minute', 'range=90d&bucket=hour', 'range=30d&bucket=hour', 'x=1']) {
      expect((await get(`/api/operator/metrics/usage?${query}`, operatorToken)).status).toBe(400);
    }
    expect((await get('/api/operator/metrics/people', operatorToken)).status).toBe(404);
  });

  it('keeps 400 and 404 for the new pages', async () => {
    for (const page of ['ai', 'devices', 'features']) {
      for (const query of ['range=1y', 'bucket=minute', 'range=90d&bucket=hour', 'x=1']) {
        expect((await get(`/api/operator/metrics/${page}?${query}`, operatorToken)).status).toBe(400);
      }
    }
    expect((await get('/api/operator/metrics/aiq', operatorToken)).status).toBe(404);
  });

  it('serves the seeded rows as aggregates and never as a person', async () => {
    const bodies: Record<string, string> = {};
    for (const page of ['ai', 'devices', 'features']) {
      const response = await get(`/api/operator/metrics/${page}?range=90d`, operatorToken);
      expect(response.status).toBe(200);
      bodies[page] = await response.text();
      const text = bodies[page] as string;
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(text).not.toContain('@');
      for (const secret of [operatorId, ordinaryId, SEEDED.space, SEEDED.reminder, ...SEEDED.names]) expect(text).not.toContain(secret);
    }
    const ai = JSON.parse(bodies.ai as string) as { by_model: { model: string; turns: number }[]; tools: { tool: string; count: number }[] };
    expect(ai.by_model).toContainEqual(expect.objectContaining({ model: 'seeded-model-a', turns: 2 }));
    expect(ai.tools).toContainEqual({ tool: 'seeded_tool_a', count: 2 });
    const devices = JSON.parse(bodies.devices as string) as { devices: { paired: number } };
    expect(devices.devices.paired).toBeGreaterThanOrEqual(1);
    const features = JSON.parse(bodies.features as string) as { tasks: { created: number }; notifications: { created: number } };
    expect(features.tasks.created).toBeGreaterThanOrEqual(1);
    expect(features.notifications.created).toBeGreaterThanOrEqual(1);
  });

  it('rejects an unexpected extra field in any page document', async () => {
    for (const page of PAGES) {
      const body = (await (await get(`/api/operator/metrics/${page}`, operatorToken)).json()) as { window: object };
      expect(SCHEMAS[page].safeParse(body).success).toBe(true);
      expect(SCHEMAS[page].safeParse({ ...body, user_id: 'x' }).success).toBe(false);
      expect(SCHEMAS[page].safeParse({ ...body, window: { ...body.window, email: 'x' } }).success).toBe(false);
    }
  });

  it('serves a repeated request from the memo', async () => {
    const path = '/api/operator/metrics/platform?range=30d';
    const before = readLines().length;
    expect((await get(path, operatorToken)).status).toBe(200);
    expect(readLines().length).toBe(before + 1);
    expect((await get(path, operatorToken)).status).toBe(200);
    expect(readLines().length).toBe(before + 1);
  });

  it('never leaks a person: no uuid or @ in any page, one account-free journal line', async () => {
    for (const page of PAGES) {
      const text = await (await get(`/api/operator/metrics/${page}?range=90d`, operatorToken)).text();
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(text).not.toContain('@');
    }
    const last = JSON.parse(readLines().at(-1) as string) as Record<string, unknown>;
    const envelope = new Set(['ts', 'level', 'message', 'trace_id', 'span_id', 'source', 'module', 'conversation_id', 'conversation_source']);
    expect(Object.keys(last).filter((key) => !envelope.has(key)).sort()).toEqual(['bucket', 'duration_ms', 'event', 'page', 'range']);
    for (const forbidden of ['user_id', 'acct', 'email', 'account_id']) expect(last).not.toHaveProperty(forbidden);
    expect(JSON.stringify(last)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|@/);
  });

  it('answers every account 404 when the allowlist is unset', async () => {
    await stop();
    await boot(undefined);
    const operator = await tokenFor(baseUrl, operatorId);
    const ordinary = await tokenFor(baseUrl, ordinaryId);
    expect((await get('/api/operator/access', operator)).status).toBe(404);
    expect((await get('/api/operator/metrics/usage', ordinary)).status).toBe(404);
  });

  it('lets a scope holder in with the allowlist unset, and a grant needs a fresh checker', async () => {
    await stop();
    await boot(undefined);
    const ordinary = await tokenFor(baseUrl, ordinaryId);
    expect((await get('/api/operator/access', ordinary)).status).toBe(404);
    await pg.query('SELECT bob_private.grant_user_scope($1::uuid, $2::text)', [ordinaryId, 'metrics.operator']);
    expect((await get('/api/operator/access', ordinary)).status).toBe(404);
    await stop();
    await boot(undefined);
    const fresh = await tokenFor(baseUrl, ordinaryId);
    const operator = await tokenFor(baseUrl, operatorId);
    expect((await get('/api/operator/access', fresh)).status).toBe(204);
    for (const page of ['usage', 'voice', 'platform']) {
      expect((await get(`/api/operator/metrics/${page}`, fresh)).status).toBe(200);
    }
    expect((await get('/api/operator/metrics/ai', fresh)).status).toBe(200);
    expect((await get('/api/operator/access', operator)).status).toBe(404);
    expect((await get('/api/operator/access')).status).toBe(401);
  });

  it('still lets an account on the env override in, next to the scope holders', async () => {
    await stop();
    await boot(operatorId);
    const operator = await tokenFor(baseUrl, operatorId);
    const holder = await tokenFor(baseUrl, ordinaryId);
    expect((await get('/api/operator/access', operator)).status).toBe(204);
    expect((await get('/api/operator/access', holder)).status).toBe(204);
  });

  it('answers 404 again once the scope is revoked and the server is fresh', async () => {
    await pg.query('SELECT bob_private.revoke_user_scope($1::uuid, $2::text)', [ordinaryId, 'metrics.operator']);
    await stop();
    await boot(undefined);
    const holder = await tokenFor(baseUrl, ordinaryId);
    expect((await get('/api/operator/access', holder)).status).toBe(404);
    expect((await get('/api/operator/metrics/usage', holder)).status).toBe(404);
  });

  it('maps a throwing Db to 500 store_error', async () => {
    const broken = { query: async () => { throw new Error('boom'); }, tx: async () => { throw new Error('boom'); } } as unknown as Db;
    const app = express();
    app.use('/api/operator', createOperatorMetricsRouter({ getDb: async () => broken }));
    const small = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const response = await fetch(`http://127.0.0.1:${(small.address() as AddressInfo).port}/api/operator/metrics/usage`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: 'store_error' } });
    } finally {
      await new Promise<void>((resolve) => small.close(() => resolve()));
    }
  });
});
