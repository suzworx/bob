// store/tasks.ts tests (spec 014, S14-T005). Real Postgres via createTestDb, same setup
// as store-spaces.test.ts. Exercises the six store rules against real RLS:
// optimistic concurrency, active-member assignee, not-found-equals-forbidden,
// completion attribution, trash exclusion, and revision bumps -- plus due-value
// honesty, parent/space invariants, list filters and subscribers.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreConflictError, StoreError, StoreNotFoundError, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createReminder, getReminder } from '../../src/reminders/store.ts';
import {
  addSubscriber,
  completeTask,
  createTask,
  getTask,
  keyBetween,
  listSubscribers,
  listTasks,
  moveTaskItem,
  removeSubscriber,
  reopenTask,
  restoreTask,
  TaskConflictError,
  trashTask,
  updateTask,
  type StoredTask,
} from '../../src/tasks/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

/** Creates a group space owned by `owner` with `members` added as 'member'. */
async function makeSpace(ownerId: string, name: string, members: string[] = []): Promise<{ id: string }> {
  const space = await createSpace(db, ownerId, { kind: 'group', name });
  for (const member of members) {
    await addMember(db, ownerId, space.id, member, 'member');
  }
  return space;
}

describe('tasks store', () => {
  it('creates a task with status open, revision 1 and honest due values', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Chores', [b.userId]);

    const dateTask = await createTask(db, a.userId, space.id, {
      title: 'water the plants',
      due: { kind: 'date', date: '2026-09-20' },
    });
    expect(dateTask.status).toBe('open');
    expect(dateTask.revision).toBe(1);
    expect(dateTask.dueDate).toBe('2026-09-20');
    expect(dateTask.dueAt).toBeNull();
    expect(dateTask.dueZone).toBeNull();
    expect(dateTask.assigneeUserId).toBeNull();

    const at = Date.UTC(2026, 8, 20, 9, 0, 0);
    const instantTask = await createTask(db, a.userId, space.id, {
      title: 'meet the plumber',
      due: { kind: 'instant', at, zone: 'Asia/Kolkata' },
    });
    expect(instantTask.dueDate).toBeNull();
    expect(instantTask.dueAt).toBe(at);
    expect(instantTask.dueZone).toBe('Asia/Kolkata');
  });

  it('rule 1: a stale revision throws TaskConflictError carrying the current row', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Edits');
    const task = await createTask(db, a.userId, space.id, { title: 'draft' });

    const saved = await updateTask(db, a.userId, task.id, { revision: 1, title: 'edited' });
    expect(saved.revision).toBe(2);

    // Replay the original revision 1 -- a stale write must not silently win.
    const conflict = await updateTask(db, a.userId, task.id, { revision: 1, title: 'stale' }).catch(
      (error: unknown) => error,
    );
    expect(conflict).toBeInstanceOf(TaskConflictError);
    expect((conflict as TaskConflictError).current.revision).toBe(2);
    expect((conflict as TaskConflictError).current.title).toBe('edited');
  });

  it('rule 2: assigning a non-member (or revoked member) throws StoreError', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const outsider = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Assign', [b.userId]);
    const task = await createTask(db, a.userId, space.id, { title: 'shared' });

    // Active member assigns fine.
    await expect(
      updateTask(db, a.userId, task.id, { revision: task.revision, assigneeUserId: b.userId }),
    ).resolves.toMatchObject({ assigneeUserId: b.userId });

    // Non-member assignee on create.
    await expect(
      createTask(db, a.userId, space.id, { title: 'bad', assigneeUserId: outsider.userId }),
    ).rejects.toThrow(/active member/);

    // Non-member assignee on update.
    await expect(
      updateTask(db, a.userId, task.id, { revision: 2, assigneeUserId: outsider.userId }),
    ).rejects.toThrow(/active member/);

    // A revoked member is no longer assignable.
    await addMember(db, a.userId, space.id, outsider.userId, 'member');
    await (await import('../../src/spaces/store.ts')).revokeMember(db, a.userId, space.id, outsider.userId);
    await expect(
      updateTask(db, a.userId, task.id, { revision: 2, assigneeUserId: outsider.userId }),
    ).rejects.toThrow(/active member/);
  });

  it('rule 3: a task outside the caller audience and a missing id are the SAME StoreNotFoundError', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const outsider = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Private-ish', [b.userId]);
    const task = await createTask(db, a.userId, space.id, { title: 'family plans' });

    const hidden = await getTask(db, outsider.userId, task.id).catch((error: unknown) => error);
    const missing = await getTask(db, outsider.userId, randomUUID()).catch((error: unknown) => error);
    expect(hidden).toBeInstanceOf(StoreNotFoundError);
    expect(missing).toBeInstanceOf(StoreNotFoundError);
    expect((hidden as Error).message).toBe((missing as Error).message);
    expect((hidden as Error).message).toMatch(/not found/);
  });

  it('rule 4: completeTask records who and when; reopenTask clears both', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Finish', [b.userId]);
    const task = await createTask(db, a.userId, space.id, { title: 'laundry' });

    const done = await completeTask(db, b.userId, task.id);
    expect(done.status).toBe('completed');
    expect(done.completedBy).toBe(b.userId);
    expect(done.completedAt).not.toBeNull();

    const reopened = await reopenTask(db, a.userId, task.id);
    expect(reopened.status).toBe('open');
    expect(reopened.completedBy).toBeNull();
    expect(reopened.completedAt).toBeNull();
  });

  it('rule 5: trash excludes from ordinary reads immediately, restore brings it back', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Trash');
    const task = await createTask(db, a.userId, space.id, { title: 'to bin' });

    expect(await listTasks(db, a.userId, space.id)).toHaveLength(1);

    await trashTask(db, a.userId, task.id);
    expect(await listTasks(db, a.userId, space.id)).toHaveLength(0);
    expect(await listTasks(db, a.userId, space.id, { includeTrashed: true })).toHaveLength(1);

    await restoreTask(db, a.userId, task.id);
    expect(await listTasks(db, a.userId, space.id)).toHaveLength(1);
  });

  it('rule 6: revision increments on every mutation, including complete and reopen', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Rev');
    const task = await createTask(db, a.userId, space.id, { title: 'count' });
    expect(task.revision).toBe(1);

    expect((await updateTask(db, a.userId, task.id, { revision: 1, title: 'count2' })).revision).toBe(2);
    expect((await completeTask(db, a.userId, task.id)).revision).toBe(3);
    expect((await reopenTask(db, a.userId, task.id)).revision).toBe(4);
    expect((await trashTask(db, a.userId, task.id)).revision).toBe(5);
    expect((await restoreTask(db, a.userId, task.id)).revision).toBe(6);
  });

  it('updateTask switches a due value between date-only and instant (honest exclusivity)', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Due');
    const task = await createTask(db, a.userId, space.id, { title: 'switch' });

    const instant = await updateTask(db, a.userId, task.id, {
      revision: 1,
      due: { kind: 'instant', at: Date.UTC(2026, 9, 1, 12, 0, 0), zone: 'America/Toronto' },
    });
    expect(instant.dueDate).toBeNull();
    expect(instant.dueAt).toBe(Date.UTC(2026, 9, 1, 12, 0, 0));
    expect(instant.dueZone).toBe('America/Toronto');

    const dateOnly = await updateTask(db, a.userId, task.id, {
      revision: 2,
      due: { kind: 'date', date: '2026-11-05' },
    });
    expect(dateOnly.dueDate).toBe('2026-11-05');
    expect(dateOnly.dueAt).toBeNull();
    expect(dateOnly.dueZone).toBeNull();

    const cleared = await updateTask(db, a.userId, task.id, { revision: 3, due: null });
    expect(cleared.dueDate).toBeNull();
    expect(cleared.dueAt).toBeNull();
    expect(cleared.dueZone).toBeNull();
  });

  it('updateTask moves a task and its checklist to another space, dropping an assignee who is not there', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const from = await makeSpace(a.userId, 'From', [b.userId]);
    const to = await makeSpace(a.userId, 'To');
    const task = await createTask(db, a.userId, from.id, { title: 'move me', assigneeUserId: b.userId });
    const item = await createTask(db, a.userId, from.id, { title: 'step', parentTaskId: task.id });

    const moved = await updateTask(db, a.userId, task.id, { revision: 1, spaceId: to.id });
    expect(moved.spaceId).toBe(to.id);
    expect(moved.assigneeUserId).toBeNull();
    expect(moved.revision).toBe(2);
    expect((await getTask(db, a.userId, item.id)).spaceId).toBe(to.id);
    expect((await listTasks(db, a.userId, from.id)).map((t) => t.id)).not.toContain(task.id);
  });

  it('updateTask moves the reminders linked to the task and to its checklist items with it', async () => {
    const a = await addAccount(pg);
    const from = await makeSpace(a.userId, 'From');
    const to = await makeSpace(a.userId, 'To');
    const task = await createTask(db, a.userId, from.id, { title: 'renew passport' });
    const item = await createTask(db, a.userId, from.id, { title: 'photos', parentTaskId: task.id });
    const due = { kind: 'instant' as const, at: Date.UTC(2026, 10, 1, 17, 0), zone: 'UTC' };
    const onTask = await createReminder(db, a.userId, from.id, { title: 'passport', due, taskId: task.id });
    const onItem = await createReminder(db, a.userId, from.id, { title: 'photos', due, taskId: item.id });

    const moved = await updateTask(db, a.userId, task.id, { revision: 1, spaceId: to.id });
    expect(moved.spaceId).toBe(to.id);
    expect((await getTask(db, a.userId, item.id)).spaceId).toBe(to.id);
    const taskReminder = await getReminder(db, a.userId, onTask.id);
    const itemReminder = await getReminder(db, a.userId, onItem.id);
    expect([taskReminder.spaceId, taskReminder.taskId]).toEqual([to.id, task.id]);
    expect([itemReminder.spaceId, itemReminder.taskId]).toEqual([to.id, item.id]);
  });

  it('updateTask refuses (conflict, not a crash) a move that would strand another member\'s reminder', async () => {
    const owner = await addAccount(pg);
    const member = await addAccount(pg);
    const from = await makeSpace(owner.userId, 'Shared', [member.userId]);
    const to = await makeSpace(member.userId, 'Mine');
    const task = await createTask(db, member.userId, from.id, { title: 'shared chore' });
    const due = { kind: 'instant' as const, at: Date.UTC(2026, 10, 1, 17, 0), zone: 'UTC' };
    // The owner's reminder: RLS lets the member see it but not rewrite it.
    await createReminder(db, owner.userId, from.id, { title: 'chore', due, taskId: task.id });

    await expect(updateTask(db, member.userId, task.id, { revision: 1, spaceId: to.id }))
      .rejects.toBeInstanceOf(StoreConflictError);
    expect((await getTask(db, member.userId, task.id)).spaceId).toBe(from.id);
  });

  it('updateTask refuses a move into a space the caller is not in, as not found', async () => {
    const a = await addAccount(pg);
    const c = await addAccount(pg);
    const mine = await makeSpace(a.userId, 'Mine');
    const theirs = await makeSpace(c.userId, 'Theirs');
    const task = await createTask(db, a.userId, mine.id, { title: 'stay' });
    await expect(updateTask(db, a.userId, task.id, { revision: 1, spaceId: theirs.id }))
      .rejects.toBeInstanceOf(StoreNotFoundError);
    expect((await getTask(db, a.userId, task.id)).spaceId).toBe(mine.id);
  });

  it('listTasks filters by status, assignee, parent and due_before', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Filters', [b.userId]);
    const list = await createTask(db, a.userId, space.id, {
      title: 'grocery list',
      due: { kind: 'date', date: '2026-09-20' },
    });
    const item1 = await createTask(db, a.userId, space.id, {
      title: 'milk',
      parentTaskId: list.id,
      assigneeUserId: b.userId,
      due: { kind: 'date', date: '2026-09-22' },
    });
    const item2 = await createTask(db, a.userId, space.id, {
      title: 'bread',
      parentTaskId: list.id,
      due: { kind: 'date', date: '2026-09-30' },
    });
    await completeTask(db, b.userId, item1.id);

    // Roots only.
    expect((await listTasks(db, a.userId, space.id, { parentTaskId: null })).map((t) => t.id)).toEqual([
      list.id,
    ]);
    // Children of the list, in order.
    expect((await listTasks(db, a.userId, space.id, { parentTaskId: list.id })).map((t) => t.id)).toEqual([
      item1.id,
      item2.id,
    ]);
    // Status filter.
    expect((await listTasks(db, a.userId, space.id, { status: 'completed' })).map((t) => t.id)).toEqual([
      item1.id,
    ]);
    // Assignee filter.
    expect((await listTasks(db, a.userId, space.id, { assigneeUserId: b.userId })).map((t) => t.id)).toEqual([
      item1.id,
    ]);
    // due_before: strictly before 2026-09-25 excludes item2 (09-30).
    expect((await listTasks(db, a.userId, space.id, { dueBefore: '2026-09-25' })).map((t) => t.id)).toEqual([
      list.id,
      item1.id,
    ]);
  });

  it('createTask refuses a parent in another space', async () => {
    const a = await addAccount(pg);
    const other = await addAccount(pg);
    const spaceA = await makeSpace(a.userId, 'A');
    const spaceB = await makeSpace(other.userId, 'B');
    const foreignParent = await createTask(db, other.userId, spaceB.id, { title: 'not yours' });

    await expect(
      createTask(db, a.userId, spaceA.id, { title: 'child', parentTaskId: foreignParent.id }),
    ).rejects.toThrow(/same space/);
  });

  it('subscribers: add requires an active member; list and remove work', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const outsider = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Watch', [b.userId]);
    const task = await createTask(db, a.userId, space.id, { title: 'watched' });

    await expect(addSubscriber(db, a.userId, task.id, outsider.userId)).rejects.toThrow(/active member/);

    const sub = await addSubscriber(db, a.userId, task.id, b.userId);
    expect(sub.taskId).toBe(task.id);
    expect(sub.userId).toBe(b.userId);

    expect(await listSubscribers(db, a.userId, task.id)).toHaveLength(1);

    await removeSubscriber(db, a.userId, task.id, b.userId);
    expect(await listSubscribers(db, a.userId, task.id)).toHaveLength(0);
  });
});
describe('checklist reorder (#510)', () => {
  /** A checklist in a fresh space: returns the list id and its items' ids by title. */
  async function checklist(userId: string, titles: string[]): Promise<{ listId: string; ids: Record<string, string> }> {
    const space = await makeSpace(userId, 'Reorder');
    const list = await createTask(db, userId, space.id, { title: 'packing list' });
    const ids: Record<string, string> = {};
    for (const title of titles) {
      ids[title] = (await createTask(db, userId, space.id, { title, parentTaskId: list.id })).id;
    }
    return { listId: list.id, ids };
  }

  async function order(userId: string, listId: string): Promise<StoredTask[]> {
    const list = await getTask(db, userId, listId);
    return listTasks(db, userId, list.spaceId, { parentTaskId: listId });
  }

  it('keyBetween always lands strictly between its bounds and never ends in the lowest character', () => {
    const cases: Array<[string | null, string | null]> = [
      [null, null], [null, 'a0'], ['a0', null], ['a0', 'a1'], ['a', 'a!"'],['a!', 'a!!"'],
      ['mfx1-abc', 'mfx1-abd'], ['~', null], [null, '!!"'], ['a0', 'a00'],
    ];
    for (const [lower, upper] of cases) {
      const key = keyBetween(lower, upper);
      if (lower !== null) expect(key > lower).toBe(true);
      if (upper !== null) expect(key < upper).toBe(true);
      expect(key.endsWith('!')).toBe(false);
    }
    expect(() => keyBetween('b', 'a')).toThrow(StoreError);
  });

  it('moving C before A in [A, B, C] reads back [C, A, B] and bumps the revision', async () => {
    const a = await addAccount(pg);
    const { listId, ids } = await checklist(a.userId, ['A', 'B', 'C']);
    const moved = await moveTaskItem(db, a.userId, ids.C!, { beforeItemId: ids.A!, revision: 1 });
    expect(moved.revision).toBe(2);
    expect((await order(a.userId, listId)).map((t) => t.title)).toEqual(['C', 'A', 'B']);
    const after = await moveTaskItem(db, a.userId, ids.C!, { afterItemId: ids.B!, revision: 2 });
    expect(after.revision).toBe(3);
    expect((await order(a.userId, listId)).map((t) => t.title)).toEqual(['A', 'B', 'C']);
  });

  it('50 alternating moves keep every order_key unique and the order as moved', async () => {
    const a = await addAccount(pg);
    const { listId, ids } = await checklist(a.userId, ['A', 'B', 'C', 'D']);
    const expected = ['A', 'B', 'C', 'D'];
    for (let i = 0; i < 50; i += 1) {
      const items = await order(a.userId, listId);
      const title = i % 2 === 0 ? 'C' : 'B';
      const item = items.find((t) => t.title === title)!;
      const anchor = i % 2 === 0 ? expected[0]! : expected[expected.length - 1]!;
      if (anchor === title) continue;
      await moveTaskItem(
        db,
        a.userId,
        item.id,
        i % 2 === 0
          ? { beforeItemId: ids[anchor]!, revision: item.revision }
          : { afterItemId: ids[anchor]!, revision: item.revision },
      );
      expected.splice(expected.indexOf(title), 1);
      if (i % 2 === 0) expected.unshift(title);
      else expected.push(title);
      const keys = (await order(a.userId, listId)).map((t) => t.orderKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect((await order(a.userId, listId)).map((t) => t.title)).toEqual(expected);
  });

  it('a stale revision throws TaskConflictError and leaves the order unchanged', async () => {
    const a = await addAccount(pg);
    const { listId, ids } = await checklist(a.userId, ['A', 'B', 'C']);
    await moveTaskItem(db, a.userId, ids.C!, { beforeItemId: ids.A!, revision: 1 });
    await expect(moveTaskItem(db, a.userId, ids.C!, { afterItemId: ids.B!, revision: 1 })).rejects.toBeInstanceOf(
      TaskConflictError,
    );
    expect((await order(a.userId, listId)).map((t) => t.title)).toEqual(['C', 'A', 'B']);
  });

  it('a restored item never shares a key with one moved into its old slot', async () => {
    const a = await addAccount(pg);
    const { listId, ids } = await checklist(a.userId, ['A', 'B', 'C', 'D']);
    await moveTaskItem(db, a.userId, ids.D!, { afterItemId: ids.A!, revision: 1 });
    await trashTask(db, a.userId, ids.D!);
    await moveTaskItem(db, a.userId, ids.C!, { afterItemId: ids.A!, revision: 1 });
    await restoreTask(db, a.userId, ids.D!);
    const keys = (await order(a.userId, listId)).map((t) => t.orderKey);
    expect(new Set(keys).size).toBe(4);
  });

  it('rejects a root task, a foreign anchor and an outsider', async () => {
    const a = await addAccount(pg);
    const outsider = await addAccount(pg);
    const { listId, ids } = await checklist(a.userId, ['A', 'B']);
    const other = await checklist(a.userId, ['X']);
    await expect(moveTaskItem(db, a.userId, listId, { afterItemId: ids.A!, revision: 1 })).rejects.toBeInstanceOf(StoreError);
    await expect(moveTaskItem(db, a.userId, ids.A!, { afterItemId: other.ids.X!, revision: 1 })).rejects.toBeInstanceOf(
      StoreError,
    );
    await expect(
      moveTaskItem(db, outsider.userId, ids.A!, { afterItemId: ids.B!, revision: 1 }),
    ).rejects.toBeInstanceOf(StoreNotFoundError);
  });
});
