import { z } from 'zod';
import { HOURLY_MAX_INTERVAL } from '../calendar/recurrence.ts';

const WallTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** A reminder's rule: the shared calendar shape, or hourly (reminders only) with its daily window. */
export const ReminderRuleSchema = z.discriminatedUnion('freq', [
  z.object({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().min(1).optional(),
    byWeekday: z.array(z.number().int().min(0).max(6)).optional(),
    until: z.string().optional(),
    count: z.number().int().min(1).optional(),
  }),
  z.object({
    freq: z.literal('hourly'),
    interval: z.number().int().min(1).max(HOURLY_MAX_INTERVAL).optional(),
    window: z.object({ start: WallTime, end: WallTime }).optional(),
    until: z.string().optional(),
    count: z.number().int().min(1).optional(),
  }),
]);

/** An IANA zone the runtime knows. */
const ZoneSchema = z.string().min(1).refine((zone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, 'unknown time zone');

/** POST /api/spaces/:spaceId/reminders body. Recipients are user ids; each must be an active member. */
export const CreateReminderRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    due_at: z.number().int().positive(),
    due_zone: ZoneSchema,
    rrule: ReminderRuleSchema.nullable().optional(),
    task_id: z.string().uuid().optional(),
    recipient_user_ids: z.array(z.string().uuid()).min(1).max(50),
  })
  .strict();

/** PATCH /api/reminders/:id body. due_at and due_zone travel together; a timing or rule change bumps the revision. */
export const UpdateReminderRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    due_at: z.number().int().positive().optional(),
    due_zone: ZoneSchema.optional(),
    rrule: ReminderRuleSchema.nullable().optional(),
  })
  .strict()
  .refine((body) => (body.due_at === undefined) === (body.due_zone === undefined), 'due_at and due_zone go together')
  .refine((body) => Object.keys(body).length > 0, 'nothing to update');

/** POST /api/reminders/:id/occurrences/snooze body: the caller's own occurrence and when it rings again. */
export const SnoozeOccurrenceRequestSchema = z
  .object({ occurrence_id: z.string().uuid(), until: z.number().int().positive() })
  .strict();
