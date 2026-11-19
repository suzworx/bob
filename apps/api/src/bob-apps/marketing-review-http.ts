import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Db } from '../platform/db/db.ts';
import { StoreConflictError, StoreError, StoreNotFoundError } from '../platform/db/db.ts';
import { requireActiveSession } from '../platform/http/auth-guard.ts';
import { route, sendError } from '../platform/http/route.ts';
import { MarketingReviewApproveSchema, MarketingReviewApprovalResponseSchema, MarketingReviewResponseSchema } from './marketing-review-schemas.ts';
import { approveMarketingPlan, getMarketingReview } from './marketing-review-store.ts';

const Params = z.strictObject({ installationId: z.uuid(), campaignId: z.uuid() });
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) sendError(response, 404, 'not_found', 'That plan is not available.');
  else if (error instanceof StoreError && error.message === 'app_management_required') sendError(response, 403, 'permission_denied', 'A space owner or admin can approve this plan.');
  else if (error instanceof StoreError && error.message === 'marketing_session_inactive') sendError(response, 401, 'invalid_token', 'Please sign in again before approving.');
  else if (error instanceof StoreConflictError) sendError(response, 409, 'review_conflict', 'This plan changed. Review the latest version, then approve it again.');
  else if (error instanceof z.ZodError) sendError(response, 400, 'invalid', 'That review request is not valid.');
  else sendError(response, 503, 'unavailable', 'The plan review is unavailable. Please try again.');
}
export function createMarketingReviewRouter(deps: { getDb(): Promise<Db> }): Router {
  const router = Router();
  const base = '/marketing/installations/:installationId/campaigns/:campaignId/review';
  router.get(base, route({ params: Params, mapError }, async ({ userId, params }, _req, res) => {
    res.json(MarketingReviewResponseSchema.parse({ review: await getMarketingReview(await deps.getDb(), userId, params.installationId, params.campaignId) }));
  }));
  router.post(`${base}/approve`, requireActiveSession(deps.getDb), route({ params: Params, body: MarketingReviewApproveSchema, mapError }, async ({ userId, params, body }, req, res) => {
    res.json(MarketingReviewApprovalResponseSchema.parse(await approveMarketingPlan(await deps.getDb(), userId, params.installationId, params.campaignId, body, req.account?.sessionId ?? '')));
  }));
  return router;
}
