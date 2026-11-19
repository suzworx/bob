/**
 * The #757 merge 4 expand migration (20261003130000_reminders_kind_expand) on
 * real Postgres: existing reminders become kind 'reminder' and still satisfy every
 * check, timer and alarm rows are accepted with the timer vocabulary, and no
 * reminder reader (fanout source, list, get, cancel) ever sees a non-reminder.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from '../support/pg-template.ts';
import { asDb } from '../support/test-db.ts';
import { StoreNotFoundError, type Db } from '../../src/platform/db/db.ts';
import {
  cancelReminder,
  getReminder,
  listReminders,
} from '../../src/reminders/store.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const KIND = '20261003130000_reminders_kind_expand.sql';
const A = '00000000-0000-4000-8000-00000000000a';
const G = '20000000-0000-4000-8000-0000000000f0';
const R = '50000000-0000-4000-8000-000000000001';
const TIMER = '50000000-0000-4000-8000-000000000002';

const insertRow = (id: string, extra: string, values: string): string =>
  `insert into bob.reminders (id, space_id, due_at, due_zone, created_by${extra})
   values ('${id}', '${G}', now() - interval '1 minute', 'UTC', '${A}'${values})`;

describe('reminders kind expand migration (#757 merge 4)', () => {
  let pg: TestDb;
  let db: Db;
  let kindSql: string;
  const rows = async <T,>(sql: string): Promise<T[]> => (await pg.query<T>(sql)).rows;

  beforeAll(async () => {
    pg = await createMigratedDb({ before: KIND });
    await pg.exec(`
      insert into auth.users (id) values ('${A}');
      insert into bob.spaces (id, kind, name, owner_user_id) values ('${G}', 'group', 'Family', '${A}');
      insert into bob.space_memberships (space_id, user_id, role) values ('${G}', '${A}', 'owner');
      ${insertRow(R, ', title', ", 'Pay rent'")};
      insert into bob.reminder_recipients (reminder_id, user_id) values ('${R}', '${A}');`);
    kindSql = readFileSync(new URL(KIND, dir), 'utf8');
    await pg.transaction(async (tx) => void (await tx.exec(kindSql)));
    db = asDb(pg);
  }, 120_000);

  afterAll(async () => {
    await pg?.close();
  });

  it('is re-runnable', async () => {
    await pg.transaction(async (tx) => void (await tx.exec(kindSql)));
  });

  it('gives the existing reminder kind reminder and keeps it valid', async () => {
    expect(await rows(`select kind, status, title from bob.reminders where id = '${R}'`))
      .toEqual([{ kind: 'reminder', status: 'active', title: 'Pay rent' }]);
  });

  it('refuses a reminder with a timer status or no title', async () => {
    await expect(pg.exec(insertRow('50000000-0000-4000-8000-0000000000a1', ', title, status', ", 'x', 'pending'")))
      .rejects.toThrow(/reminders_status_check/);
    await expect(pg.exec(insertRow('50000000-0000-4000-8000-0000000000a2', '', '')))
      .rejects.toThrow(/reminders_title_check/);
  });

  it('accepts a timer row with a timer status, no title and a due_at', async () => {
    await pg.exec(insertRow(TIMER, ', kind, status, duration_ms', ", 'timer', 'pending', 60000"));
    expect(await rows(`select kind, status, title from bob.reminders where id = '${TIMER}'`))
      .toEqual([{ kind: 'timer', status: 'pending', title: null }]);
  });

  it('refuses a timer without duration_ms, and accepts an alarm without one', async () => {
    await expect(pg.exec(insertRow('50000000-0000-4000-8000-0000000000b1', ', kind, status', ", 'timer', 'pending'")))
      .rejects.toThrow(/reminders_timer_shape_check/);
    await pg.exec(insertRow('50000000-0000-4000-8000-0000000000b2', ', kind, status', ", 'alarm', 'pending'"));
  });

  it('keeps the fanout source and every reminder reader blind to timer rows', async () => {
    await pg.exec(`insert into bob.reminder_recipients (reminder_id, user_id) values ('${TIMER}', '${A}')`);
    const due = await rows<{ reminderId: string }>(
      `select "reminderId" from bob_private.reminder_fanout_sources(now())`,
    );
    expect(due.map((r) => r.reminderId)).toEqual([R]);

    expect((await listReminders(db, A, G)).map((r) => r.id)).toEqual([R]);
    await expect(getReminder(db, A, TIMER)).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(cancelReminder(db, A, TIMER)).rejects.toBeInstanceOf(StoreNotFoundError);
    expect(await rows(`select status from bob.reminders where id = '${TIMER}'`)).toEqual([{ status: 'pending' }]);
  });
});
