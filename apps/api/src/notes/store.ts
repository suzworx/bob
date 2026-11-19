/**
 * Shared notes and revision history store (spec 014, S14-T016; data-model.md
 * "notes, note_revisions"; contracts/api.md "Notes and assets"). Every function
 * runs under withUser() so RLS decides access from ACTIVE membership in the
 * note's space; a note in a space the caller is not a member of is
 * indistinguishable from one that does not exist (same StoreNotFoundError, no
 * separate code). Timestamps are timestamptz read back as epoch-ms.
 *
 * The five rules enforced in code, each with a test in store-notes.test.ts:
 *   1. updateNote is optimistic on `revision` -- a stale write throws
 *      NoteConflictError (a StoreConflictError) carrying the CURRENT row.
 *   2. Every accepted edit writes an append-only note_revisions row with the
 *      editor and the ai_assisted flag, so history is inspectable.
 *   3. Not found equals forbidden -- same error, same message.
 *   4. searchNotes is scoped: it never returns a note from another space.
 *   5. trashNote excludes the row from ordinary reads immediately; listNotes
 *      and searchNotes omit trashed rows unless explicitly asked.
 *
 * revision is the CONTENT version: it starts at 1 on create and increments on
 * every content edit (each of which writes a history row), so every revision
 * number maps to exactly one note_revisions row. Pin, trash and restore are
 * metadata changes and do not bump revision or write history.
 */
import {
  StoreConflictError,
  StoreError,
  StoreNotFoundError,
  withUser,
  type Db,
} from '../platform/db/db.ts';
import { requireSpaceMember } from '../spaces/store.ts';



/** A durable note row as the rest of the app sees it (epoch-ms stamps). */
export type StoredNote = {
  id: string;
  spaceId: string;
  title: string;
  body: string;
  pinned: boolean;
  revision: number;
  createdBy: string;
  updatedBy: string;
  aiAssisted: boolean;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** One append-only revision of a note's content (newest first on read). */
export type StoredRevision = {
  id: string;
  noteId: string;
  spaceId: string;
  revision: number;
  title: string;
  body: string;
  editorUserId: string;
  aiAssisted: boolean;
  createdAt: number;
};

type NewNote = {
  title: string;
  body?: string;
  aiAssisted?: boolean;
};

/** updateNote's body. undefined = leave unchanged. */
type NoteUpdate = {
  title?: string;
  body?: string;
  aiAssisted?: boolean;
};

type ListNotesOptions = {
  /** When true, trashed notes are included in the read. */
  includeTrashed?: boolean;
};

/** The note columns with timestamptz -> epoch-ms read-back. Column names are
 *  unqualified so the same list works in SELECT (FROM bob.notes n) and in
 *  INSERT/UPDATE ... RETURNING (which has no table alias). */
const NOTE_COLUMNS = `id, space_id AS "spaceId", title, body, pinned, revision,
  created_by AS "createdBy", updated_by AS "updatedBy", ai_assisted AS "aiAssisted",
  floor(extract(epoch from trashed_at) * 1000)::bigint AS "trashedAt",
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt"`;

/** A raw bob.notes row (aliases follow NOTE_COLUMNS). */
type NoteRow = {
  id: unknown;
  spaceId: unknown;
  title: unknown;
  body: unknown;
  pinned: unknown;
  revision: unknown;
  createdBy: unknown;
  updatedBy: unknown;
  aiAssisted: unknown;
  trashedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

/** A raw bob.note_revisions row. */
type RevisionRow = {
  id: unknown;
  noteId: unknown;
  spaceId: unknown;
  revision: unknown;
  title: unknown;
  body: unknown;
  editorUserId: unknown;
  aiAssisted: unknown;
  createdAt: unknown;
};

/** Raw row -> StoredNote. Exported so tests exercise the mapping without a DB. */
function rowToNote(row: NoteRow): StoredNote {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    title: String(row.title),
    body: String(row.body),
    pinned: Boolean(row.pinned),
    revision: Number(row.revision),
    createdBy: String(row.createdBy),
    updatedBy: String(row.updatedBy),
    aiAssisted: Boolean(row.aiAssisted),
    trashedAt: row.trashedAt === null ? null : Number(row.trashedAt),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

/** Raw revision row -> StoredRevision. */
function rowToRevision(row: RevisionRow): StoredRevision {
  return {
    id: String(row.id),
    noteId: String(row.noteId),
    spaceId: String(row.spaceId),
    revision: Number(row.revision),
    title: String(row.title),
    body: String(row.body),
    editorUserId: String(row.editorUserId),
    aiAssisted: Boolean(row.aiAssisted),
    createdAt: Number(row.createdAt),
  };
}

/** An optimistic-concurrency failure carrying the CURRENT row, so the caller
 *  can present a conflict and preserve the user's draft. */
export class NoteConflictError extends StoreConflictError {
  readonly current: StoredNote;
  constructor(current: StoredNote) {
    super('note revision conflict');
    this.name = 'NoteConflictError';
    this.current = current;
  }
}

/** Validates a title: 1..200 chars after trim (contracts/api.md "Notes"). */
function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new StoreError('note title must be 1..200 characters');
  }
  return trimmed;
}

/** Validates a body: at most 20000 chars (body is not null, default ''). */
function validateBody(body: string): string {
  if (body.length > 20000) throw new StoreError('note body must be at most 20000 characters');
  return body;
}

/** Reads one note row by id under RLS, or null. */
async function readNoteRow(tx: Db, id: string, opts?: { forUpdate?: boolean }): Promise<NoteRow | null> {
  const lock = opts?.forUpdate ? 'FOR UPDATE OF n' : '';
  const rows = await tx.query<NoteRow>(`SELECT ${NOTE_COLUMNS} FROM bob.notes n WHERE n.id = $1 ${lock}`, [id]);
  return rows.length === 0 ? null : rows[0]!;
}

/**
 * Lists notes in a space, excluding trashed rows unless includeTrashed is true.
 * Pinned notes first, then by most recently updated -- the listing index order.
 */
export async function listNotes(
  db: Db,
  userId: string,
  spaceId: string,
  options: ListNotesOptions = {},
): Promise<StoredNote[]> {
  return withUser(db, userId, async (tx) => {
    const where = ['n.space_id = $1'];
    const params: unknown[] = [spaceId];
    if (options.includeTrashed !== true) {
      where.push('n.trashed_at IS NULL');
    }
    const rows = await tx.query<NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM bob.notes n
       WHERE ${where.join(' AND ')}
       ORDER BY n.pinned DESC, n.updated_at DESC`,
      params,
    );
    return rows.map(rowToNote);
  });
}

/**
 * Reads one note. A caller who is not an active member of the note's space gets
 * StoreNotFoundError exactly as if the id did not exist (the identity-leak
 * rule): the message does not embed the id, so both paths are identical.
 * A trashed note is still readable by its owner/members (restore needs it).
 */
export async function getNote(db: Db, userId: string, noteId: string): Promise<StoredNote> {
  return withUser(db, userId, async (tx) => {
    const row = await readNoteRow(tx, noteId);
    if (!row) throw new StoreNotFoundError('note not found');
    return rowToNote(row);
  });
}

/**
 * Creates a note in a space at revision 1 and writes its first revision row, so
 * history is complete from the start. `ai_assisted` marks a model-assisted
 * draft. A non-member insert is refused by RLS (no row is returned).
 */
export async function createNote(
  db: Db,
  userId: string,
  spaceId: string,
  input: NewNote,
): Promise<StoredNote> {
  const title = validateTitle(input.title);
  const body = validateBody(input.body ?? '');
  const aiAssisted = input.aiAssisted ?? false;
  return withUser(db, userId, async (tx) => {
    await requireSpaceMember(tx, spaceId, userId);
    const rows = await tx.query<NoteRow>(
      `INSERT INTO bob.notes (space_id, title, body, revision, created_by, updated_by, ai_assisted)
       VALUES ($1, $2, $3, 1, $4, $4, $5)
       RETURNING ${NOTE_COLUMNS}`,
      [spaceId, title, body, userId, aiAssisted],
    );
    if (rows.length === 0) throw new StoreError('could not create note');
    const note = rowToNote(rows[0]!);
    await tx.query(
      `INSERT INTO bob.note_revisions (note_id, space_id, revision, title, body, editor_user_id, ai_assisted)
       VALUES ($1, $2, 1, $3, $4, $5, $6)`,
      [note.id, spaceId, title, body, userId, aiAssisted],
    );
    return note;
  });
}

/**
 * Creates the note with a caller-chosen id the first time and returns it on
 * every later call, so a retried job writes one note. Returns null when that
 * note has since been trashed or is not visible to the user.
 */
export async function createNoteOnce(
  db: Db,
  userId: string,
  spaceId: string,
  id: string,
  input: NewNote,
): Promise<StoredNote | null> {
  const title = validateTitle(input.title);
  const body = validateBody(input.body ?? '');
  const aiAssisted = input.aiAssisted ?? false;
  return withUser(db, userId, async (tx) => {
    await requireSpaceMember(tx, spaceId, userId);
    const created = await tx.query<{ id: string }>(
      `INSERT INTO bob.notes (id, space_id, title, body, revision, created_by, updated_by, ai_assisted)
       VALUES ($1, $2, $3, $4, 1, $5, $5, $6)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [id, spaceId, title, body, userId, aiAssisted],
    );
    if (created.length > 0) {
      await tx.query(
        `INSERT INTO bob.note_revisions (note_id, space_id, revision, title, body, editor_user_id, ai_assisted)
         VALUES ($1, $2, 1, $3, $4, $5, $6)`,
        [id, spaceId, title, body, userId, aiAssisted],
      );
    }
    const rows = await tx.query<NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM bob.notes n
       WHERE n.id = $1 AND n.space_id = $2 AND n.trashed_at IS NULL`,
      [id, spaceId],
    );
    return rows[0] ? rowToNote(rows[0]) : null;
  });
}

/**
 * Updates a note's content optimistically. A stale `revision` (not the current
 * row's) throws NoteConflictError carrying the current row. On success the
 * revision increments and an append-only note_revisions row records the new
 * content, the editor and the ai_assisted flag -- every accepted edit writes
 * history, and no edit silently overwrites another.
 */
export async function updateNote(
  db: Db,
  userId: string,
  noteId: string,
  update: NoteUpdate & { revision: number },
): Promise<StoredNote> {
  if (!Number.isInteger(update.revision) || update.revision < 1) {
    throw new StoreError('updateNote: revision must be a positive integer');
  }
  return withUser(db, userId, async (tx) => {
    // Lock the row before the revision check to prevent lost updates when two concurrent
    // saves race at the same revision: the second will block, then read the updated revision
    // and throw NoteConflictError, rather than both passing the check and both updating.
    const row = await readNoteRow(tx, noteId, { forUpdate: true });
    if (!row) throw new StoreNotFoundError('note not found');
    const current = rowToNote(row);
    if (current.revision !== update.revision) {
      throw new NoteConflictError(current);
    }

    const title = update.title !== undefined ? validateTitle(update.title) : current.title;
    const body = update.body !== undefined ? validateBody(update.body) : current.body;
    const aiAssisted = update.aiAssisted !== undefined ? update.aiAssisted : current.aiAssisted;

    const set: string[] = ['revision = revision + 1', 'updated_by = $2', 'updated_at = now()'];
    const params: unknown[] = [noteId, userId];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    set.push(`title = ${push(title)}`);
    set.push(`body = ${push(body)}`);
    set.push(`ai_assisted = ${push(aiAssisted)}`);

    const rows = await tx.query<NoteRow>(
      `UPDATE bob.notes SET ${set.join(', ')} WHERE id = $1 RETURNING ${NOTE_COLUMNS}`,
      params,
    );
    if (rows.length === 0) throw new StoreNotFoundError('note not found');
    const note = rowToNote(rows[0]!);
    await tx.query(
      `INSERT INTO bob.note_revisions (note_id, space_id, revision, title, body, editor_user_id, ai_assisted)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [note.id, note.spaceId, note.revision, title, body, userId, aiAssisted],
    );
    return note;
  });
}

/** Pins (true) or unpins (false) a note. Pin state is per space, not per viewer;
 *  it is a metadata change, so it does not bump revision or write history. */
export async function setPinned(
  db: Db,
  userId: string,
  noteId: string,
  pinned: boolean,
): Promise<StoredNote> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<NoteRow>(
      `UPDATE bob.notes
       SET pinned = $2, updated_at = now()
       WHERE id = $1
       RETURNING ${NOTE_COLUMNS}`,
      [noteId, pinned],
    );
    if (rows.length === 0) throw new StoreNotFoundError('note not found');
    return rowToNote(rows[0]!);
  });
}

/** Trashes a note (delete is trash, not purge); excludes it from ordinary reads. */
export async function trashNote(db: Db, userId: string, noteId: string): Promise<StoredNote> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<NoteRow>(
      `UPDATE bob.notes
       SET trashed_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING ${NOTE_COLUMNS}`,
      [noteId],
    );
    if (rows.length === 0) throw new StoreNotFoundError('note not found');
    return rowToNote(rows[0]!);
  });
}

/** Restores a trashed note; brings it back into ordinary reads. */
export async function restoreNote(db: Db, userId: string, noteId: string): Promise<StoredNote> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<NoteRow>(
      `UPDATE bob.notes
       SET trashed_at = NULL, updated_at = now()
       WHERE id = $1
       RETURNING ${NOTE_COLUMNS}`,
      [noteId],
    );
    if (rows.length === 0) throw new StoreNotFoundError('note not found');
    return rowToNote(rows[0]!);
  });
}

/**
 * Lists a note's revision history, newest first. A non-member (or a missing id)
 * answers the same StoreNotFoundError as getNote -- the disclosure boundary.
 */
export async function listRevisions(
  db: Db,
  userId: string,
  noteId: string,
): Promise<StoredRevision[]> {
  return withUser(db, userId, async (tx) => {
    const row = await readNoteRow(tx, noteId);
    if (!row) throw new StoreNotFoundError('note not found');
    const rows = await tx.query<RevisionRow>(
      `SELECT id, note_id AS "noteId", space_id AS "spaceId", revision, title, body,
              editor_user_id AS "editorUserId", ai_assisted AS "aiAssisted",
              floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt"
       FROM bob.note_revisions
       WHERE note_id = $1
       ORDER BY revision DESC`,
      [noteId],
    );
    return rows.map(rowToRevision);
  });
}

/**
 * Searches note titles and bodies within one space, excluding trashed notes.
 * Scoped by space_id (rule 4): a note in a space the caller is not in is never
 * returned, not even its title. A blank query answers an empty list.
 */
export async function searchNotes(
  db: Db,
  userId: string,
  spaceId: string,
  query: string,
): Promise<StoredNote[]> {
  const term = query.trim();
  if (term.length === 0) return [];
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM bob.notes n
       WHERE n.space_id = $1 AND n.trashed_at IS NULL
         AND to_tsvector('english', n.title || ' ' || n.body)
             @@ websearch_to_tsquery('english', $2)
       ORDER BY ts_rank_cd(
         to_tsvector('english', n.title || ' ' || n.body),
         websearch_to_tsquery('english', $2)
       ) DESC, n.updated_at DESC`,
      [spaceId, term],
    );
    return rows.map(rowToNote);
  });
}