// Typed client for GET /api/me/usage. The shapes mirror the handler's response
// schema (apps/api/src/account/usage-http.ts); they are written
// out by hand because the UI never imports from the API app. Days and hours
// are the account's own (its time zone), and every day of the range is listed.

import { fetchWithAuth } from '@/lib/auth/use-session';

export type UsageRange = '7d' | '30d' | '90d';

type SurfaceCounts = {
  device: number;
  web_voice: number;
  web_text: number;
};

type UsageDay = SurfaceCounts & { day: string };

export type UsageWeekdayHour = {
  dow: number;
  hour: number;
  count: number;
};

export type UsageResponse = {
  range: UsageRange;
  from: string;
  to: string;
  generated_at: string;
  active_days: number;
  turns: {
    total: number;
    by_surface: SurfaceCounts;
    by_day: UsageDay[];
    by_weekday_hour: UsageWeekdayHour[];
  };
  conversations_created: number;
  created: {
    tasks: number;
    notes: number;
    reminders: number;
  };
  /** Tasks, suggested to-dos and reminders you finished in the range: what Today counts. */
  todos_done: number;
  /** New in the range, next to the total Memory lists; null when memory is off. */
  memories: { new_in_range: number; total: number } | null;
  game_minutes: number | null;
};

export async function fetchUsage(range: UsageRange): Promise<UsageResponse> {
  const response = await fetchWithAuth(`/api/me/usage?range=${range}`);
  if (!response.ok) throw new Error('usage_failed');
  return (await response.json()) as UsageResponse;
}
