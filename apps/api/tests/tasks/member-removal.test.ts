// Issue #115: removing a member (or a member leaving) clears their task
// assignments, task follows and reminder recipiencies in that space, and writes
// nothing else.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { createReminder } from '../../src/reminders/store.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { addSubscriber, createTask } from '../../src/tasks/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

describe('member removal clears access-bearing rows (#115)', () => {
  let pg: TestDb;
  let db: Db;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
  });

  afterAll(async () => {
    if (pg) await closeTestDb(pg);
  });

  const due = { kind: 'instant' as const, at: Date.now() + 86_400_000, zone: 'Asia/Kolkata' };

  /** A group with an owner and one member, plus the member's footprint in it. */
  async function seed(): Promise<{ owner: TestAccount; member: TestAccount; spaceId: string; taskId: string }> {
    const owner = await addAccount(pg);
    const member = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    await addMember(db, owner.userId, space.id, member.userId, 'member');
    const task = await createTask(db, owner.userId, space.id, { title: 'Groceries', assigneeUserId: member.userId });
    await addSubscriber(db, owner.userId, task.id, member.userId);
    await addSubscriber(db, owner.userId, task.id, owner.userId);
    await createReminder(db, owner.userId, space.id, { title: 'Pay rent', due, recipients: [owner.userId, member.userId] });
    await createReminder(db, member.userId, space.id, { title: 'Call mum', due, recipients: [member.userId] });
    return { owner, member, spaceId: space.id, taskId: task.id };
  }

  async function footprint(readerId: string, spaceId: string, userId: string): Promise<{ assigned: number; follows: number; recipients: number }> {
    return withUser(db, readerId, async (tx) => {
      const [row] = await tx.query<{ assigned: number; follows: number; recipients: number }>(
        `SELECT
           (SELECT count(*)::int FROM bob.tasks WHERE space_id = $1 AND assignee_user_id = $2) AS assigned,
           (SELECT count(*)::int FROM bob.task_subscribers ts JOIN bob.tasks t ON t.id = ts.task_id
             WHERE t.space_id = $1 AND ts.user_id = $2) AS follows,
           (SELECT count(*)::int FROM bob.reminder_recipients rr JOIN bob.reminders r ON r.id = rr.reminder_id
             WHERE r.space_id = $1 AND rr.user_id = $2) AS recipients`,
        [spaceId, userId],
      );
      return { assigned: Number(row?.assigned), follows: Number(row?.follows), recipients: Number(row?.recipients) };
    });
  }

  /** A claim clock no earlier than the database's own. available_at defaults to
   *  the DB's now(), while claims compare it to the caller's clock; a DB host
   *  running even a few ms ahead of this process would make a just-written row
   *  look not yet due. Reading the DB clock after the write pins that. */
  // Rounded up: a row's available_at is its transaction's now() in
  // microseconds, so a floored read in the same millisecond as a commit
  // lands before it and the row is not yet due to the claim that follows.
  it('an owner removing a member unassigns their tasks and drops their follows and reminder recipiencies', async () => {
    const { owner, member, spaceId, taskId } = await seed();
    expect(await footprint(owner.userId, spaceId, member.userId)).toEqual({ assigned: 1, follows: 1, recipients: 2 });

    await revokeMember(db, owner.userId, spaceId, member.userId);

    expect(await footprint(owner.userId, spaceId, member.userId)).toEqual({ assigned: 0, follows: 0, recipients: 0 });
    // The task survives, keeps its author, and nobody else's rows were touched.
    const [task] = await withUser(db, owner.userId, (tx) =>
      tx.query<{ createdBy: string; assignee: string | null; revision: number }>(
        `SELECT created_by::text AS "createdBy", assignee_user_id AS assignee, revision FROM bob.tasks WHERE id = $1`,
        [taskId],
      ),
    );
    expect(task).toMatchObject({ createdBy: owner.userId, assignee: null });
    expect(Number(task?.revision)).toBeGreaterThan(1);
    expect(await footprint(owner.userId, spaceId, owner.userId)).toEqual({ assigned: 0, follows: 1, recipients: 1 });
  });

  it('a member leaving on their own clears their assignments, follows and their own reminders', async () => {
    const { owner, member, spaceId } = await seed();
    await revokeMember(db, member.userId, spaceId, member.userId);

    const left = await footprint(owner.userId, spaceId, member.userId);
    expect(left).toMatchObject({ assigned: 0, follows: 0 });
    // Only the reminder the owner created still lists them (see the todo below).
    expect(left.recipients).toBe(1);
  });

  // reminder_recipients_delete (20260917050000_reminders_rls_harden.sql:166)
  // only lets the reminder's creator or an owner/admin delete a recipient row,
  // so a plain member leaving cannot drop themselves from a reminder someone
  // else created. Closing this needs a migration (a recipient may delete their
  // own row, or a definer), outside this unit's files.
  it.todo('a member leaving on their own is dropped from reminders someone else created');

  it('only the removed space is touched', async () => {
    const { owner, member, spaceId } = await seed();
    const other = await seed();
    await addMember(db, other.owner.userId, other.spaceId, owner.userId, 'member');
    await revokeMember(db, owner.userId, spaceId, member.userId);

    expect(await footprint(other.owner.userId, other.spaceId, other.member.userId)).toEqual({ assigned: 1, follows: 1, recipients: 2 });
  });

  it('a refused removal (last owner) clears nothing', async () => {
    const { owner, spaceId } = await seed();
    await createTask(db, owner.userId, spaceId, { title: 'Mine', assigneeUserId: owner.userId });
    await expect(revokeMember(db, owner.userId, spaceId, owner.userId)).rejects.toThrow(/last owner/);

    expect(await footprint(owner.userId, spaceId, owner.userId)).toEqual({ assigned: 1, follows: 1, recipients: 1 });
  });
});
