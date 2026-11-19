import { Router } from 'express';
import { requireActiveSession } from '../platform/http/auth-guard.ts';
import { route, sendError } from '../platform/http/route.ts';
import type { Db } from '../platform/db/db.ts';
import { PushDeviceParamsSchema, PushRegisteredSchema, PushRegistrationSchema } from './push-schemas.ts';
import { registerPushDevice, removePushDevice } from './push-store.ts';
import { pushTopics, configuredApnsSender } from './push-apns.ts';

export function createPushRouter(deps: { getDb: () => Promise<Db>; topics?: () => readonly string[] }): Router {
  const router = Router();
  router.use(requireActiveSession(deps.getDb));
  router.post('/push/devices', route({ body: PushRegistrationSchema }, async ({ body, userId }, request, response) => {
    const db = await deps.getDb();
    if (!(deps.topics ?? pushTopics)().includes(body.topic)) {
      sendError(response,400,'push_topic_unavailable'); return;
    }
    const sessionId = request.account?.sessionId;
    if (!sessionId || !await registerPushDevice(db,userId,sessionId,body)) {
      sendError(response,401,'invalid_token'); return;
    }
    response.json(PushRegisteredSchema.parse({ registered: true, delivery_available: configuredApnsSender() !== null }));
  }));
  router.delete('/push/devices/:installationId', route({ params: PushDeviceParamsSchema }, async ({ params,userId }, request,response) => {
    const db = await deps.getDb();
    await removePushDevice(db,userId,params.installationId);
    response.status(204).end();
  }));
  return router;
}
