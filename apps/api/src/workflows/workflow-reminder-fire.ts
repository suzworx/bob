/**
 * Workflow: rings a reminder when its occurrence comes due, once per occurrence.
 * Trigger: outboxModule's tick (outbox-module.ts), once at start and then every REMINDER_TICK_MS.
 * Steps: 1. Read the due occurrences. 2. Read each one's origin conversation (one read per tick).
 *   3. Claim each occurrence before notifying (record it, or clear its ended snooze); a lost claim is skipped.
 *   Claiming first is what keeps two servers ticking at once (Railway runs the old and new instance together
 *   during a deploy) from notifying and ringing an occurrence twice.
 *   4. Count a claim older than NOTIFICATION_STALE_MS as stale, never notified.
 *   5. Read the reminder as its recipient and notify (notifyReminderDue); a failed enqueue hands the claim back.
 *   6. Announce an enqueued reminder on the recipient's devices (reminderAnnouncement).
 *   7. Journal the tally and set the outcome.
 * Outcome: each due occurrence is notified and announced at most once across servers. A muted or unreadable
 *   occurrence stays claimed, so it is never retried. A failed enqueue hands the claim back (the row is released,
 *   or the snooze restored) so the next tick retries it, journaled with an enum reason and ids. A claim
 *   older than NOTIFICATION_STALE_MS is counted stale and never notified, so delivery that was down for days
 *   does not blast old reminders. An enqueued reminder is also announced (ring:false, spoken after its
 *   card) on the recipient's devices, held for a busy or DND device and replayed on reconnect until acked or
 *   REMINDER_ANNOUNCE_TTL_MS passes; the speech is synthesized on delivery through the turn pipeline's MP3 path.
 *   A muted reminder is not announced. An announce failure is counted and never touches the inbox or email
 *   fan-out. A failed read marks the tick failed. tick() never throws.
 * Journal: v2.reminder_fanout (tally), v2.reminder_delivery_failed (per occurrence), v2.reminder_fanout_failed
 *   (store read failed); v2.reminder_fanout_tick is emitted by outbox-module.ts after a tick that enqueued.
 *   Trace: reminder-fanout. Pass the RAW Db from getDb(); journal lines carry counts and ids only.
 */
import { withTraceContext } from '@bob/ai';
import { moduleJournal } from '../platform/logger.ts';
import { traceWorkflow, type SetWorkflowOutcome } from '../platform/observability/workflow-diagnostics.ts';
import type { Db } from '../platform/db/db.ts';
import { clearEndedSnooze, dueOccurrences, getReminder, recordOccurrence, releaseOccurrence,
  snoozeOccurrence, type DueOccurrence } from '../reminders/store.ts';
import { type Announcement } from '../voice/device-sessions.ts';
import { NOTIFICATION_STALE_MS, notifyReminderDue } from '../notifications/notify.ts';
import { jobCorrelations } from '../reminders/origin-conversation.ts';
import { reminderAnnouncement } from '../reminders/fanout.ts';

const journal = moduleJournal('reminders');

type ReminderFanoutDeps = {
  db: Db;
  now?: () => number;
  /** Rings the recipient's devices (the device registry's announce). */
  announce: (userId: string, announcement: Announcement) => unknown;
};

type ReminderFanout = {
  /** Runs one pass; resolves to how many notifications were enqueued. */
  tick: () => Promise<number>;
};

export function createReminderFanout({
  db,
  now = Date.now,
  announce,
}: ReminderFanoutDeps): ReminderFanout {
  type Tally = { enqueued: number; failed: number; deliveryFailed: number; announced: number; announceFailed: number; stale: number };

  /** A claimed occurrence: read the reminder as its recipient, notify, ring their devices; a failed enqueue hands the claim back. */
  async function deliverClaimed(occurrence: DueOccurrence, tally: Tally): Promise<void> {
    const { userId, reminderId, occurrenceId, snoozedUntil } = occurrence;
    // Read as the recipient: RLS lets an active member see the reminder, and a
    // recipient who has since left the space gets nothing.
    const reminder = await getReminder(db, userId, reminderId).catch(() => undefined);
    if (reminder === undefined) return;
    const outcome = await notifyReminderDue(db, occurrence, reminder.spaceId);
    if (outcome.status === 'failed') {
      tally.deliveryFailed += 1;
      journal('v2.reminder_delivery_failed', { reason: outcome.reason, reminder_id: reminderId, user_id: userId });
      // Hand the claim back so the next tick retries it; the effect key makes
      // a half-done enqueue resolve to the same row.
      if (occurrenceId !== undefined && snoozedUntil !== undefined) {
        await snoozeOccurrence(db, userId, occurrenceId, snoozedUntil);
      } else {
        await releaseOccurrence(db, occurrence);
      }
      return;
    }
    if (outcome.status !== 'delivered') return;
    tally.enqueued += outcome.enqueued;
    try {
      announce(userId, reminderAnnouncement(occurrence, reminder.title, now()));
      tally.announced += 1;
    } catch {
      tally.announceFailed += 1;
    }
  }

  async function runTick(outcome: SetWorkflowOutcome): Promise<number> {
    const tally: Tally = { enqueued: 0, failed: 0, deliveryFailed: 0, announced: 0, announceFailed: 0, stale: 0 };
    let due: DueOccurrence[];
    try {
      due = await dueOccurrences(db, { now: now() });
    } catch {
      outcome('failed');
      journal('v2.reminder_fanout_failed', { count: 0 });
      return 0;
    }
    // The conversation each reminder was created in, else its recipient's active one: one read for the tick.
    const correlationOf = await jobCorrelations(db, due);
    for (const occurrence of due) {
      const { userId, reminderId, occurrenceId, snoozedUntil } = occurrence;
      try {
        // Claim before notifying: false means another tick (or server) has it.
        const claimed = occurrenceId !== undefined && snoozedUntil !== undefined
          ? await clearEndedSnooze(db, userId, occurrenceId, snoozedUntil)
          : await recordOccurrence(db, occurrence);
        if (!claimed) continue;
        if (now() - (snoozedUntil ?? occurrence.occurrenceAt) > NOTIFICATION_STALE_MS) {
          tally.stale += 1;
          continue;
        }
        await withTraceContext(correlationOf(occurrence), () => deliverClaimed(occurrence, tally));
      } catch {
        tally.failed += 1;
        journal('v2.reminder_delivery_failed', { reason: 'record_failed',
          reminder_id: reminderId, user_id: userId });
      }
    }
    const { enqueued, failed, deliveryFailed, announced, announceFailed, stale } = tally;
    if (due.length > 0 || failed > 0) {
      const summary = { due: due.length, enqueued, failed, delivery_failed: deliveryFailed,
        announced, announce_failed: announceFailed, stale };
      journal('v2.reminder_fanout', summary);
    }
    if (failed + deliveryFailed + announceFailed > 0) outcome('failed');
    else if (enqueued === 0) outcome('skipped');
    return enqueued;
  }

  const tick = (): Promise<number> => traceWorkflow('reminder-fanout', { detached: true }, runTick);
  return { tick };
}
