/**
 * DELETE /api/account: self-service account deletion. The route keeps auth, the
 * request body and the HTTP response; the steps live in
 * workflows/workflow-account-deletion.ts.
 *
 * Not atomic: each step commits on its own. A 500 mid-way is safe to retry --
 * every step is idempotent, so a second DELETE re-runs cleanly and picks up
 * wherever the first call left off.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { route, sendError } from '../platform/http/route.ts';
import type { Db } from '../platform/db/db.ts';
import type { createGoogleConnectionService } from '../integrations/google-connection-service.ts';
import { type DeviceSessions } from '../voice/device-sessions.ts';
import { deleteAccount } from '../workflows/workflow-account-deletion.ts';
import { AccountDeleteRefusedSchema, AccountDeleteRequestSchema } from '../web-schemas.ts';

interface AccountRouterDeps {
  getDb: () => Promise<Db>;
  requireActiveSession: (request: Request, response: Response, next: NextFunction) => Promise<void>;
  deviceSessions: Pick<DeviceSessions, 'closeDevice'>;
  googleConnection?: Pick<ReturnType<typeof createGoogleConnectionService>, 'revoke'>;
  now?: () => number;
}

export function createAccountRouter({
  getDb,
  requireActiveSession,
  deviceSessions,
  googleConnection,
  now = Date.now,
}: AccountRouterDeps): Router {
  const router = Router();

  // No mapError: a failure before or during erasure is an Express 500, only the
  // purge after it maps StoreError to store_error.
  router.delete('/', requireActiveSession, route({ body: AccountDeleteRequestSchema },
    async ({ userId }, _request, response) => {
      const result = await deleteAccount(
        { db: await getDb(), googleConnection, deviceSessions, now },
        { userId },
      );
      switch (result.outcome) {
        case 'deleted':
          response.status(204).end();
          return;
        case 'owns_groups':
          response
            .status(409)
            .json(AccountDeleteRefusedSchema.parse({ error: { code: 'owns_groups', count: result.count } }));
          return;
        case 'store_error':
          sendError(response, 500, 'store_error');
          return;
      }
    }));

  return router;
}
