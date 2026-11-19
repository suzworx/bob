import { z } from 'zod';

// Strict wire contracts for Marketing campaigns, plans and drafts (U3). Text limits count UTF-8 bytes. Exported through
// web-schemas for the UI. An intent is what a write changes; a request adds the UI mutationId. Tools validate intents
// server-side and derive their own operation key, so a model never supplies identity or a key.
export const CAMPAIGN_GOALS = ['awareness', 'curiosity', 'beta_interest'] as const;
const CAMPAIGN_STATUSES = ['draft', 'paused', 'archived'] as const;
export const PLAN_SECTIONS = ['brief', 'strategy', 'positioning', 'calendar', 'measurement', 'review'] as const;
export const DRAFT_CHANNELS = ['instagram', 'linkedin'] as const;
export const DRAFT_FORMATS = ['text', 'image', 'carousel'] as const;
export const DRAFT_CTAS = ['none', 'waitlist', 'signin'] as const;
const DRAFT_STATES = ['draft', 'needs_check'] as const;
export const MAX_CAMPAIGNS_PER_INSTALLATION = 20;
export const MAX_DRAFTS_PER_CAMPAIGN = 100;
const MAX_WEEK_PLAN_POSTS = 7;
export const LIST_PAGE_CAMPAIGNS = 20;
export const LIST_PAGE_DRAFTS = 50;
export const CONTENT_PAGE_DRAFTS = 20;
export const CONTENT_PAGE_BYTES = 256 * 1024;
export const DraftListQuerySchema = z.strictObject({ campaignId: z.uuid().optional(), cursor: z.uuid().optional(), projection: z.enum(['summary', 'content']).optional(), channel: z.enum(DRAFT_CHANNELS).optional() })
  .refine((value) => value.projection === 'content' ? value.campaignId !== undefined : value.channel === undefined, 'Content projection requires a campaign; channel filtering is content-only.');

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const bytesAtMost = (max: number) => z.string().refine((value) => new TextEncoder().encode(value).byteLength <= max, `Must be at most ${max} bytes.`);
const revision = z.number().int().positive().max(2147483646);
const mutationId = z.uuid();
const Name = z.string().refine((value) => value.trim().length >= 1 && value.trim().length <= 80, 'Name must be 1 to 80 characters.');
const Channels = z.array(z.enum(DRAFT_CHANNELS)).min(1).max(2).refine(unique, 'Channels must be unique.');
const changesSomething = (keys: readonly string[]) => (value: Record<string, unknown>): boolean =>
  Object.keys(value).some((key) => !keys.includes(key));
/** Instagram posts are images or carousels; LinkedIn accepts any supported format. Checked on every create and merged update. */
export const draftFormatAllowed = (channel: (typeof DRAFT_CHANNELS)[number], format: (typeof DRAFT_FORMATS)[number]): boolean =>
  channel === 'linkedin' || format !== 'text';

const DraftFields = {
  channel: z.enum(DRAFT_CHANNELS),
  format: z.enum(DRAFT_FORMATS),
  body: bytesAtMost(8000),
  altText: bytesAtMost(2000).nullable().optional(),
  pillar: bytesAtMost(120).nullable().optional(),
  approvedAssetIds: z.array(z.string().min(1).max(64)).max(8).refine(unique, 'Asset IDs must be unique.'),
  claimIds: z.array(z.string().min(1).max(120)).max(20).refine(unique, 'Claim IDs must be unique.'),
  cta: z.enum(DRAFT_CTAS),
};

const CreateCampaignBase = z.strictObject({
  name: Name, goal: z.enum(CAMPAIGN_GOALS), goalNote: bytesAtMost(500).nullable().optional(), channels: Channels,
});
const UpdateCampaignBase = z.strictObject({
  name: Name.optional(), goal: z.enum(CAMPAIGN_GOALS).optional(), goalNote: bytesAtMost(500).nullable().optional(),
  channels: Channels.optional(), status: z.enum(CAMPAIGN_STATUSES).optional(), expectedRevision: revision,
});
const SaveSectionBase = z.strictObject({ section: z.enum(PLAN_SECTIONS), content: bytesAtMost(20000), expectedRevision: revision });
const CreateDraftBase = z.strictObject({ campaignId: z.uuid(), ...DraftFields });
const UpdateDraftBase = z.strictObject(DraftFields).partial().extend({ expectedContentRevision: revision });
const draftRule = (value: { channel?: (typeof DRAFT_CHANNELS)[number]; format?: (typeof DRAFT_FORMATS)[number] }): boolean =>
  value.channel === undefined || value.format === undefined || draftFormatAllowed(value.channel, value.format);
const draftRuleMessage = { message: 'Instagram posts must be image or carousel.', path: ['format'] };

// One week in one tool call. The caps keep the largest plan inside the specialist's 4096 output tokens, and the labels
// inside the 120-byte pillar column as "Day N · pillar · beat" (see weekDraftLabel).
const WeekLabel = (max: number) => bytesAtMost(max).refine((value) => value.trim().length > 0 && !value.includes('·'), 'Use a short label without the · separator.');
const WeekPostSchema = z.strictObject({
  day: z.number().int().min(1).max(7), channel: z.enum(DRAFT_CHANNELS), format: z.enum(DRAFT_FORMATS).optional(),
  pillar: WeekLabel(32), beat: WeekLabel(72), body: bytesAtMost(1200).refine((value) => value.trim().length > 0, 'Write the post.'),
  altText: bytesAtMost(200).nullable().optional(), approvedAssetIds: z.array(z.string().min(1).max(64)).max(2).refine(unique, 'Asset IDs must be unique.').default([]),
  claimIds: z.array(z.string().min(1).max(120)).max(4).refine(unique, 'Claim IDs must be unique.').default([]), cta: z.enum(DRAFT_CTAS).default('none'),
}).refine((post) => post.format === undefined || draftRule(post), draftRuleMessage);
export const SaveWeekPlanIntentSchema = z.strictObject({
  name: Name, goal: z.enum(CAMPAIGN_GOALS), channels: Channels,
  story: bytesAtMost(800).refine((value) => value.trim().length > 0, 'Write the story.'),
  posts: z.array(WeekPostSchema).min(1).max(MAX_WEEK_PLAN_POSTS),
}).refine((plan) => unique(plan.posts.map((post) => `${post.day}/${post.channel}`)), { message: 'Plan one post per channel per day.', path: ['posts'] })
  .refine((plan) => plan.posts.every((post) => plan.channels.includes(post.channel)), { message: 'Every post must use one of the campaign channels.', path: ['posts'] });

export const CreateCampaignIntentSchema = CreateCampaignBase;
export const CreateCampaignRequestSchema = CreateCampaignBase.extend({ mutationId });
export const UpdateCampaignIntentSchema = UpdateCampaignBase.refine(changesSomething(['expectedRevision']), 'Change at least one field.');
export const UpdateCampaignRequestSchema = UpdateCampaignBase.extend({ mutationId }).refine(changesSomething(['expectedRevision', 'mutationId']), 'Change at least one field.');
export const SaveSectionIntentSchema = SaveSectionBase;
export const SaveSectionRequestSchema = SaveSectionBase.extend({ mutationId });
export const SelectCampaignRequestSchema = z.strictObject({ campaignId: z.uuid().nullable(), mutationId });
export const CreateDraftIntentSchema = CreateDraftBase.refine(draftRule, draftRuleMessage);
export const CreateDraftRequestSchema = CreateDraftBase.extend({ mutationId }).refine(draftRule, draftRuleMessage);
export const UpdateDraftIntentSchema = UpdateDraftBase.refine(changesSomething(['expectedContentRevision']), 'Change at least one field.').refine(draftRule, draftRuleMessage);
export const UpdateDraftRequestSchema = UpdateDraftBase.extend({ mutationId })
  .refine(changesSomething(['expectedContentRevision', 'mutationId']), 'Change at least one field.').refine(draftRule, draftRuleMessage);

const Timestamp = z.number().int();
export const CampaignSummarySchema = z.strictObject({
  id: z.uuid(), installationId: z.uuid(), name: z.string(), goal: z.enum(CAMPAIGN_GOALS), goalNote: z.string().nullable(),
  channels: z.array(z.enum(DRAFT_CHANNELS)), status: z.enum(CAMPAIGN_STATUSES), revision: z.number().int().positive(),
  draftCount: z.number().int().nonnegative(), updatedAt: Timestamp,
});
export const CampaignSchema = CampaignSummarySchema.extend({
  packRevision: z.string().length(64),
  sections: z.array(z.strictObject({ section: z.enum(PLAN_SECTIONS), content: z.string() })).length(PLAN_SECTIONS.length),
});
export const DraftSchema = z.strictObject({
  id: z.uuid(), campaignId: z.uuid(), channel: z.enum(DRAFT_CHANNELS), format: z.enum(DRAFT_FORMATS), body: z.string(),
  altText: z.string().nullable(), pillar: z.string().nullable(), approvedAssetIds: z.array(z.string()), claimIds: z.array(z.string()),
  cta: z.enum(DRAFT_CTAS), state: z.enum(DRAFT_STATES), contentRevision: z.number().int().positive(), packRevision: z.string().length(64),
  createdAt: Timestamp, updatedAt: Timestamp,
});
export const DraftSummarySchema = z.strictObject({
  id: z.uuid(), campaignId: z.uuid(), channel: z.enum(DRAFT_CHANNELS), format: z.enum(DRAFT_FORMATS), state: z.enum(DRAFT_STATES),
  contentRevision: z.number().int().positive(), updatedAt: Timestamp,
});
/** The minimal stored result of one write: IDs and revisions only, never content or the request. */
export const MarketingOperationReceiptSchema = z.strictObject({
  kind: z.enum(['campaign.create', 'campaign.update', 'campaign.section', 'campaign.select', 'campaign.week_plan', 'draft.create', 'draft.update']),
  campaignId: z.uuid().nullable(), draftId: z.uuid().nullable(), revision: z.number().int().positive().nullable(),
});
export const MarketingOverviewSchema = z.strictObject({
  installation: z.strictObject({ id: z.uuid(), state: z.enum(['draft', 'active', 'paused', 'inactive']), revision: z.number().int().positive() }),
  counts: z.strictObject({ campaigns: z.number().int().nonnegative(), liveCampaigns: z.number().int().nonnegative(), drafts: z.number().int().nonnegative(), needsCheck: z.number().int().nonnegative() }),
  analytics: z.strictObject({ status: z.literal('unavailable'), reason: z.string() }),
});
export const CampaignListResponseSchema = z.strictObject({ items: z.array(CampaignSummarySchema).max(LIST_PAGE_CAMPAIGNS), nextCursor: z.uuid().nullable() });
export const DraftListResponseSchema = z.strictObject({ items: z.array(DraftSummarySchema).max(LIST_PAGE_DRAFTS), nextCursor: z.uuid().nullable() });
export const DraftContentListResponseSchema = z.strictObject({ items: z.array(DraftSchema).max(CONTENT_PAGE_DRAFTS), nextCursor: z.uuid().nullable() });
export const CampaignResponseSchema = z.strictObject({ campaign: CampaignSchema });
export const CampaignSelectionResponseSchema = z.strictObject({ campaign: CampaignSummarySchema.nullable() });
export const DraftResponseSchema = z.strictObject({ draft: DraftSchema });
export const MarketingReceiptResponseSchema = z.strictObject({ receipt: MarketingOperationReceiptSchema });
export const MarketingOverviewResponseSchema = z.strictObject({ overview: MarketingOverviewSchema });
