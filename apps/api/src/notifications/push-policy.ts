import type { StoredPreference, StoredNotification } from './store.ts';

/** All applicable quiet windows are respected. A wall-clock scan handles overnight and DST gaps/folds. */
export function pushQuietDelay(preferences: readonly StoredPreference[], notification: Pick<StoredNotification,'spaceId'|'type'|'resourceType'|'resourceId'>,
  now: number): number {
  const relevant = preferences.filter((p) => (p.spaceId === null || p.spaceId === notification.spaceId)
    && (p.type === null || p.type === notification.type)
    && (p.threadId === null || (notification.resourceType === 'thread' && p.threadId === notification.resourceId))
    && p.quietHoursStart !== null && p.quietHoursEnd !== null && p.quietZone !== null);
  const isQuiet = (at: number): boolean => relevant.some((p) => inWindow(p,at));
  if (!isQuiet(now)) return 0;
  for (let minutes = 1; minutes <= 24*60; minutes += 1) {
    if (!isQuiet(now+minutes*60_000)) return minutes*60_000;
  }
  return 86_400_000;
}

function inWindow(p: StoredPreference, at: number): boolean {
  if (!p.quietHoursStart || !p.quietHoursEnd || !p.quietZone || p.quietHoursStart === p.quietHoursEnd) return false;
  try {
    const time = new Intl.DateTimeFormat('en-GB',{ timeZone:p.quietZone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).format(at);
    return p.quietHoursStart < p.quietHoursEnd
      ? time >= p.quietHoursStart && time < p.quietHoursEnd
      : time >= p.quietHoursStart || time < p.quietHoursEnd;
  } catch { return true; } // Invalid configuration must not bypass the recipient's quiet preference.
}
