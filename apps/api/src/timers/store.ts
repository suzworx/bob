/**
 * Timers and alarms (issue #320, server half). One row per timer or alarm in
 * bob.reminders (kind 'timer' or 'alarm', #757); the server is the source of truth. Account calls run under
 * withUser (own rows only, RLS forced). The scheduler reads due rows across
 * accounts through the bob_private definers (the dueOccurrences pattern, pass
 * the RAW Db from getDb()), then marks each fired as its owner: markTimerFired
 * is a conditional pending -> fired update, so two racing schedulers fire a
 * timer once.
 *
 * Alarms take an account time zone as a parameter: "07:00" means the next
 * 07:00 on the wall clock of that zone, across a DST change.
 */
import { asServer, StoreError, withUser, type Db } from '../platform/db/db.ts';
import { originConversationId } from '../reminders/origin-conversation.ts';
import { ensurePrivateSpace } from '../spaces/store.ts';

type TimerKind = 'timer' | 'alarm';
type TimerStatus = 'pending' | 'fired' | 'dismissed' | 'cancelled';

export type Timer = {
  id: string;
  userId: string;
  kind: TimerKind;
  label: string | null;
  firesAt: number;
  durationMs: number | null;
  status: TimerStatus;
  createdAt: number;
  firedAt: number | null;
};

type PendingTimer = Timer & { remainingMs: number };

/** A due timer and the conversation it was set in (telemetry only; absent when set outside one). */
type DueTimer = Timer & { conversationId?: string };

/** Which pending timers to cancel: one id, a spoken label, or all of them. An
 *  empty target (or a label that is only "the timer") cancels the single
 *  pending timer when exactly one is running, and nothing otherwise. */
type TimerCancelTarget = { id?: string; label?: string; all?: boolean };

const TIMER_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const LABEL_MAX_CHARS = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A timer or alarm is an bob.reminders row whose kind is not 'reminder';
 *  every statement below carries this predicate. */
const TIMER_ROW = `kind <> 'reminder'`;

const COLUMNS = `id, created_by AS "userId", kind, title AS label,
  floor(extract(epoch from due_at) * 1000)::bigint AS "firesAt",
  duration_ms AS "durationMs", status,
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from fired_at) * 1000)::bigint AS "firedAt"`;

type TimerRow = Record<keyof Timer, unknown>;

function toTimer(row: TimerRow): Timer {
  return {
    id: String(row.id),
    userId: String(row.userId),
    kind: row.kind === 'alarm' ? 'alarm' : 'timer',
    label: row.label === null ? null : String(row.label),
    firesAt: Number(row.firesAt),
    durationMs: row.durationMs === null ? null : Number(row.durationMs),
    status: String(row.status) as TimerStatus,
    createdAt: Number(row.createdAt),
    firedAt: row.firedAt === null ? null : Number(row.firedAt),
  };
}

/** "the pasta timer" -> "pasta"; empty or kind-only -> null. */
export function normalizeTimerLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const cleaned = label
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(the|my|a|an)(\s+|$)/i, '')
    .replace(/\s*\b(timer|alarm)s?$/i, '')
    .trim()
    .slice(0, LABEL_MAX_CHARS)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Throws StoreError for a zone Intl does not know. */
export function validateTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new StoreError('unknown time zone');
  }
  return timeZone;
}

/** The zone's UTC offset in ms at instant `at`. */
function zoneOffset(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant a wall-clock time in `timeZone` names (a DST gap shifts forward). */
function wallToInstant(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - zoneOffset(timeZone, guess);
  const second = guess - zoneOffset(timeZone, first);
  return second === first ? first : Math.max(first, second);
}

/** The zone's calendar date at instant `at`. */
function dateInZone(timeZone: string, at: number): { y: number; mo: number; d: number } {
  const shifted = new Date(at + zoneOffset(timeZone, at));
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

const CLOCK_RE = /^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?$/i;
const LOCAL_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const OFFSET_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * The instant an alarm time names. "07:00", "7", "7am", "7:30 pm": the next
 * such wall time in `timeZone` after `now` (today, else tomorrow). A local ISO
 * ("2026-09-24T07:00") is a wall time in `timeZone`; an ISO with Z or an
 * offset is absolute. A past instant throws StoreError.
 */
export function resolveAlarmTime(time: string, timeZone: string, now: number): number {
  validateTimeZone(timeZone);
  const text = time.trim();
  let at: number;
  const clock = CLOCK_RE.exec(text);
  const local = LOCAL_ISO_RE.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] === undefined ? 0 : Number(clock[2]);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem !== undefined) {
      if (hour < 1 || hour > 12) throw new StoreError('invalid alarm time');
      hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
    }
    if (hour > 23 || minute > 59) throw new StoreError('invalid alarm time');
    const today = dateInZone(timeZone, now);
    at = wallToInstant(timeZone, today.y, today.mo, today.d, hour, minute);
    if (at <= now) {
      const next = new Date(Date.UTC(today.y, today.mo - 1, today.d + 1));
      at = wallToInstant(timeZone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour, minute);
    }
  } else if (local) {
    const [, y, mo, d, h, mi] = local.map(Number) as [number, number, number, number, number, number];
    at = wallToInstant(timeZone, y, mo, d, h, mi);
  } else if (OFFSET_ISO_RE.test(text)) {
    at = Date.parse(text);
  } else {
    throw new StoreError('invalid alarm time');
  }
  if (!Number.isFinite(at)) throw new StoreError('invalid alarm time');
  if (at <= now) throw new StoreError('that time has already passed');
  return at;
}

async function insertTimer(
  db: Db, userId: string, kind: TimerKind, label: string | null, firesAt: number, durationMs: number | null,
): Promise<Timer> {
  const space = await ensurePrivateSpace(db, userId);
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<TimerRow>(
      `INSERT INTO bob.reminders (space_id, created_by, kind, title, due_at, due_zone, duration_ms, status, origin_conversation_id)
       VALUES ($6, $1, $2, $3, to_timestamp($4 / 1000.0), 'UTC', $5, 'pending', $7)
       RETURNING ${COLUMNS}`,
      [userId, kind, label, firesAt, durationMs, space.id, originConversationId()],
    );
    if (!rows[0]) throw new StoreError('timer insert returned no row');
    return toTimer(rows[0]);
  });
}

/** A timer that fires `durationMs` after `now` (1 s .. 24 h). */
export async function createTimer(
  db: Db, userId: string, input: { durationMs: number; label?: string | null; now?: number },
): Promise<Timer> {
  const durationMs = Math.round(input.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > TIMER_MAX_DURATION_MS) {
    throw new StoreError('timer duration must be between 1 second and 24 hours');
  }
  const now = input.now ?? Date.now();
  return insertTimer(db, userId, 'timer', normalizeTimerLabel(input.label), now + durationMs, durationMs);
}

/** An alarm at `time` in the account zone `timeZone` (see resolveAlarmTime). */
export async function createAlarm(
  db: Db, userId: string, input: { time: string; timeZone: string; label?: string | null; now?: number },
): Promise<Timer> {
  const firesAt = resolveAlarmTime(input.time, input.timeZone, input.now ?? Date.now());
  return insertTimer(db, userId, 'alarm', normalizeTimerLabel(input.label), firesAt, null);
}

/** The account's pending timers and alarms, soonest first, with time left. */
export async function listPendingTimers(db: Db, userId: string, now: number = Date.now()): Promise<PendingTimer[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<TimerRow>(
      `SELECT ${COLUMNS} FROM bob.reminders
       WHERE created_by = $1 AND ${TIMER_ROW} AND status = 'pending'
       ORDER BY due_at, id`,
      [userId],
    );
    return rows.map(toTimer).map((t) => ({ ...t, remainingMs: Math.max(0, t.firesAt - now) }));
  });
}

/** One statement snapshot: the60 earliest active timers plus terminal states
 * for this phone's bounded tracked requests. Missing/foreign ids are omitted. */
export async function timerNotificationState(db: Db, userId: string, trackedIds: string[]): Promise<Timer[]> {
  if (trackedIds.length > 60 || trackedIds.some((id) => !UUID_RE.test(id))) {
    throw new StoreError('invalid tracked timer ids');
  }
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<TimerRow>(
      `SELECT ${COLUMNS} FROM bob.reminders
       WHERE created_by = $1 AND ${TIMER_ROW} AND
         (id = ANY($2::uuid[]) OR id IN (
           SELECT id FROM bob.reminders WHERE created_by = $1 AND ${TIMER_ROW} AND status = 'pending'
           ORDER BY due_at, id LIMIT 60
         ))
       ORDER BY due_at, id`,
      [userId, trackedIds],
    );
    return rows.map(toTimer);
  });
}

/** Cancels pending timers per `target`; returns them and how many stay pending. */
export async function cancelTimers(
  db: Db, userId: string, target: TimerCancelTarget,
): Promise<{ cancelled: Timer[]; remaining: number }> {
  return withUser(db, userId, async (tx) => {
    const cancelWhere = async (where: string, params: unknown[]): Promise<Timer[]> => {
      const rows = await tx.query<TimerRow>(
        `UPDATE bob.reminders SET status = 'cancelled'
         WHERE created_by = $1 AND ${TIMER_ROW} AND status = 'pending' AND ${where}
         RETURNING ${COLUMNS}`,
        [userId, ...params],
      );
      return rows.map(toTimer).sort((a, b) => a.firesAt - b.firesAt);
    };
    let cancelled: Timer[] = [];
    const label = normalizeTimerLabel(target.label);
    if (target.all === true) {
      cancelled = await cancelWhere('true', []);
    } else if (target.id !== undefined) {
      if (UUID_RE.test(target.id)) cancelled = await cancelWhere('id = $2', [target.id]);
    } else if (label !== null) {
      cancelled = await cancelWhere('lower(title) = lower($2)', [label]);
    } else {
      const pending = await tx.query<{ id: unknown }>(
        `SELECT id FROM bob.reminders WHERE created_by = $1 AND ${TIMER_ROW} AND status = 'pending' LIMIT 2`,
        [userId],
      );
      if (pending.length === 1) cancelled = await cancelWhere('id = $2', [String(pending[0]?.id)]);
    }
    const left = await tx.query<{ count: unknown }>(
      `SELECT count(*) AS count FROM bob.reminders WHERE created_by = $1 AND ${TIMER_ROW} AND status = 'pending'`,
      [userId],
    );
    return { cancelled, remaining: Number(left[0]?.count ?? 0) };
  });
}

/** pending -> fired, once: null when the timer is not (or no longer) pending. */
export async function markTimerFired(
  db: Db, userId: string, id: string, now: number = Date.now(),
): Promise<Timer | null> {
  if (!UUID_RE.test(id)) return null;
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<TimerRow>(
      `UPDATE bob.reminders SET status = 'fired', fired_at = to_timestamp($3 / 1000.0)
       WHERE created_by = $1 AND id = $2 AND ${TIMER_ROW} AND status = 'pending'
       RETURNING ${COLUMNS}`,
      [userId, id, now],
    );
    return rows[0] ? toTimer(rows[0]) : null;
  });
}

/** fired -> dismissed (the ringing was stopped); null when not ringing. */
export async function dismissTimer(db: Db, userId: string, id: string): Promise<Timer | null> {
  if (!UUID_RE.test(id)) return null;
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<TimerRow>(
      `UPDATE bob.reminders SET status = 'dismissed'
       WHERE created_by = $1 AND id = $2 AND ${TIMER_ROW} AND status = 'fired'
       RETURNING ${COLUMNS}`,
      [userId, id],
    );
    return rows[0] ? toTimer(rows[0]) : null;
  });
}

/** Service path: pending rows across accounts due at or before `now`, oldest
 *  first, at most `limit` (1..1000). Pass the RAW Db. */
export async function duePending(db: Db, now: number, limit = 100): Promise<DueTimer[]> {
  const bounded = Math.max(1, Math.min(Math.floor(limit), 1000));
  return asServer(db, async (server) => {
    const rows = await server.query<TimerRow & { conversationId?: unknown }>(
      `SELECT * FROM bob_private.timers_due($1::timestamptz, $2::integer)`,
      [new Date(now).toISOString(), bounded],
    );
    return rows.map((row) => ({ ...toTimer(row), ...(typeof row.conversationId === 'string' ? { conversationId: row.conversationId } : {}) }));
  });
}

/** Service path: the earliest pending fires_at across accounts, or null. */
export async function nextPendingFireAt(db: Db): Promise<number | null> {
  return asServer(db, async (server) => {
    const rows = await server.query<{ at: unknown }>(`SELECT bob_private.timers_next_fire_at() AS at`);
    const at = rows[0]?.at;
    return at === null || at === undefined ? null : Number(at);
  });
}
