import { Router, type Response } from 'express';
import { z } from 'zod';
import { StoreConflictError, StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import { BobAppRefreshInputSchema, BobAppRefreshSchema, BobAppRunsSchema } from './refresh-schemas.ts';
import { configureBobAppRefresh, getBobAppRefresh, listBobAppRuns } from './refresh-store.ts';

const Params = z.strictObject({ id: z.uuid() });
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) sendError(response, 404, 'not_found');
  else if (error instanceof StoreConflictError) sendError(response, 409, 'conflict');
  else if (error instanceof StoreError || error instanceof z.ZodError) sendError(response, 400, 'app_refresh_unavailable');
  else sendError(response, 503, 'app_refresh_unavailable');
}
export function createBobAppRefreshRouter(deps: { getDb(): Promise<Db> }): Router {
  const router = Router();
  router.get('/:id/refresh', route({ params: Params, mapError }, async ({ userId, params }, _request, response) => {
    response.json(BobAppRefreshSchema.parse(await getBobAppRefresh(await deps.getDb(), userId, params.id)));
  }));
  router.put('/:id/refresh', route({ params: Params, body: BobAppRefreshInputSchema, mapError }, async ({ userId, params, body }, _request, response) => {
    response.json(BobAppRefreshSchema.parse(await configureBobAppRefresh(await deps.getDb(), userId, params.id, body)));
  }));
  router.get('/:id/runs', route({ params: Params, mapError }, async ({ userId, params }, _request, response) => {
    response.json(BobAppRunsSchema.parse(await listBobAppRuns(await deps.getDb(), userId, params.id)));
  }));
  return router;
}
