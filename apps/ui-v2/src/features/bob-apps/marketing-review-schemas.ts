import { z } from 'zod';
import { campaignSchema, draftSchema } from './marketing-schemas';

const revision = z.number().int().positive().max(2147483646);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const author = z.strictObject({ id: z.uuid(), label: z.string().min(1).max(200) }).nullable();
const note = z.strictObject({ id: z.uuid(), text: z.string().trim().min(1).max(1000), author, createdAt: z.number().int() });
const decision = z.strictObject({ id: z.uuid(), snapshotHash: hash, reviewRevision: revision, author, createdAt: z.number().int() });
export const marketingReviewSchema = z.strictObject({
  installationId: z.uuid(), campaignId: z.uuid(), state: z.enum(['needs_review', 'approved']), reviewRevision: revision,
  snapshotHash: hash, lifecycleGeneration: z.number().int().nonnegative(), packRevision: hash, canApprove: z.boolean(),
  snapshot: z.strictObject({ campaign: campaignSchema, drafts: z.array(draftSchema).max(100) }),
  notes: z.array(note).max(100), approval: decision.nullable(), history: z.array(decision).max(20),
});
export const reviewResponseSchema = z.strictObject({ review: marketingReviewSchema });
export const approvalInputSchema = z.strictObject({ expectedReviewRevision: revision, snapshotHash: hash, mutationId: z.uuid() });
export const approvalResponseSchema = z.strictObject({ receipt: z.strictObject({ kind: z.literal('review.approved'), installationId: z.uuid(), campaignId: z.uuid(), approvalId: z.uuid() }), review: marketingReviewSchema });
export type MarketingReview = z.infer<typeof marketingReviewSchema>;
export type MarketingApprovalResult = z.infer<typeof approvalResponseSchema>;
