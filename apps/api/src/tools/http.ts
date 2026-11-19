import { Router, type Response } from 'express';
import type { Db } from '../platform/db/db.ts';
import { StoreNotFoundError } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import { ToolCatalogResponseSchema, ToolContextSchema, ToolPreferenceSchema } from './schemas.ts';
import { getEffectiveTools, setToolPreference } from './store.ts';
function mapError(res: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) sendError(res, 404, 'not_found');
  else sendError(res, 503, 'tools_unavailable');
}
export function createToolsRouter(deps: { getDb(): Promise<Db> }): Router {
  const router = Router();
  router.get('/', route({ query: ToolContextSchema, mapError }, async ({ userId, query }, _req, res) => {
    res.json(ToolCatalogResponseSchema.parse(await getEffectiveTools(await deps.getDb(), userId, query)));
  }));
  router.patch('/preferences', route({ body: ToolPreferenceSchema, mapError }, async ({ userId, body }, _req, res) => {
    res.json(ToolCatalogResponseSchema.parse(await setToolPreference(await deps.getDb(), userId, body)));
  }));
  return router;
}
