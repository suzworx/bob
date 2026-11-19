// Race condition tests for note updates (SCAN-D4-NOTE-RACE).
// Verifies that concurrent saves at the same revision result in exactly one success.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createNote, NoteConflictError, updateNote } from '../../src/notes/store.ts';
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

describe('notes store race conditions', () => {
  it('a save racing a committed edit at the same revision is refused, not merged', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Race1');
    const note = await createNote(db, a.userId, space.id, { title: 'test' });

    // Open a transaction, make a change, and start an updateNote before committing.
    // The started updateNote will block on the lock, then read the new revision and fail.
    const conflictError = await new Promise<unknown>((resolve) => {
      withUser(db, a.userId, async (tx) => {
        // Make a change in this transaction and commit it.
        await tx.query(`UPDATE bob.notes SET body = $1, revision = revision + 1 WHERE id = $2`, [
          'first',
          note.id,
        ]);
        // Start the second updateNote (do not await yet); it will block on the row lock.
        const promise = updateNote(db, a.userId, note.id, {
          revision: 1,
          body: 'second',
        }).catch((e) => e);
        // Wait for the second update to block on the lock, then return from the transaction.
        // This commits the first change, and the second updateNote will wake up.
        await waitForLockWaiter(pg);
        // Resolve the promise immediately after this transaction commits.
        promise.then(resolve).catch(resolve);
      });
    });

    expect(conflictError).toBeInstanceOf(NoteConflictError);
    const error = conflictError as NoteConflictError;
    expect(error.current.revision).toBe(2);
    expect(error.current.body).toBe('first');

    const stored = await updateNote(db, a.userId, note.id, { revision: 2, body: 'after' }).catch((e) => e);
    expect(stored).not.toBeInstanceOf(Error);
    expect((stored as any).body).toBe('after');
    expect((stored as any).revision).toBe(3);
  });

  it('two concurrent saves at one revision: exactly one wins', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Race2');
    const note = await createNote(db, a.userId, space.id, { title: 'concurrent' });

    // Both updates start at revision 1; exactly one should succeed.
    const results = await Promise.allSettled([
      updateNote(db, a.userId, note.id, { revision: 1, body: 'body-a' }),
      updateNote(db, a.userId, note.id, { revision: 1, body: 'body-b' }),
    ]);

    // One fulfilled, one rejected.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    expect(winner.revision).toBe(2);
    expect(['body-a', 'body-b']).toContain(winner.body);

    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(NoteConflictError);
    expect(reason.current.revision).toBe(2);
    expect(reason.current.body).toBe(winner.body);
  });
});
