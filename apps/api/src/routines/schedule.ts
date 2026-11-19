import { RoutineScheduleSchema } from './schemas.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Interpret local calendar parts as UTC only for arithmetic, never as an instant. */
function wallAt(format: Intl.DateTimeFormat, at: number): number {
  const parts = Object.fromEntries(format.formatToParts(at).map(({ type, value }) => [type, value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
}

function resolveDay(format: Intl.DateTimeFormat, wall: number): number | null {
  const offsets = new Set<number>();
  // Observe both sides of a transition, including half-hour and date-line shifts.
  for (let hours = -36; hours <= 36; hours += 6) {
    const at = wall + hours * 60 * MINUTE;
    offsets.add(wallAt(format, at) - at);
  }
  // Same policy as calendar recurrence: advance a missing time to the gap end.
  // Three hours is a hard bound; a skipped date is handled by the next day.
  for (let minute = 0; minute <= 180; minute++) {
    const candidateWall = wall + minute * MINUTE;
    const matches = [...offsets].map((offset) => candidateWall - offset)
      .filter((at) => wallAt(format, at) === candidateWall);
    if (matches.length > 0) return Math.min(...matches);
  }
  return null;
}

/** Pure definition-time calculation. No worker is registered by this function.
 * Overlaps choose the first instant only; gaps advance to the first valid minute.
 * A result is strictly after now, including when now is in the repeated hour. */
export function nextRoutineRun(schedule: { localTime: string; timeZone: string; weekdays?: number[] }, now: number): number {
  const { localTime, timeZone, weekdays } = RoutineScheduleSchema.parse(schedule);
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('Invalid routine clock');
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, calendar: 'gregory', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const today = new Date(wallAt(format, now));
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const [hour = 0, minute = 0] = localTime.split(':').map(Number);
  for (let day = 0; day < 9; day++) {
    const weekday = new Date(midnight + day * DAY).getUTCDay() || 7;
    if (!weekdays.includes(weekday)) continue;
    const at = resolveDay(format, midnight + day * DAY + (hour * 60 + minute) * MINUTE);
    if (at !== null && at > now) return at;
  }
  throw new Error('Routine schedule unavailable');
}
