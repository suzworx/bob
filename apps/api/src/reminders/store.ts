/**
 * Reminder store (S14-REMINDERS-STORE, specs/014-family-collaboration/
 * data-model.md "reminders, reminder_recipients, reminder_occurrences";
 * contracts/api.md "Tasks, checklists and reminders"). Issue #125: "a saved
 * intention turns into follow-through." This unit is the storage and the
 * occurrence contract only -- the fanout worker, the API routes and the UI are
 * later units.
 *
 * Every account-facing read/mutation runs under withUser(), so RLS decides
 * access from ACTIVE membership in the reminder's space; a reminder in a space
 * the caller is not a member of is indistinguishable from one that does not
 * exist (same StoreNotFoundError, no separate code). Occurrence rows are
 * additionally scoped to their OWN user by RLS, so one person's snooze is
 * never another's business.
 *
 * The fanout-facing functions (dueOccurrences, recordOccurrence) run through
 * the bob_private.* definers (asServer), the established server-only pattern
 * from outbox/notifications: they must see active reminders across EVERY space
 * and write into a FORCE-RLS table no account role may insert into. The three
 * acceptance criteria are one idea -- the uniqueness key is
 * **recipient + occurrence + schedule revision** -- and the store honours it:
 * dueOccurrences returns only (recipient, occurrence, revision) triples that
 * have no row yet, recordOccurrence is an ON CONFLICT DO NOTHING replay
 * no-op, and updateReminder bumps schedule_revision exactly when timing or
 * rrule changes, un-matching every row queued under an older revision.
 */
import {
  StoreError,
  StoreNotFoundError,
  withUser,
  type Db,
} from '../platform/db/db.ts';
import { REMINDER_COLUMNS, ReminderRow, dueInstant, isActiveMember, readReminderRow, rowToReminder, rrulePlaceholder, validateRrule, validateTitle } from './rows.ts';
import { originConversationId } from './origin-conversation.ts';
import { NewReminder, ReminderRecipientError, ReminderUpdate, StoredReminder } from './types.ts';
export { ReminderRecipientError } from './types.ts';
export type { DueOccurrence, OccurrenceKey, ReminderUpdate, StoredReminder } from './types.ts';
export { occurrenceEffectKey } from './rows.ts';
export { acknowledgeOccurrence, clearEndedSnooze, dueOccurrences, recordOccurrence, releaseOccurrence, snoozeOccurrence } from './occurrences.ts';




/**
 * Creates a reminder in a space. Standalone, or targeting exactly one resource
 * (task/note/event) in the SAME space -- a target is validated to share the
 * space (the FK alone cannot). due must be an instant (a reminder is never
 * date-only); rrule null = one-shot, a non-null rrule = recurring. revision
 * starts at 1. With `recipients`, the caller must be an active member and so
 * must every recipient (else ReminderRecipientError); the reminder and its
 * recipient rows commit together or not at all. Without it, setRecipients
 * sets the recipients later.
 */
export async function createReminder(
  db: Db,
  userId: string,
  spaceId: string,
  input: NewReminder,
): Promise<StoredReminder> {
  const title = validateTitle(input.title);
  const targetCount = [input.taskId, input.noteId, input.eventId].filter(
    (v) => v !== undefined && v !== null,
  ).length;
  if (targetCount > 1) throw new StoreError('a reminder may target at most one resource');
  const due = dueInstant(input.due);
  const rrule = validateRrule(input.rrule ?? null);
  const recipients = input.recipients === undefined ? null : uniqueIds(input.recipients);
  return withUser(db, userId, async (tx) => {
    if (recipients !== null) {
      // A space the caller is not in answers like a missing one (no oracle).
      if (!(await isActiveMember(tx, spaceId, userId))) throw new StoreNotFoundError('space not found');
      await assertRecipients(tx, spaceId, recipients);
    }
    if (input.taskId) {
      const task = await tx.query<{ spaceId: unknown }>(
        `SELECT space_id AS "spaceId" FROM bob.tasks WHERE id = $1`,
        [input.taskId],
      );
      if (task.length === 0) {
        throw new StoreError('reminder task must exist in the same space');
      }
      const taskRow = task[0];
      if (!taskRow || String(taskRow.spaceId) !== spaceId) {
        throw new StoreError('reminder task must exist in the same space');
      }
    }
    if (input.noteId) {
      const note = await tx.query<{ spaceId: unknown }>(
        `SELECT space_id AS "spaceId" FROM bob.notes WHERE id = $1`,
        [input.noteId],
      );
      if (note.length === 0) {
        throw new StoreError('reminder note must exist in the same space');
      }
      const noteRow = note[0];
      if (!noteRow || String(noteRow.spaceId) !== spaceId) {
        throw new StoreError('reminder note must exist in the same space');
      }
    }
    if (input.eventId) {
      const event = await tx.query<{ spaceId: unknown }>(
        `SELECT space_id AS "spaceId" FROM bob.calendar_events WHERE id = $1`,
        [input.eventId],
      );
      if (event.length === 0) {
        throw new StoreError('reminder event must exist in the same space');
      }
      const eventRow = event[0];
      if (!eventRow || String(eventRow.spaceId) !== spaceId) {
        throw new StoreError('reminder event must exist in the same space');
      }
    }
    const rows = await tx.query<ReminderRow>(
      `INSERT INTO bob.reminders (space_id, title, task_id, note_id, event_id,
        due_date, due_at, due_zone, rrule, schedule_revision, status, created_by, origin_conversation_id)
       VALUES ($1, $2, $3, $4, $5, NULL,
         to_timestamp($6 / 1000.0), $7, ${rrulePlaceholder('$8')}, 1, 'active', $9, $10)
       RETURNING ${REMINDER_COLUMNS}`,
      [
        spaceId,
        title,
        input.taskId ?? null,
        input.noteId ?? null,
        input.eventId ?? null,
        due.at,
        due.zone,
        rrule === null ? null : JSON.stringify(rrule),
        userId,
        originConversationId(),
      ],
    );
    if (rows.length === 0) throw new StoreError('could not create reminder');
    const reminderRow = rows[0];
    if (!reminderRow) throw new StoreError('could not create reminder');
    const created = rowToReminder(reminderRow);
    if (recipients !== null) await insertRecipients(tx, created.id, recipients);
    return created;
  });
}

/** Reads one reminder. A caller who is not an active member of the reminder's
 *  space gets StoreNotFoundError exactly as if the id did not exist. */
export async function getReminder(
  db: Db,
  userId: string,
  reminderId: string,
): Promise<StoredReminder> {
  return withUser(db, userId, async (tx) => {
    const row = await readReminderRow(tx, reminderId);
    if (!row) throw new StoreNotFoundError('reminder not found');
    return rowToReminder(row);
  });
}

/** Lists reminders in a space (order is creation order). */
export async function listReminders(
  db: Db,
  userId: string,
  spaceId: string,
): Promise<StoredReminder[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<ReminderRow>(
      `SELECT ${REMINDER_COLUMNS} FROM bob.reminders r
       WHERE r.space_id = $1 AND r.kind = 'reminder' ORDER BY r.created_at ASC`,
      [spaceId],
    );
    return rows.map(rowToReminder);
  });
}

/**
 * Updates a reminder. schedule_revision bumps when (and only when) the timing
 * (due) or the rrule changes -- the contract/api.md "PATCH bumps
 * schedule_revision, invalidating queued occurrences". A same-value write
 * leaves the revision alone, so it never un-matches live occurrences. due is
 * always an instant.
 */
export async function updateReminder(
  db: Db,
  userId: string,
  reminderId: string,
  update: ReminderUpdate,
): Promise<StoredReminder> {
  return withUser(db, userId, async (tx) => {
    const row = await readReminderRow(tx, reminderId);
    if (!row) throw new StoreNotFoundError('reminder not found');
    const current = rowToReminder(row);

    const set: string[] = ['updated_at = now()'];
    const params: unknown[] = [reminderId];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    let timingChanged = false;
    if (update.title !== undefined) {
      set.push(`title = ${push(validateTitle(update.title))}`);
    }
    if (update.due !== undefined) {
      const due = dueInstant(update.due);
      if (current.dueAt !== due.at || current.dueZone !== due.zone || current.dueDate !== null) {
        timingChanged = true;
      }
      set.push('due_date = NULL', `due_at = to_timestamp(${push(due.at)} / 1000.0)`, `due_zone = ${push(due.zone)}`);
    }
    if (update.rrule !== undefined) {
      const rrule = validateRrule(update.rrule ?? null);
      if (JSON.stringify(current.rrule) !== JSON.stringify(rrule)) {
        timingChanged = true;
      }
      set.push(`rrule = ${rrulePlaceholder(push(rrule === null ? null : JSON.stringify(rrule)))}`);
    }
    if (timingChanged) set.push('schedule_revision = schedule_revision + 1');

    const rows = await tx.query<ReminderRow>(
      `UPDATE bob.reminders SET ${set.join(', ')} WHERE id = $1 AND kind = 'reminder' RETURNING ${REMINDER_COLUMNS}`,
      params,
    );
    if (rows.length === 0) throw new StoreNotFoundError('reminder not found');
    const reminderRow = rows[0];
    if (!reminderRow) throw new StoreNotFoundError('reminder not found');
    return rowToReminder(reminderRow);
  });
}

/** Cancels a reminder (status 'cancelled'). The fanout source query skips
 *  non-active reminders, so a delayed delivery resumes to nothing (criterion
 *  2). */
export async function cancelReminder(
  db: Db,
  userId: string,
  reminderId: string,
): Promise<StoredReminder> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<ReminderRow>(
      `UPDATE bob.reminders
       SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND kind = 'reminder'
       RETURNING ${REMINDER_COLUMNS}`,
      [reminderId],
    );
    if (rows.length === 0) throw new StoreNotFoundError('reminder not found');
    const reminderRow = rows[0];
    if (!reminderRow) throw new StoreNotFoundError('reminder not found');
    return rowToReminder(reminderRow);
  });
}

/**
 * Replaces the recipient set. Each recipient must be an ACTIVE member of the
 * reminder's space (validated server-side, never trusted from the caller).
 * The set is STORED, never re-derived from a token claim, and a full replace
 * keeps it consistent: DELETE then INSERT in one transaction.
 */
export async function setRecipients(
  db: Db,
  userId: string,
  reminderId: string,
  userIds: string[],
): Promise<void> {
  const ids = uniqueIds(userIds);
  return withUser(db, userId, async (tx) => {
    const row = await readReminderRow(tx, reminderId);
    if (!row) throw new StoreNotFoundError('reminder not found');
    await assertRecipients(tx, String(row.spaceId), ids);
    await tx.query(`DELETE FROM bob.reminder_recipients WHERE reminder_id = $1`, [reminderId]);
    await insertRecipients(tx, reminderId, ids);
  });
}

/** Trimmed, de-duplicated recipient ids in first-seen order. */
function uniqueIds(userIds: string[]): string[] {
  return [...new Set(userIds.map((id) => id.trim()))];
}

/** Refuses the set unless every recipient is an ACTIVE member of the space. */
async function assertRecipients(tx: Db, spaceId: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    if (!(await isActiveMember(tx, spaceId, id))) {
      throw new ReminderRecipientError('recipient must be an active member of the space');
    }
  }
}

/** Inserts the (already validated) recipient rows. */
async function insertRecipients(tx: Db, reminderId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const params: unknown[] = [reminderId];
  const values = ids
    .map((id) => {
      params.push(id);
      return `($1, $${params.length})`;
    })
    .join(', ');
  await tx.query(
    `INSERT INTO bob.reminder_recipients (reminder_id, user_id) VALUES ${values}`,
    params,
  );
}
