/**
 * A signed-in user's own usage as counts and times only (ANL-U1). Every query runs
 * under withUser (RLS scopes it to the caller) with an explicit ownership filter,
 * and none selects message, note, task, conversation or memory text. Each query is
 * its own transaction so a failing optional one (memories need the vector
 * extension; game_usage may be absent) cannot abort the rest.
 *
 * Days and hours are the account's own (its time zone, UTC when unset), the window
 * is the last N calendar days ending today, and every day in it is listed, zeros
 * included. Counts match the page each one links to: to-dos done counts what Today
 * shows (tasks, Bob's suggested to-dos and reminders), memories count what Memory
 * lists. Device facts live on Devices only.
 */
import { resolveTimeZone } from '@bob/ai';
import { withUser, type Db } from '../platform/db/db.ts';
import { getAccountTimeZone } from '../devices/settings-store.ts';

export type UsageRange = '7d' | '30d' | '90d';

type Origin = 'device' | 'web_voice' | 'web_text';

export interface UsageDay {
  day: string;
  device: number;
  web_voice: number;
  web_text: number;
}

export interface UsageData {
  range: UsageRange;
  from: string;
  to: string;
  generatedAt: string;
  activeDays: number;
  total: number;
  bySurface: Record<Origin, number>;
  byDay: UsageDay[];
  byWeekdayHour: Array<{ dow: number; hour: number; count: number }>;
  conversationsCreated: number;
  created: { tasks: number; notes: number; reminders: number };
  todosDone: number;
  memories: { newInRange: number; total: number } | null;
  gameMinutes: number | null;
}

const RANGE_DAYS: Record<UsageRange, number> = { '7d': 7, '30d': 30, '90d': 90 };
const ORIGINS: readonly Origin[] = ['device', 'web_voice', 'web_text'];

function isOrigin(value: unknown): value is Origin {
  return typeof value === 'string' && (ORIGINS as readonly string[]).includes(value);
}

async function rows<T>(db: Db, userId: string, sql: string, params: unknown[]): Promise<T[]> {
  return withUser(db, userId, (tx) => tx.query<T>(sql, params));
}

/** Params for every windowed query: $1 user, $2 days, $3 zone. */
async function count(db: Db, userId: string, sql: string, days: number, zone: string): Promise<number> {
  const result = await rows<{ n: number }>(db, userId, sql, [userId, days, zone]);
  return Number(result[0]?.n ?? 0);
}

async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** The first instant of the window: local midnight, (days - 1) days before today, in $3. */
const START = `(((now() at time zone $3::text)::date - ($2::int - 1))::timestamp at time zone $3::text)`;
const SINCE = `created_at >= ${START}`;

/** `YYYY-MM-DD` plus `offset` calendar days. */
function addDays(date: string, offset: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + offset)).toISOString().slice(0, 10);
}

/** Every calendar day of the window ending `today`, oldest first, zero-filled. */
export function fillDays(today: string, days: number, counts: ReadonlyArray<{ day: string; origin: string; n: number }>): UsageDay[] {
  const byDay = new Map<string, UsageDay>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = addDays(today, -offset);
    byDay.set(day, { day, device: 0, web_voice: 0, web_text: 0 });
  }
  for (const row of counts) {
    const entry = byDay.get(row.day);
    if (entry && isOrigin(row.origin)) entry[row.origin] += row.n;
  }
  return [...byDay.values()];
}

export async function readUsage(db: Db, userId: string, range: UsageRange): Promise<UsageData> {
  const days = RANGE_DAYS[range];
  const zone = resolveTimeZone(await getAccountTimeZone(db, userId).catch(() => null));
  const params = [userId, days, zone];
  const now = new Date();
  const window = await rows<{ today: string; start: string }>(
    db,
    userId,
    `select (now() at time zone $3::text)::date::text as today, ${START} as start
       from (select $1::uuid as u, $2::int as d) as p`,
    params,
  );
  const today = window[0]?.today ?? now.toISOString().slice(0, 10);
  const start = window[0]?.start ? new Date(window[0].start) : new Date(now.getTime() - days * 86_400_000);
  const turnRows = await rows<{ day: string; origin: string; n: number }>(
    db,
    userId,
    `select (created_at at time zone $3::text)::date::text as day, origin, count(*)::int as n
       from bob.messages
      where user_id = $1 and role = 'user' and tombstoned_at is null and ${SINCE}
      group by 1, 2 order by 1`,
    params,
  );
  const heat = await rows<{ dow: number; hour: number; n: number }>(
    db,
    userId,
    `select extract(dow from created_at at time zone $3::text)::int as dow,
            extract(hour from created_at at time zone $3::text)::int as hour, count(*)::int as n
       from bob.messages
      where user_id = $1 and role = 'user' and tombstoned_at is null and ${SINCE}
      group by 1, 2 order by 1, 2`,
    params,
  );
  const conversationsCreated = await count(db, userId, `select count(*)::int as n from bob.conversations where user_id = $1 and ${SINCE}`, days, zone);
  const tasks = await count(db, userId, `select count(*)::int as n from bob.tasks where created_by = $1 and trashed_at is null and ${SINCE}`, days, zone);
  const notes = await count(db, userId, `select count(*)::int as n from bob.notes where created_by = $1 and ${SINCE}`, days, zone);
  const reminders = await count(
    db,
    userId,
    `select count(*)::int as n from bob.reminders where created_by = $1 and kind = 'reminder' and ${SINCE}`,
    days,
    zone,
  );
  // To-dos done, as Today counts them: tasks you completed (whenever they were
  // made), Bob's suggested to-dos you marked done, and reminders you acknowledged.
  const tasksDone = await count(
    db,
    userId,
    `select count(*)::int as n from bob.tasks
      where completed_by = $1 and status = 'completed' and trashed_at is null and completed_at >= ${START}`,
    days,
    zone,
  );
  const suggestionsDone = await optional(() => count(
    db,
    userId,
    `select count(*)::int as n from bob.action_items where user_id = $1 and status = 'done' and updated_at >= ${START}`,
    days,
    zone,
  ));
  const remindersDone = await optional(() => count(
    db,
    userId,
    `select count(*)::int as n from bob.reminder_occurrences o join bob.reminders r on r.id = o.reminder_id
      where o.user_id = $1 and r.kind = 'reminder' and o.acknowledged_at >= ${START}`,
    days,
    zone,
  ));
  const memories = await optional(async () => {
    const result = await rows<{ fresh: number; total: number }>(
      db,
      userId,
      `select (count(*) filter (where ${SINCE}))::int as fresh, count(*)::int as total
         from bob.memories where user_id = $1`,
      params,
    );
    return { newInRange: Number(result[0]?.fresh ?? 0), total: Number(result[0]?.total ?? 0) };
  });
  // game_usage days are already the account's local days.
  const seconds = await optional(() => count(
    db,
    userId,
    `select coalesce(sum(seconds), 0)::int as n from bob.game_usage
      where user_id = $1 and day >= (now() at time zone $3::text)::date - ($2::int - 1)`,
    days,
    zone,
  ));

  const byDay = fillDays(today, days, turnRows);
  const bySurface: Record<Origin, number> = { device: 0, web_voice: 0, web_text: 0 };
  for (const day of byDay) {
    for (const origin of ORIGINS) bySurface[origin] += day[origin];
  }
  return {
    range,
    from: start.toISOString(),
    to: now.toISOString(),
    generatedAt: now.toISOString(),
    activeDays: byDay.filter((day) => day.device + day.web_voice + day.web_text > 0).length,
    total: bySurface.device + bySurface.web_voice + bySurface.web_text,
    bySurface,
    byDay,
    byWeekdayHour: heat.map((cell) => ({ dow: cell.dow, hour: cell.hour, count: cell.n })),
    conversationsCreated,
    created: { tasks, notes, reminders },
    todosDone: tasksDone + (suggestionsDone ?? 0) + (remindersDone ?? 0),
    memories,
    gameMinutes: seconds === null ? null : Math.floor(seconds / 60),
  };
}
