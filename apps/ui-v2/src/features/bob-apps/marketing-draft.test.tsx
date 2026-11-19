import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MarketingDraft } from './marketing-draft';
import { useMarketingDraftEdits } from './marketing-draft-edits';
import * as api from './marketing-api';
vi.mock('./marketing-api', async (original) => ({ ...await original<typeof import('./marketing-api')>(), saveDraft: vi.fn() }));
vi.mock('./post-creative', () => ({ PostCreative: () => <button type="button">Share image</button> }));
const draft: api.Draft = { id: 'draft', campaignId: 'campaign', channel: 'instagram', format: 'image', body: 'Saved caption', altText: 'Bob waving', pillar: null, approvedAssetIds: [], claimIds: [], cta: 'none', state: 'needs_check', contentRevision: 1, packRevision: 'a'.repeat(64), createdAt: 1, updatedAt: 1 };
beforeEach(() => vi.mocked(api.saveDraft).mockReset());
function Workspace({ latest = draft, additional, owner = 'owner', installationId = 'installation', visible = true, onChanged = () => {}, rendered = () => {} }: { latest?: api.Draft; additional?: api.Draft; owner?: string; installationId?: string; visible?: boolean; onChanged?: () => void; rendered?: () => void }): ReactElement | null {
  const edits = useMarketingDraftEdits(owner, installationId, onChanged);
  rendered();
  return visible ? <><MarketingDraft draft={latest} assets={[]} writable edits={edits} />{additional && <MarketingDraft draft={additional} assets={[]} writable edits={edits} />}</> : null;
}
function changeCaption(value: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'Caption' }), { target: { value } });
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let complete: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { complete = resolve; });
  return { promise, resolve: () => complete?.() };
}
it('lets readers read the caption before opening or sharing its image', () => {
  render(<Workspace />);
  const caption = screen.getByText('Saved caption');
  const creative = screen.getByRole('button', { name: 'Share image' });
  expect(caption.compareDocumentPosition(creative) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it('copies the exact post, confirms it, and says so when the browser refuses', async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const body = 'First line 🌱\nSecond line';
  render(<Workspace latest={{ ...draft, body, pillar: 'Day 1 · Help · A small hello' }} />);
  expect(screen.getByText('A small hello · Help')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Copy post' }));
  await screen.findByRole('button', { name: 'Copied' });
  expect(writeText).toHaveBeenCalledWith(body);
  fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
  await screen.findByText("Couldn't copy this post. Select the text and copy it yourself.");
});

it('preserves the owners exact text on conflict and requires explicit review before retrying at the latest revision', async () => {
  vi.mocked(api.saveDraft).mockRejectedValueOnce(new api.MarketingRequestError(409));
  const refreshed = vi.fn();
  const { rerender } = render(<Workspace onChanged={refreshed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Caption' }), { target: { value: 'My exact rough copy' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByText('This draft changed while you were editing. Your edits are still here.');
  rerender(<Workspace latest={{ ...draft, body: 'Remote caption', contentRevision: 2 }} onChanged={refreshed} />);
  expect((screen.getByRole('textbox', { name: 'Caption' }) as HTMLTextAreaElement).value).toBe('My exact rough copy');
  expect(screen.getAllByText('Remote caption').length).toBeGreaterThan(0);
  vi.mocked(api.saveDraft).mockResolvedValueOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Keep my edits against latest draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(api.saveDraft).toHaveBeenLastCalledWith('installation', expect.objectContaining({ contentRevision: 2 }), { body: 'My exact rough copy', altText: 'Bob waving', pillar: null }, expect.any(String)));
});

it('restores all exact fields after the card unmounts without rerendering the workspace for each edit', () => {
  const rendered = vi.fn();
  const { rerender } = render(<Workspace rendered={rendered} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
  const renders = rendered.mock.calls.length;
  changeCaption('Exact caption 🌱\nSecond line');
  fireEvent.change(screen.getByRole('textbox', { name: 'Image description' }), { target: { value: 'Exact alt text' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Pillar' }), { target: { value: 'Exact pillar' } });
  expect(rendered).toHaveBeenCalledTimes(renders);
  rerender(<Workspace visible={false} rendered={rendered} />);
  rerender(<Workspace rendered={rendered} />);
  expect((screen.getByRole('textbox', { name: 'Caption' }) as HTMLTextAreaElement).value).toBe('Exact caption 🌱\nSecond line');
  expect(screen.getByDisplayValue('Exact alt text')).toBeTruthy();
  expect(screen.getByDisplayValue('Exact pillar')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect((screen.getByRole('textbox', { name: 'Caption' }) as HTMLTextAreaElement).value).toBe('Exact caption 🌱\nSecond line');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard edits' }));
  expect(screen.queryByRole('textbox', { name: 'Caption' })).toBeNull();
});

it('keeps fields disabled and a single save in flight after switching away and returning', async () => {
  const pending = deferred();
  vi.mocked(api.saveDraft).mockReturnValueOnce(pending.promise);
  const refreshed = vi.fn();
  const { rerender } = render(<Workspace onChanged={refreshed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
  changeCaption('Submitted exact copy');
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  rerender(<Workspace visible={false} onChanged={refreshed} />);
  rerender(<Workspace onChanged={refreshed} />);
  for (const name of ['Caption', 'Image description', 'Pillar']) expect((screen.getByRole('textbox', { name }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByDisplayValue('Submitted exact copy')).toBeTruthy();
  changeCaption('Attempted change while saving');
  expect(screen.getByDisplayValue('Submitted exact copy')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(api.saveDraft).toHaveBeenCalledOnce();
  await act(async () => pending.resolve());
  expect(refreshed).toHaveBeenCalledOnce();
  expect(screen.queryByRole('textbox', { name: 'Caption' })).toBeNull();
});

it('closes only the matching editor when an uncertain save replay succeeds', async () => {
  vi.mocked(api.saveDraft).mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce();
  const refreshed = vi.fn();
  const second: api.Draft = { ...draft, id: 'another-draft', channel: 'linkedin', format: 'text', body: 'Another saved post' };
  const { rerender } = render(<Workspace additional={second} onChanged={refreshed} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit draft' })[0] as HTMLButtonElement);
  changeCaption('Submitted exact copy');
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('button', { name: 'Retry save' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Post narrative' }), { target: { value: 'Other pending copy' } });
  rerender(<Workspace latest={{ ...draft, body: 'Submitted exact copy', contentRevision: 2 }} additional={second} onChanged={refreshed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
  await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
  expect(vi.mocked(api.saveDraft).mock.calls[1]).toEqual(vi.mocked(api.saveDraft).mock.calls[0]);
  expect(screen.queryByRole('textbox', { name: 'Caption' })).toBeNull();
  expect(screen.getByDisplayValue('Other pending copy')).toBeTruthy();
});

it('retries an uncertain save with its exact snapshot and key, then requires explicit review on a conflict', async () => {
  vi.mocked(api.saveDraft).mockRejectedValueOnce(new Error('response lost')).mockRejectedValueOnce(new api.MarketingRequestError(409));
  const refreshed = vi.fn();
  const { rerender } = render(<Workspace onChanged={refreshed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
  changeCaption('Submitted exact copy');
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('button', { name: 'Retry save' });
  const original = vi.mocked(api.saveDraft).mock.calls[0];
  rerender(<Workspace latest={{ ...draft, body: 'Latest server text', contentRevision: 2 }} onChanged={refreshed} />);
  expect((screen.getByRole('textbox', { name: 'Caption' }) as HTMLTextAreaElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
  await screen.findByText('This draft changed while you were editing. Your edits are still here.');
  expect(vi.mocked(api.saveDraft).mock.calls[1]).toEqual(original);
  vi.mocked(api.saveDraft).mockResolvedValueOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Keep my edits against latest draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(api.saveDraft).toHaveBeenCalledTimes(3));
  const reviewed = vi.mocked(api.saveDraft).mock.calls[2];
  expect(reviewed?.[1].contentRevision).toBe(2);
  expect(reviewed?.[2]).toEqual(original?.[2]);
  expect(reviewed?.[3]).not.toBe(original?.[3]);
});

it.each([{ owner: 'another-owner' }, { installationId: 'another-installation' }])('isolates new scope fields from an old pending save completing: %j', async (scope) => {
  const pending = deferred();
  vi.mocked(api.saveDraft).mockReturnValueOnce(pending.promise);
  const oldChanged = vi.fn();
  const newChanged = vi.fn();
  const { rerender } = render(<Workspace onChanged={oldChanged} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
  changeCaption('Old scope copy');
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  rerender(<Workspace {...scope} onChanged={newChanged} />);
  expect(screen.queryByDisplayValue('Old scope copy')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
  changeCaption('New scope copy');
  await act(async () => pending.resolve());
  expect(screen.getByDisplayValue('New scope copy')).toBeTruthy();
  expect(oldChanged).not.toHaveBeenCalled();
  expect(newChanged).not.toHaveBeenCalled();
});
