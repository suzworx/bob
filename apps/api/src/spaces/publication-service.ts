/**
 * Publishing acts: copy a private note into a space, or promote a remembered
 * action into a task. The failure this prevents is provenance leakage -- a
 * copy that lets a space member infer something about the author's private
 * notes or memory. Each act creates an ORDINARY note/task from an explicit
 * field allowlist and records a provenance row whose select policy is
 * actor-only, all in ONE transaction. The journal carries type labels only.
 *
 * source_id is `text` because bob.memories uses a text primary key.
 */
import { getMemory } from '../memory/store.ts';
import { createNote, getNote, type StoredNote } from '../notes/store.ts';
import { createTask, type StoredTask } from '../tasks/store.ts';
import { StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { moduleJournal } from '../platform/logger.ts';

const journal = moduleJournal('spaces');

type PublicationSourceType = 'note' | 'memory';
type PublicationPublishedType = 'note' | 'task';

type NewPublication = {
  sourceType: PublicationSourceType;
  sourceId: string;
  publishedType: PublicationPublishedType;
  publishedId: string;
  publishedIntoSpaceId: string;
};

type StoredPublication = {
  id: string;
  sourceType: PublicationSourceType;
  sourceId: string;
  publishedType: PublicationPublishedType;
  publishedId: string;
  publishedIntoSpaceId: string;
  actorUserId: string;
  createdAt: number;
};

const SOURCE_TYPES: readonly string[] = ['note', 'memory'];
const PUBLISHED_TYPES: readonly string[] = ['note', 'task'];

function isSourceType(value: unknown): value is PublicationSourceType {
  return typeof value === 'string' && (SOURCE_TYPES as string[]).includes(value);
}

function isPublishedType(value: unknown): value is PublicationPublishedType {
  return typeof value === 'string' && (PUBLISHED_TYPES as string[]).includes(value);
}

const PUBLICATION_COLUMNS = `id, source_type AS "sourceType", source_id AS "sourceId",
  published_type AS "publishedType", published_id AS "publishedId",
  published_into_space_id AS "publishedIntoSpaceId", actor_user_id AS "actorUserId",
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt"`;

type PublicationRow = {
  id: unknown;
  sourceType: unknown;
  sourceId: unknown;
  publishedType: unknown;
  publishedId: unknown;
  publishedIntoSpaceId: unknown;
  actorUserId: unknown;
  createdAt: unknown;
};

function rowToPublication(row: PublicationRow): StoredPublication {
  return {
    id: String(row.id),
    sourceType: row.sourceType as PublicationSourceType,
    sourceId: String(row.sourceId),
    publishedType: row.publishedType as PublicationPublishedType,
    publishedId: String(row.publishedId),
    publishedIntoSpaceId: String(row.publishedIntoSpaceId),
    actorUserId: String(row.actorUserId),
    createdAt: Number(row.createdAt),
  };
}

export async function recordPublication(
  db: Db,
  userId: string,
  input: NewPublication,
): Promise<StoredPublication> {
  if (!isSourceType(input.sourceType)) {
    throw new StoreError('recordPublication: invalid sourceType');
  }
  if (!isPublishedType(input.publishedType)) {
    throw new StoreError('recordPublication: invalid publishedType');
  }
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<PublicationRow>(
      `INSERT INTO bob.publications
         (source_type, source_id, published_type, published_id,
          published_into_space_id, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${PUBLICATION_COLUMNS}`,
      [
        input.sourceType,
        input.sourceId,
        input.publishedType,
        input.publishedId,
        input.publishedIntoSpaceId,
        userId,
      ],
    );
    const [row] = rows;
    if (row === undefined) throw new StoreError('could not record publication');
    return rowToPublication(row);
  });
}

/** Null for anyone but the actor: RLS decides, with no TypeScript filter. */
export async function publicationFor(
  db: Db,
  userId: string,
  publishedId: string,
): Promise<StoredPublication | null> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<PublicationRow>(
      `SELECT ${PUBLICATION_COLUMNS} FROM bob.publications WHERE published_id = $1`,
      [publishedId],
    );
    const [row] = rows;
    return row === undefined ? null : rowToPublication(row);
  });
}

/** The actor's publications, newest first. RLS restricts the rows; the
 *  actor_user_id filter is for the index, not authorization. */
export async function publicationsByActor(
  db: Db,
  userId: string,
  options: { limit: number },
): Promise<StoredPublication[]> {
  const limit = Math.max(1, Math.floor(options.limit));
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<PublicationRow>(
      `SELECT ${PUBLICATION_COLUMNS} FROM bob.publications
       WHERE actor_user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [userId, limit],
    );
    return rows.map(rowToPublication);
  });
}

/** The explicit field allowlist: an unselected field is ABSENT from the copy. */
type PublishFields = { title?: boolean; body?: boolean };

/** Copies the selected fields of a private note into a NEW note in the space;
 *  no history, timestamps or source id travel with it. A copy, not a sync. */
export async function publishNoteIntoSpace(args: {
  db: Db;
  userId: string;
  noteId: string;
  spaceId: string;
  fields: PublishFields;
}): Promise<StoredNote> {
  const { db, userId, noteId, spaceId, fields } = args;
  const copy = await withUser(db, userId, async (tx) => {
    const source = await getNote(tx, userId, noteId);
    const copy = await createNote(tx, userId, spaceId, {
      title: fields.title === true ? source.title : '',
      body: fields.body === true ? source.body : '',
    });
    await recordPublication(tx, userId, {
      sourceType: 'note',
      sourceId: source.id,
      publishedType: 'note',
      publishedId: copy.id,
      publishedIntoSpaceId: spaceId,
    });
    return copy;
  });
  journal('v2.publication', { source_type: 'note', published_type: 'note' });
  return copy;
}

/** Creates an ordinary task from a remembered action. The memory text is NOT
 *  copied -- the caller supplies the title, because a promotion the user did
 *  not read is a leak. Someone else's memory looks missing (no oracle). */
export async function promoteMemoryToTask(args: {
  db: Db;
  userId: string;
  memoryId: string;
  spaceId: string;
  title: string;
  dueAt?: number;
}): Promise<StoredTask> {
  const { db, userId, memoryId, spaceId, title, dueAt } = args;
  const task = await withUser(db, userId, async (tx) => {
    const memory = await getMemory(tx, userId, memoryId);
    if (!memory) {
      throw new StoreNotFoundError('memory not found');
    }
    const created = await createTask(tx, userId, spaceId, {
      title,
      ...(dueAt !== undefined ? { due: { kind: 'instant', at: dueAt, zone: 'UTC' } } : {}),
    });
    await recordPublication(tx, userId, {
      sourceType: 'memory',
      sourceId: memory.id,
      publishedType: 'task',
      publishedId: created.id,
      publishedIntoSpaceId: spaceId,
    });
    return created;
  });
  journal('v2.publication', { source_type: 'memory', published_type: 'task' });
  return task;
}