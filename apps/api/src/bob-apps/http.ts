import { Router, type Response } from 'express';
import { z } from 'zod';
import { StoreConflictError, StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import { BobAppConversationResponseSchema, BobAppActionSchema, BobAppCreateSchema, BobAppDeleteSchema, BobAppExportSchema, BobAppMutationSchema, BobAppResponseSchema, BobAppsQuerySchema, BobAppsResponseSchema } from './api-schemas.ts';
import { createBobApp, deleteBobApp, getBobApp, listBobApps, mutateBobApp, runBobAppAction } from './store.ts';

const Params = z.strictObject({ id: z.uuid() });
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) sendError(response, 404, 'not_found');
  else if (error instanceof StoreConflictError) sendError(response, 409, 'conflict');
  else if (error instanceof StoreError || error instanceof z.ZodError) sendError(response, 400, 'app_change_unavailable');
  else sendError(response, 503, 'app_unavailable');
}
export function createBobAppsRouter(deps: { getDb(): Promise<Db>; openAppConversation?: (actor: string, appId: string) => Promise<{ conversationId: string; spaceId: string }> }): Router {
  const router = Router();
  router.get('/', route({ query: BobAppsQuerySchema, mapError }, async ({ userId, query }, _req, res) => {
    const apps = await listBobApps(await deps.getDb(), userId, query);
    res.json(BobAppsResponseSchema.parse({ apps, nextCursor: apps.length === query.limit ? apps.at(-1)?.id ?? null : null }));
  }));
  router.post('/', route({ body: BobAppCreateSchema, mapError }, async ({ userId, body }, _req, res) => {
    res.status(201).json(BobAppResponseSchema.parse({ app: await createBobApp(await deps.getDb(), userId, body) }));
  }));
  router.post('/:id/conversation', route({ params: Params, mapError }, async ({ userId, params }, req, res) => {
    if (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding']) throw new StoreError('app_conversation_body_not_allowed');
    if (!deps.openAppConversation) throw new StoreError('app_conversation_unavailable');
    res.json(BobAppConversationResponseSchema.parse(await deps.openAppConversation(userId, params.id)));
  }));
  router.get('/:id', route({ params: Params, mapError }, async ({ userId, params }, _req, res) => {
    res.json(BobAppResponseSchema.parse({ app: await getBobApp(await deps.getDb(), userId, params.id) }));
  }));
  router.get('/:id/export', route({ params: Params, mapError }, async ({ userId, params }, _req, res) => {
    const app = await getBobApp(await deps.getDb(), userId, params.id);
    res.setHeader('Content-Disposition', 'attachment; filename="bob-app.json"');
    res.json(BobAppExportSchema.parse({ schemaVersion: 1, updatedAt: app.updatedAt, definition: app.definition, state: app.state }));
  }));
  router.post('/:id/actions', route({ params: Params, body: BobAppActionSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    res.json(BobAppResponseSchema.parse({ app: await runBobAppAction(await deps.getDb(), userId, params.id, body) }));
  }));
  router.patch('/:id', route({ params: Params, body: BobAppMutationSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    res.json(BobAppResponseSchema.parse({ app: await mutateBobApp(await deps.getDb(), userId, params.id, body) }));
  }));
  router.delete('/:id', route({ params: Params, body: BobAppDeleteSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    await deleteBobApp(await deps.getDb(), userId, params.id, body); res.status(204).end();
  }));
  return router;
}
