import { z } from 'zod';

export const InsightCategorySchema = z.enum(['future', 'reflections', 'past']);
export const InsightSourceSchema = z.object({
  kind: z.enum(['gmail', 'calendar']), id: z.string().min(1).max(200), label: z.string().max(300),
  url: z.url().max(2048).refine((value) => new URL(value).protocol === 'https:').optional(),
}).strict();
export const InsightSchema = z.object({
  id: z.uuid(), routineId: z.uuid().nullable(), googleAccountId: z.uuid(), category: InsightCategorySchema,
  title: z.string().min(1).max(160), summary: z.string().min(1).max(6000),
  periodStart: z.number().int(), periodEnd: z.number().int(), generatedAt: z.number().int(),
  sources: z.array(InsightSourceSchema).max(200), partial: z.boolean(), messageCount: z.number().int().min(0).max(200),
}).strict();
const RoutineResultSchema = InsightSchema.omit({ category: true, routineId: true, googleAccountId: true });
export const RoutineRunSchema = z.object({
  id: z.uuid(), routineId: z.uuid(), scheduledAt: z.number().int(),
  startedAt: z.number().int().nullable(), completedAt: z.number().int().nullable(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
  failureCode: z.enum(['consent_unavailable', 'provider_unavailable', 'summary_unavailable', 'cancelled', 'missed', 'stale']).nullable(),
  emailOutcome: z.enum(['queued', 'muted']).nullable().default(null),
  insightId: z.uuid().nullable(),
  routineName: z.string().max(100).default('Email recap'),
  coverageStart: z.number().int().optional(), coverageEnd: z.number().int().optional(),
  result: RoutineResultSchema.nullable().default(null),
}).strict();
export const InsightsResponseSchema = z.object({ insights: z.array(InsightSchema).max(100) }).strict();
export const RoutineRunsResponseSchema = z.object({ runs: z.array(RoutineRunSchema).max(100) }).strict();

export const RoutineTimelineQuerySchema = z.object({
  before: z.coerce.number().int().optional(), beforeId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict().refine(value => (value.before === undefined) === (value.beforeId === undefined), 'Both cursor fields are required');
export const RoutineTimelineResponseSchema = z.object({ runs: z.array(RoutineRunSchema).max(100), nextCursor: z.object({ before: z.number().int(), beforeId: z.uuid() }).nullable() }).strict();
