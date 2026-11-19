// RLS hardening tests for the reminders schema (S14-REMINDERS-RLS-HARDEN,
// migration 20260917050000_reminders_rls_harden.sql). Each test names the
// defect it guards. Runs against REAL Postgres on the local stack as
// bob_server (nobypassrls) via createTestDb + withUserRaw -- a superuser
// connection would bypass RLS, proving nothing.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearEndedSnooze,
  dueOccurrences,
  recordOccurrence,
  snoozeOccurrence,
  type DueOccurrence,
} from '../../src/reminders/store.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  withUserRaw,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

describe('reminders RLS hardening (S14)', () => {
  let db: TestDb;
  let owner: TestAccount;
  let creator: TestAccount;
  let member: TestAccount;
  let outsider: TestAccount;
  let spaceId: string;
  let outsiderSpaceId: string;

  beforeAll(async () => {
    db = await createTestDb();
    owner = await addAccount(db);
    creator = await addAccount(db);
    member = await addAccount(db);
    outsider = await addAccount(db);

    // Space 1: owner (owner), creator (member), member (member).
    spaceId = await seedSpace(db, owner, [
      { user: creator, role: 'member' },
      { user: member, role: 'member' },
    ]);
    // Outsider's own space (owner), isolated from space 1.
    outsiderSpaceId = await seedSpace(db, outsider, []);
  });

  afterAll(async () => {
    await closeTestDb(db).catch(() => undefined);
  });

  it('defect A: the creator can update and delete their own reminder', async () => {
    const reminderId = await createReminder(db, creator.userId, spaceId);
    await withUserRaw(db, creator.userId, async (tx) => {
      const upd = await tx.query(
        'update bob.reminders set title = $2 where id = $1 returning id',
        [reminderId, 'mine'],
      );
      expect(upd.rows).toHaveLength(1);
    });
    await withUserRaw(db, creator.userId, async (tx) => {
      const del = await tx.query(
        'delete from bob.reminders where id = $1 returning id',
        [reminderId],
      );
      expect(del.rows).toHaveLength(1);
    });
  });

  it('defect A: a non-creator ordinary member CANNOT update or delete another reminder', async () => {
    const reminderId = await createReminder(db, creator.userId, spaceId);
    await withUserRaw(db, member.userId, async (tx) => {
      // RLS USING filters the row out, so both writes match zero rows.
      const upd = await tx.query(
        'update bob.reminders set title = $2 where id = $1 returning id',
        [reminderId, 'hijacked'],
      );
      expect(upd.rows).toHaveLength(0);
      const del = await tx.query('delete from bob.reminders where id = $1 returning id', [
        reminderId,
      ]);
      expect(del.rows).toHaveLength(0);
    });
    await withUserRaw(db, creator.userId, async (tx) => {
      const { rows } = await tx.query<{ title: string }>(
        'select title from bob.reminders where id = $1',
        [reminderId],
      );
      expect(rows[0]!.title).toBe('r');
    });
  });

  it('defect A: a space owner/admin CAN update or delete another reminder', async () => {
    const reminderId = await createReminder(db, creator.userId, spaceId);
    await withUserRaw(db, owner.userId, async (tx) => {
      const upd = await tx.query(
        'update bob.reminders set title = $2 where id = $1 returning id',
        [reminderId, 'owned'],
      );
      expect(upd.rows).toHaveLength(1);
    });
    await withUserRaw(db, owner.userId, async (tx) => {
      const del = await tx.query('delete from bob.reminders where id = $1 returning id', [
        reminderId,
      ]);
      expect(del.rows).toHaveLength(1);
    });
  });

  it('defect B: a non-creator member cannot add, change or remove recipients', async () => {
    const reminderId = await createReminder(db, creator.userId, spaceId);
    await addRecipient(db, creator.userId, reminderId, member.userId);

    // Add: WITH CHECK fails, so the INSERT raises an RLS error.
    await expect(
      withUserRaw(db, member.userId, async (tx) => {
        await tx.query(
          'insert into bob.reminder_recipients (reminder_id, user_id) values ($1, $2)',
          [reminderId, owner.userId],
        );
      }),
    ).rejects.toThrow(/row.?level security/i);

    // Change (redirect) and remove: USING filters the rows out -> zero rows.
    await withUserRaw(db, member.userId, async (tx) => {
      const upd = await tx.query(
        'update bob.reminder_recipients set user_id = $2 where reminder_id = $1',
        [reminderId, owner.userId],
      );
      expect(upd.rows).toHaveLength(0);
      const del = await tx.query('delete from bob.reminder_recipients where reminder_id = $1', [
        reminderId,
      ]);
      expect(del.rows).toHaveLength(0);
    });
  });

  it('defect B: a recipient who is not a member of the reminder space is rejected', async () => {
    const reminderId = await createReminder(db, creator.userId, spaceId);
    // Creator adds a recipient from ANOTHER space -> WITH CHECK rejects it.
    await expect(
      withUserRaw(db, creator.userId, async (tx) => {
        await tx.query(
          'insert into bob.reminder_recipients (reminder_id, user_id) values ($1, $2)',
          [reminderId, outsider.userId],
        );
      }),
    ).rejects.toThrow(/row.?level security/i);
  });

  it('defect C: a reminder cannot target a task/note/event in another space', async () => {
    const foreignTask = await createForeignTask(db, outsider.userId, outsiderSpaceId);
    const foreignNote = await createForeignNote(db, outsider.userId, outsiderSpaceId);
    const foreignEvent = await createForeignEvent(db, outsider.userId, outsiderSpaceId);

    // Create with a cross-space task/note/event -> composite FK violation.
    await expect(
      withUserRaw(db, creator.userId, async (tx) => {
        await tx.query(
          `insert into bob.reminders (space_id, title, task_id, due_at, due_zone, created_by)
           values ($1, 'r', $2, now(), 'UTC', $3)`,
          [spaceId, foreignTask, creator.userId],
        );
      }),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withUserRaw(db, creator.userId, async (tx) => {
        await tx.query(
          `insert into bob.reminders (space_id, title, note_id, due_at, due_zone, created_by)
           values ($1, 'r', $2, now(), 'UTC', $3)`,
          [spaceId, foreignNote, creator.userId],
        );
      }),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withUserRaw(db, creator.userId, async (tx) => {
        await tx.query(
          `insert into bob.reminders (space_id, title, event_id, due_at, due_zone, created_by)
           values ($1, 'r', $2, now(), 'UTC', $3)`,
          [spaceId, foreignEvent, creator.userId],
        );
      }),
    ).rejects.toThrow(/foreign key/i);

    // Update an existing same-space reminder to a foreign target is also blocked.
    const reminderId = await createReminder(db, creator.userId, spaceId);
    await expect(
      withUserRaw(db, creator.userId, async (tx) => {
        await tx.query('update bob.reminders set task_id = $2 where id = $1', [
          reminderId,
          foreignTask,
        ]);
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it('an ordinary member can still SELECT the space reminders and their recipients', async () => {
    const reminderId = await createReminder(db, creator.userId, spaceId);
    await addRecipient(db, creator.userId, reminderId, member.userId);
    await withUserRaw(db, member.userId, async (tx) => {
      const rem = await tx.query('select id from bob.reminders where id = $1', [reminderId]);
      expect(rem.rows).toHaveLength(1);
      const rec = await tx.query<{ user_id: string }>(
        'select user_id from bob.reminder_recipients where reminder_id = $1',
        [reminderId],
      );
      expect(rec.rows.map((row) => row.user_id)).toContain(member.userId);
    });
  });

  it('#507: an ended snooze is re-read as its own recipient, and only they can clear it', async () => {
    // Injected clock (#534): due_at and every `now` derive from one fixed
    // instant, never from the database's now() versus Date.now(), which drift
    // apart under load (Postgres in a container vs the host clock).
    const dueAt = Date.UTC(2026, 0, 15, 9, 0, 0);
    const store = asDb(db);
    const reminderId = await createReminder(db, creator.userId, spaceId, dueAt);
    await addRecipient(db, creator.userId, reminderId, member.userId);
    await addRecipient(db, creator.userId, reminderId, owner.userId);
    const mine = async (now: number): Promise<DueOccurrence[]> =>
      (await dueOccurrences(store, { now })).filter((d) => d.reminderId === reminderId);

    expect(await mine(dueAt - 1)).toHaveLength(0);
    const fresh = await mine(dueAt);
    expect(fresh).toHaveLength(2);
    for (const d of fresh) await recordOccurrence(store, d);
    const memberRow = await withUserRaw(db, member.userId, (tx) => tx.query<{ id: string }>(
      'select id from bob.reminder_occurrences where reminder_id = $1', [reminderId]));
    expect(memberRow.rows).toHaveLength(1);
    const occurrenceId = memberRow.rows[0]!.id;
    const until = dueAt + 10 * 60_000;
    await snoozeOccurrence(store, member.userId, occurrenceId, until);

    expect(await mine(until - 60_000)).toHaveLength(0);
    const again = await mine(until);
    expect(again.map((d) => [d.userId, d.occurrenceId, d.snoozedUntil]))
      .toEqual([[member.userId, occurrenceId, until]]);
    // Another recipient cannot clear someone else's snooze: RLS hides the row.
    expect(await clearEndedSnooze(store, owner.userId, occurrenceId, until)).toBe(false);
    expect(await clearEndedSnooze(store, member.userId, occurrenceId, until)).toBe(true);
    expect(await mine(until)).toHaveLength(0);
  });

  // Runs last: it revokes `member` permanently for the shared per-file database,
  // so no later test can assume the member is still an active space member.
  it('defect D: a removed member stops being returned by reminder_fanout_sources', async () => {
    const reminderId = await createReminder(db, creator.userId, spaceId);
    await addRecipient(db, creator.userId, reminderId, member.userId);

    // Base connection is bob_server; the definer is granted to it, and it
    // reads membership as the migration owner (bypasses RLS), so the recipient
    // set is returned while membership is active.
    const before = await db.query<{ userId: string }>(
      'select * from bob_private.reminder_fanout_sources(now())',
    );
    expect(before.rows.some((row) => row.userId === member.userId)).toBe(true);

    // Owner revokes the member.
    await withUserRaw(db, owner.userId, async (tx) => {
      await tx.query(
        'update bob.space_memberships set revoked_at = now() where space_id = $1 and user_id = $2',
        [spaceId, member.userId],
      );
    });

    const after = await db.query<{ userId: string }>(
      'select * from bob_private.reminder_fanout_sources(now())',
    );
    expect(after.rows.some((row) => row.userId === member.userId)).toBe(false);
  });
});

/** Creates a group space owned by `owner` and adds the given memberships. The
 *  owner inserts through the authenticated policies (owner_user_id = auth.uid()
 *  for the space; then owner/admin for the members), which is how prod reaches
 *  these rows. Returns the space id. */
async function seedSpace(
  db: TestDb,
  owner: TestAccount,
  members: Array<{ user: TestAccount; role: string }>,
): Promise<string> {
  let spaceId = '';
  await withUserRaw(db, owner.userId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into bob.spaces (kind, name, owner_user_id) values ('group', 'Group', $1) returning id`,
      [owner.userId],
    );
    spaceId = rows[0]!.id;
    await tx.query(
      `insert into bob.space_memberships (space_id, user_id, role) values ($1, $2, 'owner')`,
      [spaceId, owner.userId],
    );
    for (const member of members) {
      await tx.query(
        `insert into bob.space_memberships (space_id, user_id, role) values ($1, $2, $3)`,
        [spaceId, member.user.userId, member.role],
      );
    }
  });
  return spaceId;
}

/** Creates a reminder owned by `asUser` in the given space, due at `dueAt`
 *  (epoch ms) when given, else at the database's now(). */
async function createReminder(
  db: TestDb,
  asUser: string,
  spaceId: string,
  dueAt: number | null = null,
): Promise<string> {
  let id = '';
  await withUserRaw(db, asUser, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into bob.reminders (space_id, title, due_at, due_zone, created_by)
       values ($1, 'r', coalesce(to_timestamp($3::float8 / 1000), now()), 'UTC', $2)
       returning id`,
      [spaceId, asUser, dueAt],
    );
    id = rows[0]!.id;
  });
  return id;
}

/** Adds a recipient to a reminder as the reminder's owner (creator). */
async function addRecipient(
  db: TestDb,
  asUser: string,
  reminderId: string,
  recipientId: string,
): Promise<void> {
  await withUserRaw(db, asUser, async (tx) => {
    await tx.query(
      'insert into bob.reminder_recipients (reminder_id, user_id) values ($1, $2)',
      [reminderId, recipientId],
    );
  });
}

/** Creates a task in the outsider's space, so a reminder can try to cross. */
async function createForeignTask(
  db: TestDb,
  asUser: string,
  spaceId: string,
): Promise<string> {
  let id = '';
  await withUserRaw(db, asUser, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into bob.tasks (space_id, title, order_key, created_by)
       values ($1, 'foreign task', '0', $2) returning id`,
      [spaceId, asUser],
    );
    id = rows[0]!.id;
  });
  return id;
}

/** Creates a note in the outsider's space. */
async function createForeignNote(
  db: TestDb,
  asUser: string,
  spaceId: string,
): Promise<string> {
  let id = '';
  await withUserRaw(db, asUser, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into bob.notes (space_id, title, created_by, updated_by)
       values ($1, 'foreign note', $2, $2) returning id`,
      [spaceId, asUser],
    );
    id = rows[0]!.id;
  });
  return id;
}

/** Creates a timed event (in a calendar) in the outsider's space. */
async function createForeignEvent(
  db: TestDb,
  asUser: string,
  spaceId: string,
): Promise<string> {
  let id = '';
  await withUserRaw(db, asUser, async (tx) => {
    const cal = await tx.query<{ id: string }>(
      `insert into bob.calendars (space_id, name, zone, created_by)
       values ($1, 'foreign cal', 'UTC', $2) returning id`,
      [spaceId, asUser],
    );
    const calendarId = cal.rows[0]!.id;
    const ev = await tx.query<{ id: string }>(
      `insert into bob.calendar_events
         (calendar_id, space_id, uid, organizer_user_id, title, all_day, start_at, end_at, zone)
       values ($1, $2, $3, $4, 'foreign event', false, now(), now() + interval '1 hour', 'UTC')
       returning id`,
      [calendarId, spaceId, randomUUID(), asUser],
    );
    id = ev.rows[0]!.id;
  });
  return id;
}