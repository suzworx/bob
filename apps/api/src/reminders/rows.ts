/**
 * store: rows (split out of store.ts for the file-size limit, epic #611; behaviour unchanged).
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
  type Db,
} from '../platform/db/db.ts';
import { ruleError, type ReminderRule } from '../calendar/recurrence.ts';
import type { TaskDue } from '../tasks/store.ts';
import { OccurrenceKey, REMINDER_STATUSES, ReminderStatus, StoredReminder } from './types.ts';

function isReminderStatus(value: unknown): value is ReminderStatus {
  return typeof value === 'string' && (REMINDER_STATUSES as readonly string[]).includes(value);
}

function toReminderStatus(value: unknown): ReminderStatus {
  if (!isReminderStatus(value)) throw new StoreError('reminder status is invalid');
  return value;
}

/** The reminder columns with timestamptz -> epoch-ms read-back. Column names
 *  are unqualified so the same list works in SELECT (FROM bob.reminders r)
 *  and in INSERT/UPDATE ... RETURNING. due_date rides to_char so both drivers
 *  hand back a 'YYYY-MM-DD' string; rrule is read back in normalizeRrule. */
export const REMINDER_COLUMNS = `id, space_id AS "spaceId", title,
  task_id AS "taskId", note_id AS "noteId", event_id AS "eventId",
  to_char(due_date, 'YYYY-MM-DD') AS "dueDate",
  floor(extract(epoch from due_at) * 1000)::bigint AS "dueAt",
  due_zone AS "dueZone", rrule, schedule_revision AS "scheduleRevision", status,
  created_by AS "createdBy",
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt"`;

/** A raw bob.reminders row (aliases follow REMINDER_COLUMNS). */
export type ReminderRow = {
  id: unknown;
  spaceId: unknown;
  title: unknown;
  taskId: unknown;
  noteId: unknown;
  eventId: unknown;
  dueDate: unknown;
  dueAt: unknown;
  dueZone: unknown;
  rrule: unknown;
  scheduleRevision: unknown;
  status: unknown;
  createdBy: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

/** The SQL for an rrule parameter bound as serialized JSON text. A bare
 *  `$n::jsonb` types the parameter jsonb, and postgres.js then JSON-encodes the
 *  already-serialized string again, storing a jsonb STRING scalar; binding it
 *  as text and casting stores an object. */
export function rrulePlaceholder(param: string): string {
  return `${param}::text::jsonb`;
}

/** jsonb normally arrives as an object. The string branch reads rows written
 *  double-encoded before 20260926100000_reminders_rrule_object; that migration
 *  converts them and CHECKs objects, so drop the branch after one release. */
export function normalizeRrule(value: unknown): ReminderRule | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value) as ReminderRule;
  return value as ReminderRule;
}

/** Raw row -> StoredReminder. Exported so tests exercise the mapping. */
export function rowToReminder(row: ReminderRow): StoredReminder {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    title: String(row.title),
    taskId: row.taskId === null ? null : String(row.taskId),
    noteId: row.noteId === null ? null : String(row.noteId),
    eventId: row.eventId === null ? null : String(row.eventId),
    dueDate: row.dueDate === null ? null : String(row.dueDate),
    dueAt: row.dueAt === null ? null : Number(row.dueAt),
    dueZone: row.dueZone === null ? null : String(row.dueZone),
    rrule: normalizeRrule(row.rrule),
    scheduleRevision: Number(row.scheduleRevision),
    status: toReminderStatus(row.status),
    createdBy: String(row.createdBy),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

/** Validates a title: 1..200 chars after trim (data-model.md "reminders"). */
export function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new StoreError('reminder title must be 1..200 characters');
  }
  return trimmed;
}

/** How far back dueOccurrences looks for a missed hourly ring (see there). */
export const HOURLY_LOOKBACK_MS = 2 * 86_400_000;

/** Refuses a rule the engine cannot honour (e.g. hourly every 13 hours). */
export function validateRrule(rrule: ReminderRule | null): ReminderRule | null {
  const problem = rrule === null ? null : ruleError(rrule);
  if (problem !== null) throw new StoreError(problem);
  return rrule;
}

function validateZone(zone: string): string {
  if (typeof zone !== 'string' || zone.length === 0) {
    throw new StoreError('reminder due zone must be a non-empty IANA zone');
  }
  return zone;
}

/** A reminder always resolves to an instant: a date-only due is refused. */
export function dueInstant(due: TaskDue | null | undefined): { at: number; zone: string } {
  if (due === undefined || due === null) {
    throw new StoreError('a reminder must have a due instant');
  }
  if (due.kind === 'date') {
    throw new StoreError('a reminder must resolve to an instant; provide a time and zone');
  }
  return { at: due.at, zone: validateZone(due.zone) };
}

/** True when `candidate` is an ACTIVE member of `spaceId` (revoked_at null),
 *  the same server-side truth check the tasks store uses. */
export async function isActiveMember(tx: Db, spaceId: string, candidate: string): Promise<boolean> {
  const rows = await tx.query<{ ok: unknown }>(
    `SELECT 1 AS ok FROM bob.space_memberships m
     WHERE m.space_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL`,
    [spaceId, candidate],
  );
  return rows.length > 0;
}

/** Reads one reminder row by id under RLS, or null. */
export async function readReminderRow(tx: Db, id: string): Promise<ReminderRow | null> {
  const rows = await tx.query<ReminderRow>(
    `SELECT ${REMINDER_COLUMNS} FROM bob.reminders r WHERE r.id = $1 AND r.kind = 'reminder'`,
    [id],
  );
  return rows.length === 0 ? null : rows[0]!;
}

/** The wall clock 'YYYY-MM-DDTHH:mm' an instant occupies in a zone, used as the
 *  expansion origin for a recurring rule (recurrence.ts expects a wall time). */
export function wallStringAt(at: number, zone: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    calendar: 'gregory',
  });
  const g: Record<string, string | undefined> = {};
  for (const p of fmt.formatToParts(at)) if (p.type !== 'literal') g[p.type] = p.value;
  const pad = (n: string): string => n.padStart(2, '0');
  return `${g.year}-${pad(g.month!)}-${pad(g.day!)}T${pad(g.hour!)}:${pad(g.minute!)}`;
}

/** An in-memory set key for an occurrence triple. */
export function keyString(k: {
  reminderId: unknown;
  userId: unknown;
  occurrenceAt: unknown;
  scheduleRevision: unknown;
}): string {
  return `${String(k.reminderId)}|${String(k.userId)}|${String(k.occurrenceAt)}|${String(k.scheduleRevision)}`;
}

/** The pure seam to the inbox and outbox units: the idempotency key one
 *  recipient can never receive the same effect twice. Stable across the four
 *  inputs, distinct when any of them changes. Kept pure so it is tested
 *  directly (test 7). */
export function occurrenceEffectKey(k: OccurrenceKey): string {
  return `reminder:${k.reminderId}:${k.userId}:${k.occurrenceAt}:${k.scheduleRevision}`;
}
