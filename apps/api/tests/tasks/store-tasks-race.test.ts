// Race condition tests for updateTask: concurrent saves at the same revision.
// Verifies that lost updates are prevented by row-level locking.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreError, StoreNotFoundError, type Db, withUser } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createTask, TaskConflictError, updateTask } from '../../src/tasks/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { waitForLockWaiter } from '../support/lock-barrier.ts';

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

describe('tasks store: race conditions', () => {
  it('a save racing a committed edit at the same revision is refused, not merged', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Races');
    const task = await createTask(db, a.userId, space.id, { title: 'original' });
    expect(task.revision).toBe(1);

    // Simulate: one writer commits an edit. Start a second save at the same
    // revision; it should block on the lock and then fail with TaskConflictError.
    let updatePromise: Promise<unknown>;
    await withUser(db, a.userId, async (tx) => {
      // First writer updates the row directly within the transaction.
      await tx.query(
        `UPDATE bob.tasks SET title = $1, revision = revision + 1 WHERE id = $2`,
        ['first', task.id],
      );
      // Start the second writer's updateTask in parallel (don't await yet).
      updatePromise = updateTask(db, a.userId, task.id, {
        revision: 1,
        title: 'second',
      }).catch((e) => e);
      // Wait for the second transaction to block on the lock.
      await waitForLockWaiter(pg);
    });

    // Now the first transaction has committed, the second can proceed,
    // read revision 2, and fail with TaskConflictError.
    const conflict = await updatePromise!;
    expect(conflict).toBeInstanceOf(TaskConflictError);
    expect((conflict as TaskConflictError).current.revision).toBe(2);
    expect((conflict as TaskConflictError).current.title).toBe('first');
  });

  it('two concurrent saves at one revision: exactly one wins', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Concurrent');
    const task = await createTask(db, a.userId, space.id, { title: 'shared' });
    expect(task.revision).toBe(1);

    // Start two updates at the same revision concurrently.
    const results = await Promise.allSettled([
      updateTask(db, a.userId, task.id, { revision: 1, title: 'writer-a' }),
      updateTask(db, a.userId, task.id, { revision: 1, title: 'writer-b' }),
    ]);

    // Exactly one must succeed, exactly one must fail with TaskConflictError.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winner = (fulfilled[0] as PromiseFulfilledResult<typeof task>).value;
    const loser = (rejected[0] as PromiseRejectedResult).reason;
    expect(loser).toBeInstanceOf(TaskConflictError);

    // The winner's title is in the row, revision incremented.
    expect(winner.revision).toBe(2);
    expect(['writer-a', 'writer-b']).toContain(winner.title);

    // The loser's current row in the error carries the winner's state.
    expect((loser as TaskConflictError).current.title).toBe(winner.title);
    expect((loser as TaskConflictError).current.revision).toBe(2);
  });
});
