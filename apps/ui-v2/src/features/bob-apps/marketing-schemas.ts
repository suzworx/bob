import { z } from 'zod';

// Browser-only DTOs mirror the strict producer contracts without loading the server's Node/AI graph.
const id = z.uuid();
const revision = z.number().int().positive();
const channel = z.enum(['instagram', 'linkedin']);
const state = z.enum(['draft', 'active', 'paused', 'inactive']);
const config = z.strictObject({ visibleViews: z.array(z.enum(['campaign', 'content', 'schedule', 'results'])), contentGrouping: z.enum(['none', 'channel', 'pillar']), defaultChannels: z.array(channel) });
export const installationSchema = z.strictObject({ id, appId: id, spaceId: id.nullable(), canManage: z.boolean(), state, grantedCapabilities: z.array(z.enum(['campaign.read', 'campaign.draft', 'campaign.configure'])), revision, configRevision: revision, config, package: z.strictObject({ packageId: z.literal('bob-marketing'), name: z.string(), version: z.string() }), createdAt: z.number(), updatedAt: z.number() });
export const packageSchema = z.strictObject({ packageId: z.literal('bob-marketing'), version: z.string(), name: z.string(), mission: z.string(), voice: z.string(), roles: z.array(z.strictObject({ id: z.string(), label: z.string(), summary: z.string(), skillId: z.string(), skillVersion: z.string() })), assets: z.array(z.strictObject({ id: z.string(), url: z.string(), rights: z.string() })), capabilities: z.array(z.strictObject({ id: z.enum(['drafting', 'publishing', 'analytics', 'research', 'render', 'conversions']), status: z.enum(['available', 'unavailable']), reason: z.string() })), grants: z.array(z.enum(['campaign.draft', 'campaign.configure', 'campaign.read'])) });
export const campaignSummarySchema = z.strictObject({ id, installationId: id, name: z.string(), goal: z.enum(['awareness', 'curiosity', 'beta_interest']), goalNote: z.string().nullable(), channels: z.array(channel), status: z.enum(['draft', 'paused', 'archived']), revision, draftCount: z.number().int().nonnegative(), updatedAt: z.number() });
export const campaignSchema = campaignSummarySchema.extend({ packRevision: z.string(), sections: z.array(z.strictObject({ section: z.enum(['brief', 'strategy', 'positioning', 'calendar', 'measurement', 'review']), content: z.string() })) });
export const draftSchema = z.strictObject({ id, campaignId: id, channel, format: z.enum(['text', 'image', 'carousel']), body: z.string(), altText: z.string().nullable(), pillar: z.string().nullable(), approvedAssetIds: z.array(z.string()), claimIds: z.array(z.string()), cta: z.enum(['none', 'waitlist', 'signin']), state: z.enum(['draft', 'needs_check']), contentRevision: revision, packRevision: z.string(), createdAt: z.number(), updatedAt: z.number() });
export const draftContentPageSchema = z.strictObject({ items: z.array(draftSchema).max(20), nextCursor: id.nullable() });
const dependency = z.strictObject({ id: z.string(), status: z.literal('unavailable'), reason: z.string() });
const change = z.discriminatedUnion('field', [
  z.strictObject({ field: z.literal('visibleViews'), before: config.shape.visibleViews, after: config.shape.visibleViews }),
  z.strictObject({ field: z.literal('contentGrouping'), before: config.shape.contentGrouping, after: config.shape.contentGrouping }),
  z.strictObject({ field: z.literal('defaultChannels'), before: config.shape.defaultChannels, after: config.shape.defaultChannels }),
]);
const proposal = z.strictObject({ id, status: z.enum(['pending', 'applied', 'discarded']), baseConfigRevision: revision, packageVersion: z.string(), canonicalHash: z.string(), appUrl: z.string(), config, changes: z.array(change), dependencies: z.array(dependency), dataImpact: z.literal('none'), requiresApply: z.literal(true), createdAt: z.number() });
export const configDetailSchema = z.strictObject({ installation: z.strictObject({ id, state, configRevision: revision, config, packageVersion: z.string(), packageId: z.literal('bob-marketing') }), pending: z.array(proposal), versions: z.array(z.strictObject({ revision, config: config.nullable(), packageVersion: z.string(), sourceProposalId: id.nullable(), restorable: z.boolean(), createdAt: z.number() })), nextBeforeRevision: revision.nullable(), dependencies: z.array(dependency) });

export type Installation = z.infer<typeof installationSchema>;
export type MarketingPackage = z.infer<typeof packageSchema>;
export type Campaign = z.infer<typeof campaignSchema>;
export type CampaignSummary = z.infer<typeof campaignSummarySchema>;
export type Draft = z.infer<typeof draftSchema>;
export type ConfigDetail = z.infer<typeof configDetailSchema>;
