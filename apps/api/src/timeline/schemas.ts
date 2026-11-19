import { z } from 'zod';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const timeZone = z.string().min(1).max(64).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return !/^[+-]/.test(value); } catch { return false; }
});
export const TimelineQuerySchema = z.object({
  day, timeZone, kind: z.enum(['all', 'routine', 'conversation', 'task', 'note', 'event']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.coerce.number().int().nonnegative().optional(), beforeId: z.string().min(1).max(180).optional(),
}).strict().refine(value => (value.before === undefined) === (value.beforeId === undefined));
const TimelineEntrySchema = z.object({
  id: z.string(), kind: z.enum(['routine', 'conversation', 'task', 'note', 'event']),
  action: z.enum(['scheduled', 'conversation', 'created', 'completed', 'updated']),
  title: z.string(), at: z.number(), recordId: z.string(), spaceId: z.string().nullable(),
  routineId: z.string().nullable(), status: z.string().nullable(), count: z.number().int().nonnegative(),
});
export const TimelineResponseSchema = z.object({
  day, timeZone, entries: z.array(TimelineEntrySchema),
  nextCursor: z.object({ before: z.number(), beforeId: z.string() }).nullable(),
});
export type TimelineQuery = z.infer<typeof TimelineQuerySchema>;
export type TimelineResponse = z.infer<typeof TimelineResponseSchema>;
