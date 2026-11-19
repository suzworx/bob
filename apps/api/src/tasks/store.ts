/**
 * Task and checklist store. Every function runs under withUser() so RLS decides
 * access from ACTIVE membership in the task's space; a task in a space the
 * caller is not a member of is indistinguishable from one that does not exist
 * (same StoreNotFoundError, same message). due_date is read back via to_char as
 * 'YYYY-MM-DD' so it is a string whatever the driver does with a date column.
 *
 * A list is a task: its checklist items are CHILD tasks (parent_task_id), so
 * there is no separate items table. revision increments on every mutation and
 * updateTask/moveTaskItem are optimistic on it.
 */
import {
  StoreConflictError,
  StoreError,
  StoreNotFoundError,
  withUser,
  type Db,
} from '../platform/db/db.ts';
import { isActiveMember, requireSpaceMember } from '../spaces/store.ts';

type TaskStatus = 'open' | 'completed';

/** Either a calendar date (date-only, never a midnight instant) or an instant
 *  carrying its IANA zone. */
export type TaskDue =
  | { kind: 'date'; date: string }
  | { kind: 'instant'; at: number; zone: string };

export type StoredTask = {
  id: string;
  spaceId: string;
  parentTaskId: string | null;
  title: string;
  body: string | null;
  status: TaskStatus;
  assigneeUserId: string | null;
  dueDate: string | null;
  dueAt: number | null;
  dueZone: string | null;
  orderKey: string;
  revision: number;
  createdBy: string;
  completedAt: number | null;
  completedBy: string | null;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** A task watcher (distinct from the single accountable assignee). */
export type StoredSubscriber = {
  taskId: string;
  userId: string;
  createdAt: number;
};

type NewTask = {
  title: string;
  body?: string | null;
  parentTaskId?: string | null;
  assigneeUserId?: string | null;
  due?: TaskDue | null;
};

/** undefined = leave unchanged; null clears the field. */
type TaskUpdate = {
  title?: string;
  body?: string | null;
  assigneeUserId?: string | null;
  due?: TaskDue | null;
  status?: TaskStatus;
  /** Moves the task (and its checklist) to another space the caller belongs to. */
  spaceId?: string;
};

type ListTasksOptions = {
  status?: TaskStatus;
  assigneeUserId?: string;
  /** A calendar date ('YYYY-MM-DD'); matches a task due strictly before it. */
  dueBefore?: string;
  /** undefined = no filter; null = roots only; a string = that parent's children. */
  parentTaskId?: string | null;
  includeTrashed?: boolean;
};

/** Carries the CURRENT row so the caller can present a conflict and keep the
 *  user's draft. */
export class TaskConflictError extends StoreConflictError {
  readonly current: StoredTask;
  constructor(current: StoredTask) {
    super('task revision conflict');
    this.name = 'TaskConflictError';
    this.current = current;
  }
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'open' || value === 'completed';
}

/** Unqualified so the same list works in SELECT (FROM bob.tasks t) and in
 *  INSERT/UPDATE ... RETURNING, which has no table alias. */
const TASK_COLUMNS = `id, space_id AS "spaceId", parent_task_id AS "parentTaskId",
  title, body, status, assignee_user_id AS "assigneeUserId",
  to_char(due_date, 'YYYY-MM-DD') AS "dueDate",
  floor(extract(epoch from due_at) * 1000)::bigint AS "dueAt",
  due_zone AS "dueZone", order_key AS "orderKey", revision,
  created_by AS "createdBy",
  floor(extract(epoch from completed_at) * 1000)::bigint AS "completedAt",
  completed_by AS "completedBy",
  floor(extract(epoch from trashed_at) * 1000)::bigint AS "trashedAt",
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt"`;

type TaskRow = Record<keyof StoredTask, unknown>;

const strOrNull = (value: unknown): string | null => (value === null ? null : String(value));
const numOrNull = (value: unknown): number | null => (value === null ? null : Number(value));

function rowToTask(row: TaskRow): StoredTask {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    parentTaskId: strOrNull(row.parentTaskId),
    title: String(row.title),
    body: strOrNull(row.body),
    status: isTaskStatus(row.status) ? row.status : 'open',
    assigneeUserId: strOrNull(row.assigneeUserId),
    dueDate: strOrNull(row.dueDate),
    dueAt: numOrNull(row.dueAt),
    dueZone: strOrNull(row.dueZone),
    orderKey: String(row.orderKey),
    revision: Number(row.revision),
    createdBy: String(row.createdBy),
    completedAt: numOrNull(row.completedAt),
    completedBy: strOrNull(row.completedBy),
    trashedAt: numOrNull(row.trashedAt),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new StoreError('task title must be 1..200 characters');
  }
  return trimmed;
}

function validateBody(body: string | null | undefined): string | null {
  if (body === undefined || body === null) return null;
  if (body.trim().length > 8000) throw new StoreError('task body must be at most 8000 characters');
  return body;
}

function validateZone(zone: string): string {
  if (typeof zone !== 'string' || zone.length === 0) {
    throw new StoreError('task due zone must be a non-empty IANA zone');
  }
  return zone;
}

/** A date-only due is stored as a date (never a midnight instant); an instant
 *  stores a timestamptz and its zone. */
function dueSet(set: string[], params: unknown[], due: TaskDue | null | undefined): void {
  if (due === undefined) return;
  if (due === null) {
    set.push('due_date = NULL', 'due_at = NULL', 'due_zone = NULL');
    return;
  }
  if (due.kind === 'date') {
    set.push(`due_date = $${params.length + 1}`, 'due_at = NULL', 'due_zone = NULL');
    params.push(due.date);
    return;
  }
  set.push(
    'due_date = NULL',
    `due_at = to_timestamp($${params.length + 1} / 1000.0)`,
    `due_zone = $${params.length + 2}`,
  );
  params.push(due.at, validateZone(due.zone));
}

/** Hex timestamp + random suffix: sorts in insertion order, collides only by chance. */
function generateOrderKey(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
}

/** An assignee is checked against the space's ACTIVE members server-side, never
 *  trusted from the caller; null clears. */
async function resolveAssignee(
  tx: Db,
  spaceId: string,
  assignee: string | null | undefined,
): Promise<string | null | undefined> {
  if (assignee === undefined || assignee === null) return assignee;
  if (!(await isActiveMember(tx, spaceId, assignee))) {
    throw new StoreError('assignee must be an active member of the space');
  }
  return assignee;
}

async function readTaskRow(tx: Db, id: string, options?: { forUpdate?: boolean }): Promise<TaskRow | null> {
  const lock = options?.forUpdate ? ' FOR UPDATE OF t' : '';
  const rows = await tx.query<TaskRow>(`SELECT ${TASK_COLUMNS} FROM bob.tasks t WHERE t.id = $1${lock}`, [id]);
  return rows[0] ?? null;
}

const KEY_MIN = 0x21; // '!': the lowest key character, never the last one
const KEY_BELOW = 0x20; // below every key character (an exhausted lower bound)
const KEY_ABOVE = 0x7f; // above every key character (an open upper bound)

/**
 * A key strictly between `lower` and `upper` in byte ("C") order; null is an
 * open end. Keys are printable ASCII and a generated key never ends in '!', so
 * there is always room below one.
 */
export function keyBetween(lower: string | null, upper: string | null): string {
  if (lower !== null && upper !== null && lower >= upper) {
    throw new StoreError('keyBetween: lower must sort before upper');
  }
  let prefix = '';
  let lowTight = lower !== null;
  let highTight = upper !== null;
  for (let i = 0; ; i += 1) {
    const lo = lowTight && lower !== null && i < lower.length ? lower.charCodeAt(i) : KEY_BELOW;
    if (highTight && upper !== null && i >= upper.length) {
      throw new StoreError('keyBetween: no room below the upper key');
    }
    const hi = highTight && upper !== null ? upper.charCodeAt(i) : KEY_ABOVE;
    const floor = Math.max(lo, KEY_MIN);
    if (hi - floor >= 2) {
      return prefix + String.fromCharCode(floor + Math.floor((hi - floor) / 2));
    }
    const next = lo === KEY_BELOW ? KEY_MIN : lo;
    if (lo === KEY_BELOW) lowTight = false;
    if (next !== hi) highTight = false;
    prefix += String.fromCharCode(next);
  }
}

/** Order is the stable per-parent order_key. */
export async function listTasks(
  db: Db,
  userId: string,
  spaceId: string,
  options: ListTasksOptions = {},
): Promise<StoredTask[]> {
  return withUser(db, userId, async (tx) => {
    const where = ['t.space_id = $1'];
    const params: unknown[] = [spaceId];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (options.includeTrashed !== true) where.push('t.trashed_at IS NULL');
    if (options.status !== undefined) {
      if (!isTaskStatus(options.status)) throw new StoreError('listTasks: invalid status filter');
      where.push(`t.status = ${push(options.status)}`);
    }
    if (options.assigneeUserId !== undefined) {
      where.push(`t.assignee_user_id = ${push(options.assigneeUserId)}`);
    }
    if (options.dueBefore !== undefined) {
      // An instant due compares by its date in its own zone.
      where.push(
        `(t.due_date < ${push(options.dueBefore)} OR ` +
          `(t.due_at IS NOT NULL AND (t.due_at AT TIME ZONE t.due_zone)::date < ${push(options.dueBefore)}))`,
      );
    }
    if (options.parentTaskId === null) {
      where.push('t.parent_task_id IS NULL');
    } else if (options.parentTaskId !== undefined) {
      where.push(`t.parent_task_id = ${push(options.parentTaskId)}`);
    }
    const rows = await tx.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM bob.tasks t
       WHERE ${where.join(' AND ')}
       ORDER BY t.order_key COLLATE "C", t.id`,
      params,
    );
    return rows.map(rowToTask);
  });
}

export async function getTask(db: Db, userId: string, taskId: string): Promise<StoredTask> {
  return withUser(db, userId, async (tx) => {
    const row = await readTaskRow(tx, taskId);
    if (!row) throw new StoreNotFoundError('task not found');
    return rowToTask(row);
  });
}

/** A checklist item's parent must live in the SAME space, so a child cannot
 *  claim one space while referencing another's parent. */
export async function createTask(
  db: Db,
  userId: string,
  spaceId: string,
  input: NewTask,
): Promise<StoredTask> {
  const title = validateTitle(input.title);
  const body = validateBody(input.body);
  return withUser(db, userId, async (tx) => {
    await requireSpaceMember(tx, spaceId, userId);
    if (input.parentTaskId) {
      const parent = await tx.query<{ spaceId: unknown }>(
        `SELECT space_id AS "spaceId" FROM bob.tasks WHERE id = $1`,
        [input.parentTaskId],
      );
      if (!parent[0] || String(parent[0].spaceId) !== spaceId) {
        throw new StoreError('parent task must exist in the same space');
      }
    }
    const assignee = await resolveAssignee(tx, spaceId, input.assigneeUserId);
    const params: unknown[] = [spaceId, input.parentTaskId ?? null, title, body, assignee ?? null];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    let dueSql = 'NULL, NULL, NULL';
    if (input.due) {
      dueSql = input.due.kind === 'date'
        ? `${push(input.due.date)}, NULL, NULL`
        : `NULL, to_timestamp(${push(input.due.at)} / 1000.0), ${push(validateZone(input.due.zone))}`;
    }
    const rows = await tx.query<TaskRow>(
      `INSERT INTO bob.tasks (space_id, parent_task_id, title, body, status,
        assignee_user_id, due_date, due_at, due_zone, order_key, revision, created_by)
       VALUES ($1, $2, $3, $4, 'open', $5, ${dueSql}, ${push(generateOrderKey())}, 1, ${push(userId)})
       RETURNING ${TASK_COLUMNS}`,
      params,
    );
    if (!rows[0]) throw new StoreError('could not create task');
    return rowToTask(rows[0]);
  });
}

/**
 * Optimistic on `revision`. A `status` is applied in the same write as the other
 * fields (one revision bump) so a combined body cannot split across two writes:
 * 'completed' records who/when, 'open' clears them.
 */
export async function updateTask(
  db: Db,
  userId: string,
  taskId: string,
  update: TaskUpdate & { revision: number },
): Promise<StoredTask> {
  try {
    return await writeTask(db, userId, taskId, update);
  } catch (error) {
    // A linked row the caller may not rewrite (RLS skips another member's
    // reminder) leaves a dangling composite key: refuse, never a 500.
    if (isForeignKeyViolation(error)) throw new StoreConflictError('task is linked to something that cannot move');
    throw error;
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23503';
}

async function writeTask(
  db: Db,
  userId: string,
  taskId: string,
  update: TaskUpdate & { revision: number },
): Promise<StoredTask> {
  if (!Number.isInteger(update.revision) || update.revision < 1) {
    throw new StoreError('updateTask: revision must be a positive integer');
  }
  if (update.status !== undefined && !isTaskStatus(update.status)) {
    throw new StoreError('updateTask: invalid status');
  }
  return withUser(db, userId, async (tx) => {
    // Locked so concurrent saves at the same revision cannot both win.
    const row = await readTaskRow(tx, taskId, { forUpdate: true });
    if (!row) throw new StoreNotFoundError('task not found');
    const current = rowToTask(row);
    if (current.revision !== update.revision) throw new TaskConflictError(current);

    const set: string[] = ['revision = revision + 1', 'updated_at = now()'];
    const params: unknown[] = [taskId];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const spaceId = update.spaceId ?? current.spaceId;
    const moving = spaceId !== current.spaceId;
    if (moving && current.parentTaskId !== null) {
      throw new StoreError('a checklist item moves with its task');
    }
    // A hidden space answers like a missing one (no oracle).
    if (moving) await requireSpaceMember(tx, spaceId, userId);
    if (moving) set.push(`space_id = ${push(spaceId)}`);
    if (update.title !== undefined) set.push(`title = ${push(validateTitle(update.title))}`);
    if (update.body !== undefined) set.push(`body = ${push(validateBody(update.body))}`);
    if (update.assigneeUserId !== undefined) {
      const assignee = await resolveAssignee(tx, spaceId, update.assigneeUserId);
      set.push(`assignee_user_id = ${push(assignee)}`);
    } else if (moving && current.assigneeUserId !== null
      && !(await isActiveMember(tx, spaceId, current.assigneeUserId))) {
      // The assignee is not in the new space, so nobody there holds it yet.
      set.push('assignee_user_id = NULL');
    }
    dueSet(set, params, update.due);
    if (update.status === 'completed') {
      set.push('status = \'completed\'', `completed_by = ${push(userId)}`, 'completed_at = now()');
    } else if (update.status === 'open') {
      set.push('status = \'open\'', 'completed_by = NULL', 'completed_at = NULL');
    }
    // A move rewrites the task, its checklist items and every reminder linked
    // to any of them in ONE statement. reminders_task_fk is a composite
    // (task_id, space_id) FK with NO ACTION and no ON UPDATE CASCADE; NO ACTION
    // is checked at the end of the statement, so the parent and child rows
    // change together and the check sees both new keys. Two statements would
    // fail whichever way round they ran.
    const sql = moving
      ? `WITH moved AS (
           UPDATE bob.tasks SET ${set.join(', ')} WHERE id = $1 RETURNING ${TASK_COLUMNS}
         ), items AS (
           UPDATE bob.tasks c
           SET space_id = ${push(spaceId)}, revision = c.revision + 1, updated_at = now(),
               assignee_user_id = CASE WHEN c.assignee_user_id IS NULL OR EXISTS (
                 SELECT 1 FROM bob.space_memberships m
                 WHERE m.space_id = ${push(spaceId)} AND m.user_id = c.assignee_user_id AND m.revoked_at IS NULL)
               THEN c.assignee_user_id ELSE NULL END
           WHERE c.parent_task_id = $1
           RETURNING c.id
         ), linked AS (
           UPDATE bob.reminders r
           SET space_id = ${push(spaceId)}, updated_at = now()
           WHERE r.task_id = $1 OR r.task_id IN (SELECT id FROM items)
           RETURNING r.id
         )
         SELECT * FROM moved`
      : `UPDATE bob.tasks SET ${set.join(', ')} WHERE id = $1 RETURNING ${TASK_COLUMNS}`;
    const rows = await tx.query<TaskRow>(sql, params);
    if (!rows[0]) throw new StoreNotFoundError('task not found');
    return rowToTask(rows[0]);
  });
}

/** One unconditional UPDATE of a task that also bumps revision. */
async function setTask(db: Db, userId: string, taskId: string, setSql: string, extra: unknown[] = []): Promise<StoredTask> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<TaskRow>(
      `UPDATE bob.tasks
       SET ${setSql}, revision = revision + 1, updated_at = now()
       WHERE id = $1
       RETURNING ${TASK_COLUMNS}`,
      [taskId, ...extra],
    );
    if (!rows[0]) throw new StoreNotFoundError('task not found');
    return rowToTask(rows[0]);
  });
}

export function completeTask(db: Db, userId: string, taskId: string): Promise<StoredTask> {
  return setTask(db, userId, taskId, `status = 'completed', completed_by = $2, completed_at = now()`, [userId]);
}

export function reopenTask(db: Db, userId: string, taskId: string): Promise<StoredTask> {
  return setTask(db, userId, taskId, `status = 'open', completed_by = NULL, completed_at = NULL`);
}

/** Delete is trash, not purge. */
export function trashTask(db: Db, userId: string, taskId: string): Promise<StoredTask> {
  return setTask(db, userId, taskId, 'trashed_at = now()');
}

export function restoreTask(db: Db, userId: string, taskId: string): Promise<StoredTask> {
  return setTask(db, userId, taskId, 'trashed_at = NULL');
}

type TaskItemMove =
  | { afterItemId: string; revision: number }
  | { beforeItemId: string; revision: number };

/**
 * Moves a checklist item directly after or before a sibling. The parent row is
 * locked first, so moves in one checklist are serialized and each reads its
 * neighbours' current keys: concurrent moves converge on one order with unique
 * keys. Trashed siblings still count as neighbours, so a restored item never
 * shares a key with one written while it was in the trash.
 */
export async function moveTaskItem(
  db: Db,
  userId: string,
  itemId: string,
  move: TaskItemMove,
): Promise<StoredTask> {
  if (!Number.isInteger(move.revision) || move.revision < 1) {
    throw new StoreError('moveTaskItem: revision must be a positive integer');
  }
  const anchorId = 'afterItemId' in move ? move.afterItemId : move.beforeItemId;
  if (anchorId === itemId) throw new StoreError('an item cannot move relative to itself');
  return withUser(db, userId, async (tx) => {
    const unlocked = await readTaskRow(tx, itemId);
    if (!unlocked) throw new StoreNotFoundError('task not found');
    const parentId = strOrNull(unlocked.parentTaskId);
    if (parentId === null) throw new StoreError('only checklist items can be reordered');
    // Lock order is parent then item, the same for every move.
    if (!(await readTaskRow(tx, parentId, { forUpdate: true }))) {
      throw new StoreNotFoundError('task not found');
    }
    const row = await readTaskRow(tx, itemId, { forUpdate: true });
    if (!row) throw new StoreNotFoundError('task not found');
    const current = rowToTask(row);
    if (current.revision !== move.revision) throw new TaskConflictError(current);

    const siblings = await tx.query<{ id: unknown; orderKey: unknown; trashedAt: unknown }>(
      `SELECT t.id, t.order_key AS "orderKey", t.trashed_at AS "trashedAt" FROM bob.tasks t
       WHERE t.parent_task_id = $1 AND t.id <> $2
       ORDER BY t.order_key COLLATE "C", t.id`,
      [parentId, itemId],
    );
    const index = siblings.findIndex((s) => String(s.id) === anchorId);
    const anchor = siblings[index];
    if (!anchor || anchor.trashedAt !== null) {
      throw new StoreError('the anchor item is not in this checklist');
    }
    const keyAt = (at: number): string | null => {
      const sibling = siblings[at];
      return sibling ? String(sibling.orderKey) : null;
    };
    const orderKey =
      'afterItemId' in move ? keyBetween(keyAt(index), keyAt(index + 1)) : keyBetween(keyAt(index - 1), keyAt(index));

    const rows = await tx.query<TaskRow>(
      `UPDATE bob.tasks SET order_key = $2, revision = revision + 1, updated_at = now()
       WHERE id = $1 RETURNING ${TASK_COLUMNS}`,
      [itemId, orderKey],
    );
    if (!rows[0]) throw new StoreNotFoundError('task not found');
    return rowToTask(rows[0]);
  });
}

const SUBSCRIBER_COLUMNS = `task_id AS "taskId", user_id AS "userId",
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt"`;

type SubscriberRow = Record<keyof StoredSubscriber, unknown>;

function rowToSubscriber(row: SubscriberRow): StoredSubscriber {
  return { taskId: String(row.taskId), userId: String(row.userId), createdAt: Number(row.createdAt) };
}

/** A watcher who has since left the space is omitted, so they are neither
 *  shown nor notified. */
export async function listSubscribers(
  db: Db,
  userId: string,
  taskId: string,
): Promise<StoredSubscriber[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<SubscriberRow>(
      `SELECT s.task_id AS "taskId", s.user_id AS "userId",
              floor(extract(epoch from s.created_at) * 1000)::bigint AS "createdAt"
       FROM bob.task_subscribers s
       JOIN bob.tasks t ON t.id = s.task_id
       JOIN bob.space_memberships m
         ON m.space_id = t.space_id AND m.user_id = s.user_id AND m.revoked_at IS NULL
       WHERE s.task_id = $1
       ORDER BY s.created_at ASC`,
      [taskId],
    );
    return rows.map(rowToSubscriber);
  });
}

/** Idempotent on the (task_id, user_id) unique pair. */
export async function addSubscriber(
  db: Db,
  userId: string,
  taskId: string,
  subscriberUserId: string,
): Promise<StoredSubscriber> {
  return withUser(db, userId, async (tx) => {
    const task = await readTaskRow(tx, taskId);
    if (!task) throw new StoreNotFoundError('task not found');
    if (!(await isActiveMember(tx, String(task.spaceId), subscriberUserId))) {
      throw new StoreError('subscriber must be an active member of the space');
    }
    const inserted = await tx.query<SubscriberRow>(
      `INSERT INTO bob.task_subscribers (task_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (task_id, user_id) DO NOTHING
       RETURNING ${SUBSCRIBER_COLUMNS}`,
      [taskId, subscriberUserId],
    );
    const row = inserted[0] ?? (await tx.query<SubscriberRow>(
      `SELECT ${SUBSCRIBER_COLUMNS} FROM bob.task_subscribers WHERE task_id = $1 AND user_id = $2`,
      [taskId, subscriberUserId],
    ))[0];
    if (!row) throw new StoreError('could not add subscriber');
    return rowToSubscriber(row);
  });
}

/** Idempotent: an unknown pair answers quietly. */
export async function removeSubscriber(
  db: Db,
  userId: string,
  taskId: string,
  subscriberUserId: string,
): Promise<void> {
  return withUser(db, userId, async (tx) => {
    if (!(await readTaskRow(tx, taskId))) throw new StoreNotFoundError('task not found');
    await tx.query(
      `DELETE FROM bob.task_subscribers WHERE task_id = $1 AND user_id = $2`,
      [taskId, subscriberUserId],
    );
  });
}
