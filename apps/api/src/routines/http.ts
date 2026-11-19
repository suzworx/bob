import { Router, type Response } from 'express';
import { z } from 'zod';
import { StoreConflictError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import type { createGoogleConnectionService } from '../integrations/google-connection-service.ts';
import { GoogleCredentialError } from '../integrations/google-credentials.ts';
import { RoutineCreateSchema, RoutineDeleteSchema, RoutineSchema, RoutineUpdateSchema,
  InsightCategorySchema, InsightsResponseSchema, RoutineRunsResponseSchema } from '../web-schemas.ts';
import type { createInsightRefresh } from '../integrations/insight-refresh.ts';
import { createRoutine, deleteRoutine, listRoutines, updateRoutine } from './store.ts';
import { listInsights, listRoutineRuns, persistInsightDraft, getRoutineRun, listRoutineTimeline } from './run-store.ts';

import { RoutineTimelineQuerySchema, RoutineTimelineResponseSchema } from './execution-schemas.ts';

interface Dependencies { getDb(): Promise<Db>; connection?: Pick<ReturnType<typeof createGoogleConnectionService>, 'capabilities'>;
  refresh?: ReturnType<typeof createInsightRefresh> }
const Params = z.object({ id: z.uuid() });
const ListQuery = z.object({ includeArchived: z.enum(['true', 'false']).default('false').transform(value => value === 'true') }).strict();
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) sendError(response, 404, 'not_found');
  else if (error instanceof StoreConflictError) sendError(response, 409, 'conflict');
  else if (error instanceof GoogleCredentialError) sendError(response, 403, error.code);
  else if (error instanceof Error && error.message === 'insight_no_selected_calendars') sendError(response, 409, 'insight_no_selected_calendars');
  else sendError(response, 503, 'routine_unavailable');
}
async function authorize(deps: Dependencies, owner: string, account: string): Promise<void> {
  if (!deps.connection) throw new Error('routine_unavailable');
  const capabilities = await deps.connection.capabilities(owner, account, AbortSignal.timeout(15000));
  if (!capabilities.includes('gmail.read')) throw new GoogleCredentialError('permission_required');
}

export function createRoutineRouter(deps: Dependencies): Router {
  const router = Router();
  router.get('/', route({ query: ListQuery, mapError }, async ({ userId, query }, _req, res) => {
    res.json({ routines: z.array(RoutineSchema).parse(await listRoutines(await deps.getDb(), userId, query.includeArchived)) });
  }));
  router.post('/', route({ body: RoutineCreateSchema, mapError }, async ({ userId, body }, _req, res) => {
    await authorize(deps, userId, body.googleAccountId);
    res.status(201).json({ routine: await createRoutine(await deps.getDb(), userId, body, Date.now()) });
  }));
  router.patch('/:id', route({ params: Params, body: RoutineUpdateSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    const db = await deps.getDb();
    const current = (await listRoutines(db, userId)).find((item) => item.id === params.id);
    if (!current) throw new StoreNotFoundError('routine_not_found');
    if (body.googleAccountId || (body.status !== 'paused' && body.status !== 'archived')) await authorize(deps, userId, body.googleAccountId ?? current.googleAccountId);
    res.json({ routine: await updateRoutine(db, userId, params.id, body, Date.now()) });
  }));
  router.delete('/:id', route({ params: Params, body: RoutineDeleteSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    await deleteRoutine(await deps.getDb(), userId, params.id, body);
    res.status(204).end();
  }));
  router.get('/timeline', route({ query: RoutineTimelineQuerySchema, mapError }, async ({ userId, query }, _req, res) => {
    res.json(RoutineTimelineResponseSchema.parse(await listRoutineTimeline(await deps.getDb(), userId, query)));
  }));
  router.get('/:id/runs/:runId', route({ params: Params.extend({ runId: z.uuid() }), mapError }, async ({ userId, params }, _req, res) => {
    const run = await getRoutineRun(await deps.getDb(), userId, params.id, params.runId);
    if (!run) throw new StoreNotFoundError('routine_run_not_found');
    res.json({ run });
  }));
  router.get('/:id/runs', route({ params: Params, mapError }, async ({ userId, params }, _req, res) => {
    res.json(RoutineRunsResponseSchema.parse({ runs: await listRoutineRuns(await deps.getDb(), userId, params.id) }));
  }));
  return router;
}

export function createInsightsRouter(deps: Dependencies): Router {
  const router = Router();
  router.get('/', route({ query: z.object({ category: InsightCategorySchema.default('past') }).strict(), mapError }, async ({ userId, query }, _req, res) => {
    res.json(InsightsResponseSchema.parse({ insights: await listInsights(await deps.getDb(), userId, query.category) }));
  }));
  router.post('/refresh', route({ body: z.object({ googleAccountId: z.uuid(), category: z.enum(['future', 'reflections']) }).strict(), mapError }, async ({ userId, body }, _req, res) => {
    if (!deps.refresh) throw new Error('insight_refresh_unavailable');
    const signal = AbortSignal.timeout(60000);
    const draft = await deps.refresh[body.category]({ owner: userId, googleAccountId: body.googleAccountId, now: Date.now(), signal });
    // Fresh Calendar access at publication, not just before the first page.
    if (body.category === 'future') {
      const grants = await deps.connection?.capabilities(userId, body.googleAccountId, signal);
      if (!grants?.includes('calendar.read')) throw new GoogleCredentialError('permission_required');
    }
    signal.throwIfAborted();
    const insight = draft ? await persistInsightDraft(await deps.getDb(), userId, draft) : null;
    res.json(InsightsResponseSchema.parse({ insights: insight ? [insight] : [] }));
  }));
  return router;
}
