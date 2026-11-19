import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useMarketingReview } from './use-marketing-review';
import { readReview, approveReview } from './marketing-review-api';
import { MarketingRequestError } from './marketing-api';
import type { MarketingReview } from './marketing-review-schemas';

vi.mock('./marketing-review-api', () => ({ readReview: vi.fn(), approveReview: vi.fn() }));
const review: MarketingReview = { installationId: 'installation', campaignId: 'campaign', state: 'needs_review', reviewRevision: 1, snapshotHash: 'a'.repeat(64), lifecycleGeneration: 0, packRevision: 'a'.repeat(64), canApprove: true,
  snapshot: { campaign: { id: 'campaign', installationId: 'installation', name: 'Saved story', goal: 'curiosity', goalNote: null, channels: ['instagram'], status: 'draft', revision: 1, draftCount: 0, updatedAt: 1, packRevision: 'a'.repeat(64), sections: [] }, drafts: [] }, notes: [], approval: null, history: [] };
function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { complete = resolve; });
  return { promise, resolve: (value: T): void => { complete?.(value); } };
}
beforeEach(() => { vi.mocked(readReview).mockReset(); vi.mocked(approveReview).mockReset(); });
it('does not expose a loaded or late review after the authenticated audience/target changes', async () => {
  const late = deferred<MarketingReview>();
  vi.mocked(readReview).mockResolvedValueOnce(review).mockReturnValueOnce(late.promise).mockResolvedValueOnce({ ...review, campaignId: 'other' });
  const { result, rerender } = renderHook(({ user, campaign }) => useMarketingReview(user, 'installation', campaign, true, '1'), { initialProps: { user: 'member', campaign: 'campaign' } });
  act(() => result.current.setOpen(true));
  await waitFor(() => expect(result.current.data).toEqual(review));
  act(() => result.current.refresh());
  rerender({ user: 'another-member', campaign: 'other' });
  expect(result.current.data).toBeNull();
  act(() => result.current.setOpen(true));
  await waitFor(() => expect(result.current.data?.campaignId).toBe('other'));
  await act(async () => { late.resolve(review); await late.promise; });
  expect(result.current.data?.campaignId).toBe('other');
});
it('keeps the displayed snapshot on background content changes and adopts a new target only on explicit refresh', async () => {
  const changed = { ...review, reviewRevision: 2, snapshotHash: 'b'.repeat(64) };
  vi.mocked(readReview).mockResolvedValueOnce(review).mockResolvedValue(changed);
  const { result, rerender } = renderHook(({ revision }) => useMarketingReview('member', 'installation', 'campaign', true, revision), { initialProps: { revision: '1' } });
  act(() => result.current.setOpen(true));
  await waitFor(() => expect(result.current.data).toEqual(review));
  rerender({ revision: '2' });
  await waitFor(() => expect(result.current.changed).toBe(true));
  expect(result.current.data).toEqual(review);
  await act(async () => { await result.current.approve(); });
  expect(approveReview).not.toHaveBeenCalled();
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.data).toEqual(changed));
  expect(approveReview).not.toHaveBeenCalled();
  expect(result.current.changed).toBe(false);
});
it('retries an uncertain approval with the same captured hash and mutation identity without double submitting', async () => {
  vi.mocked(readReview).mockResolvedValue(review);
  vi.mocked(approveReview).mockRejectedValueOnce(new MarketingRequestError(503));
  const pending = deferred<Awaited<ReturnType<typeof approveReview>>>();
  vi.mocked(approveReview).mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() => useMarketingReview('member', 'installation', 'campaign', true, '1'));
  act(() => result.current.setOpen(true));
  await waitFor(() => expect(result.current.data).toEqual(review));
  await act(async () => { await result.current.approve(); });
  let second: Promise<void> | undefined;
  act(() => { second = result.current.approve(); void result.current.approve(); });
  expect(approveReview).toHaveBeenCalledTimes(2);
  expect(vi.mocked(approveReview).mock.calls[0]).toEqual(vi.mocked(approveReview).mock.calls[1]);
  expect(readReview).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve({ receipt: { kind: 'review.approved', installationId: 'installation', campaignId: 'campaign', approvalId: 'approval' }, review: { ...review, state: 'approved' } }); await second; });
  expect(result.current.data?.state).toBe('approved');
});
