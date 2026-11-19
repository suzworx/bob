/**
 * store: types (split out of store.ts for the file-size limit, epic #611; behaviour unchanged).
 */
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
} from '../platform/db/db.ts';
import { type ReminderRule } from '../calendar/recurrence.ts';
import type { TaskDue } from '../tasks/store.ts';

/** A reminder's lifecycle state (data-model.md "reminders"). */
export type ReminderStatus = 'active' | 'paused' | 'cancelled';

/** A durable reminder row as the rest of the app sees it (epoch-ms stamps;
 *  rrule is the serialized ReminderRule, null = one-shot). */
export type StoredReminder = {
  id: string;
  spaceId: string;
  title: string;
  taskId: string | null;
  noteId: string | null;
  eventId: string | null;
  dueDate: string | null;
  dueAt: number | null;
  dueZone: string | null;
  rrule: ReminderRule | null;
  scheduleRevision: number;
  status: ReminderStatus;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

/** A new reminder. due must resolve to an instant (a reminder is never
 *  date-only; a one-shot requires an anchor, a recurring rule one to expand
 *  from). At most one of taskId/noteId/eventId may be set. */
export type NewReminder = {
  title: string;
  taskId?: string | null;
  noteId?: string | null;
  eventId?: string | null;
  due?: TaskDue | null;
  rrule?: ReminderRule | null;
  /** When set, the recipient set is written in the SAME transaction as the
   *  reminder; every id must be an active member of the space. */
  recipients?: string[];
};

/** A recipient who is not an active member of the reminder's space. Nothing
 *  is written when this is thrown (the transaction rolls back). */
export class ReminderRecipientError extends StoreError {}

/** updateReminder's body. undefined = unchanged. due and rrule are replaced in
 *  full; a change to either bumps schedule_revision (and only then). */
export type ReminderUpdate = {
  title?: string;
  due?: TaskDue | null;
  rrule?: ReminderRule | null;
};

/** The (recipient, occurrence, schedule revision) key that makes a retry safe
 *  and a revision-invalidated queue un-matchable (criteria 1-3). */
export type OccurrenceKey = {
  reminderId: string;
  userId: string;
  occurrenceAt: number;
  scheduleRevision: number;
};

/** A due occurrence the fanout worker should materialize. `catchUp` is true
 *  only when an outage backlog was collapsed to this single most-recent missed
 *  instant (spec.md:92 "at most one catch-up item per recipient"); a normally
 *  scheduled single occurrence carries false. */
export type DueOccurrence = OccurrenceKey & {
  catchUp: boolean;
  /** Set only on a snoozed re-delivery: the recorded row's id and the instant
   *  its snooze ended (#507). */
  occurrenceId?: string;
  snoozedUntil?: number;
  /** The conversation the recipient created the reminder in (telemetry only); absent otherwise. */
  conversationId?: string;
};

export const REMINDER_STATUSES: readonly ReminderStatus[] = ['active', 'paused', 'cancelled'];
