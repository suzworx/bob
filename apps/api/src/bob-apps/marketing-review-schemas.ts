import { z } from 'zod';
import { CampaignSchema, DraftSchema } from './marketing-campaign-schemas.ts';

const revision = z.number().int().positive().max(2147483646);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.number().int();
const author = z.strictObject({ id: z.uuid(), label: z.string().min(1).max(200) }).nullable();
export const MarketingReviewNoteTextSchema = z.string().trim().min(1).max(1000);
const note = z.strictObject({ id: z.uuid(), text: MarketingReviewNoteTextSchema, author, createdAt: timestamp });
const decision = z.strictObject({ id: z.uuid(), snapshotHash: hash, reviewRevision: revision, author, createdAt: timestamp });
export const MarketingReviewSchema = z.strictObject({
  installationId: z.uuid(), campaignId: z.uuid(), state: z.enum(['needs_review', 'approved']),
  reviewRevision: revision, snapshotHash: hash, lifecycleGeneration: z.number().int().nonnegative(), packRevision: hash,
  canApprove: z.boolean(), snapshot: z.strictObject({ campaign: CampaignSchema, drafts: z.array(DraftSchema).max(100) }),
  notes: z.array(note).max(100), approval: decision.nullable(), history: z.array(decision).max(20),
});
export const MarketingReviewApproveSchema = z.strictObject({ expectedReviewRevision: revision, snapshotHash: hash, mutationId: z.uuid() });
const MarketingReviewReceiptSchema = z.strictObject({ kind: z.literal('review.approved'), installationId: z.uuid(), campaignId: z.uuid(), approvalId: z.uuid() });
export const MarketingReviewResponseSchema = z.strictObject({ review: MarketingReviewSchema });
export const MarketingReviewApprovalResponseSchema = z.strictObject({ receipt: MarketingReviewReceiptSchema, review: MarketingReviewSchema });
