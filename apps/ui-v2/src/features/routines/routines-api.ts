import { z } from 'zod';
import { fetchWithAuth } from '@/lib/auth/use-session';

// Browser mirrors of the private integration DTOs; no provider code reaches the client.
const scheduleSchema = z.object({ localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timeZone: z.string().min(1).max(100), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6, 7]) });
const configuration = { name: z.string().trim().min(1).max(100).default('Email recap'), instructions: z.string().trim().max(2000).default(''), gmailQuery: z.string().trim().max(500).default(''), summaryStyle: z.enum(['concise', 'detailed']).default('concise'), emailResult: z.boolean().default(false) };
const createSchema = scheduleSchema.extend({ ...configuration, kind: z.literal('daily_gmail_digest'), googleAccountId: z.uuid(), scheduledReadConsent: z.literal(true) }).strict();
const updateSchema = scheduleSchema.partial().extend({ weekdays: scheduleSchema.shape.weekdays.removeDefault().optional(), name: configuration.name.removeDefault().optional(), instructions: configuration.instructions.removeDefault().optional(), gmailQuery: configuration.gmailQuery.removeDefault().optional(), summaryStyle: configuration.summaryStyle.removeDefault().optional(), emailResult: configuration.emailResult.removeDefault().optional(), expectedRevision: z.number().int().positive(), status: z.enum(['active', 'paused', 'archived']).optional(), googleAccountId: z.uuid().optional(), scheduledReadConsent: z.literal(true).optional() }).strict();
const routineSchema = createSchema.extend({ id: z.uuid(), status: z.enum(['active', 'paused', 'archived']), revision: z.number().int().positive(), nextRunAt: z.number().int().nullable(), createdAt: z.number().int(), updatedAt: z.number().int() });
const sourceSchema = z.object({ kind: z.enum(['gmail', 'calendar']), id: z.string(), label: z.string(), url: z.string().url().refine((value) => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }).optional() });
const resultSchema = z.object({ id: z.string(), title: z.string(), summary: z.string(), sources: z.array(sourceSchema), periodStart: z.number(), periodEnd: z.number(), generatedAt: z.number(), partial: z.boolean(), messageCount: z.number().int().nonnegative() });
const runSchema = z.object({ id: z.string(), routineId: z.string(), routineName: z.string().default('Email recap'), coverageStart: z.number().nullable().default(null), coverageEnd: z.number().nullable().default(null), result: resultSchema.nullable().default(null), emailOutcome: z.enum(['queued', 'muted']).nullable().default(null), scheduledAt: z.number(), startedAt: z.number().nullable(), completedAt: z.number().nullable(), status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']), failureCode: z.string().nullable(), insightId: z.string().nullable() });
export type Routine = z.infer<typeof routineSchema>;
export type RoutineCreate = z.input<typeof createSchema>;
export type RoutineUpdate = z.infer<typeof updateSchema>;
export type RoutineRun = z.infer<typeof runSchema>;
export type RoutineResult = z.infer<typeof resultSchema>;

export class RoutineRequestError extends Error {
  constructor(readonly status: number) { super('routine_request_failed'); }
}

async function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const response = await fetchWithAuth(`/api/routines${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new RoutineRequestError(response.status);
  return response;
}

export async function listRoutines(): Promise<Routine[]> {
  return z.object({ routines: z.array(routineSchema) }).parse(await (await request('?includeArchived=true')).json()).routines;
}
export async function createRoutine(input: RoutineCreate): Promise<Routine> {
  return z.object({ routine: routineSchema }).parse(await (await request('', 'POST', createSchema.parse(input))).json()).routine;
}
export async function updateRoutine(id: string, input: RoutineUpdate): Promise<Routine> {
  return z.object({ routine: routineSchema }).parse(await (await request(`/${encodeURIComponent(id)}`, 'PATCH', updateSchema.parse(input))).json()).routine;
}
export async function deleteRoutine(routine: Routine): Promise<void> {
  await request(`/${encodeURIComponent(routine.id)}`, 'DELETE', { expectedRevision: routine.revision });
}
export async function listRoutineRuns(id: string): Promise<RoutineRun[]> {
  return z.object({ runs: z.array(runSchema) }).parse(await (await request(`/${encodeURIComponent(id)}/runs`)).json()).runs;
}
export async function getRoutineRun(id: string, runId: string): Promise<RoutineRun> {
  return z.object({ run: runSchema }).parse(await (await request(`/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`)).json()).run;
}
