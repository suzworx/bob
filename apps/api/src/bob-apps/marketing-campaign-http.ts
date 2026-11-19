import { Router, type Response } from 'express';
import { z } from 'zod';
import { StoreConflictError, StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import {
  CampaignListResponseSchema, CampaignResponseSchema, CreateCampaignRequestSchema, CreateDraftRequestSchema, DraftListResponseSchema, DraftResponseSchema,
  MarketingOverviewResponseSchema, MarketingReceiptResponseSchema, SaveSectionRequestSchema, UpdateCampaignRequestSchema, UpdateDraftRequestSchema,
  CampaignSelectionResponseSchema, SelectCampaignRequestSchema, DraftContentListResponseSchema, DraftListQuerySchema,
} from './marketing-campaign-schemas.ts';
import { createMarketingReviewRouter } from './marketing-review-http.ts';
import { getMarketingInstallation } from './marketing-install.ts';
import * as store from './marketing-store.ts';

// Campaign routes for personal or matching group installations, mounted under /api/bob-apps. Reads never need an
// active installation; writes recheck current audience/capability under the store lock. Each person's selection stays
// separate. Writes take a UI mutationId; identity and grants never come from the body.
const COPY = {
  not_found: 'That item was not found.',
  conflict: 'That change conflicts with the current state. Refresh and try again.',
  invalid: 'That change is not allowed.',
  unavailable: 'Marketing is unavailable right now. Try again soon.',
} as const;
const Installation = z.strictObject({ installationId: z.uuid() });
const CampaignParams = Installation.extend({ campaignId: z.uuid() });
const DraftParams = Installation.extend({ draftId: z.uuid() });
const SelectionParams = Installation.extend({ conversationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });
const CampaignsQuery = z.strictObject({ cursor: z.uuid().optional() });
/** Reference and channel refusals are input problems the owner can correct, so they are 400, not a conflict. */
const INVALID_REFERENCE = new Set(['marketing_asset_unknown', 'marketing_claim_unknown', 'marketing_channel_not_in_campaign', 'marketing_format_not_allowed']);
const CONFLICT_CODES: Readonly<Record<string, string>> = {
  marketing_revision_conflict: 'revision_conflict', marketing_mutation_conflict: 'mutation_conflict', marketing_campaign_archived: 'archived',
};

function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) return sendError(response, 404, 'not_found', COPY.not_found);
  if (error instanceof StoreConflictError) return conflictError(response, error);
  if (error instanceof z.ZodError) return sendError(response, 400, 'invalid', COPY.invalid);
  if (error instanceof StoreError) return inputError(response, error);
  sendError(response, 503, 'unavailable', COPY.unavailable);
}
function conflictError(response: Response, error: StoreConflictError): void {
  const code = CONFLICT_CODES[error.message];
  if (code) return sendError(response, 409, code, COPY.conflict);
  if (error.message === 'marketing_permission_denied') return sendError(response, 403, 'permission_denied', COPY.conflict);
  sendError(response, 503, 'unavailable', COPY.unavailable);
}
function inputError(response: Response, error: StoreError): void {
  if (error.message === 'operation_limit_reached') {
    sendError(response, 503, 'operation_limit_reached', 'This installation has reached its recorded marketing change limit. You can still pause the installation.');
  } else if (error.message === 'campaign_quota_reached' || error.message === 'draft_quota_reached') {
    sendError(response, 409, 'quota_reached', 'This campaign or installation has reached its limit.');
  } else if (INVALID_REFERENCE.has(error.message)) sendError(response, 400, 'invalid_reference', COPY.invalid);
  else if (error.message === 'marketing_package_unavailable') sendError(response, 503, 'unavailable', COPY.unavailable);
  else sendError(response, 400, 'invalid', COPY.invalid);
}
/** A UI mutation: the mutationId is the operation key, and the rest of the body is the intent. */
const ui = (mutationId: string): store.WriteOrigin => ({ key: mutationId, scope: { source: 'ui' } });

export function createMarketingCampaignRouter(deps: { getDb(): Promise<Db> }): Router {
  const router = Router();
  const base = '/marketing/installations/:installationId';
  router.get(`${base}/overview`, route({ params: Installation, mapError }, async ({ userId, params }, _req, res) => {
    res.json(MarketingOverviewResponseSchema.parse({ overview: await store.getMarketingOverview(await deps.getDb(), userId, params.installationId) }));
  }));
  router.get(`${base}/conversations/:conversationId/selection`, route({ params: SelectionParams, mapError }, async ({ userId, params }, _req, res) => {
    const db = await deps.getDb();
    await getMarketingInstallation(db, userId, params.installationId);
    if ((await store.marketingConversationSpace(db, userId, params.installationId, params.conversationId)) === null) throw new StoreNotFoundError('marketing_scope_unavailable');
    res.json(CampaignSelectionResponseSchema.parse({ campaign: await store.readSelectedCampaign(db, userId, params.installationId, params.conversationId) }));
  }));
  router.post(`${base}/conversations/:conversationId/selection`, route({ params: SelectionParams, body: SelectCampaignRequestSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    const receipt = await store.selectCampaign(await deps.getDb(), userId, params.installationId, params.conversationId, body.campaignId, ui(body.mutationId));
    res.json(MarketingReceiptResponseSchema.parse({ receipt }));
  }));
  router.get(`${base}/campaigns`, route({ params: Installation, query: CampaignsQuery, mapError }, async ({ userId, params, query }, _req, res) => {
    res.json(CampaignListResponseSchema.parse(await store.listCampaigns(await deps.getDb(), userId, params.installationId, query.cursor ?? null)));
  }));
  router.post(`${base}/campaigns`, route({ params: Installation, body: CreateCampaignRequestSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    const { mutationId, ...intent } = body;
    const receipt = await store.createCampaign(await deps.getDb(), userId, params.installationId, intent, ui(mutationId));
    res.status(201).json(MarketingReceiptResponseSchema.parse({ receipt }));
  }));
  router.get(`${base}/campaigns/:campaignId`, route({ params: CampaignParams, mapError }, async ({ userId, params }, _req, res) => {
    res.json(CampaignResponseSchema.parse({ campaign: await store.getCampaign(await deps.getDb(), userId, params.installationId, params.campaignId) }));
  }));
  router.patch(`${base}/campaigns/:campaignId`, route({ params: CampaignParams, body: UpdateCampaignRequestSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    const { mutationId, ...intent } = body;
    const receipt = await store.updateCampaign(await deps.getDb(), userId, params.installationId, params.campaignId, intent, ui(mutationId));
    res.json(MarketingReceiptResponseSchema.parse({ receipt }));
  }));
  router.post(`${base}/campaigns/:campaignId/sections`, route({ params: CampaignParams, body: SaveSectionRequestSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    const { mutationId, ...intent } = body;
    const receipt = await store.saveCampaignSection(await deps.getDb(), userId, params.installationId, params.campaignId, intent, ui(mutationId));
    res.json(MarketingReceiptResponseSchema.parse({ receipt }));
  }));
  router.use(createMarketingReviewRouter(deps));
  router.get(`${base}/drafts`, route({ params: Installation, query: DraftListQuerySchema, mapError }, async ({ userId, params, query }, _req, res) => {
    if (query.projection === 'content' && query.campaignId) {
      const page = await store.listDraftContent(await deps.getDb(), userId, params.installationId, { campaignId: query.campaignId, cursor: query.cursor ?? null, ...(query.channel ? { channel: query.channel } : {}) });
      res.json(DraftContentListResponseSchema.parse(page));
      return;
    }
    const filter = { campaignId: query.campaignId ?? null, cursor: query.cursor ?? null };
    res.json(DraftListResponseSchema.parse(await store.listDrafts(await deps.getDb(), userId, params.installationId, filter)));
  }));
  router.post(`${base}/drafts`, route({ params: Installation, body: CreateDraftRequestSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    const { mutationId, ...intent } = body;
    const receipt = await store.createDraft(await deps.getDb(), userId, params.installationId, intent, ui(mutationId));
    res.status(201).json(MarketingReceiptResponseSchema.parse({ receipt }));
  }));
  router.get(`${base}/drafts/:draftId`, route({ params: DraftParams, mapError }, async ({ userId, params }, _req, res) => {
    res.json(DraftResponseSchema.parse({ draft: await store.getDraft(await deps.getDb(), userId, params.installationId, params.draftId) }));
  }));
  router.patch(`${base}/drafts/:draftId`, route({ params: DraftParams, body: UpdateDraftRequestSchema, mapError }, async ({ userId, params, body }, _req, res) => {
    const { mutationId, ...intent } = body;
    const receipt = await store.updateDraft(await deps.getDb(), userId, params.installationId, params.draftId, intent, ui(mutationId));
    res.json(MarketingReceiptResponseSchema.parse({ receipt }));
  }));
  return router;
}
