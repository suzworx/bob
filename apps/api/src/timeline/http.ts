import { Router } from 'express';
import type { Db } from '../platform/db/db.ts';
import { route } from '../platform/http/route.ts';
import { TimelineQuerySchema } from './schemas.ts';
import { listTimeline } from './store.ts';

export function createTimelineRouter(deps: { getDb: () => Promise<Db> }): Router {
  const router = Router();
  router.get('/', route({ query: TimelineQuerySchema }, async ({ userId, query }, _request, response) => {
    response.json(await listTimeline(await deps.getDb(), userId, query));
  }));
  return router;
}
