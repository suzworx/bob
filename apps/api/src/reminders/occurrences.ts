/**
 * store: occurrences (split out of store.ts for the file-size limit, epic #611; behaviour unchanged).
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
  StoreNotFoundError,
  asServer,
  withUser,
  type Db,
} from '../platform/db/db.ts';
import { expandOccurrences, } from '../calendar/recurrence.ts';
import { HOURLY_LOOKBACK_MS, keyString, normalizeRrule, wallStringAt } from './rows.ts';
import { DueOccurrence, OccurrenceKey } from './types.ts';

/** A raw source row from reminder_fanout_sources (aliases as declared). */
type FanoutSourceRow = {
  reminderId: unknown;
  spaceId: unknown;
  dueAt: unknown;
  dueZone: unknown;
  rrule: unknown;
  scheduleRevision: unknown;
  userId: unknown;
  conversationId?: unknown;
};

/** The source row's originating conversation, as a DueOccurrence field (absent when none). */
function originOf(source: FanoutSourceRow | undefined): { conversationId?: string } {
  return typeof source?.conversationId === 'string' ? { conversationId: source.conversationId } : {};
}

/** A raw key row from reminder_existing_keys. */
type ExistingKeyRow = {
  reminderId: unknown;
  userId: unknown;
  occurrenceAt: unknown;
  scheduleRevision: unknown;
};

/**
 * The fanout worker's read: the (recipient, occurrence, revision) triples that
 * are due at `now` and have NO occurrence row yet. Runs through the
 * bob_private definers (asServer) because it must see active reminders across
 * every space. Criterion 2 is enforced in SQL (reminder_fanout_sources skips
 * non-active reminders and ones whose task is completed); criterion 3 by
 * skipping triples whose key is already recorded.
 */
export async function dueOccurrences(
  db: Db,
  options: { now: number; limit?: number },
): Promise<DueOccurrence[]> {
  const nowMs = options.now;
  const limit = options.limit === undefined ? 500 : Math.max(1, Math.min(Math.floor(options.limit), 1000));
  const nowTs = new Date(nowMs).toISOString();
  const { out, sources } = await asServer(db, async (server) => {
    const sources = await server.query<FanoutSourceRow>(
      `SELECT "reminderId", "spaceId", "dueAt", "dueZone", rrule,
              "scheduleRevision", "userId", "conversationId"
         FROM bob_private.reminder_fanout_sources($1::timestamptz)`,
      [nowTs],
    );
    if (sources.length === 0) return { out: [], sources };
    const reminderIds = [...new Set(sources.map((s) => String(s.reminderId)))];
    const existing = await server.query<ExistingKeyRow>(
      `SELECT "reminderId", "userId", "occurrenceAt", "scheduleRevision"
         FROM bob_private.reminder_existing_keys($1::uuid[])`,
      [reminderIds],
    );
    const seen = new Set(existing.map((e) => keyString(e)));
    const groups = new Map<string, FanoutSourceRow[]>();
    for (const s of sources) {
      const id = String(s.reminderId);
      const arr = groups.get(id) ?? [];
      arr.push(s);
      groups.set(id, arr);
    }
    const out: DueOccurrence[] = [];
    for (const [reminderId, rows] of groups) {
      const sourceRow = rows[0];
      if (!sourceRow) throw new StoreError('dueOccurrences: no source row');
      const anchor = Number(sourceRow.dueAt);
      const zone = String(sourceRow.dueZone);
      const revision = Number(sourceRow.scheduleRevision);
      const rrule = normalizeRrule(sourceRow.rrule);

      // Latest recorded occurrence under THIS schedule revision only: a bumped
      // revision starts a fresh namespace, so revision 2 must not inherit
      // revision 1's high-water mark (or a revised reminder would skip
      // everything before the bump). Every recipient row in a group shares the
      // current revision.
      let latestRecorded: number | null = null;
      for (const e of existing) {
        if (String(e.reminderId) === reminderId && Number(e.scheduleRevision) === revision) {
          const at = Number(e.occurrenceAt);
          if (latestRecorded === null || at > latestRecorded) latestRecorded = at;
        }
      }

      let instants: number[];
      if (rrule === null) {
        instants = [anchor];
      } else {
        // Advance the lower bound past the latest recorded occurrence instead
        // of re-expanding from the original anchor: once `limit` instants are
        // recorded, re-expanding from the anchor regenerates exactly those
        // instants, `seen` removes them all, and the reminder dies forever
        // (defect 1). `startWallTime` and `from` both derive from the SAME
        // instant (`latestRecorded`, else the anchor) in the reminder's zone,
        // so the wall string and the epoch bound stay consistent across a DST
        // boundary. `from` is inclusive in expandOccurrences, so `+1` steps
        // just past the recorded instant; with nothing recorded yet `from`
        // stays at the anchor so the anchor itself is still delivered.
        // An hourly backlog outgrows `limit` in about a month (a paused
        // reminder resumed, a long outage), and the collapse would then pick a
        // stale instant and emit another catch-up every tick. Only the newest
        // missed ring matters, so look back no further than two days: longer
        // than any gap between hourly slots, even across a DST change.
        const startInstant = latestRecorded === null ? anchor : latestRecorded;
        const lowerBound = latestRecorded === null ? anchor : latestRecorded + 1;
        instants = expandOccurrences({
          rule: rrule,
          startWallTime: wallStringAt(startInstant, zone),
          zone,
          from: rrule.freq === 'hourly' ? Math.max(lowerBound, nowMs - HOURLY_LOOKBACK_MS) : lowerBound,
          to: nowMs,
          limit,
        }).map((o) => o.at);
      }
      for (const row of rows) {
        const userId = String(row.userId);
        const pending: DueOccurrence[] = [];
        for (const occ of instants) {
          if (occ > nowMs) continue;
          const key: OccurrenceKey = {
            reminderId,
            userId,
            occurrenceAt: occ,
            scheduleRevision: revision,
          };
          if (!seen.has(keyString(key))) pending.push({ ...key, catchUp: false });
        }
        if (pending.length === 0) continue;
        // Collapse an outage backlog into ONE catch-up per recipient (defect
        // 2): the most recent missed instant -- expandOccurrences returns
        // ascending, so the last pending key is the newest -- because that is
        // the one a person still cares about. A single missed instant stays an
        // ordinary occurrence. The collapsed instants cannot come back: once
        // the catch-up is recorded it becomes the new high-water mark and the
        // lower bound advances past them, and even unrecorded the collapse is
        // deterministic (it always projects to the same most-recent instant),
        // so a backlog can never flood again.
        const mostRecent = pending[pending.length - 1];
        if (!mostRecent) throw new StoreError('dueOccurrences: no most recent');
        out.push({ ...mostRecent, catchUp: pending.length > 1, ...originOf(row) });
        if (out.length >= limit) return { out, sources };
      }
    }
    return { out, sources };
  });
  if (out.length >= limit) return out;
  return out.concat(await snoozedOccurrences(db, sources, nowMs, limit - out.length));
}

/** A raw recorded occurrence whose snooze has ended. */
type SnoozedRow = {
  id: unknown;
  reminderId: unknown;
  occurrenceAt: unknown;
  scheduleRevision: unknown;
  snoozedUntil: unknown;
};

/**
 * The recorded occurrences whose snooze has ended (snoozed_until <= now, not
 * acknowledged), for the still-due reminders in `sources` under their CURRENT
 * schedule revision (#507). The server role cannot read the FORCE-RLS
 * occurrence table, so each recipient's rows are read as that recipient: RLS
 * shows only their own rows, and nothing once they have left the space.
 */
async function snoozedOccurrences(
  db: Db,
  sources: ReadonlyArray<FanoutSourceRow>,
  nowMs: number,
  limit: number,
): Promise<DueOccurrence[]> {
  const revisions = new Map<string, number>();
  const byUser = new Map<string, Set<string>>();
  const sourceOf = new Map<string, FanoutSourceRow>();
  for (const s of sources) {
    const reminderId = String(s.reminderId);
    sourceOf.set(`${reminderId}:${String(s.userId)}`, s);
    revisions.set(reminderId, Number(s.scheduleRevision));
    const ids = byUser.get(String(s.userId)) ?? new Set<string>();
    ids.add(reminderId);
    byUser.set(String(s.userId), ids);
  }
  const out: DueOccurrence[] = [];
  for (const [userId, reminderIds] of byUser) {
    const rows = await withUser(db, userId, (tx) => tx.query<SnoozedRow>(
      `SELECT id, reminder_id AS "reminderId",
              floor(extract(epoch from occurrence_at) * 1000)::bigint AS "occurrenceAt",
              schedule_revision AS "scheduleRevision",
              floor(extract(epoch from snoozed_until) * 1000)::bigint AS "snoozedUntil"
         FROM bob.reminder_occurrences
        WHERE user_id = $1 AND reminder_id = ANY($2::uuid[])
          AND snoozed_until IS NOT NULL AND snoozed_until <= $3::timestamptz
          AND acknowledged_at IS NULL
        ORDER BY snoozed_until`,
      [userId, [...reminderIds], new Date(nowMs).toISOString()],
    ));
    for (const row of rows) {
      const reminderId = String(row.reminderId);
      const revision = Number(row.scheduleRevision);
      if (revisions.get(reminderId) !== revision) continue;
      out.push({ reminderId, userId, occurrenceAt: Number(row.occurrenceAt),
        scheduleRevision: revision, catchUp: false, occurrenceId: String(row.id),
        snoozedUntil: Number(row.snoozedUntil), ...originOf(sourceOf.get(`${reminderId}:${userId}`)) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Ends a snooze once its re-delivery is done (delivered or muted), as the
 *  recipient. Only a snooze that has ended by `snoozedUntil` is cleared, so a
 *  re-snooze to a later time in the meantime survives. Returns true if cleared. */
export async function clearEndedSnooze(
  db: Db,
  userId: string,
  occurrenceId: string,
  snoozedUntil: number,
): Promise<boolean> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query(
      `UPDATE bob.reminder_occurrences
       SET snoozed_until = NULL
       WHERE id = $1 AND snoozed_until <= to_timestamp($2 / 1000.0)
       RETURNING id`,
      [occurrenceId, snoozedUntil],
    );
    return rows.length > 0;
  });
}

/**
 * Records an occurrence row, ON CONFLICT DO NOTHING so a replayed fanout run
 * is a no-op (criterion 3). Returns true only when a row was actually inserted
 * -- a retried command answers false. Runs through the definer because the
 * FORCE-RLS occurrence table has no account insert policy.
 */
export function recordOccurrence(db: Db, key: OccurrenceKey): Promise<boolean> {
  return occurrenceDefiner(db, 'reminder_occurrence_record', key);
}

/**
 * Hands back an occurrence claimed by recordOccurrence whose notification then
 * failed, so the next fanout tick retries it (#507). Deletes only a fresh claim
 * (never acknowledged or snoozed). Returns true when a row was removed.
 */
export function releaseOccurrence(db: Db, key: OccurrenceKey): Promise<boolean> {
  return occurrenceDefiner(db, 'reminder_occurrence_release', key);
}

/** Calls one of the (reminder, user, occurrence, revision) -> boolean definers. */
function occurrenceDefiner(db: Db, fn: 'reminder_occurrence_record' | 'reminder_occurrence_release',
  key: OccurrenceKey): Promise<boolean> {
  const atTs = new Date(key.occurrenceAt).toISOString();
  return asServer(db, async (server) => {
    const rows = await server.query<{ ok: unknown }>(
      `SELECT bob_private.${fn}(
         $1::uuid, $2::uuid, $3::timestamptz, $4::int
       ) AS ok`,
      [key.reminderId, key.userId, atTs, key.scheduleRevision],
    );
    const row = rows[0];
    return row ? row.ok === true : false;
  });
}

/** Snoozes one occurrence for its OWN recipient (RLS scopes the UPDATE to
 *  auth.uid(), so a snooze can never touch another person's delivery --
 *  criterion 1). A row the caller does not own is "not found". With
 *  `reminderId`, a row of any other reminder is "not found" too. */
export async function snoozeOccurrence(
  db: Db,
  userId: string,
  occurrenceId: string,
  until: number,
  reminderId?: string,
): Promise<void> {
  await withUser(db, userId, async (tx) => {
    const rows = await tx.query(
      `UPDATE bob.reminder_occurrences
       SET snoozed_until = to_timestamp($2 / 1000.0)
       WHERE id = $1 AND user_id = $3 AND ($4::uuid IS NULL OR reminder_id = $4::uuid)
       RETURNING id`,
      [occurrenceId, until, userId, reminderId ?? null],
    );
    if (rows.length === 0) throw new StoreNotFoundError('occurrence not found');
  });
}

/** Acknowledges one occurrence for its OWN recipient (idempotent; a retry
 *  still resolves, and RLS scopes it to the caller's rows). */
export async function acknowledgeOccurrence(
  db: Db,
  userId: string,
  occurrenceId: string,
): Promise<void> {
  await withUser(db, userId, async (tx) => {
    const rows = await tx.query(
      `UPDATE bob.reminder_occurrences
       SET acknowledged_at = now()
       WHERE id = $1
       RETURNING id`,
      [occurrenceId],
    );
    if (rows.length === 0) throw new StoreNotFoundError('occurrence not found');
  });
}
