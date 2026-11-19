import { AdminWaitlistRequestSchema } from './admin-waitlist-schemas.ts';
import { searchAdminWaitlist } from './admin-waitlist.ts';
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Db } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import { createTokenBucket } from '../platform/http/rate-limit.ts';
import { moduleJournal } from '../platform/logger.ts';
import {
  AdminSearchRequestSchema,
  AdminMutationRequestSchema,
  AdminMutationResponseSchema,
} from './admin-schemas.ts';
import { searchAdminAccounts, mutateAdminAccount } from './admin-management.ts';

function managementError(response: Response, error: unknown): void {
  const denied =
    typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';
  sendError(response, denied ? 403 : 503, denied ? 'admin_required' : 'administration_unavailable');
}
const journal = moduleJournal('account');
/** Mounted inside the fresh admin gate; the SQL repeats authority inside its transaction. */
export function createAdminManagementRouter(getDb: () => Promise<Db>): Router {
  const router = Router();
  const searchLimit = createTokenBucket(60);
  const mutationLimit = createTokenBucket(10);
  router.post(
    '/accounts/search',
    route(
      {
        body: AdminSearchRequestSchema,
        query: z.object({}).strict(),
        mapError: managementError,
      },
      async ({ body, userId }, request, response) => {
        if (!searchLimit.take(userId)) {
          sendError(response, 429, 'rate_limited');
          return;
        }
        response.json(
          await searchAdminAccounts(await getDb(), userId, request.account?.sessionId ?? '', body),
        );
      },
    ),
  );
  router.post(
    '/waitlist/search',
    route(
      { body: AdminWaitlistRequestSchema, query: z.object({}).strict(), mapError: managementError },
      async ({ body, userId }, request, response) => {
        if (!searchLimit.take(userId)) {
          sendError(response, 429, 'rate_limited');
          return;
        }
        response.set('Cache-Control', 'no-store');
        response.json(await searchAdminWaitlist(await getDb(), userId, request.account?.sessionId ?? '', body));
      },
    ),
  );
  router.post(
    '/accounts/manage',
    route(
      {
        body: AdminMutationRequestSchema,
        query: z.object({}).strict(),
        mapError: managementError,
      },
      async ({ body, userId }, request, response) => {
        if (!mutationLimit.take(userId)) {
          sendError(response, 429, 'rate_limited');
          return;
        }
        const outcome = await mutateAdminAccount(
          await getDb(),
          userId,
          request.account?.sessionId ?? '',
          body,
        );
        // Fixed enums only: never export target IDs, addresses, search terms or request bodies.
        journal('v2.admin_account_managed', { action: body.action, outcome });
        if (outcome === 'updated') {
          response.json(AdminMutationResponseSchema.parse({ status: 'updated' }));
          return;
        }
        const status = outcome === 'forbidden' ? 403 : outcome === 'not_found' ? 404 : 409;
        sendError(response, status, outcome);
      },
    ),
  );
  return router;
}
