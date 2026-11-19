import { z } from 'zod';

export const TimerNotificationStateQuerySchema = z.object({
  ids: z.string().max(2_219).default('').transform((value) => value === '' ? [] : value.split(','))
    .pipe(z.array(z.string().uuid()).max(60))
    .refine((ids) => new Set(ids).size === ids.length),
}).strict();

export const TimerNotificationStateResponseSchema = z.object({
  timers: z.array(z.object({
    id: z.string().uuid(),
    kind: z.enum(['timer', 'alarm']),
    label: z.string().nullable(),
    fire_at: z.number(),
    remaining_ms: z.number().int().min(0),
    zone: z.string(),
    status: z.enum(['pending', 'fired', 'cancelled', 'dismissed']),
  })).max(120),
});
