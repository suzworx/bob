// test:db suite for #126 criterion 3 (travel), against the local Supabase stack
// as bob_server. A daily 08:00 Europe/London reminder keeps firing at 08:00
// London after its owner's account zone (auth user_metadata.time_zone, read by
// bob_private.account_time_zone) changes to America/New_York, across London's
// DST end (2026-10-25) and New York's (2026-11-01). Drives dueOccurrences, the
// fanout worker's read, and records each ring the way the worker does. Skips
// cleanly when Docker is not available.
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountTimeZone } from '../../src/devices/settings-store.ts';
import { createReminder, dueOccurrences, recordOccurrence, setRecipients } from '../../src/reminders/store.ts';
import { ensureLocalStack, setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';
// 08:00 London each day 2026-10-23 .. 2026-11-02: BST (07:00Z) until the 25th, GMT after.
const ANCHOR = Date.UTC(2026, 9, 23, 7, 0);
const EXPECTED = Array.from({ length: 11 }, (_, i) => Date.UTC(2026, 9, 23 + i, i < 2 ? 7 : 8, 0));

function clockIn(zone: string, at: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(at));
}

describe.skipIf(!dockerUp)('travel: a London reminder survives an account move to New York (#126, test:db)', () => {
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

  async function setAccountZone(userId: string, zone: string): Promise<void> {
    await admin`update auth.users
      set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('time_zone', ${zone}::text)
      where id = ${userId}`;
  }

  it('fires at 08:00 London every day, before and after the zone change and both DST ends', async () => {
    const owner = env.a.userId;
    await setAccountZone(owner, LONDON);
    expect(await getAccountTimeZone(env.db, owner)).toBe(LONDON);

    const reminder = await createReminder(env.db, owner, env.spaces.privateA, {
      title: 'take vitamins',
      due: { kind: 'instant', at: ANCHOR, zone: LONDON },
      rrule: { freq: 'daily' },
    });
    await setRecipients(env.db, owner, reminder.id, [owner]);

    const mine = async (now: number) =>
      (await dueOccurrences(env.db, { now })).filter((d) => d.reminderId === reminder.id);

    const fired: number[] = [];
    for (const [i, expected] of EXPECTED.entries()) {
      if (i === 1) {
        await setAccountZone(owner, NEW_YORK);
        expect(await getAccountTimeZone(env.db, owner)).toBe(NEW_YORK);
      }
      expect(await mine(expected - 60_000)).toEqual([]);
      const due = await mine(expected + 60_000);
      expect(due).toEqual([
        { reminderId: reminder.id, userId: owner, occurrenceAt: expected, scheduleRevision: 1, catchUp: false },
      ]);
      for (const d of due) await recordOccurrence(env.db, d);
      fired.push(due[0]!.occurrenceAt);
    }
    expect(fired).toEqual(EXPECTED);
    expect(fired.every((at) => clockIn(LONDON, at) === '08:00')).toBe(true);
    // Read back from the row: the reminder still carries the zone it was set in.
    const rows = await admin<Array<{ zone: string }>>`select due_zone as zone from bob.reminders where id = ${reminder.id}`;
    expect(rows[0]?.zone).toBe(LONDON);
  });
});
