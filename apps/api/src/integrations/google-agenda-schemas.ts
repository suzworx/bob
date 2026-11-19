import { z } from 'zod';

const identifier = z.string().min(1).max(1024).refine((value) => value !== '.' && value !== '..');
const time = z.union([z.object({ date: z.string().date() }).strict(),
  z.object({ dateTime: z.string().datetime({ offset: true }), timeZone: z.string().max(128).optional() }).strict()]);
export const GoogleCalendarSelectionInputSchema = z.object({ calendarIds: z.array(identifier).max(5) }).strict()
  .refine((value) => new Set(value.calendarIds).size === value.calendarIds.length);
export const GoogleAgendaWindowSchema = z.object({ from: z.coerce.number().int().nonnegative(), to: z.coerce.number().int().nonnegative() }).strict()
  .refine(({ from, to }) => to > from && to - from <= 366 * 86400_000);
const selection = z.object({ account_id: z.string().uuid(), calendar_id: identifier, title: z.string().max(200),
  time_zone: z.string().max(128).nullable(), last_success_at: z.number().int().nullable() }).strict();
export const GoogleCalendarSelectionsResponseSchema = z.object({ selections: z.array(selection).max(5) }).strict();
export const GoogleCalendarListResponseSchema = z.object({ calendars: z.array(z.object({ id: identifier, title: z.string().max(200),
  time_zone: z.string().max(128).nullable(), selected: z.boolean(), selectable: z.boolean(), read_only: z.literal(true) }).strict()).max(100),
  selected_calendar_ids: z.array(identifier).max(5), next_page_token: z.string().max(4096).optional() }).strict();
const item = z.object({ origin: z.literal('google'), source_key: z.string().regex(/^google:[a-f0-9]{64}$/),
  source: z.object({ account_id: z.string().uuid(), calendar_id: identifier, event_id: identifier, etag: z.string().max(256) }).strict(),
  title: z.string().max(200), location: z.string().max(500).nullable(), start: time, end: time, original_start: time.optional(),
  read_only: z.literal(true), fetched_at: z.number().int() }).strict();
const status = z.object({ account_id: z.string().uuid(), calendar_id: identifier,
  state: z.enum(['fresh', 'partial', 'unavailable', 'reconnect_required', 'permission_required']),
  last_success_at: z.number().int().nullable(), fetched_at: z.number().int().optional(), next_page_token: z.string().max(4096).optional() }).strict();
export const GoogleAgendaResponseSchema = z.object({ remote_items: z.array(item).max(250), sources: z.array(status).max(5) }).strict();
export type GoogleAgendaProjection = z.infer<typeof GoogleAgendaResponseSchema>;
export type GoogleCalendarSelection = z.infer<typeof selection>;
