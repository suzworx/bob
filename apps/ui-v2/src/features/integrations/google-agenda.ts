import { z } from 'zod';

// Browser DTOs mirror web-schemas without loading server modules into the UI.
const time = z.union([z.object({ date: z.string().date() }), z.object({ dateTime: z.string().datetime({ offset: true }), timeZone: z.string().optional() })]);
const remoteItem = z.object({ origin: z.literal('google'), source_key: z.string(),
  source: z.object({ account_id: z.string(), calendar_id: z.string(), event_id: z.string(), etag: z.string() }),
  title: z.string(), location: z.string().nullable(), start: time, end: time, original_start: time.optional(), read_only: z.literal(true), fetched_at: z.number() });
const source = z.object({ account_id: z.string(), calendar_id: z.string(), state: z.enum(['fresh', 'partial', 'unavailable', 'reconnect_required', 'permission_required']), last_success_at: z.number().nullable(), fetched_at: z.number().optional(), next_page_token: z.string().optional() });
export const googleProjectionSchema = z.object({ remote_items: z.array(remoteItem).max(250).default([]), sources: z.array(source).max(5).default([]), remote_unavailable: z.boolean().optional() });
export type GoogleAgendaItem = z.infer<typeof remoteItem>;
export type GoogleAgendaState = z.infer<typeof googleProjectionSchema>;

export function googleAgendaDay(item: GoogleAgendaItem): string {
  if ('date' in item.start) return item.start.date;
  const date = new Date(item.start.dateTime);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Calendar date arithmetic only; the provider end date is exclusive. */
export function googleInclusiveEnd(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
}

/** List each covered viewer day within the displayed month, preserving the
 * original provider range for details. Exclusive ends never add a day. */
export function googleAgendaDays(item: GoogleAgendaItem, month: Date): string[] {
  const first = googleAgendaDay(item);
  const last = 'date' in item.end ? googleInclusiveEnd(item.end.date)
    : googleAgendaDay({ ...item, start: { dateTime: new Date(Date.parse(item.end.dateTime) - 1).toISOString() } });
  const day = new Date(month.getFullYear(), month.getMonth(), 1);
  const result: string[] = [];
  while (day.getMonth() === month.getMonth()) {
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    if (key >= first && key <= last) result.push(key);
    day.setDate(day.getDate() + 1);
  }
  return result;
}
