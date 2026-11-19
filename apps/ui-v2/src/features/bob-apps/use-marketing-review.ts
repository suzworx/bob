import { useEffect, useRef, useState } from 'react';
import { MarketingRequestError } from './marketing-api';
import { approveReview, readReview } from './marketing-review-api';
import type { MarketingReview } from './marketing-review-schemas';

const conflictMessage = 'This plan changed. Review the latest version, then approve it again.';
function samePlan(a: MarketingReview, b: MarketingReview): boolean {
  return a.reviewRevision === b.reviewRevision && a.snapshotHash === b.snapshotHash && a.lifecycleGeneration === b.lifecycleGeneration;
}
type ReviewRead = { scope: string; data: MarketingReview | null; loading: boolean; busy: boolean; changed: boolean; error: string | null };
interface ReviewState {
  open: boolean;
  data: MarketingReview | null;
  loading: boolean;
  busy: boolean;
  changed: boolean;
  error: string | null;
  setOpen: (value: boolean) => void;
  refresh: () => void;
  approve: () => Promise<void>;
}
function approvalFailure(cause: unknown): Pick<ReviewRead, 'changed' | 'error'> {
  if (cause instanceof MarketingRequestError && cause.status === 409) return { changed: true, error: conflictMessage };
  if (cause instanceof MarketingRequestError && (cause.status === 403 || cause.status === 404)) return { changed: true, error: 'Access to this plan changed. Refresh the review before continuing.' };
  return { changed: false, error: "Couldn't confirm approval. Your work is safe. Try again to check the same approval." };
}

/** A review pins the entire atomic read. Only an explicit refresh adopts a different plan. */
export function useMarketingReview(userId: string, installationId: string, campaignId: string | null | undefined, enabled: boolean, revision: string, onClosed?: () => void): ReviewState {
  const scope = `${userId}:${installationId}:${campaignId}`;
  const [opened, setOpened] = useState<string | null>(null);
  const open = enabled && opened === scope;
  const [read, setRead] = useState<ReviewRead>({ scope, data: null, loading: false, busy: false, changed: false, error: null });
  const latest = useRef({ scope, open }); latest.current = { scope, open };
  const generation = useRef(0);
  const pending = useRef<{ scope: string; target: MarketingReview; mutationId: string } | null>(null);
  const busy = useRef<string | null>(null);
  const needsCheck = useRef<string | null>(null);
  const activeRun = (run: number): boolean => latest.current.scope === scope && latest.current.open && generation.current === run;
  const load = async (replace: boolean): Promise<void> => {
    if (!campaignId || !latest.current.open) return;
    if (busy.current === scope) { needsCheck.current = scope; return; }
    const run = ++generation.current;
    setRead((current) => current.scope === scope
      ? { ...current, loading: true, error: null }
      : { scope, data: null, loading: true, busy: false, changed: false, error: null });
    try {
      const data = await readReview(installationId, campaignId);
      if (!activeRun(run)) return;
      setRead((current) => {
        if (replace || current.scope !== scope || !current.data) return { scope, data, loading: false, busy: false, changed: false, error: null };
        if (samePlan(current.data, data)) return { ...current, data, loading: false };
        return { ...current, loading: false, changed: true, error: conflictMessage };
      });
      if (replace) pending.current = null;
    } catch {
      if (activeRun(run)) setRead((current) => ({ ...current, loading: false, changed: true, error: "Couldn't open the latest plan review. Your work is still here." }));
    }
  };
  useEffect(() => {
    if (!open) { generation.current += 1; return; }
    void load(true);
    return () => { generation.current += 1; };
  }, [scope, open]);
  const initialRevision = useRef(revision);
  useEffect(() => {
    if (initialRevision.current === revision) return;
    initialRevision.current = revision;
    if (open) void load(false);
  }, [revision, scope, open]);
  const data = read.scope === scope && open ? read.data : null;
  const finishApproval = (): void => {
    if (busy.current === scope) busy.current = null;
    if (needsCheck.current !== scope || latest.current.scope !== scope) return;
    needsCheck.current = null;
    void load(false);
  };
  const approve = async (): Promise<void> => {
    if (!data?.canApprove || !campaignId || busy.current === scope || read.loading || read.changed || !open) return;
    const operation = pending.current?.scope === scope ? pending.current : { scope, target: data, mutationId: crypto.randomUUID() };
    pending.current = operation;
    busy.current = scope;
    const run = ++generation.current;
    setRead((current) => ({ ...current, busy: true, error: null }));
    try {
      const result = await approveReview(installationId, campaignId, { expectedReviewRevision: operation.target.reviewRevision, snapshotHash: operation.target.snapshotHash, mutationId: operation.mutationId });
      if (!activeRun(run)) return;
      pending.current = null;
      setRead((current) => samePlan(operation.target, result.review)
        ? { ...current, data: result.review, busy: false }
        : { ...current, busy: false, changed: true, error: conflictMessage });
    } catch (cause) {
      if (!activeRun(run)) return;
      setRead((current) => ({ ...current, busy: false, ...approvalFailure(cause) }));
    } finally { finishApproval(); }
  };
  return { open, data, loading: open && (read.scope !== scope || read.loading), busy: read.scope === scope && read.busy, changed: read.scope === scope && read.changed, error: read.scope === scope ? read.error : null,
    setOpen: (value: boolean): void => { setOpened(value ? scope : null); if (!value) onClosed?.(); }, refresh: (): void => { if (!read.busy) void load(true); }, approve };
}
