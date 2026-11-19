import { createAdminManagementRouter } from './admin-management-http.ts';
import { Router, type RequestHandler } from 'express';
import { createTokenBucket } from '../platform/http/rate-limit.ts';
import { route, sendError } from '../platform/http/route.ts';
import { moduleJournal } from '../platform/logger.ts';
import { requireScope } from '../platform/observability/operator-gate.ts';
import { AdminAccountRequestSchema, AdminAccountResponseSchema } from './admin-schemas.ts';
import { ensureInviteeAccount } from './provisioning.ts';
import { queueAdminInvitation, type InvitationStatus } from './admin-invitation.ts';
import type { Db } from '../platform/db/db.ts';

export const ACCOUNT_ADMIN_SCOPE = 'accounts.admin';
const journal = moduleJournal('account');

type AdminRouterDeps = {
  getDb: () => Promise<Db>;
  requireActiveSession: RequestHandler;
  checkAccess: (userId: string) => Promise<boolean>;
};

/** Sign-in access and a durable Bob invitation; no Space membership or role changes. */
export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();
  const limiter = createTokenBucket(10);
  router.use(deps.requireActiveSession, requireScope(ACCOUNT_ADMIN_SCOPE, deps.checkAccess));
  router.use(createAdminManagementRouter(deps.getDb));
  router.get('/access', (_request, response) => {
    response.status(204).end();
  });
  router.post(
    '/accounts',
    route({ body: AdminAccountRequestSchema }, async ({ body, userId }, request, response) => {
      if (!limiter.take(userId)) {
        sendError(response, 429, 'rate_limited');
        return;
      }
      const outcome = await ensureInviteeAccount(body.email);
      journal('v2.admin_account_provisioned', { outcome });
      if (outcome === 'skipped' || outcome === 'failed') {
        sendError(
          response,
          503,
          outcome === 'skipped' ? 'provisioning_unavailable' : 'provisioning_failed',
        );
        return;
      }
      let invitation: InvitationStatus = 'failed';
      try {
        const db = await deps.getDb();
        invitation = await queueAdminInvitation(
          db,
          userId,
          request.account?.sessionId ?? '',
          body.email,
          body.retryInvitation ?? false,
        );
      } catch {
        // Account access is independent of the queue transaction.
        invitation = 'failed';
      }
      journal('v2.admin_invitation_queued', { outcome: invitation });
      response
        .status(outcome === 'created' ? 201 : 200)
        .json(AdminAccountResponseSchema.parse({ status: outcome, invitation }));
    }),
  );
  return router;
}
