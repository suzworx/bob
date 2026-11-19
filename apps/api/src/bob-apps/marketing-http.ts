import { Router, type Response } from 'express';
import { z } from 'zod';
import { StoreConflictError, StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import { changeMarketingLifecycle, getMarketingInstallation, installMarketingPackage, listMarketingInstallations, readSelectedMarketingInstallationId, selectMarketingInstallation } from './marketing-install.ts';
import { MarketingInstallResponseSchema, MarketingInstallSchema, MarketingInstallationsResponseSchema, MarketingInstallationsQuerySchema, MarketingLifecycleSchema, MarketingPackageResponseSchema, MarketingSelectionResponseSchema, MarketingSelectionSchema } from './marketing-schemas.ts';
import { marketingPackage } from './marketing-registry.ts';

// Kind codes with plain copy. Errors never echo store internals or ids.
const COPY = {
  not_found: 'That installation was not found.',
  conflict: 'That change conflicts with the current state. Refresh and try again.',
  invalid: 'That change is not allowed.',
  unavailable: 'Marketing is unavailable right now. Try again soon.',
} as const;
const Params = z.strictObject({ id: z.uuid() });

function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) sendError(response, 404, 'not_found', COPY.not_found);
  else if (error instanceof StoreConflictError) sendError(response, 409, 'conflict', COPY.conflict);
  else if (error instanceof StoreError && error.message === 'marketing_operation_limit') {
    sendError(response, 503, 'limit_reached', 'This account has reached its recorded marketing change limit. Pausing still works.');
  } else if (error instanceof StoreError && error.message === 'marketing_package_unavailable') sendError(response, 503, 'unavailable', COPY.unavailable);
  else if (error instanceof StoreError || error instanceof z.ZodError) sendError(response, 400, 'invalid', COPY.invalid);
  else sendError(response, 503, 'unavailable', COPY.unavailable);
}

// Mounted ahead of the generic /:id routes. Every route answers for the signed-in account only.
export function createMarketingRouter(deps: { getDb(): Promise<Db> }): Router {
  const router = Router();
  router.get('/marketing/package', route({ mapError }, async (_input, _req, res) => {
    res.json(MarketingPackageResponseSchema.parse({ package: marketingPackage() }));
  }));
  // The session comes from the authenticated request, never from the body: the service checks it under the owner lock.
  router.post('/marketing/install', route({ body: MarketingInstallSchema, mapError }, async ({ userId, body }, req, res) => {
    res.status(201).json(MarketingInstallResponseSchema.parse({ installation: await installMarketingPackage(await deps.getDb(), userId, body, req.account?.sessionId ?? '') }));
  }));
  router.get('/marketing/installations', route({ query: MarketingInstallationsQuerySchema, mapError }, async ({ userId, query }, _req, res) => {
    const db = await deps.getDb();
    const installations = await listMarketingInstallations(db, userId, query);
    const selected = await readSelectedMarketingInstallationId(db, userId);
    res.json(MarketingInstallationsResponseSchema.parse({ installations, selectedInstallationId: installations.some((item) => item.id === selected) ? selected : null }));
  }));
  router.get('/marketing/installations/:id', route({ params: Params, mapError }, async ({ userId, params }, _req, res) => {
    res.json(MarketingInstallResponseSchema.parse({ installation: await getMarketingInstallation(await deps.getDb(), userId, params.id) }));
  }));
  router.post('/marketing/installations/:id/lifecycle', route({ params: Params, body: MarketingLifecycleSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    res.json(MarketingInstallResponseSchema.parse({ installation: await changeMarketingLifecycle(await deps.getDb(), userId, params.id, body) }));
  }));
  // Selection (set or clear) checks the session under the owner lock, like install. The session comes from the request only.
  router.post('/marketing/selection', route({ body: MarketingSelectionSchema, mapError }, async ({ userId, body }, req, res) => {
    res.json(MarketingSelectionResponseSchema.parse({ selection: await selectMarketingInstallation(await deps.getDb(), userId, body, req.account?.sessionId ?? '') }));
  }));
  return router;
}
