/** Reminder fanout capabilities (S14-REMINDERS, #321): the announcement a due reminder
 *  rings on the recipient's devices. The tick that claims and delivers due occurrences
 *  is workflows/workflow-reminder-fire.ts. */
import { ANNOUNCE_BODY_MAX, ANNOUNCE_TITLE_MAX } from '../devices/settings.ts';
import { type Announcement } from '../voice/device-sessions.ts';
import type { DueOccurrence } from './store.ts';

/** How long a due reminder is replayed to a device that was offline, busy or in DND. */
const REMINDER_ANNOUNCE_TTL_MS = 60 * 60 * 1000;

/** One announcement per occurrence: a replayed tick or a second server dedupes on it. */
export function reminderAnnouncement(occurrence: DueOccurrence, title: string, now: number): Announcement {
  return {
    announce_id: occurrence.snoozedUntil === undefined
      ? `rm_${occurrence.reminderId}_${occurrence.occurrenceAt}`
      : `rm_${occurrence.reminderId}_${occurrence.occurrenceAt}_s${occurrence.snoozedUntil}`,
    kind: 'reminder',
    title: title.slice(0, ANNOUNCE_TITLE_MAX),
    body: title.slice(0, ANNOUNCE_BODY_MAX),
    ring: false,
    expires_at: now + REMINDER_ANNOUNCE_TTL_MS,
    speech: `Reminder: ${title}`,
  };
}
