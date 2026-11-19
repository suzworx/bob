import { z } from 'zod';

function validTimeZone(value: string): boolean {
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export const RoutineScheduleSchema = z.object({
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(days => new Set(days).size === days.length).default([1,2,3,4,5,6,7]),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.string().min(1).max(100).refine(validTimeZone, 'Invalid time zone'),
}).strict();

const configuration = {
  name: z.string().trim().min(1).max(100).default('Email recap'),
  instructions: z.string().trim().max(2000).default(''),
  gmailQuery: z.string().trim().max(500).default(''),
  summaryStyle: z.enum(['concise', 'detailed']).default('concise'),
  emailResult: z.boolean().default(false),
};
export const RoutineCreateSchema = RoutineScheduleSchema.extend({
  ...configuration,
  kind: z.literal('daily_gmail_digest'),
  googleAccountId: z.uuid(),
  scheduledReadConsent: z.literal(true),
}).strict();

export const RoutineUpdateSchema = z.object({
  googleAccountId: z.uuid().optional(), scheduledReadConsent: z.literal(true).optional(),
  localTime: RoutineScheduleSchema.shape.localTime.optional(),
  timeZone: RoutineScheduleSchema.shape.timeZone.optional(),
  weekdays: RoutineScheduleSchema.shape.weekdays.removeDefault().optional(),
  name: configuration.name.removeDefault().optional(),
  instructions: configuration.instructions.removeDefault().optional(),
  gmailQuery: configuration.gmailQuery.removeDefault().optional(),
  summaryStyle: configuration.summaryStyle.removeDefault().optional(),
  emailResult: configuration.emailResult.removeDefault().optional(),
  expectedRevision: z.number().int().positive().max(2_147_483_646),
  status: z.enum(['active', 'paused', 'archived']).optional(),
}).strict().refine(value => value.googleAccountId === undefined || value.scheduledReadConsent === true, 'Consent is required to change accounts').refine((value) => value.googleAccountId !== undefined || value.localTime !== undefined || value.timeZone !== undefined || value.status !== undefined || value.weekdays !== undefined || value.name !== undefined || value.instructions !== undefined || value.gmailQuery !== undefined || value.summaryStyle !== undefined || value.emailResult !== undefined,
  'A routine change is required');

export const RoutineDeleteSchema = z.object({
  expectedRevision: z.number().int().positive().max(2_147_483_646),
}).strict();

export const RoutineSchema = RoutineCreateSchema.extend({
  id: z.uuid(),
  status: z.enum(['active', 'paused', 'archived']),
  revision: z.number().int().positive(),
  nextRunAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
}).strict();
