// #126 criterion 3 (travel): a repeating reminder keeps the zone it was set in.
// A daily 08:00 Europe/London reminder, whose owner then moves the account to
// America/New_York, must still fire at 08:00 London -- across London's DST end
// (2026-10-25) and New York's (2026-11-01). The pure half checks the expansion;
// the store half drives the fanout read (dueOccurrences) the worker uses, with
// the account zone changed where production reads it (auth user_metadata).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expandOccurrences } from '../../src/calendar/recurrence.ts';
import { type Db } from '../../src/platform/db/db.ts';
import { getAccountTimeZone } from '../../src/devices/settings-store.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { createReminder, dueOccurrences, recordOccurrence, setRecipients } from '../../src/reminders/store.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';

/** 'HH:mm' of an instant in a zone. */
function clockIn(zone: string, at: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(at));
}

// 08:00 London each day 2026-10-23 .. 2026-11-02: BST (07:00Z) until the 25th,
// GMT (08:00Z) after. New York stays on EDT until 2026-11-01.
const ANCHOR = Date.UTC(2026, 9, 23, 7, 0);
const EXPECTED = Array.from({ length: 11 }, (_, i) => Date.UTC(2026, 9, 23 + i, i < 2 ? 7 : 8, 0));

describe('travel: reminder zone is the zone it was set in (#126 criterion 3, pure)', () => {
  it('a daily 08:00 London rule expands to 08:00 London across both DST changes', () => {
    const occurrences = expandOccurrences({
      rule: { freq: 'daily' },
      startWallTime: '2026-10-23T08:00',
      zone: LONDON,
      from: ANCHOR,
      to: EXPECTED[EXPECTED.length - 1]! + 60_000,
    });
    expect(occurrences.map((o) => o.at)).toEqual(EXPECTED);
    expect(occurrences.every((o) => clockIn(LONDON, o.at) === '08:00')).toBe(true);
    // Seen from New York the same instants move (03:00 EDT, 04:00 EDT once London
    // falls back, 03:00 EST once New York does): the rule did not follow the traveller.
    expect(occurrences.map((o) => clockIn(NEW_YORK, o.at))).toEqual([
      '03:00', '03:00', '04:00', '04:00', '04:00', '04:00', '04:00', '04:00', '04:00', '03:00', '03:00',
    ]);
  });
});

describe('travel: account zone change does not move a London reminder (#126 criterion 3, store)', () => {
  let pg: TestDb;
  let db: Db;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
  });

  afterAll(async () => {
    await closeTestDb(pg).catch(() => undefined);
  });

  async function setAccountZone(userId: string, zone: string): Promise<void> {
    const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
    await withAdmin(url, async (sql) => {
      await sql`update auth.users
        set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('time_zone', ${zone}::text)
        where id = ${userId}`;
    });
  }

  it('fires at 08:00 London every day after the owner moves the account to New York', async () => {
    const owner = await addAccount(pg);
    await setAccountZone(owner.userId, LONDON);
    expect(await getAccountTimeZone(db, owner.userId)).toBe(LONDON);

    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Travel' });
    const reminder = await createReminder(db, owner.userId, space.id, {
      title: 'take vitamins',
      due: { kind: 'instant', at: ANCHOR, zone: LONDON },
      rrule: { freq: 'daily' },
    });
    await setRecipients(db, owner.userId, reminder.id, [owner.userId]);

    const fired: number[] = [];
    for (const [i, expected] of EXPECTED.entries()) {
      // The trip: the account zone changes after the first 08:00 London ring.
      if (i === 1) {
        await setAccountZone(owner.userId, NEW_YORK);
        expect(await getAccountTimeZone(db, owner.userId)).toBe(NEW_YORK);
      }
      const early = (await dueOccurrences(db, { now: expected - 60_000 })).filter((d) => d.reminderId === reminder.id);
      expect(early).toEqual([]);
      const due = (await dueOccurrences(db, { now: expected + 60_000 })).filter((d) => d.reminderId === reminder.id);
      expect(due).toEqual([
        { reminderId: reminder.id, userId: owner.userId, occurrenceAt: expected, scheduleRevision: 1, catchUp: false },
      ]);
      for (const d of due) await recordOccurrence(db, d);
      fired.push(due[0]!.occurrenceAt);
    }
    expect(fired).toEqual(EXPECTED);
    expect(fired.every((at) => clockIn(LONDON, at) === '08:00')).toBe(true);
  });
});
