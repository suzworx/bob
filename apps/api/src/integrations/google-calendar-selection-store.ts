import { StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { GoogleCalendarSelectionsResponseSchema, type GoogleCalendarSelection } from './google-agenda-schemas.ts';

interface Row { google_account_id: string; calendar_id: string; title: string; time_zone: string | null; last_success_at: Date | string | null }
function map(row: Row): GoogleCalendarSelection {
  return { account_id: row.google_account_id, calendar_id: row.calendar_id, title: row.title, time_zone: row.time_zone,
    last_success_at: row.last_success_at === null ? null : new Date(row.last_success_at).getTime() };
}
export async function listGoogleCalendarSelections(db: Db, userId: string): Promise<GoogleCalendarSelection[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<Row>('select google_account_id, calendar_id, title, time_zone, last_success_at from bob.google_calendar_selections order by google_account_id, calendar_id limit 6');
    if (rows.length > 5) throw new StoreError('google_selection_limit');
    return rows.map(map);
  });
}
export async function replaceGoogleCalendarSelections(db: Db, userId: string, accountId: string, selections: GoogleCalendarSelection[]): Promise<GoogleCalendarSelection[]> {
  const parsed = GoogleCalendarSelectionsResponseSchema.safeParse({ selections });
  if (!parsed.success || selections.some((selection) => selection.account_id !== accountId)) throw new StoreError('google_selection_invalid');
  return withUser(db, userId, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`google-calendars:${userId}`]);
    const account = await tx.query('select id from bob.google_accounts where id = $1 for update', [accountId]);
    if (!account.length) throw new StoreNotFoundError('google_account_not_found');
    const existing = await listGoogleCalendarSelections(tx, userId);
    if (existing.filter((selection) => selection.account_id !== accountId).length + selections.length > 5) throw new StoreError('google_selection_limit');
    await tx.query('delete from bob.google_calendar_selections where google_account_id = $1 and not (calendar_id = any($2::text[]))', [accountId, selections.map((selection) => selection.calendar_id)]);
    for (const selection of selections) {
      await tx.query(`insert into bob.google_calendar_selections (user_id, google_account_id, calendar_id, title, time_zone)
        values ($1,$2,$3,$4,$5) on conflict (user_id,google_account_id,calendar_id)
        do update set title = excluded.title, time_zone = excluded.time_zone`,
      [userId, accountId, selection.calendar_id, selection.title, selection.time_zone]);
    }
    return (await listGoogleCalendarSelections(tx, userId)).filter((selection) => selection.account_id === accountId);
  });
}
export async function recordGoogleCalendarFetch(db: Db, userId: string, selection: GoogleCalendarSelection, stamp: number): Promise<boolean> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query(`update bob.google_calendar_selections set last_success_at = to_timestamp($3 / 1000.0)
      where google_account_id = $1 and calendar_id = $2 returning calendar_id`, [selection.account_id, selection.calendar_id, stamp]);
    return rows.length === 1;
  });
}
