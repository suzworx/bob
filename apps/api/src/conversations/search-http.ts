/**
 * REST route for scoped search. Authorization happens in the search query
 * itself (search-store.ts). Journal events carry counts and a bounded scope
 * label only -- never titles, snippets or query text.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { OpaqueId } from '../platform/id-schemas.ts';
import { route, sendError } from '../platform/http/route.ts';
import { moduleJournal } from '../platform/logger.ts';
import { StoreError, type Db } from '../platform/db/db.ts';
import { searchResources, type SearchResourceType } from './search-store.ts';

const journal = moduleJournal('conversations');

interface SearchRouterDeps {
  getDb: () => Promise<Db>;
}

const RESOURCE_TYPE = z.enum(['task', 'note', 'event', 'thread']);

// `type` is repeatable (?type=note&type=task); express hands a single value as
// a string and repeats as an array, so normalise to an array before validating.
const SearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    space_id: z.string().uuid().optional(),
    type: z
      .preprocess(
        (value) => (Array.isArray(value) ? value : value === undefined ? undefined : [value]),
        z.array(RESOURCE_TYPE).max(4),
      )
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

const SearchResultSchema = z
  .object({
    resource_type: RESOURCE_TYPE,
    resource_id: OpaqueId,
    space_id: z.string().uuid(),
    title: z.string(),
    snippet: z.string(),
    updated_at: z.number().int().nonnegative(),
    rank: z.number().int().nonnegative(),
  })
  .strict();

export const SearchResponseSchema = z.object({ results: z.array(SearchResultSchema) }).strict();

/** searchResources raises only on internal misuse; anything else is rethrown so
 *  the net webErrorHandler answers a generic 500, never a silent 200. */
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreError) {
    sendError(response, 400, 'invalid_request', error.message);
    return;
  }
  throw error;
}

export function createSearchRouter({ getDb }: SearchRouterDeps): Router {
  const router = Router();

  router.get('/search', route({ query: SearchQuerySchema, mapError }, async ({ query, userId }, _request, response) => {
    const results = await searchResources(await getDb(), userId, {
      query: query.q,
      spaceId: query.space_id,
      types: query.type as SearchResourceType[] | undefined,
      limit: query.limit,
    });
    journal('v2.search', { count: results.length, scope: query.space_id ? 'space' : 'all' });
    response.status(200).json(SearchResponseSchema.parse({ results }));
  }));

  return router;
}
