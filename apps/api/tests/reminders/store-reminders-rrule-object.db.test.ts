// test:db suite for RRULE-JSONB and RRULE-CHECK-DEFER (local Supabase stack
// only). postgres.js used to double-encode reminder rules into jsonb STRING
// scalars; this proves the store now writes objects, that
// 20260926100000_reminders_rrule_object converts a string row in place and is
// idempotent, and that 20260927020000_defer_rrule_object_check drops its CHECK
// so the old server (which still writes strings) keeps working through the
// switchover and any rollback. Skips cleanly when Docker is not available.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReminder, getReminder, updateReminder } from '../../src/reminders/store.ts';
import { ensureLocalStack, setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

const migration = (name: string): string =>
  readFileSync(new URL(`../../../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const CONVERT = migration('20260926100000_reminders_rrule_object');
const DEFER = migration('20260927020000_defer_rrule_object_check');

const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;

/** Rolls back the superuser transaction once the assertions have run. */
class Rollback extends Error {}

describe.skipIf(!dockerUp)('reminder rules are jsonb objects (RRULE-JSONB, test:db)', () => {
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

  async function rruleType(sql: postgres.Sql | postgres.TransactionSql, id: string): Promise<string | null> {
    const rows = await sql.unsafe<Array<{ t: string | null }>>(
      `select jsonb_typeof(rrule) as t from bob.reminders where id = $1`,
      [id],
    );
    return rows[0]?.t ?? null;
  }

  async function checkCount(sql: postgres.Sql | postgres.TransactionSql): Promise<number | undefined> {
    const rows = await sql.unsafe<Array<{ n: number }>>(
      `select count(*)::int as n from pg_constraint
       where conname = 'reminders_rrule_object' and conrelid = 'bob.reminders'::regclass`,
    );
    return rows[0]?.n;
  }

  async function newReminder(): Promise<string> {
    const reminder = await createReminder(env.db, env.a.userId, env.spaces.privateA, {
      title: 'stretch',
      due: { kind: 'instant', at: Date.UTC(2026, 0, 5, 9, 0), zone: 'Asia/Kolkata' },
      rrule: { freq: 'hourly', interval: 1, window: { start: '09:00', end: '21:00' } },
    });
    return reminder.id;
  }

  it('a created and an updated reminder store jsonb objects', async () => {
    const id = await newReminder();
    expect(await rruleType(admin, id)).toBe('object');
    await updateReminder(env.db, env.a.userId, id, { rrule: { freq: 'daily' } });
    expect(await rruleType(admin, id)).toBe('object');
    const rows = await admin.unsafe<Array<{ freq: string }>>(
      `select rrule->>'freq' as freq from bob.reminders where id = $1`,
      [id],
    );
    expect(rows[0]?.freq).toBe('daily');
  });

  it('the conversion still turns a string row into an object; the deferral then drops the CHECK', async () => {
    const id = await newReminder();
    const outcome = await admin
      .begin(async (tx) => {
        await tx.unsafe(`alter table bob.reminders drop constraint if exists reminders_rrule_object`);
        await tx.unsafe(`update bob.reminders set rrule = to_jsonb(rrule::text) where id = $1`, [id]);
        const before = await rruleType(tx, id);
        await tx.unsafe(CONVERT);
        await tx.unsafe(CONVERT);
        const after = await rruleType(tx, id);
        const checkAfterConvert = await checkCount(tx);
        await tx.unsafe(DEFER);
        await tx.unsafe(DEFER);
        const checkAfterDefer = await checkCount(tx);
        throw new Rollback(JSON.stringify({ before, after, checkAfterConvert, checkAfterDefer }));
      })
      .catch((err: unknown) => {
        if (err instanceof Rollback) return JSON.parse(err.message) as unknown;
        throw err;
      });
    expect(outcome).toEqual({ before: 'string', after: 'object', checkAfterConvert: 1, checkAfterDefer: 0 });
  });

  it('with the migrations applied, an old-server string write and a new-server object write both succeed', async () => {
    expect(await checkCount(admin)).toBe(0);
    const id = await newReminder();
    // What the server on main does: JSON.stringify(rrule) into $n::jsonb stores a jsonb string.
    await admin.unsafe(`update bob.reminders set rrule = to_jsonb($2::text) where id = $1`, [
      id,
      JSON.stringify({ freq: 'weekly', interval: 2 }),
    ]);
    expect(await rruleType(admin, id)).toBe('string');
    expect((await getReminder(env.db, env.a.userId, id)).rrule).toEqual({ freq: 'weekly', interval: 2 });

    await updateReminder(env.db, env.a.userId, id, { rrule: { freq: 'daily' } });
    expect(await rruleType(admin, id)).toBe('object');
    expect((await getReminder(env.db, env.a.userId, id)).rrule).toEqual({ freq: 'daily' });
  });
});
