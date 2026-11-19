import { useEffect, useRef } from 'react';
import { MarketingRequestError, saveDraft, type Draft } from './marketing-api';

type Fields = { body: string; altText: string; pillar: string };
type Submission = { base: Draft; fields: { body: string; altText: string | null; pillar: string | null }; mutationId: string };
type Edit = Fields & { base: Draft; mutationId: string; busy: boolean; error: string | null; conflict: boolean; cancelRequested: boolean; submitted?: Submission };
export interface MarketingDraftEdits {
  read: (id: string) => Edit | undefined;
  subscribe: (id: string, listener: () => void) => () => void;
  open: (draft: Draft) => void;
  change: (id: string, field: keyof Fields, value: string) => void;
  close: (id: string, discard?: boolean) => void;
  keep: (id: string) => void;
  useLatest: (draft: Draft) => void;
  save: (draft: Draft) => Promise<void>;
}
type DraftEdits = MarketingDraftEdits & { setActive: (value: boolean) => void };

function dirty(edit: Edit): boolean {
  return edit.body !== edit.base.body || edit.altText !== (edit.base.altText ?? '') || edit.pillar !== (edit.base.pillar ?? '');
}
function canSave(edit: Edit | undefined, draft: Draft): edit is Edit {
  if (!edit || edit.busy || edit.conflict) return false;
  return Boolean(edit.submitted) || edit.base.contentRevision === draft.contentRevision;
}
function submissionOf(edit: Edit): Submission {
  return edit.submitted ?? { base: edit.base, fields: { body: edit.body, altText: edit.altText || null, pillar: edit.pillar || null }, mutationId: edit.mutationId };
}

function failedEdit(edit: Edit, submitted: Submission, cause: unknown): Edit {
  const conflict = cause instanceof MarketingRequestError && cause.status === 409;
  const definitive = cause instanceof MarketingRequestError && cause.status < 500;
  const failed: Edit = { ...edit, submitted, busy: false, conflict,
    error: conflict ? null : "Couldn't confirm this save. Your edits are still here. Retry to check the same save, or discard your edits." };
  if (definitive) delete failed.submitted;
  return failed;
}

/** One workspace's pending draft intents. Only the matching card subscribes to field changes. */
function draftEdits(installationId: string, onChanged: () => void): DraftEdits {
  let active = true;
  const entries = new Map<string, Edit>();
  const listeners = new Map<string, Set<() => void>>();
  const put = (id: string, edit: Edit | null): void => {
    if (!active) return;
    if (edit) entries.set(id, edit);
    else entries.delete(id);
    for (const listener of listeners.get(id) ?? []) listener();
  };
  const open = (draft: Draft): void => {
    if (entries.has(draft.id)) return;
    put(draft.id, { base: draft, body: draft.body, altText: draft.altText ?? '', pillar: draft.pillar ?? '', mutationId: crypto.randomUUID(), busy: false, error: null, conflict: false, cancelRequested: false });
  };
  const change = (id: string, field: keyof Fields, value: string): void => {
    const edit = entries.get(id);
    if (!edit || edit.busy || edit.submitted) return;
    put(id, { ...edit, [field]: value, mutationId: crypto.randomUUID(), error: null });
  };
  const close = (id: string, discard = false): void => {
    const edit = entries.get(id);
    if (!edit || edit.busy) return;
    put(id, discard || !dirty(edit) ? null : { ...edit, cancelRequested: true });
  };
  const keep = (id: string): void => {
    const edit = entries.get(id);
    if (edit) put(id, { ...edit, cancelRequested: false });
  };
  const useLatest = (draft: Draft): void => {
    const edit = entries.get(draft.id);
    if (!edit || edit.busy || edit.submitted) return;
    put(draft.id, { ...edit, base: draft, mutationId: crypto.randomUUID(), conflict: false, error: null });
  };
  const save = async (draft: Draft): Promise<void> => {
    const edit = entries.get(draft.id);
    if (!active || !canSave(edit, draft)) return;
    const submitted = submissionOf(edit);
    put(draft.id, { ...edit, submitted, busy: true, error: null });
    try {
      await saveDraft(installationId, submitted.base, submitted.fields, submitted.mutationId);
      if (!active) return;
      put(draft.id, null); onChanged();
    } catch (cause) {
      if (!active) return;
      const failed = failedEdit(edit, submitted, cause);
      put(draft.id, failed);
      if (failed.conflict) onChanged();
    }
  };
  const subscribe = (id: string, listener: () => void): (() => void) => {
    const subscribed = listeners.get(id) ?? new Set<() => void>();
    subscribed.add(listener); listeners.set(id, subscribed);
    return () => { subscribed.delete(listener); if (subscribed.size === 0) listeners.delete(id); };
  };
  return { read: (id: string): Edit | undefined => entries.get(id), subscribe, open, change, close, keep, useLatest, save, setActive: (value: boolean): void => { active = value; } };
}

/** Pending work belongs to this mounted owner/installation, never browser storage or server record caches. */
export function useMarketingDraftEdits(userId: string, installationId: string, onChanged: () => void): MarketingDraftEdits {
  const scope = `${userId}:${installationId}`;
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const current = useRef<{ scope: string; edits: DraftEdits } | null>(null);
  if (current.current?.scope !== scope) {
    current.current?.edits.setActive(false);
    current.current = { scope, edits: draftEdits(installationId, () => changed.current()) };
  }
  const edits = current.current.edits;
  useEffect(() => { edits.setActive(true); return () => edits.setActive(false); }, [edits]);
  return edits;
}
