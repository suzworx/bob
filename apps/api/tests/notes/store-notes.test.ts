// store/notes.ts tests (spec 014, S14-T016). Real Postgres via createTestDb, same
// setup as store-tasks.test.ts. Exercises the five store rules against real
// RLS: optimistic concurrency, revision history, not-found-equals-forbidden,
// scoped search, and trash exclusion -- plus pin/unpin and restore.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreNotFoundError, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import {
  createNote,
  createNoteOnce,
  getNote,
  listNotes,
  listRevisions,
  NoteConflictError,
  restoreNote,
  searchNotes,
  setPinned,
  trashNote,
  updateNote,
} from '../../src/notes/store.ts';
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

describe('notes store', () => {
  it('creates a note at revision 1 with a first revision row', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Family');

    const note = await createNote(db, a.userId, space.id, { title: 'Grocery list', body: 'milk' });
    expect(note.revision).toBe(1);
    expect(note.pinned).toBe(false);
    expect(note.trashedAt).toBeNull();
    expect(note.createdBy).toBe(a.userId);
    expect(note.updatedBy).toBe(a.userId);

    const revisions = await listRevisions(db, a.userId, note.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ revision: 1, title: 'Grocery list', body: 'milk', editorUserId: a.userId });
  });

  it('createNoteOnce writes one note per id and returns null once it is trashed', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Recaps');
    const id = randomUUID();

    const first = await createNoteOnce(db, a.userId, space.id, id, { title: 'Recap', body: 'one', aiAssisted: true });
    const again = await createNoteOnce(db, a.userId, space.id, id, { title: 'Recap', body: 'two', aiAssisted: true });
    expect(first).toMatchObject({ id, body: 'one', aiAssisted: true, revision: 1 });
    expect(again).toMatchObject({ id, body: 'one' });
    expect(await listRevisions(db, a.userId, id)).toHaveLength(1);

    await trashNote(db, a.userId, id);
    expect(await createNoteOnce(db, a.userId, space.id, id, { title: 'Recap', body: 'one' })).toBeNull();
  });

  it('rule 1: a stale revision throws NoteConflictError carrying the current row', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Edits');
    const note = await createNote(db, a.userId, space.id, { title: 'draft' });

    const saved = await updateNote(db, a.userId, note.id, { revision: 1, title: 'edited' });
    expect(saved.revision).toBe(2);

    // Replay the original revision 1 -- a stale write must not silently win.
    const conflict = await updateNote(db, a.userId, note.id, { revision: 1, title: 'stale' }).catch(
      (error: unknown) => error,
    );
    expect(conflict).toBeInstanceOf(NoteConflictError);
    expect((conflict as NoteConflictError).current.revision).toBe(2);
    expect((conflict as NoteConflictError).current.title).toBe('edited');
  });

  it('rule 2: every accepted edit writes an append-only revision row with editor and ai_assisted', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const space = await makeSpace(a.userId, 'History', [b.userId]);
    const note = await createNote(db, a.userId, space.id, { title: 'v1', aiAssisted: true });

    // aiAssisted is left undefined here, so it carries forward from current (true).
    await updateNote(db, b.userId, note.id, { revision: 1, title: 'v2', body: 'edited by b' });
    await updateNote(db, a.userId, note.id, { revision: 2, title: 'v3', aiAssisted: false });

    const revisions = await listRevisions(db, a.userId, note.id);
    // Newest first; one row per accepted edit, none skipped or overwritten.
    expect(revisions.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(revisions[0]).toMatchObject({ title: 'v3', editorUserId: a.userId, aiAssisted: false });
    expect(revisions[1]).toMatchObject({ title: 'v2', body: 'edited by b', editorUserId: b.userId, aiAssisted: true });
    expect(revisions[2]).toMatchObject({ title: 'v1', editorUserId: a.userId, aiAssisted: true });
  });

  it('pin/trash/restore are metadata changes: they do not bump revision or write history', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Meta');
    const note = await createNote(db, a.userId, space.id, { title: 'pinnable' });
    expect(note.revision).toBe(1);

    const pinned = await setPinned(db, a.userId, note.id, true);
    expect(pinned.pinned).toBe(true);
    expect(pinned.revision).toBe(1);

    const unpinned = await setPinned(db, a.userId, note.id, false);
    expect(unpinned.pinned).toBe(false);
    expect(unpinned.revision).toBe(1);

    const trashed = await trashNote(db, a.userId, note.id);
    expect(trashed.trashedAt).not.toBeNull();
    expect(trashed.revision).toBe(1);

    const restored = await restoreNote(db, a.userId, note.id);
    expect(restored.trashedAt).toBeNull();
    expect(restored.revision).toBe(1);

    expect(await listRevisions(db, a.userId, note.id)).toHaveLength(1);
  });

  it('rule 3: a note outside the caller audience and a missing id are the SAME StoreNotFoundError', async () => {
    const a = await addAccount(pg);
    const outsider = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Private-ish');
    const note = await createNote(db, a.userId, space.id, { title: 'family plans' });

    const hidden = await getNote(db, outsider.userId, note.id).catch((error: unknown) => error);
    const missing = await getNote(db, outsider.userId, randomUUID()).catch((error: unknown) => error);
    expect(hidden).toBeInstanceOf(StoreNotFoundError);
    expect(missing).toBeInstanceOf(StoreNotFoundError);
    expect((hidden as Error).message).toBe((missing as Error).message);
    expect((hidden as Error).message).toMatch(/not found/);

    // Same disclosure boundary for the other single-note reads.
    const hiddenRevisions = await listRevisions(db, outsider.userId, note.id).catch((error: unknown) => error);
    expect(hiddenRevisions).toBeInstanceOf(StoreNotFoundError);
    expect((hiddenRevisions as Error).message).toBe((hidden as Error).message);
  });

  it('rule 4: searchNotes never returns a note from another space, not even its title', async () => {
    const a = await addAccount(pg);
    const outsider = await addAccount(pg);
    const spaceA = await makeSpace(a.userId, 'A');
    const spaceB = await makeSpace(outsider.userId, 'B');
    await createNote(db, a.userId, spaceA.id, { title: 'unicorn parade', body: 'confetti everywhere' });
    await createNote(db, outsider.userId, spaceB.id, { title: 'unicorn parade secrets', body: 'confetti too' });

    const results = await searchNotes(db, a.userId, spaceA.id, 'unicorn');
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('unicorn parade');

    // The caller is not a member of spaceB at all -- RLS filters every row
    // silently, so the search answers empty rather than leaking a title.
    expect(await searchNotes(db, a.userId, spaceB.id, 'unicorn')).toHaveLength(0);
  });

  it('rule 5: trash excludes from ordinary reads immediately; listNotes omits it unless asked', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Trash');
    const note = await createNote(db, a.userId, space.id, { title: 'to bin', body: 'findable text' });

    expect(await listNotes(db, a.userId, space.id)).toHaveLength(1);
    expect(await searchNotes(db, a.userId, space.id, 'findable')).toHaveLength(1);

    await trashNote(db, a.userId, note.id);
    expect(await listNotes(db, a.userId, space.id)).toHaveLength(0);
    expect(await listNotes(db, a.userId, space.id, { includeTrashed: true })).toHaveLength(1);
    expect(await searchNotes(db, a.userId, space.id, 'findable')).toHaveLength(0);

    await restoreNote(db, a.userId, note.id);
    expect(await listNotes(db, a.userId, space.id)).toHaveLength(1);
    expect(await searchNotes(db, a.userId, space.id, 'findable')).toHaveLength(1);
  });

  it('listNotes orders pinned first, then most recently updated', async () => {
    const a = await addAccount(pg);
    const space = await makeSpace(a.userId, 'Order');
    const first = await createNote(db, a.userId, space.id, { title: 'first' });
    const second = await createNote(db, a.userId, space.id, { title: 'second' });
    await setPinned(db, a.userId, second.id, true);
    await updateNote(db, a.userId, first.id, { revision: 1, title: 'first, edited' });

    const notes = await listNotes(db, a.userId, space.id);
    expect(notes.map((n) => n.id)).toEqual([second.id, first.id]);
  });
});
