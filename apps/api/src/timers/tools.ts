/** Binds the timer tool callbacks (apps/ai timer-tools.ts) to ONE account and
 *  its time zone (issue #320). Every create and cancel calls onChange, which
 *  the wiring unit points at the scheduler's reschedule() so its one armed
 *  timeout follows the new earliest timer. onChange errors are swallowed: the
 *  row is already stored and the scheduler re-arms on its next run anyway. */
import { type TimerCallbacks, type TimerView } from '@bob/ai';
import type { Db } from '../platform/db/db.ts';
import {
  cancelTimers,
  createAlarm,
  createTimer,
  listPendingTimers,
  validateTimeZone,
  type Timer,
} from './store.ts';

type BindTimerToolsOptions = {
  /** The account's IANA time zone, e.g. "America/New_York". */
  timeZone: string;
  /** Called with the account's userId, so only that account's devices are pushed. */
  onChange?: (userId: string) => void | Promise<void>;
  now?: () => number;
};

/** "7:00 AM" on the wall clock of `timeZone`. */
function speakLocalTime(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
    .format(new Date(at))
    .replace(/ /g, ' ');
}

function toTimerView(timer: Timer, now: number, timeZone: string): TimerView {
  return {
    id: timer.id,
    kind: timer.kind,
    label: timer.label,
    firesAtIso: new Date(timer.firesAt).toISOString(),
    remainingMs: Math.max(0, timer.firesAt - now),
    localTime: speakLocalTime(timer.firesAt, timeZone),
  };
}

export function bindTimerTools(db: Db, userId: string, options: BindTimerToolsOptions): TimerCallbacks {
  const timeZone = validateTimeZone(options.timeZone);
  const now = options.now ?? Date.now;
  const changed = async (): Promise<void> => {
    try {
      await options.onChange?.(userId);
    } catch {
      // The row is stored; the scheduler re-arms on its next run.
    }
  };
  return {
    async setTimer(input) {
      const at = now();
      const timer = await createTimer(db, userId, { durationMs: input.durationMs, label: input.label ?? null, now: at });
      await changed();
      return toTimerView(timer, at, timeZone);
    },
    async setAlarm(input) {
      const at = now();
      const timer = await createAlarm(db, userId, { time: input.time, timeZone, label: input.label ?? null, now: at });
      await changed();
      return toTimerView(timer, at, timeZone);
    },
    async listTimers() {
      const at = now();
      const pending = await listPendingTimers(db, userId, at);
      return pending.map((timer) => toTimerView(timer, at, timeZone));
    },
    async cancelTimers(input) {
      const at = now();
      const result = await cancelTimers(db, userId, input);
      if (result.cancelled.length > 0) await changed();
      return { cancelled: result.cancelled.map((timer) => toTimerView(timer, at, timeZone)), remaining: result.remaining };
    },
  };
}
