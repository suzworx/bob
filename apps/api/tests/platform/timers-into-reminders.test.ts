/**
 * The #757 merge 4 step 2 migration (20261003160000_timers_into_reminders) on
 * real Postgres: bob.timers rows are copied into bob.reminders (same ids, the
 * owner's private space, created when missing), the scheduler's two service
 * functions read the new rows with unchanged results, no reminder reader sees a
 * timer, accounts stay isolated, and erase_account removes a user's timer rows.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from '../support/pg-template.ts';
import { asDb } from '../support/test-db.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { listReminders } from '../../src/reminders/store.ts';
import {
  cancelTimers, duePending, listPendingTimers, nextPendingFireAt,
} from '../../src/timers/store.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const MIGRATION = '20261003160000_timers_into_reminders.sql';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const T1 = '60000000-0000-4000-8000-000000000001';
const T2 = '60000000-0000-4000-8000-000000000002';
const T3 = '60000000-0000-4000-8000-000000000003';
const T4 = '60000000-0000-4000-8000-000000000004';
const DUE = `select id, "userId", kind, label, "firesAt", "durationMs", status, "createdAt", "firedAt"
  from bob_private.timers_due('2031-01-01T00:00:00Z', 10)`;
const NEXT = 'select bob_private.timers_next_fire_at() as at';

describe('timers into reminders migration (#757 merge 4 step 2)', () => {
  let pg: TestDb;
  let db: Db;
  let sql: string;
  let dueBefore: unknown[];
  let nextBefore: unknown[];
  const rows = async <T,>(text: string): Promise<T[]> => (await pg.query<T>(text)).rows;
  const run = (): Promise<void> => pg.transaction(async (tx) => void (await tx.exec(sql)));

  beforeAll(async () => {
    pg = await createMigratedDb({ before: MIGRATION });
    await pg.exec(`
      insert into auth.users (id) values ('${A}'), ('${B}');
      delete from bob.spaces where kind = 'private' and owner_user_id = '${B}';
      insert into bob.timers (id, user_id, kind, label, fires_at, duration_ms, status, created_at, fired_at) values
        ('${T1}', '${A}', 'timer', 'pasta', '2030-06-01T10:10:00Z', 600000, 'pending', '2030-06-01T10:00:00Z', null),
        ('${T2}', '${A}', 'alarm', null, '2030-06-02T07:00:00Z', null, 'fired', '2030-06-01T09:00:00Z', '2030-06-02T07:00:01Z'),
        ('${T3}', '${B}', 'timer', 'tea', '2030-06-01T10:05:00Z', 300000, 'pending', '2030-06-01T10:00:00Z', null),
        ('${T4}', '${B}', 'timer', null, '2030-06-01T10:30:00Z', 1800000, 'cancelled', '2030-06-01T10:00:00Z', null)`);
    dueBefore = await rows(DUE);
    nextBefore = await rows(NEXT);
    sql = readFileSync(new URL(MIGRATION, dir), 'utf8');
    await run();
    db = asDb(pg);
  }, 120_000);

  afterAll(async () => {
    await pg?.close();
  });

  it('copies every timer with the same id and values into the owner private space', async () => {
    const copied = await rows<Record<string, unknown>>(
      `select r.id, r.kind, r.title, r.due_zone, r.duration_ms::int as duration_ms, r.status,
              (r.space_id = s.id) as in_private, r.created_by,
              extract(epoch from r.due_at) as due, extract(epoch from r.created_at) as created,
              extract(epoch from r.fired_at) as fired
         from bob.reminders r
         join bob.spaces s on s.kind = 'private' and s.owner_user_id = r.created_by
        where r.kind <> 'reminder' order by r.id`,
    );
    const originals = await rows<Record<string, unknown>>(
      `select id, kind, label as title, 'UTC' as due_zone, duration_ms, status, true as in_private, user_id as created_by,
              extract(epoch from fires_at) as due, extract(epoch from created_at) as created,
              extract(epoch from fired_at) as fired
         from bob.timers order by id`,
    );
    expect(copied).toHaveLength(4);
    expect(copied).toEqual(originals);
    expect(await rows(`select 1 from bob.reminder_recipients rr join bob.reminders r on r.id = rr.reminder_id where r.kind <> 'reminder'`))
      .toEqual([]);
    expect(await rows(`select 1 from bob.spaces where kind = 'private' and owner_user_id = '${B}'`)).toHaveLength(1);
  });

  it('is re-runnable and changes nothing the second time', async () => {
    const snapshot = `select id, space_id, kind, title, status, due_at, fired_at, updated_at from bob.reminders order by id`;
    const before = await rows(snapshot);
    const spaces = await rows(`select id from bob.spaces order by id`);
    await run();
    expect(await rows(snapshot)).toEqual(before);
    expect(await rows(`select id from bob.spaces order by id`)).toEqual(spaces);
  });

  it('keeps timers_due and timers_next_fire_at returning the same rows and values', async () => {
    expect(await rows(DUE)).toEqual(dueBefore);
    expect(await rows(NEXT)).toEqual(nextBefore);
    expect((await duePending(db, Date.parse('2031-01-01T00:00:00Z'))).map((t) => t.id)).toEqual([T3, T1]);
    expect(await nextPendingFireAt(db)).toBe(Date.parse('2030-06-01T10:05:00Z'));
  });

  it('never shows a timer to the reminder fanout or the reminder store', async () => {
    await pg.exec(`insert into bob.reminder_recipients (reminder_id, user_id) values ('${T1}', '${A}')`);
    expect(await rows(`select "reminderId" from bob_private.reminder_fanout_sources('2031-01-01T00:00:00Z')`)).toEqual([]);
    const privateSpace = (await rows<{ id: string }>(`select id from bob.spaces where kind = 'private' and owner_user_id = '${A}'`))[0]!.id;
    expect(await listReminders(db, A, privateSpace)).toEqual([]);
  });

  it('isolates the two accounts under RLS', async () => {
    const now = Date.parse('2030-06-01T10:01:00Z');
    expect((await listPendingTimers(db, A, now)).map((t) => t.id)).toEqual([T1]);
    expect((await listPendingTimers(db, B, now)).map((t) => t.id)).toEqual([T3]);
    expect((await cancelTimers(db, B, { id: T1 })).cancelled).toEqual([]);
    expect(await rows(`select status from bob.reminders where id = '${T1}'`)).toEqual([{ status: 'pending' }]);
  });

  it('erase_account removes the user timer rows and leaves other users rows', async () => {
    await pg.exec(`select * from bob_private.erase_account('${A}', now())`);
    expect(await rows(`select id from bob.reminders where kind <> 'reminder' order by id`)).toEqual([{ id: T3 }, { id: T4 }]);
  });
});
