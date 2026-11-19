import { z } from 'zod';
import { RoutineScheduleSchema } from '../routines/schemas.ts';
export const BobAppRefreshConfigSchema = z.strictObject({ source: z.literal('tasks'), spaceId: z.uuid(), targetTable: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), schedule: RoutineScheduleSchema });
export const BobAppRefreshInputSchema = z.strictObject({ expectedRevision: z.number().int().positive(), mutationId: z.uuid(), enabled: z.boolean(), consent: z.literal(true), config: BobAppRefreshConfigSchema.nullable() }).refine((v) => !v.enabled || v.config !== null);
export const BobAppRefreshSchema = z.strictObject({ enabled: z.boolean(), config: BobAppRefreshConfigSchema.nullable(), nextRunAt: z.number().nullable(), lastRefreshAt: z.number().nullable(), lastError: z.string().nullable() });
export const BobAppRunsSchema = z.strictObject({ runs: z.array(z.strictObject({ id: z.uuid(), status: z.enum(['pending','completed','failed','skipped']), scheduledAt: z.number(), completedAt: z.number().nullable(), failureCode: z.string().nullable() })) });
