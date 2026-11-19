import { beforeEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { readReview, approveReview } from './marketing-review-api';
import { marketingReviewSchema, type MarketingReview } from './marketing-review-schemas';

vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth: vi.fn() }));
const installationId = '11111111-1111-4111-8111-111111111111';
const campaignId = '22222222-2222-4222-8222-222222222222';
const approvalId = '33333333-3333-4333-8333-333333333333';
const fixture: MarketingReview = {
  installationId, campaignId, state: 'needs_review', reviewRevision: 1, snapshotHash: 'a'.repeat(64), lifecycleGeneration: 0, packRevision: 'a'.repeat(64), canApprove: false,
  snapshot: { campaign: { id: campaignId, installationId, name: 'One story', goal: 'curiosity', goalNote: null, channels: ['instagram', 'linkedin'], status: 'draft', revision: 1, draftCount: 0, updatedAt: 1, packRevision: 'a'.repeat(64), sections: [] }, drafts: [] },
  notes: [{ id: approvalId, text: 'A team note', author: null, createdAt: 1 }], approval: null, history: [],
};
beforeEach(() => vi.mocked(fetchWithAuth).mockReset());
it('reads one complete strict atomic review with neutral erased attribution', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(Response.json({ review: fixture }));
  expect(await readReview(installationId, campaignId)).toEqual(fixture);
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  expect(fetchWithAuth).toHaveBeenCalledWith(`/api/bob-apps/marketing/installations/${installationId}/campaigns/${campaignId}/review`);
});
it('rejects unexpected review fields and malformed authority/revision metadata', () => {
  for (const changed of [{ ...fixture, sessionId: approvalId }, { ...fixture, canApprove: undefined }, { ...fixture, reviewRevision: 0 }, { ...fixture, lifecycleGeneration: -1 }, { ...fixture, snapshotHash: 'invented' }, { ...fixture, notes: [{ ...fixture.notes[0], author: { id: approvalId, label: 'Team', email: 'private' } }] }]) expect(marketingReviewSchema.safeParse(changed).success).toBe(false);
});
it('rejects a response belonging to another campaign', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(Response.json({ review: { ...fixture, campaignId: approvalId } }));
  await expect(readReview(installationId, campaignId)).rejects.toThrow('review_audience_mismatch');
});
it('posts only the displayed revision/hash and a mutation identity to explicit approval HTTP', async () => {
  const mutationId = crypto.randomUUID();
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(Response.json({ receipt: { kind: 'review.approved', installationId, campaignId, approvalId }, review: { ...fixture, state: 'approved' } }));
  await approveReview(installationId, campaignId, { expectedReviewRevision: 1, snapshotHash: fixture.snapshotHash, mutationId });
  const [path, init] = vi.mocked(fetchWithAuth).mock.calls[0] ?? [];
  expect(path).toBe(`/api/bob-apps/marketing/installations/${installationId}/campaigns/${campaignId}/review/approve`);
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({ expectedReviewRevision: 1, snapshotHash: fixture.snapshotHash, mutationId });
});
it('reports409 without returning a newly fetched target to approve', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(Response.json({ error: { code: 'review_conflict' } }, { status: 409 }));
  await expect(approveReview(installationId, campaignId, { expectedReviewRevision: 1, snapshotHash: fixture.snapshotHash, mutationId: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);
});
