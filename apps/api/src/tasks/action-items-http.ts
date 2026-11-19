/**
 * REST routes for the account's action items, mounted under /api/action-items.
 * An other-account or unknown id answers exactly like a missing one (no
 * oracle). When memoryAvailable() is false the routes answer 503
 * memory_unavailable rather than an empty list. Journal events carry ids,
 * counts and the status only, never content.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { route, sendError } from '../platform/http/route.ts';
import { moduleJournal } from '../platform/logger.ts';
import { StoreError, type Db } from '../platform/db/db.ts';
import { listActionItems, setActionItemStatus } from './action-items-store.ts';
import { memoryAvailable as memoryAvailableProbe } from '../memory/available.ts';
import {
  ActionItemUpdateRequestSchema,
  ActionItemsQuerySchema,
  ActionItemsResponseSchema,
  ActionItemSummarySchema,
  OpaqueId,
} from '../web-schemas.ts';

const journal = moduleJournal('tasks');

interface ActionItemsRouterDeps {
  getDb: () => Promise<Db>;
  /** Overridable in tests; defaults to the runtime guard. */
  memoryAvailable?: (db: Db) => Promise<boolean>;
}

/** A store outage must be loud, never a fake empty action-item list. */
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreError) {
    sendError(response, 500, 'store_error');
    return;
  }
  throw error;
}

const IdParams = z.object({ id: OpaqueId });

export function createActionItemsRouter({
  getDb,
  memoryAvailable = memoryAvailableProbe,
}: ActionItemsRouterDeps): Router {
  const router = Router();

  router.get('/', route({ query: ActionItemsQuerySchema, mapError }, async ({ query, userId }, _request, response) => {
    const db = await getDb();
    if (!(await memoryAvailable(db))) {
      sendError(response, 503, 'memory_unavailable');
      return;
    }
    const items = await listActionItems(db, userId, {
      status: query.status,
      dueBefore: query.due_before,
      limit: query.limit,
    });
    journal('v2.action_items_listed', { count: items.length, status: query.status });
    response.status(200).json(ActionItemsResponseSchema.parse({ action_items: items }));
  }));

  router.patch('/:id', route({ body: ActionItemUpdateRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const db = await getDb();
      if (!(await memoryAvailable(db))) {
        sendError(response, 503, 'memory_unavailable');
        return;
      }
      // The store answers null for an unknown/foreign id: exactly not_found.
      const updated = await setActionItemStatus(db, userId, params.id, body.status);
      if (!updated) {
        sendError(response, 404, 'not_found');
        return;
      }
      journal('v2.action_item_updated', { action_item_id: params.id, status: body.status });
      response.status(200).json(ActionItemSummarySchema.parse(updated));
    }));

  return router;
}
