// S14-PUBLICATION core acts (spec 014, GitHub issue #142). Real Postgres via
// createTestDb, same setup as store-notes.test.ts. Provenance leakage is the point:
// a published copy, or a promoted task, must never let a space member infer
// something about the author's private notes or memory. The published note and
// the promoted task are ORDINARY resources; only the provenance row names the
// source, and it is visible only to the actor.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreNotFoundError, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace, ensurePrivateSpace } from '../../src/spaces/store.ts';
import { createNote, getNote, updateNote } from '../../src/notes/store.ts';
import { createTask, listTasks } from '../../src/tasks/store.ts';
import {
  promoteMemoryToTask,
  publicationFor,
  publicationsByActor,
  publishNoteIntoSpace,
  recordPublication,
} from '../../src/spaces/publication-service.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  withUserRaw,
  type TestDb,
} from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  // bob.memories comes from the real memory migration, with its production
  // actor-only RLS.
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

/** The caller's private space (source for note publications). */
async function privateSpace(userId: string): Promise<{ id: string }> {
  return ensurePrivateSpace(db, userId);
}

/** A memory the caller owns, shaped like a remembered action. Inserted with a
 *  plain statement under the actor (insertMemory needs the vector extension). */
async function rememberedAction(userId: string, content: string): Promise<{ id: string; content: string }> {
  const id = `mem_${randomUUID()}`;
  await withUserRaw(pg, userId, (tx) =>
    tx.query(
      `INSERT INTO bob.memories (id, user_id, kind, content, confidence, surface)
       VALUES ($1, $2, 'action_item', $3, 0.9, 'device')`,
      [id, userId, content],
    ),
  );
  return { id, content };
}

/**
 * A Db whose every query path throws when the SQL mentions `needle`, while
 * everything else passes through to `base`. The guard is re-asserted on the
 * transaction handle the core store functions actually call (they run on the
 * db.tx(...) handle), exactly like the erasure atomicity test.
 */
function rejectOn(needle: string, base: Db): Db {
  const guard = <T>(sql: string, params: unknown[] | undefined, target: Db): Promise<T[]> => {
    if (sql.includes(needle)) {
      return Promise.reject(new Error('injected failure'));
    }
    return target.query<T>(sql, params);
  };
  const wrapTx = <T>(fn: (txDb: Db) => Promise<T>, target: Db): Promise<T> =>
    target.tx((tx) =>
      fn({
        query: <T2>(sql: string, params?: unknown[]) => guard<T2>(sql, params, tx),
        tx: <T3>(innerFn: (txDb: Db) => Promise<T3>): Promise<T3> => wrapTx(innerFn, tx),
      }),
    );
  return {
    query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      return guard<T>(sql, params, base);
    },
    tx<T>(fn: (txDb: Db) => Promise<T>): Promise<T> {
      return wrapTx(fn, base);
    },
  };
}

describe('publication acts', () => {
  it('1: publishing copies only the selected fields; a field NOT selected is absent from the copy', async () => {
    const a = await addAccount(pg);
    const privateSpaceId = await privateSpace(a.userId);
    const dest = await makeSpace(a.userId, 'Dest');
    const source = await createNote(db, a.userId, privateSpaceId.id, {
      title: 'Secret plans',
      body: 'the family secret',
    });

    const copy = await publishNoteIntoSpace({
      db,
      userId: a.userId,
      noteId: source.id,
      spaceId: dest.id,
      fields: { title: true },
    });

    // title selected -> present; body NOT selected -> absent, never leaked.
    expect(copy.title).toBe('Secret plans');
    expect(copy.body).toBe('');
  });

  it('2: editing the published copy does not change the source, and vice versa', async () => {
    const a = await addAccount(pg);
    const privateSpaceId = await privateSpace(a.userId);
    const dest = await makeSpace(a.userId, 'Dest');
    const source = await createNote(db, a.userId, privateSpaceId.id, {
      title: 'Recipe',
      body: 'original body',
    });
    const copy = await publishNoteIntoSpace({
      db,
      userId: a.userId,
      noteId: source.id,
      spaceId: dest.id,
      fields: { title: true, body: true },
    });

    // Edit the copy: the source must stay untouched.
    await updateNote(db, a.userId, copy.id, { revision: 1, body: 'edited copy' });
    expect((await getNote(db, a.userId, source.id)).body).toBe('original body');

    // Edit the source: the copy must stay untouched (copy, not sync).
    await updateNote(db, a.userId, source.id, { revision: 1, body: 'edited source' });
    expect((await getNote(db, a.userId, copy.id)).body).toBe('edited copy');
  });

  it('3: the published note carries no column, id or marker that names the source', async () => {
    const a = await addAccount(pg);
    const privateSpaceId = await privateSpace(a.userId);
    const dest = await makeSpace(a.userId, 'Dest');
    const source = await createNote(db, a.userId, privateSpaceId.id, {
      title: 'Private note',
      body: 'nobody else should map this back',
    });
    const copy = await publishNoteIntoSpace({
      db,
      userId: a.userId,
      noteId: source.id,
      spaceId: dest.id,
      fields: { title: true, body: true },
    });

    // A fresh id (a copy, never the source row) and no property on the copy
    // references the source id.
    expect(copy.id).not.toBe(source.id);
    expect(copy.createdBy).toBe(a.userId);
    const values = Object.values(copy);
    expect(values).not.toContain(source.id);

    // The raw row has no source marker either -- only ordinary note columns.
    // Read as the copy's creator: RLS applies, as in production.
    const raw = (
      await withUserRaw(pg, a.userId, (tx) =>
        tx.query<{ title: string; body: string }>(`SELECT title, body FROM bob.notes WHERE id = $1`, [copy.id]),
      )
    ).rows;
    expect(raw).toHaveLength(1);
    expect(raw[0]!.title).toBe('Private note');
    expect(raw[0]!.body).toBe('nobody else should map this back');
  });

  it('4: a second member sees an ordinary note, and publicationFor is null for them but returns the row for the actor', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const privateSpaceId = await privateSpace(a.userId);
    const dest = await makeSpace(a.userId, 'Dest', [b.userId]);
    const source = await createNote(db, a.userId, privateSpaceId.id, {
      title: 'Shared plan',
      body: 'published to the family',
    });
    const copy = await publishNoteIntoSpace({
      db,
      userId: a.userId,
      noteId: source.id,
      spaceId: dest.id,
      fields: { title: true, body: true },
    });

    // b reads the copy as an ORDINARY note -- no provenance, no source id.
    const bView = await getNote(db, b.userId, copy.id);
    expect(bView.title).toBe('Shared plan');
    expect(bView.id).toBe(copy.id);

    // The actor sees the provenance; the member sees nothing.
    const actorRow = await publicationFor(db, a.userId, copy.id);
    expect(actorRow).not.toBeNull();
    expect(actorRow!.sourceType).toBe('note');
    expect(actorRow!.sourceId).toBe(source.id);
    expect(actorRow!.actorUserId).toBe(a.userId);
    expect(await publicationFor(db, b.userId, copy.id)).toBeNull();
  });

  it('5: promoting a memory creates an ordinary task with the supplied title, and the memory text never appears unless passed', async () => {
    const a = await addAccount(pg);
    const dest = await makeSpace(a.userId, 'Dest');
    const memory = await rememberedAction(a.userId, 'remember to buy milk on the way home');

    const task = await promoteMemoryToTask({
      db,
      userId: a.userId,
      memoryId: memory.id,
      spaceId: dest.id,
      title: 'buy milk',
    });

    expect(task.title).toBe('buy milk');
    expect(task.body).toBeNull();
    // The memory's own text never crossed into the task unless the caller gave it.
    expect(task.title).not.toContain(memory.content);

    // Provenance recorded for the actor, source_type memory.
    const row = await publicationFor(db, a.userId, task.id);
    expect(row).not.toBeNull();
    expect(row!.sourceType).toBe('memory');
    expect(row!.sourceId).toBe(memory.id);
    expect(row!.publishedType).toBe('task');
    expect(row!.actorUserId).toBe(a.userId);
  });

  it('6: promoting someone else\'s memory is refused exactly like a missing id (same error, no oracle)', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const dest = await makeSpace(a.userId, 'Dest');
    const bMemory = await rememberedAction(b.userId, 'b private thought');

    const hidden = await promoteMemoryToTask({
      db,
      userId: a.userId,
      memoryId: bMemory.id,
      spaceId: dest.id,
      title: 'sneak peek',
    }).catch((error: unknown) => error);
    const missing = await promoteMemoryToTask({
      db,
      userId: a.userId,
      memoryId: 'mem_does_not_exist',
      spaceId: dest.id,
      title: 'sneak peek',
    }).catch((error: unknown) => error);

    expect(hidden).toBeInstanceOf(StoreNotFoundError);
    expect(missing).toBeInstanceOf(StoreNotFoundError);
    expect((hidden as Error).message).toBe((missing as Error).message);
    expect((hidden as Error).message).toMatch(/not found/);

    // Nothing was created, nothing recorded.
    expect(await listTasks(db, a.userId, dest.id)).toHaveLength(0);
    expect(await publicationsByActor(db, a.userId, { limit: 50 })).toHaveLength(0);
  });

  it('7: both acts are atomic -- an injected failure leaves neither the copy nor the provenance row', async () => {
    const a = await addAccount(pg);
    const privateSpaceId = await privateSpace(a.userId);
    const dest = await makeSpace(a.userId, 'Dest');
    const source = await createNote(db, a.userId, privateSpaceId.id, {
      title: 'To publish',
      body: 'should roll back',
    });

    // Note publication: fail the provenance insert; the copy must roll back too.
    const failingNote = rejectOn('bob.publications', db);
    const noteError = await publishNoteIntoSpace({
      db: failingNote,
      userId: a.userId,
      noteId: source.id,
      spaceId: dest.id,
      fields: { title: true, body: true },
    }).catch((error: unknown) => error);
    expect(noteError).toBeInstanceOf(Error);
    expect((noteError as Error).message).toContain('injected failure');
    expect(await publicationFor(db, a.userId, source.id)).toBeNull();
    expect(await publicationsByActor(db, a.userId, { limit: 50 })).toHaveLength(0);

    // Task promotion: same injected failure; the task must roll back too.
    const memory = await rememberedAction(a.userId, 'remember to file taxes');
    const failingTask = rejectOn('bob.publications', db);
    const taskError = await promoteMemoryToTask({
      db: failingTask,
      userId: a.userId,
      memoryId: memory.id,
      spaceId: dest.id,
      title: 'file taxes',
    }).catch((error: unknown) => error);
    expect(taskError).toBeInstanceOf(Error);
    expect((taskError as Error).message).toContain('injected failure');
    expect(await listTasks(db, a.userId, dest.id)).toHaveLength(0);
    expect(await publicationsByActor(db, a.userId, { limit: 50 })).toHaveLength(0);
  });
});

describe('publications store', () => {
  it('publicationFor and publicationsByActor are actor-only via RLS', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const dest = await makeSpace(a.userId, 'Dest');
    const task = await createTask(db, a.userId, dest.id, { title: 'an ordinary task' });

    await recordPublication(db, a.userId, {
      sourceType: 'note',
      sourceId: randomUUID(),
      publishedType: 'task',
      publishedId: task.id,
      publishedIntoSpaceId: dest.id,
    });

    expect(await publicationFor(db, a.userId, task.id)).not.toBeNull();
    expect(await publicationFor(db, b.userId, task.id)).toBeNull();
    expect(await publicationsByActor(db, a.userId, { limit: 10 })).toHaveLength(1);
    expect(await publicationsByActor(db, b.userId, { limit: 10 })).toHaveLength(0);
  });
});