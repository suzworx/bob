// GET /api/me/usage over the REAL mounted server (ANL-U1): the caller's own usage as
// counts and times only. Boots createV2Server() like notifications-http.test.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createV2Server } from '../../src/server.ts';
import { closeDb, setSharedDb, StoreError, withUser, type Db } from '../../src/platform/db/db.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { approvePairing, issuePairing } from '../../src/devices/pairing-store.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin, type PgTestDb } from '../support/pg-template.ts';

const SECRET = 'SECRET TRANSCRIPT TEXT';
const DEVICE_LABEL = 'Kitchen-Cardputer-Label';

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
const journalLines: string[] = [];

type Usage = {
  range: string;
  active_days: number;
  turns: {
    total: number;
    by_surface: { device: number; web_voice: number; web_text: number };
    by_day: Array<{ day: string; device: number; web_voice: number; web_text: number }>;
    by_weekday_hour: Array<{ dow: number; hour: number; count: number }>;
  };
  conversations_created: number;
  created: { tasks: number; notes: number; reminders: number };
  todos_done: number;
  memories: { new_in_range: number; total: number } | null;
  game_minutes: number | null;
};

/** Runs SQL as the stack superuser: occurrences and auth metadata have no account write path. */
async function asAdmin(run: (sql: Parameters<Parameters<typeof withAdmin>[1]>[0]) => Promise<unknown>): Promise<void> {
  await withAdmin(await adminDatabaseUrl((pg as PgTestDb).databaseName), async (sql) => {
    await run(sql);
  });
}

/** The calendar day and hour of an instant in a zone, as the account sees it. */
function localParts(at: Date, zone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

async function tokenFor(userId: string): Promise<string> {
  const issued = await fetch(`${baseUrl}/api/test-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  return ((await issued.json()) as { token: string }).token;
}

async function getUsage(token: string | null, query = ''): Promise<Response> {
  return fetch(`${baseUrl}/api/me/usage${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

function dayOf(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/** Seeds one account: messages across origins and days, a conversation, a task (done), a note, a reminder, a timer, a device. */
async function seed(deviceName: string): Promise<{ userId: string; token: string }> {
  const { userId } = await addAccount(pg);
  const space = await ensurePrivateSpace(db, userId);
  const conversationId = `conv_${randomUUID()}`;
  await withUser(db, userId, async (tx) => {
    await tx.query('insert into bob.conversations (id, user_id, space_id, title) values ($1, $2, $3, $4)', [conversationId, userId, space.id, SECRET]);
    const turns: Array<[string, string, number]> = [
      ['user', 'device', 0], ['user', 'device', 0], ['user', 'web_text', 1], ['user', 'web_voice', 2],
      ['user', 'web_text', 20], ['assistant', 'web_text', 0],
    ];
    for (const [position, [role, origin, daysAgo]] of turns.entries()) {
      const id = `msg_${randomUUID()}`;
      await tx.query(
        `insert into bob.messages (id, conversation_id, space_id, user_id, role, position, sequence, origin, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now() - make_interval(days => $9::int))`,
        [id, conversationId, space.id, userId, role, position, position + 1, origin, daysAgo],
      );
      await tx.query(
        `insert into bob.message_versions (id, message_id, user_id, space_id, parts, version_index, is_selected)
         values ($1, $2, $3, $4, $5::jsonb, 0, true)`,
        [`ver_${randomUUID()}`, id, userId, space.id, JSON.stringify([{ type: 'text', text: SECRET }])],
      );
    }
    await tx.query(
      `insert into bob.tasks (space_id, title, order_key, created_by, status, completed_at)
       values ($1, $2, 'a0', $3, 'completed', now()), ($1, $2, 'a1', $3, 'open', null)`,
      [space.id, SECRET, userId],
    );
    await tx.query(`update bob.tasks set completed_by = $1 where created_by = $1 and status = 'completed'`, [userId]);
    // Made ten days ago, finished today: a to-do done this week, not a task created this week.
    await tx.query(
      `insert into bob.tasks (space_id, title, order_key, created_by, status, completed_at, completed_by, created_at)
       values ($1, $2, 'a2', $3, 'completed', now(), $3, now() - interval '10 days')`,
      [space.id, SECRET, userId],
    );
    // Memory lists every memory: two new this week, one older.
    const fresh = `mem_${randomUUID()}`;
    const action = `mem_${randomUUID()}`;
    await tx.query(
      `insert into bob.memories (id, user_id, kind, content, confidence, created_at) values
         ($1, $4, 'fact', $5::text || ' one', 0.9, now()), ($2, $4, 'action_item', $5::text || ' two', 0.9, now()),
         ($3, $4, 'fact', $5::text || ' three', 0.9, now() - interval '20 days')`,
      // Distinct content: one current row per account and content key (memories_current_content_key_uidx).
      [fresh, action, `mem_${randomUUID()}`, userId, SECRET],
    );
    await tx.query(`insert into bob.action_items (memory_id, user_id, status) values ($1, $2, 'done')`, [action, userId]);
    await tx.query('insert into bob.notes (space_id, title, created_by, updated_by) values ($1, $2, $3, $3)', [space.id, SECRET, userId]);
    await tx.query(
      `insert into bob.reminders (space_id, title, created_by, kind, status, due_at, due_zone, duration_ms)
       values ($1, $2, $3, 'reminder', 'active', now() + interval '1 day', 'UTC', null),
              ($1, $2, $3, 'timer', 'pending', now() + interval '1 hour', 'UTC', 3600000)`,
      [space.id, SECRET, userId],
    );
  });
  // A reminder Today showed and the account marked done.
  await asAdmin(async (sql) => {
    await sql`insert into bob.reminder_occurrences (reminder_id, user_id, occurrence_at, schedule_revision, acknowledged_at)
      select id, ${userId}::uuid, now() - interval '1 hour', 1, now() from bob.reminders
       where created_by = ${userId}::uuid and kind = 'reminder'`;
  });
  const pairingId = await issuePairing(db, {
    codeHash: randomBytes(32), claimHash: randomBytes(32), model: 'cardputer', fwVersion: '1.2.3', ipHash: 'iphash', ttlSeconds: 600,
  });
  await approvePairing(db, userId, pairingId, deviceName);
  return { userId, token: '' };
}

/** Reject only this feature's read; real session admission and RLS setup still run. */
function failingDb(real: Db = db): Db {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (/\bfrom\s+bob\.messages\b/i.test(sql)) {
        throw new StoreError('injected store failure');
      }
      return real.query<T>(sql, params);
    },
    tx<T>(run: (transaction: Db) => Promise<T>): Promise<T> {
      return real.tx(transaction => run(failingDb(transaction)));
    },
  };
}

describe('GET /api/me/usage over the mounted server', () => {
  let a: { userId: string; token: string };
  let b: { userId: string; token: string };

  beforeAll(async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    pg = await createTestDb();
    db = asDb(pg);
    setSharedDb(Promise.resolve(db));
    a = await seed(DEVICE_LABEL);
    b = await seed('Bedroom-Other-Label');
    // Account b gets two more of everything so a leak into a's counts is visible.
    await withUser(db, b.userId, async (tx) => {
      const conversationId = `conv_${randomUUID()}`;
      await tx.query('insert into bob.conversations (id, user_id, title) values ($1, $2, $3)', [conversationId, b.userId, 'b extra']);
      for (let position = 0; position < 3; position += 1) {
        await tx.query(
          `insert into bob.messages (id, conversation_id, user_id, role, position, origin)
           values ($1, $2, $3, 'user', $4, 'web_voice')`,
          [`msg_${randomUUID()}`, conversationId, b.userId, position],
        );
      }
    });
    setJournalSink((line) => journalLines.push(line));
    const created = await createV2Server();
    server = created.server;
    await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
    a.token = await tokenFor(a.userId);
    b.token = await tokenFor(b.userId);
  });

  afterAll(async () => {
    setJournalSink(null);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(pg).catch(() => undefined);
    await closeDb().catch(() => undefined);
    delete process.env.BOB_SYSTEM_TEST;
    delete process.env.BOB_V2_HOST;
  });

  it('counts only the caller own rows and never account b rows', async () => {
    const res = await getUsage(a.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Usage;
    expect(body.range).toBe('7d');
    expect(body.turns.total).toBe(4);
    expect(body.turns.by_surface).toEqual({ device: 2, web_voice: 1, web_text: 1 });
    expect(body.active_days).toBe(3);
    // Every day of the window is listed, zeros included, oldest first.
    expect(body.turns.by_day.map((d) => d.day)).toEqual([6, 5, 4, 3, 2, 1, 0].map(dayOf));
    expect(body.turns.by_day.filter((d) => d.device + d.web_voice + d.web_text > 0).map((d) => d.day)).toEqual([dayOf(2), dayOf(1), dayOf(0)]);
    expect(body.turns.by_day.find((d) => d.day === dayOf(3))).toEqual({ day: dayOf(3), device: 0, web_voice: 0, web_text: 0 });
    expect(body.turns.by_day.find((d) => d.day === dayOf(0))).toEqual({ day: dayOf(0), device: 2, web_voice: 0, web_text: 0 });
    expect(body.turns.by_weekday_hour.reduce((sum, cell) => sum + cell.count, 0)).toBe(4);
    expect(body.conversations_created).toBe(1);
    expect(body.created).toEqual({ tasks: 2, notes: 1, reminders: 1 });
    expect('devices' in body).toBe(false);
  });

  it('counts to-dos done the way Today does: tasks finished in range, suggested to-dos and reminders', async () => {
    const body = (await (await getUsage(a.token)).json()) as Usage;
    // 2 tasks finished today (one made 10 days ago) + 1 suggested to-do + 1 reminder.
    expect(body.todos_done).toBe(4);
  });

  it('memories are new-in-range next to the total Memory lists', async () => {
    const week = (await (await getUsage(a.token)).json()) as Usage;
    expect(week.memories).toEqual({ new_in_range: 2, total: 3 });
    const quarter = (await (await getUsage(a.token, '?range=90d')).json()) as Usage;
    expect(quarter.memories).toEqual({ new_in_range: 3, total: 3 });
  });

  it('cuts days and hours in the account time zone, not UTC', async () => {
    const zone = 'Pacific/Kiritimati'; // UTC+14: most of a UTC day is the next local day
    const { userId } = await addAccount(pg);
    await asAdmin(async (sql) => {
      await sql`update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('time_zone', ${zone}::text) where id = ${userId}::uuid`;
    });
    const before = localParts(new Date(), zone);
    await withUser(db, userId, async (tx) => {
      const conversationId = `conv_${randomUUID()}`;
      await tx.query('insert into bob.conversations (id, user_id, title) values ($1, $2, $3)', [conversationId, userId, 'zone']);
      await tx.query(
        `insert into bob.messages (id, conversation_id, user_id, role, position, origin) values ($1, $2, $3, 'user', 0, 'web_text')`,
        [`msg_${randomUUID()}`, conversationId, userId],
      );
    });
    const body = (await (await getUsage(await tokenFor(userId))).json()) as Usage;
    const after = localParts(new Date(), zone);
    const last = body.turns.by_day.at(-1);
    expect(body.turns.by_day).toHaveLength(7);
    expect([before.day, after.day]).toContain(last?.day);
    expect(last).toMatchObject({ web_text: 1 });
    expect(body.turns.by_weekday_hour).toHaveLength(1);
    expect([before.hour, after.hour]).toContain(body.turns.by_weekday_hour[0]?.hour);
  });

  it('range=30d includes older rows that range=7d excludes', async () => {
    const wide = (await (await getUsage(a.token, '?range=30d')).json()) as Usage;
    expect(wide.range).toBe('30d');
    expect(wide.turns.total).toBe(5);
    expect(wide.active_days).toBe(4);
    const narrow = (await (await getUsage(a.token, '?range=7d')).json()) as Usage;
    expect(narrow.turns.total).toBe(4);
    const bUsage = (await (await getUsage(b.token, '?range=90d')).json()) as Usage;
    expect(bUsage.turns.total).toBe(8);
    expect(bUsage.turns.by_day).toHaveLength(90);
  });

  it('answers 401 without a token and 400 for an unknown range or key', async () => {
    expect((await getUsage(null)).status).toBe(401);
    const bad = await getUsage(a.token, '?range=1y');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: 'invalid_request' } });
    expect((await getUsage(a.token, '?extra=1')).status).toBe(400);
  });

  it('memories and game_minutes are null or counts, never a 500', async () => {
    const res = await getUsage(a.token, '?range=90d');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Usage;
    expect(body.memories === null || typeof body.memories.total === 'number').toBe(true);
    expect(body.game_minutes === null || typeof body.game_minutes === 'number').toBe(true);
  });

  it('returns no message, note, task or conversation text, and journals counts only', async () => {
    const start = journalLines.length;
    const res = await getUsage(a.token, '?range=90d');
    const raw = await res.text();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain(DEVICE_LABEL);
    const lines = journalLines.slice(start).filter((line) => line.includes('v2.usage_read'));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(['active_days', 'conversation_id', 'conversation_source', 'event', 'level', 'message', 'module', 'range', 'source', 'ts', 'turns']);
    expect(lines[0]).not.toContain(a.userId);
    expect(lines[0]).not.toContain(DEVICE_LABEL);
    expect(lines[0]).not.toContain(SECRET);
  });

  it('a failing store answers 500 store_error, not a crash', async () => {
    setSharedDb(Promise.resolve(failingDb()));
    try {
      const res = await getUsage(a.token);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: 'store_error' } });
    } finally {
      setSharedDb(Promise.resolve(db));
    }
  });
});
