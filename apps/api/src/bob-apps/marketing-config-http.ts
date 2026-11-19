import { Router, type Response } from 'express';
import { z } from 'zod';
import { StoreConflictError, StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import {
  MarketingConfigHistoryQuerySchema, MarketingConfigApplyRequestSchema, MarketingConfigDetailResponseSchema, MarketingConfigDiscardRequestSchema, MarketingConfigMutationResponseSchema,
  MarketingConfigProposeRequestSchema, MarketingConfigRestoreRequestSchema,
} from './marketing-config-schemas.ts';
import {
  applyMarketingConfigProposal, discardMarketingConfigProposal, proposeMarketingConfig, readMarketingConfig, restoreMarketingConfigVersion,
} from './marketing-config-store.ts';

// Kind codes with plain copy. Errors never echo store internals, ids or the submitted config.
const COPY = {
  not_found: 'That was not found.',
  conflict: 'That change conflicts with the current configuration. Refresh and try again.',
  invalid: 'That change is not allowed.',
  unavailable: 'That setting is not available yet.',
  limit: 'This Marketing workspace has reached its recorded configuration change limit. Viewing still works.',
  busy: 'Marketing is unavailable right now. Try again soon.',
} as const;
const Params = z.strictObject({ id: z.uuid() });

function mapError(response: Response, error: unknown): void {
  const code = error instanceof StoreError || error instanceof StoreConflictError || error instanceof StoreNotFoundError ? error.message : '';
  if (error instanceof StoreNotFoundError || code === 'marketing_version_unavailable') sendError(response, 404, 'not_found', COPY.not_found);
  else if (error instanceof StoreConflictError) sendError(response, 409, 'conflict', COPY.conflict);
  else if (code === 'marketing_operation_limit' || code === 'marketing_proposal_limit') sendError(response, 503, 'limit_reached', COPY.limit);
  else if (code === 'marketing_extension_unavailable') sendError(response, 422, 'unavailable', COPY.unavailable);
  else if (code === 'marketing_proposal_tampered') sendError(response, 400, 'invalid', COPY.invalid);
  else if (error instanceof StoreError || error instanceof z.ZodError) sendError(response, 400, 'invalid', COPY.invalid);
  else sendError(response, 503, 'unavailable', COPY.busy);
}

// Mounted at /api/bob-apps/marketing. Every route answers for the signed-in account only; the owner is never read from the body.
export function createMarketingConfigRouter(deps: { getDb(): Promise<Db> }): Router {
  const router = Router();
  router.get('/installations/:id/config', route({ params: Params, query: MarketingConfigHistoryQuerySchema, mapError }, async ({ userId, params, query }, _req, res) => {
    res.json(MarketingConfigDetailResponseSchema.parse(await readMarketingConfig(await deps.getDb(), userId, params.id, query.beforeRevision)));
  }));
  router.post('/installations/:id/config/proposals', route({ params: Params, body: MarketingConfigProposeRequestSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    res.status(201).json(MarketingConfigMutationResponseSchema.parse(await proposeMarketingConfig(await deps.getDb(), userId, params.id, body)));
  }));
  router.post('/installations/:id/config/apply', route({ params: Params, body: MarketingConfigApplyRequestSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    res.json(MarketingConfigMutationResponseSchema.parse(await applyMarketingConfigProposal(await deps.getDb(), userId, params.id, body)));
  }));
  router.post('/installations/:id/config/discard', route({ params: Params, body: MarketingConfigDiscardRequestSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    res.json(MarketingConfigMutationResponseSchema.parse(await discardMarketingConfigProposal(await deps.getDb(), userId, params.id, body)));
  }));
  router.post('/installations/:id/config/restore', route({ params: Params, body: MarketingConfigRestoreRequestSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    res.json(MarketingConfigMutationResponseSchema.parse(await restoreMarketingConfigVersion(await deps.getDb(), userId, params.id, body)));
  }));
  return router;
}
