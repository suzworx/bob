import { fetchWithAuth } from '@/lib/auth/use-session';
import { MarketingRequestError } from './marketing-api';
import { approvalInputSchema, approvalResponseSchema, reviewResponseSchema, type MarketingApprovalResult, type MarketingReview } from './marketing-review-schemas';

function path(installationId: string, campaignId: string): string {
  return `/api/bob-apps/marketing/installations/${encodeURIComponent(installationId)}/campaigns/${encodeURIComponent(campaignId)}/review`;
}
export async function readReview(installationId: string, campaignId: string): Promise<MarketingReview> {
  const response = await fetchWithAuth(path(installationId, campaignId));
  if (!response.ok) throw new MarketingRequestError(response.status);
  const { review } = reviewResponseSchema.parse(await response.json());
  if (review.installationId !== installationId || review.campaignId !== campaignId) throw new Error('review_audience_mismatch');
  return review;
}
export async function approveReview(installationId: string, campaignId: string, input: { expectedReviewRevision: number; snapshotHash: string; mutationId: string }): Promise<MarketingApprovalResult> {
  const response = await fetchWithAuth(`${path(installationId, campaignId)}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(approvalInputSchema.parse(input)) });
  if (!response.ok) throw new MarketingRequestError(response.status);
  const result = approvalResponseSchema.parse(await response.json());
  if (result.review.installationId !== installationId || result.review.campaignId !== campaignId || result.receipt.installationId !== installationId || result.receipt.campaignId !== campaignId) throw new Error('review_audience_mismatch');
  return result;
}
