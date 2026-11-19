import { useMarketingConversation } from './use-marketing-conversation';
import type { Space } from '@/features/spaces/use-spaces';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MarketingWorkspace } from './marketing-workspace';
import { MarketingConfig } from './marketing-config';
import * as api from './marketing-api';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { readReview, approveReview } from './marketing-review-api';
import type { MarketingReview } from './marketing-review-schemas';

const chat = vi.hoisted(() => ({ binding: null as unknown, mounts: 0, placeholder: '' as string | undefined, touched: (_turn?: { succeeded: boolean }) => {}, busy: (_busy: boolean) => {}, conversationId: 'conversation' as string | null }));
const phone = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (original) => ({ ...await original<typeof import('@astryxdesign/core/AppShell')>(), useAppShellMobile: () => phone }));
vi.mock('@/features/chat/chat-surface', () => ({ ChatSurface: (props: { appBinding: unknown; placeholder?: string; composerFillRef?: { current: ((text: string) => void) | null }; onConversationTouched: (turn?: { succeeded: boolean }) => void; onBusyChange: (busy: boolean) => void }) => {
  const [text, setText] = useState(() => { chat.mounts += 1; return ''; });
  chat.binding = props.appBinding;
  chat.placeholder = props.placeholder;
  if (props.composerFillRef) props.composerFillRef.current = setText;
  chat.touched = props.onConversationTouched;
  chat.busy = props.onBusyChange;
  return <textarea aria-label="Shared composer" value={text} onChange={(event) => setText(event.target.value)} />;
} }));
vi.mock('./use-marketing-conversation', () => ({ useMarketingConversation: vi.fn(() => ({ id: chat.conversationId, loading: false, error: false, recent: [], earlier: [], draftKey: 'test', created: vi.fn() })) }));
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('./marketing-review-api', () => ({ readReview: vi.fn(), approveReview: vi.fn() }));
vi.mock('./marketing-api', async (original) => ({ ...await original<typeof import('./marketing-api')>(), campaigns: vi.fn(), campaign: vi.fn(), drafts: vi.fn(), configDetail: vi.fn(), selectedCampaign: vi.fn(), configMutation: vi.fn(), saveDraft: vi.fn(), selectCampaign: vi.fn(), marketingLifecycle: vi.fn() }));

const installation: api.Installation = { id: 'installation', appId: 'app', spaceId: null, canManage: true, state: 'active', grantedCapabilities: ['campaign.read', 'campaign.draft', 'campaign.configure'], revision: 2, configRevision: 1, config: { visibleViews: ['campaign', 'content', 'schedule', 'results'], contentGrouping: 'none', defaultChannels: ['instagram', 'linkedin'] }, package: { packageId: 'bob-marketing', name: 'Bob Marketing', version: '1.0.0' }, createdAt: 1, updatedAt: 1 };
const pack: api.MarketingPackage = { packageId: 'bob-marketing', name: 'Bob Marketing', version: '1.0.0', mission: 'Bob lightens moods.', voice: 'Warm', assets: [], capabilities: [], grants: [], roles: [] };
const detail: api.ConfigDetail = { installation: { id: installation.id, state: installation.state, configRevision: 1, config: installation.config, packageVersion: '1.0.0', packageId: 'bob-marketing' }, pending: [], versions: [], nextBeforeRevision: null, dependencies: [] };

beforeEach(() => {
  vi.clearAllMocks();
  phone.isMobile = false;
  sessionStorage.clear(); chat.mounts = 0; chat.conversationId = 'conversation';
  vi.mocked(api.campaigns).mockResolvedValue([]);
  vi.mocked(api.configDetail).mockResolvedValue(detail);
  vi.mocked(api.selectedCampaign).mockResolvedValue(null);
  vi.mocked(api.configMutation).mockClear();
  vi.mocked(readReview).mockReset();
  vi.mocked(approveReview).mockReset();
});

const saved: api.Campaign = { id: 'campaign', installationId: 'installation', name: 'Hello Bob', goal: 'curiosity', goalNote: null, channels: ['instagram', 'linkedin'], status: 'draft', revision: 1, draftCount: 1, sections: [], packRevision: 'a'.repeat(64), updatedAt: 1 };
const draft: api.Draft = { id: 'draft', campaignId: 'campaign', channel: 'instagram', format: 'image', body: 'Saved caption', altText: 'Bob waving', pillar: null, approvedAssetIds: [], claimIds: [], cta: 'none', state: 'needs_check', contentRevision: 1, packRevision: 'a'.repeat(64), createdAt: 1, updatedAt: 1 };
function campaignWorkspace(): void {
  vi.mocked(api.campaigns).mockResolvedValue([saved]);
  vi.mocked(api.selectedCampaign).mockResolvedValue(saved);
  vi.mocked(api.campaign).mockResolvedValue(saved);
  vi.mocked(api.drafts).mockResolvedValue([draft]);
}

function contentPage(path: URL, rows: api.Draft[]) {
  expect(path.searchParams.get('projection')).toBe('content');
  const cursor = path.searchParams.get('cursor');
  const start = cursor ? rows.findIndex((item) => item.id === cursor) + 1 : 0;
  const items = rows.slice(start, start + 20);
  return { items, nextCursor: start + items.length < rows.length ? items.at(-1)?.id : null };
}

const improve = (): void => { fireEvent.click(screen.getByRole('button', { name: 'More app actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Improve this app' })); };
const backToPosts = (): void => { fireEvent.click(screen.getByRole('button', { name: 'Back to posts' })); };

it('loads drafts with the board, not while improving, and refreshes artifacts without rereading the installation catalog', async () => {
  campaignWorkspace();
  const catalog = vi.fn();
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={catalog} />);
  await screen.findByRole('button', { name: 'Edit draft' });
  expect(api.drafts).toHaveBeenCalledOnce();
  improve();
  await screen.findByRole('heading', { name: 'Improve this app' });
  expect(chat.binding).toEqual({ installationId: 'installation', mode: 'refine' });
  expect(api.drafts).toHaveBeenCalledOnce();
  act(() => chat.touched());
  await waitFor(() => expect(api.configDetail).toHaveBeenCalledTimes(3));
  expect(api.drafts).toHaveBeenCalledOnce();
  expect(catalog).not.toHaveBeenCalled();
});

it('first run shows Bob, one question and starters that fill the one composer without sending', async () => {
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await screen.findByRole('heading', { name: 'What should we post?' });
  expect(screen.getByRole('img', { name: 'Bob waving hello' }).getAttribute('src')).toBe('/brand/bob/bob-playful.webp');
  expect(screen.queryByRole('combobox', { name: 'Campaign' })).toBeNull();
  for (const gone of ['Schedule', 'Results', 'Chat', 'Preview', 'Build posts', 'Refine app', 'Build with Bob', 'Pause app', 'Improve this app']) expect(screen.queryByRole('button', { name: gone })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'A week of posts' }));
  expect((screen.getByRole('textbox', { name: 'Shared composer' }) as HTMLTextAreaElement).value).toBe('Write a week of posts about ');
  expect(chat.binding).toEqual({ installationId: 'installation', mode: 'run', campaignId: null });
});

it('shows the campaign story, groups week posts by day and hides the rest of the plan behind one action', async () => {
  campaignWorkspace();
  const planned = { ...saved, sections: [{ section: 'brief' as const, content: 'Seven small joys.' }, { section: 'calendar' as const, content: 'Day 1 · Instagram' }] };
  vi.mocked(api.campaign).mockResolvedValue(planned);
  vi.mocked(api.drafts).mockResolvedValue([{ ...draft, id: 'two', pillar: 'Day 2 · Play · The first wave', body: 'Second' }, { ...draft, id: 'one', pillar: 'Day 1 · Help · A small hello', body: 'First' }]);
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await screen.findByText('Seven small joys.');
  expect(screen.getByRole('button', { name: 'See the full plan' })).toBeTruthy();
  const days = screen.getAllByRole('heading', { level: 3 }).map((item) => item.textContent).filter((text) => text?.startsWith('Day'));
  expect(days).toEqual(['Day 1', 'Day 2']);
  expect(screen.getByText('A small hello · Help')).toBeTruthy();
  expect(screen.queryByText(/Revision/)).toBeNull();
  expect(screen.queryByText(/Nothing is published/)).toBeNull();
});

it('keeps the story available in one collapsed phone disclosure', async () => {
  phone.isMobile = true;
  campaignWorkspace();
  vi.mocked(api.campaign).mockResolvedValue({ ...saved, sections: [{ section: 'brief', content: 'Seven small joys.' }, { section: 'calendar', content: 'Day 1 · Instagram' }] });
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  const disclosure = await screen.findByRole('button', { name: 'See the full plan' });
  expect(disclosure.getAttribute('aria-expanded')).toBe('false');
  const content = document.getElementById(disclosure.getAttribute('aria-controls') ?? '');
  expect(content?.contains(screen.getByText('Seven small joys.'))).toBe(true);
  fireEvent.click(disclosure);
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  expect(await screen.findByText('Seven small joys.')).toBeTruthy();
});

it('uses one compact network selector on a phone and filters the board', async () => {
  phone.isMobile = true;
  campaignWorkspace();
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  const network = await screen.findByRole('combobox', { name: 'Show posts for' });
  fireEvent.click(network);
  fireEvent.click(await screen.findByRole('option', { name: 'LinkedIn' }));
  expect(await screen.findByText('No LinkedIn posts yet. Ask Bob for one.')).toBeTruthy();
});

it('puts Pause, Brand and history behind the menu, and a paused app offers Resume directly', async () => {
  vi.mocked(api.marketingLifecycle).mockResolvedValue({ ...installation, state: 'paused' });
  const changed = vi.fn();
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={changed} />);
  await screen.findByRole('heading', { name: 'What should we post?' });
  expect(screen.queryByRole('button', { name: 'Pause app' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More app actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Pause app' }));
  await waitFor(() => expect(api.marketingLifecycle).toHaveBeenCalledWith(installation, 'pause', expect.any(String)));
  expect(changed).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'More app actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'App history' }));
  await screen.findByRole('heading', { name: 'App history' });
});

it.each([20, 100])('uses actual full-page clients for %i drafts: bounded workspace GETs, lazy views and no catalog refresh', async (count) => {
  const actual = await vi.importActual<typeof import('./marketing-api')>('./marketing-api');
  vi.mocked(api.campaigns).mockImplementation(actual.campaigns);
  vi.mocked(api.campaign).mockImplementation(actual.campaign);
  vi.mocked(api.drafts).mockImplementation(actual.drafts);
  vi.mocked(api.configDetail).mockImplementation(actual.configDetail);
  vi.mocked(api.selectedCampaign).mockImplementation(actual.selectedCampaign);
  const installed = { ...installation, id: '00000000-0000-4000-8000-000000000001', appId: '00000000-0000-4000-8000-000000000002' };
  const summary: api.CampaignSummary = { id: '00000000-0000-4000-8000-000000000003', installationId: installed.id, name: saved.name, goal: saved.goal, goalNote: null, channels: saved.channels, status: saved.status, revision: 1, draftCount: count, updatedAt: 1 };
  const rows = Array.from({ length: count }, (_, index) => ({ ...draft, id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`, campaignId: summary.id }));
  const requests: string[] = [];
  vi.mocked(fetchWithAuth).mockImplementation(async (url, init) => {
    expect(init?.method).toBe('GET');
    const path = new URL(String(url), 'http://localhost');
    requests.push(path.pathname + path.search);
    let body: unknown;
    if (path.pathname.endsWith('/campaigns')) body = { items: [summary], nextCursor: null };
    else if (path.pathname.endsWith('/config')) body = { ...detail, installation: { ...detail.installation, id: installed.id } };
    else if (path.pathname.endsWith('/selection')) body = { campaign: summary };
    else if (path.pathname.endsWith(`/campaigns/${summary.id}`)) body = { campaign: { ...summary, sections: [], packRevision: saved.packRevision } };
    else if (path.pathname.endsWith('/drafts')) body = contentPage(path, rows);
    else throw new Error(`Unexpected workspace request: ${path.pathname}`);
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const catalog = vi.fn();
  render(<MarketingWorkspace userId="owner" installation={installed} pack={pack} onInstallationChanged={catalog} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Edit draft' })).toHaveLength(count));
  const contentGets = 4 + Math.ceil(count / 20);
  expect(requests).toHaveLength(contentGets);
  requests.length = 0;
  act(() => chat.touched());
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Edit draft' })).toHaveLength(count));
  expect(requests).toHaveLength(contentGets);
  expect(catalog).not.toHaveBeenCalled();
  requests.length = 0;
  improve();
  await waitFor(() => expect(requests).toHaveLength(4));
  expect(requests.some((path) => path.includes('/drafts'))).toBe(false);
});

it('restores exact unsaved fields after network, view, intent and campaign switches', async () => {
  campaignWorkspace();
  const other = { ...saved, id: 'other-campaign', name: 'Next campaign' };
  vi.mocked(api.campaigns).mockResolvedValue([saved, other]);
  vi.mocked(api.campaign).mockImplementation(async (_installation, id) => id === saved.id ? saved : other);
  vi.mocked(api.drafts).mockImplementation(async (_installation, id) => id === saved.id ? [draft] : []);
  const { rerender } = render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Caption' }), { target: { value: 'Exact caption 🌱' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Image description' }), { target: { value: 'Exact alt' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Pillar' }), { target: { value: 'Exact pillar' } });
  fireEvent.click(screen.getByRole('button', { name: 'LinkedIn' }));
  expect(screen.queryByRole('textbox', { name: 'Caption' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Instagram' }));
  expect((screen.getByRole('textbox', { name: 'Caption' }) as HTMLTextAreaElement).value).toBe('Exact caption 🌱');
  improve();
  expect(screen.queryByRole('textbox', { name: 'Caption' })).toBeNull();
  backToPosts();
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Image description' }) as HTMLTextAreaElement).value).toBe('Exact alt'));
  expect((screen.getByRole('textbox', { name: 'Pillar' }) as HTMLInputElement).value).toBe('Exact pillar');
  fireEvent.click(screen.getByRole('combobox', { name: 'Campaign' }));
  fireEvent.click(screen.getByRole('option', { name: 'Next campaign' }));
  await waitFor(() => expect(api.drafts).toHaveBeenCalledWith('installation', 'other-campaign', expect.any(AbortSignal)));
  expect(screen.queryByRole('textbox', { name: 'Caption' })).toBeNull();
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Campaign' }).getAttribute('aria-disabled')).not.toBe('true'));
  fireEvent.click(screen.getByRole('combobox', { name: 'Campaign' }));
  fireEvent.click(screen.getByRole('option', { name: 'Hello Bob' }));
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Caption' }) as HTMLTextAreaElement).value).toBe('Exact caption 🌱'));
  rerender(<MarketingWorkspace userId="other-owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await screen.findByRole('button', { name: 'Edit draft' });
  expect(screen.queryByDisplayValue('Exact caption 🌱')).toBeNull();
});

it('aborts draft reads when opening Improve and ignores a late content response', async () => {
  campaignWorkspace();
  let finish: (rows: api.Draft[]) => void = () => {};
  const pending = new Promise<api.Draft[]>((resolve) => { finish = resolve; });
  vi.mocked(api.drafts).mockReturnValueOnce(pending);
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await waitFor(() => expect(api.drafts).toHaveBeenCalledOnce());
  const signal = vi.mocked(api.drafts).mock.calls[0]?.[2];
  improve();
  await screen.findByRole('heading', { name: 'Improve this app' });
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish([draft]); await pending; });
  expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull();
});

it('rereads campaign/config/content on manual refresh while retaining edits and applying the latest paused state', async () => {
  campaignWorkspace();
  const props = { userId: 'owner', installation, pack, onInstallationChanged: vi.fn() };
  const { rerender } = render(<MarketingWorkspace {...props} readRevision={0} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Caption' }), { target: { value: 'Pending through reload' } });
  vi.mocked(api.campaign).mockResolvedValue({ ...saved, name: 'Latest campaign' });
  vi.mocked(api.configDetail).mockResolvedValue({ ...detail, installation: { ...detail.installation, state: 'paused', config: { ...installation.config, contentGrouping: 'pillar' } } });
  vi.mocked(api.drafts).mockResolvedValue([{ ...draft, body: 'Latest saved copy', pillar: 'Latest pillar', contentRevision: 2 }]);
  rerender(<MarketingWorkspace {...props} installation={{ ...installation, state: 'paused' }} readRevision={1} />);
  await screen.findByRole('heading', { name: 'Latest pillar' });
  expect(api.campaign).toHaveBeenCalledTimes(2);
  expect(api.configDetail).toHaveBeenCalledTimes(2);
  expect(api.drafts).toHaveBeenCalledTimes(2);
  expect((screen.getByRole('textbox', { name: 'Caption' }) as HTMLTextAreaElement).value).toBe('Pending through reload');
  expect((screen.getByRole('textbox', { name: 'Caption' }) as HTMLTextAreaElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Resume app' })).toBeTruthy();
  expect(screen.getByText('This draft changed while you were editing. Your edits are still here.')).toBeTruthy();
});

it('keeps the campaign chosen before the first chat turn through direct saves and supports a paused read-only picker', async () => {
  campaignWorkspace();
  chat.conversationId = null;
  vi.mocked(api.saveDraft).mockResolvedValue();
  const catalog = vi.fn();
  const { rerender } = render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={catalog} />);
  await waitFor(() => expect(api.configDetail).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('combobox', { name: 'Campaign' }));
  fireEvent.click(screen.getByRole('option', { name: saved.name }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Caption' }), { target: { value: 'Prefirst edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('button', { name: 'Edit draft' });
  expect(chat.binding).toEqual({ installationId: installation.id, mode: 'run', campaignId: saved.id });
  expect(api.selectCampaign).not.toHaveBeenCalled();
  expect(catalog).not.toHaveBeenCalled();
  rerender(<MarketingWorkspace userId="owner" installation={{ ...installation, state: 'paused' }} pack={pack} onInstallationChanged={catalog} />);
  fireEvent.click(screen.getByRole('combobox', { name: 'Campaign' }));
  fireEvent.click(screen.getByRole('option', { name: 'New campaign' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull());
  expect(api.selectCampaign).not.toHaveBeenCalled();
});

it('keeps explicit New targeting after a paused choice, resume and an external selection reload', async () => {
  campaignWorkspace();
  const refreshed = vi.fn();
  const { rerender } = render(<MarketingWorkspace userId="owner" installation={{ ...installation, state: 'paused' }} pack={pack} onInstallationChanged={refreshed} />);
  await waitFor(() => expect(api.campaigns).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('combobox', { name: 'Campaign' }));
  fireEvent.click(screen.getByRole('option', { name: 'New campaign' }));
  await waitFor(() => expect(chat.binding).toMatchObject({ campaignId: null }));
  expect(api.selectCampaign).toHaveBeenCalledWith(installation.id, 'conversation', null, expect.any(String));
  vi.mocked(api.marketingLifecycle).mockResolvedValue(installation);
  fireEvent.click(screen.getByRole('button', { name: 'Resume app' }));
  await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
  rerender(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={refreshed} readRevision={1} />);
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Campaign' }).textContent).toContain('New campaign'));
  expect(chat.binding).toMatchObject({ campaignId: null });
});

it('rereads the saved campaign on focus without replacing pending caption or composer words', async () => {
  campaignWorkspace();
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Caption' }), { target: { value: 'Keep my pending caption' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Shared composer' }), { target: { value: 'Keep my unsent words' } });
  vi.mocked(api.drafts).mockResolvedValue([{ ...draft, body: 'Saved elsewhere', contentRevision: 2 }]);
  const reads = vi.mocked(api.configDetail).mock.calls.length;
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(api.configDetail).toHaveBeenCalledTimes(reads + 1));
  expect(api.drafts).toHaveBeenCalledTimes(2);
  expect(chat.binding).toMatchObject({ campaignId: saved.id });
  expect((screen.getByRole('textbox', { name: 'Caption' }) as HTMLTextAreaElement).value).toBe('Keep my pending caption');
  expect((screen.getByRole('textbox', { name: 'Shared composer' }) as HTMLTextAreaElement).value).toBe('Keep my unsent words');
  expect(chat.mounts).toBe(1);
});

it('keeps the visible saved campaign on focus when another tab moved its initially implicit pointer', async () => {
  campaignWorkspace();
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Caption' }), { target: { value: 'Still editing this campaign' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Shared composer' }), { target: { value: 'Change this caption' } });
  const other = { ...saved, id: 'other-campaign', name: 'Elsewhere' };
  vi.mocked(api.campaigns).mockResolvedValue([saved, other]);
  vi.mocked(api.selectedCampaign).mockResolvedValue(other);
  vi.mocked(api.campaign).mockImplementation(async (_installation, id) => id === saved.id ? saved : other);
  vi.mocked(api.drafts).mockImplementation(async (_installation, id) => id === saved.id ? [draft] : []);
  await act(async () => { fireEvent(window, new Event('focus')); });
  expect(api.configDetail).toHaveBeenCalledTimes(2);
  expect(api.campaign).toHaveBeenLastCalledWith(installation.id, saved.id, expect.any(AbortSignal));
  expect(api.selectCampaign).not.toHaveBeenCalled();
  expect(chat.binding).toMatchObject({ campaignId: saved.id });
  expect(screen.getByRole('combobox', { name: 'Campaign' }).textContent).toContain(saved.name);
  expect((screen.getByRole('textbox', { name: 'Caption' }) as HTMLTextAreaElement).value).toBe('Still editing this campaign');
  expect((screen.getByRole('textbox', { name: 'Shared composer' }) as HTMLTextAreaElement).value).toBe('Change this caption');
});

it('rereads on focus while explicit New stays null despite another tab selecting a saved campaign', async () => {
  campaignWorkspace();
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await screen.findByRole('button', { name: 'Edit draft' });
  fireEvent.click(screen.getByRole('combobox', { name: 'Campaign' }));
  fireEvent.click(screen.getByRole('option', { name: 'New campaign' }));
  await waitFor(() => expect(chat.binding).toMatchObject({ campaignId: null }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Shared composer' }), { target: { value: 'New means new' } });
  vi.mocked(api.selectedCampaign).mockResolvedValue(saved);
  const reads = vi.mocked(api.configDetail).mock.calls.length;
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(api.configDetail).toHaveBeenCalledTimes(reads + 1));
  expect(chat.binding).toMatchObject({ campaignId: null });
  expect(screen.getByRole('combobox', { name: 'Campaign' }).textContent).toContain('New campaign');
  expect((screen.getByRole('textbox', { name: 'Shared composer' }) as HTMLTextAreaElement).value).toBe('New means new');
});

it('keeps one shared composer and exact rough copy while filtering, improving and returning', async () => {
  campaignWorkspace();
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await screen.findByRole('button', { name: 'Edit draft' });
  const composer = screen.getByRole('textbox', { name: 'Shared composer' });
  fireEvent.change(composer, { target: { value: 'My exact rough copy 🌱' } });
  fireEvent.click(screen.getByRole('button', { name: 'Instagram' }));
  expect(chat.binding).toEqual({ installationId: 'installation', mode: 'run', channel: 'instagram', campaignId: saved.id });
  fireEvent.click(screen.getByRole('button', { name: 'LinkedIn' }));
  await screen.findByText('No LinkedIn posts yet. Ask Bob for one.');
  improve();
  expect(chat.binding).toEqual({ installationId: 'installation', mode: 'refine' });
  backToPosts();
  await screen.findByRole('button', { name: 'All' });
  expect((composer as HTMLTextAreaElement).value).toBe('My exact rough copy 🌱');
  expect(chat.mounts).toBe(1);
  expect(screen.getAllByRole('textbox', { name: 'Shared composer' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(chat.binding).toEqual({ installationId: 'installation', mode: 'run', campaignId: saved.id });
});

it('asking Bob about a post fills the same composer and leaves the post unchanged', async () => {
  campaignWorkspace();
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Ask Bob to change it' }));
  expect((screen.getByRole('textbox', { name: 'Shared composer' }) as HTMLTextAreaElement).value).toBe('Change Instagram post draft, "Saved caption": ');
  expect(api.saveDraft).not.toHaveBeenCalled();
});

it('previews a typed proposal without writing, then applies only the hash and revision the owner reviewed', async () => {
  const proposal: api.ConfigDetail['pending'][number] = { id: 'proposal', status: 'pending', baseConfigRevision: 1, packageVersion: '1.0.0', canonicalHash: 'a'.repeat(64), appUrl: '/apps/app', config: { ...installation.config, contentGrouping: 'pillar' }, changes: [{ field: 'contentGrouping', before: 'none', after: 'pillar' }], dependencies: [], dataImpact: 'none', requiresApply: true, createdAt: 1 };
  vi.mocked(api.configMutation).mockResolvedValueOnce();
  const refreshed = vi.fn();
  render(<MarketingConfig detail={{ ...detail, pending: [proposal] }} writable onChanged={refreshed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
  expect(screen.getByText('No changes have been applied.')).toBeTruthy();
  expect(api.configMutation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
  await waitFor(() => expect(api.configMutation).toHaveBeenCalledWith('installation', 'apply', expect.objectContaining({ proposalId: 'proposal', hash: 'a'.repeat(64), expectedConfigRevision: 1 })));
  expect(refreshed).toHaveBeenCalledOnce();
});

const proposal: api.ConfigDetail['pending'][number] = { id: 'proposal', status: 'pending', baseConfigRevision: 1, packageVersion: '1.0.0', canonicalHash: 'a'.repeat(64), appUrl: '/apps/app', config: { ...installation.config, contentGrouping: 'pillar' }, changes: [{ field: 'contentGrouping', before: 'none', after: 'pillar' }], dependencies: [], dataImpact: 'none', requiresApply: true, createdAt: 1 };
const campaignPicker = (): HTMLElement => screen.getByRole('combobox', { name: 'Campaign' });
const composerShown = (): boolean => screen.queryByRole('textbox', { name: 'Shared composer' }) !== null;
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('keeps the stored campaign through a paused reload and resume: the turn pins what the screen shows', async () => {
  campaignWorkspace();
  const props = { userId: 'owner', pack, onInstallationChanged: vi.fn() };
  const { rerender } = render(<MarketingWorkspace {...props} installation={{ ...installation, state: 'paused' }} />);
  await waitFor(() => expect(campaignPicker().textContent).toContain(saved.name));
  vi.mocked(api.selectedCampaign).mockResolvedValue(null);
  vi.mocked(api.marketingLifecycle).mockResolvedValue(installation);
  fireEvent.click(screen.getByRole('button', { name: 'Resume app' }));
  await waitFor(() => expect(props.onInstallationChanged).toHaveBeenCalledOnce());
  vi.mocked(api.selectedCampaign).mockResolvedValue(saved);
  rerender(<MarketingWorkspace {...props} installation={installation} readRevision={1} />);
  await waitFor(() => expect(chat.binding).toMatchObject({ campaignId: saved.id }));
  expect(campaignPicker().textContent).toContain(saved.name);
  expect(vi.mocked(api.campaign).mock.calls.every((call) => call[1] === saved.id)).toBe(true);
});

it('a failed first read names no target and hides the composer until the campaign is known', async () => {
  campaignWorkspace();
  vi.mocked(api.campaigns).mockRejectedValueOnce(new Error('unavailable'));
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await screen.findByRole('button', { name: 'Retry workspace' });
  expect(campaignPicker().textContent).not.toContain('New campaign');
  expect(campaignPicker().textContent).toContain('Campaign unavailable');
  expect(composerShown()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Retry workspace' }));
  await waitFor(() => expect(campaignPicker().textContent).toContain(saved.name));
  expect(composerShown()).toBe(true);
  expect(chat.binding).toMatchObject({ campaignId: saved.id });
});

it('a failed refresh keeps the visible campaign as the target instead of falling back to New', async () => {
  campaignWorkspace();
  const { rerender } = render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} readRevision={0} />);
  await waitFor(() => expect(campaignPicker().textContent).toContain(saved.name));
  vi.mocked(api.campaigns).mockRejectedValueOnce(new Error('unavailable'));
  rerender(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} readRevision={1} />);
  await screen.findByRole('button', { name: 'Retry workspace' });
  expect(campaignPicker().textContent).toContain(saved.name);
  expect(chat.binding).toMatchObject({ campaignId: saved.id });
});

it('sends New as null when no campaign is selected, so another tab cannot redirect a turn the screen calls New', async () => {
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await screen.findByRole('heading', { name: 'What should we post?' });
  await waitFor(() => expect(chat.binding).toMatchObject({ campaignId: null }));
});

it('never pins a campaign on a Refine turn', async () => {
  campaignWorkspace();
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await waitFor(() => expect(chat.binding).toMatchObject({ campaignId: saved.id }));
  improve();
  expect(chat.binding).toEqual({ installationId: installation.id, mode: 'refine' });
});

/** Resolves once a read issued now has landed. */
let readsBefore = 0;
function markNextRead(): void { readsBefore = vi.mocked(api.configDetail).mock.calls.length; }
async function nextReadLanded(): Promise<void> {
  await waitFor(() => expect(vi.mocked(api.configDetail).mock.calls.length).toBeGreaterThan(readsBefore));
  await act(async () => { await Promise.all(vi.mocked(api.configDetail).mock.results.map((result) => result.value)); await Promise.resolve(); });
}

it.each([false, true])('a failed turn never adopts a selection another tab stored (a read landed before the turn: %s)', async (readBeforeTurn) => {
  campaignWorkspace();
  vi.mocked(api.selectedCampaign).mockResolvedValue(null);
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await waitFor(() => expect(campaignPicker().textContent).toContain('New campaign'));
  fireEvent.click(campaignPicker());
  fireEvent.click(screen.getByRole('option', { name: 'New campaign' }));
  await waitFor(() => expect(api.selectCampaign).toHaveBeenCalled());
  await waitFor(() => expect(chat.binding).toMatchObject({ campaignId: null }));
  vi.mocked(api.selectedCampaign).mockResolvedValue(saved);
  if (readBeforeTurn) await act(async () => { chat.touched(); });
  act(() => { chat.busy(true); });
  markNextRead();
  act(() => { chat.busy(false); chat.touched({ succeeded: false }); });
  await nextReadLanded();
  expect(campaignPicker().textContent).toContain('New campaign');
  expect(chat.binding).toMatchObject({ campaignId: null });
});

it('a successful Refine turn does not adopt a selection another tab stored, because Refine never targets a campaign', async () => {
  campaignWorkspace();
  vi.mocked(api.selectedCampaign).mockResolvedValue(null);
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await waitFor(() => expect(campaignPicker().textContent).toContain('New campaign'));
  fireEvent.click(campaignPicker());
  fireEvent.click(screen.getByRole('option', { name: 'New campaign' }));
  await waitFor(() => expect(api.selectCampaign).toHaveBeenCalled());
  improve();
  vi.mocked(api.selectedCampaign).mockResolvedValue(saved);
  act(() => { chat.busy(true); });
  markNextRead();
  act(() => { chat.busy(false); chat.touched({ succeeded: true }); });
  await nextReadLanded();
  expect(campaignPicker().textContent).toContain('New campaign');
});

it('a turn that moves the stored selection (create_campaign) moves the explicit New target with it', async () => {
  campaignWorkspace();
  vi.mocked(api.selectedCampaign).mockResolvedValue(null);
  const created = { ...saved, id: 'created-campaign', name: 'Made by Bob' };
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await waitFor(() => expect(campaignPicker().textContent).toContain('New campaign'));
  fireEvent.click(campaignPicker());
  fireEvent.click(screen.getByRole('option', { name: 'New campaign' }));
  await waitFor(() => expect(api.selectCampaign).toHaveBeenCalled());
  await waitFor(() => expect(chat.binding).toMatchObject({ campaignId: null }));
  act(() => { chat.busy(true); });
  vi.mocked(api.campaigns).mockResolvedValue([saved, created]);
  vi.mocked(api.selectedCampaign).mockResolvedValue(created);
  vi.mocked(api.campaign).mockResolvedValue(created);
  act(() => { chat.busy(false); chat.touched({ succeeded: true }); });
  await waitFor(() => expect(chat.binding).toMatchObject({ campaignId: created.id }));
  await waitFor(() => expect(campaignPicker().textContent).toContain(created.name));
});

it('a refresh keeps an open draft editor mounted and focused, with no false empty state', async () => {
  campaignWorkspace();
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
  const caption = screen.getByRole('textbox', { name: 'Caption' });
  caption.focus();
  const pending = deferred<api.Draft[]>();
  const reads = vi.mocked(api.drafts).mock.calls.length;
  vi.mocked(api.drafts).mockReturnValueOnce(pending.promise);
  act(() => chat.touched());
  await waitFor(() => expect(vi.mocked(api.drafts).mock.calls.length).toBe(reads + 1));
  expect(screen.getByRole('textbox', { name: 'Caption' })).toBe(caption);
  expect(document.activeElement).toBe(caption);
  expect(screen.queryByText(/No posts yet/)).toBeNull();
  await act(async () => { pending.resolve([draft]); await pending.promise; });
  expect(screen.getByRole('textbox', { name: 'Caption' })).toBe(caption);
});

it('never shows the previous campaign as the new target while the new one loads, and claims no empty state', async () => {
  campaignWorkspace();
  const other = { ...saved, id: 'other-campaign', name: 'Next campaign' };
  vi.mocked(api.campaigns).mockResolvedValue([saved, other]);
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await screen.findByRole('button', { name: 'Edit draft' });
  const pending = deferred<api.Campaign>();
  vi.mocked(api.campaign).mockReturnValueOnce(pending.promise);
  fireEvent.click(campaignPicker());
  fireEvent.click(screen.getByRole('option', { name: 'Next campaign' }));
  await waitFor(() => expect(screen.queryByText('Saved caption')).toBeNull());
  expect(screen.queryByText(/No posts yet/)).toBeNull();
  expect(chat.binding).toMatchObject({ campaignId: other.id });
  await act(async () => { pending.resolve(other); await pending.promise; });
});

it('does not claim an empty board while drafts are first loading for the same campaign', async () => {
  campaignWorkspace();
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await screen.findByRole('button', { name: 'Edit draft' });
  improve();
  await screen.findByRole('heading', { name: 'Improve this app' });
  const pending = deferred<api.Draft[]>();
  vi.mocked(api.drafts).mockReset();
  vi.mocked(api.drafts).mockReturnValueOnce(pending.promise);
  backToPosts();
  await waitFor(() => expect(api.drafts).toHaveBeenCalled());
  expect(screen.queryByText(/No posts yet/)).toBeNull();
  await act(async () => { pending.resolve([draft]); await pending.promise; });
  await screen.findByRole('button', { name: 'Edit draft' });
});

it('keeps a Refine conflict visible through the workspace refresh and retries with the same mutation id', async () => {
  vi.mocked(api.configDetail).mockResolvedValue({ ...detail, pending: [proposal] });
  vi.mocked(api.configMutation).mockRejectedValueOnce(new api.MarketingRequestError(409));
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  improve();
  const apply = await screen.findByRole('button', { name: 'Apply changes' });
  // The refresh after the conflict is visible as a changed default channel on the same app version.
  vi.mocked(api.configDetail).mockResolvedValue({ ...detail, pending: [proposal], installation: { ...detail.installation, config: { ...installation.config, defaultChannels: ['instagram'] } } });
  fireEvent.click(apply);
  await screen.findByText('Default channels: instagram');
  expect(screen.getByText('The app changed. Your conversation is safe. Review the latest version before trying again.')).toBeTruthy();
  vi.mocked(api.configMutation).mockResolvedValueOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
  await waitFor(() => expect(api.configMutation).toHaveBeenCalledTimes(2));
  const ids = vi.mocked(api.configMutation).mock.calls.map((call) => (call[2] as { mutationId: string }).mutationId);
  expect(ids[0]).toBe(ids[1]);
});

it('says why Apply is disabled on a stale proposal', () => {
  render(<MarketingConfig detail={{ ...detail, installation: { ...detail.installation, configRevision: 3 }, pending: [proposal] }} writable onChanged={vi.fn()} />);
  expect((screen.getByRole('button', { name: 'Apply changes' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('The app is now on version 3, so this proposal can no longer be applied. Discard it or ask Bob for a new one.')).toBeTruthy();
});

it.each([
  ['another campaign', { ...saved, id: 'campaign-b', name: 'Campaign B' }],
  ['no campaign', null],
] as const)('never carries kept drafts across a stored selection moving to %s', async (_label, next) => {
  campaignWorkspace();
  const props = { userId: 'owner', installation, pack, onInstallationChanged: vi.fn() };
  const { rerender } = render(<MarketingWorkspace {...props} readRevision={0} />);
  await screen.findByRole('button', { name: 'Edit draft' });
  improve();
  await screen.findByRole('heading', { name: 'Improve this app' });
  vi.mocked(api.campaigns).mockResolvedValue(next ? [saved, next] : [saved]);
  vi.mocked(api.selectedCampaign).mockResolvedValue(next);
  if (next) vi.mocked(api.campaign).mockResolvedValue(next);
  const reads = vi.mocked(api.configDetail).mock.calls.length;
  rerender(<MarketingWorkspace {...props} readRevision={1} />);
  await waitFor(() => expect(vi.mocked(api.configDetail).mock.calls.length).toBeGreaterThan(reads));
  await act(async () => { await Promise.resolve(); });
  const held = deferred<api.ConfigDetail>();
  const heldDrafts = deferred<api.Draft[]>();
  vi.mocked(api.configDetail).mockReturnValueOnce(held.promise);
  vi.mocked(api.drafts).mockReturnValue(heldDrafts.promise);
  backToPosts();
  expect(screen.queryByText('Saved caption')).toBeNull();
  await act(async () => { held.resolve(detail); await held.promise; });
  expect(screen.queryByText('Saved caption')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull();
  await act(async () => { heldDrafts.resolve([]); await heldDrafts.promise; });
  await waitFor(() => expect(chat.binding).toMatchObject({ campaignId: next?.id ?? null }));
});

it('a persistently failing campaign read still names the target, offers Retry and lets the owner keep working', async () => {
  campaignWorkspace();
  vi.mocked(api.campaign).mockRejectedValue(new Error('unavailable'));
  render(<MarketingWorkspace userId="owner" installation={installation} pack={pack} onInstallationChanged={vi.fn()} />);
  await screen.findByRole('button', { name: 'Retry workspace' });
  expect(campaignPicker().textContent).toContain(saved.name);
  expect(composerShown()).toBe(true);
  expect(chat.binding).toMatchObject({ campaignId: saved.id });
  expect(screen.queryByText(/No posts yet/)).toBeNull();
  expect(screen.queryByRole('heading', { name: 'What should we post?' })).toBeNull();
  fireEvent.click(campaignPicker());
  fireEvent.click(screen.getByRole('option', { name: 'New campaign' }));
  await waitFor(() => expect(chat.binding).toMatchObject({ campaignId: null }));
});

vi.mock('./use-app-conversation', () => ({ useAppConversation: () => ({ id: 'shared-thread', thread: { id: 'shared-thread' }, threads: {} }) }));
vi.mock('@/features/spaces/thread-reader', () => ({ ThreadReader: ({ appBinding, fillRef }: { appBinding: unknown; fillRef?: { current: ((text: string) => void) | null } }) => {
  const [text, setText] = useState('');
  if (fillRef) fillRef.current = setText;
  return <><output>{`Shared app target ${JSON.stringify(appBinding)}`}</output><textarea aria-label="Team composer" value={text} onChange={(event) => setText(event.target.value)} /></>;
} }));
it('uses the matching shared thread for a space app and never opens a personal conversation', async () => {
  campaignWorkspace();
  const space: Space = { id: 's1', kind: 'group', name: 'Team', role: 'member', membership_revision: 1, created_at: 1, updated_at: 1, members: [] };
  render(<MarketingWorkspace userId="owner" space={space} installation={{ ...installation, spaceId: space.id, canManage: false }} pack={pack} onInstallationChanged={vi.fn()} />);
  await screen.findByRole('button', { name: 'Edit draft' });
  expect(useMarketingConversation).not.toHaveBeenCalled();
  expect(api.selectedCampaign).toHaveBeenCalledWith(installation.id, 'shared-thread', expect.any(AbortSignal));
  expect(screen.getByText(/^Shared app target /).textContent).toContain('"campaignId":"campaign"');
  expect(screen.queryByRole('textbox', { name: 'Shared composer' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More app actions' }));
  expect(screen.queryByRole('menuitem', { name: 'Pause app' })).toBeNull();
});

function sharedReviewWorkspace(role: 'member' | 'admin'): void {
  campaignWorkspace();
  vi.mocked(api.campaign).mockResolvedValue({ ...saved, sections: [{ section: 'brief', content: 'One story for the whole week.' }, { section: 'calendar', content: 'Instagram and LinkedIn posts.' }] });
  const space: Space = { id: 's1', kind: 'group', name: 'Team', role, membership_revision: 1, created_at: 1, updated_at: 1, members: [] };
  vi.mocked(readReview).mockResolvedValue(reviewFixture(role === 'admin'));
  render(<MarketingWorkspace userId="owner" space={space} installation={{ ...installation, spaceId: space.id, canManage: role === 'admin' }} pack={pack} onInstallationChanged={vi.fn()} />);
}

it('lets a team member leave a review note through the one existing shared composer', async () => {
  sharedReviewWorkspace('member');
  await screen.findByRole('button', { name: 'Edit draft' });
  fireEvent.click(screen.getByRole('button', { name: 'See the full plan' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add a review note' }));
  expect((screen.getByRole('textbox', { name: 'Team composer' }) as HTMLTextAreaElement).value).toMatch(/review note/i);
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Approve this plan' })).toBeNull();
  expect(useMarketingConversation).not.toHaveBeenCalled();
});

function reviewFixture(canApprove = true, count = 1): MarketingReview {
  const drafts: api.Draft[] = Array.from({ length: count }, (_, index) => ({ ...draft, id: index === 0 ? draft.id : `draft-${index}`, channel: index % 2 === 0 ? 'instagram' : 'linkedin', body: `Review post ${index}` }));
  return { installationId: installation.id, campaignId: saved.id, state: 'needs_review', reviewRevision: 1, snapshotHash: 'b'.repeat(64), lifecycleGeneration: 0, packRevision: saved.packRevision, canApprove,
    snapshot: { campaign: { ...saved, draftCount: count, sections: [{ section: 'brief', content: 'The complete saved story.' }] }, drafts }, notes: [], approval: null, history: [] };
}

it('refreshes an open team review on focus while retaining unsent feedback and post edits', async () => {
  sharedReviewWorkspace('admin');
  fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Caption' }), { target: { value: 'Keep my team caption' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Team composer' }), { target: { value: 'Keep my team feedback' } });
  fireEvent.click(screen.getByRole('button', { name: 'See the full plan' }));
  await screen.findByText('Review post 0');
  vi.mocked(readReview).mockResolvedValue({ ...reviewFixture(true, 2), reviewRevision: 2 });
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(readReview).toHaveBeenCalledTimes(2));
  await screen.findByText('This plan changed. Review the latest version, then approve it again.');
  expect(screen.getByText('Review post 0')).toBeTruthy();
  expect(screen.queryByText('Review post 1')).toBeNull();
  expect((screen.getByRole('button', { name: 'Approve this plan' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan review' }));
  await screen.findByText('Review post 1');
  fireEvent.click(screen.getByRole('button', { name: 'See the full plan' }));
  expect((screen.getByRole('textbox', { name: 'Caption' }) as HTMLTextAreaElement).value).toBe('Keep my team caption');
  expect((screen.getByRole('textbox', { name: 'Team composer' }) as HTMLTextAreaElement).value).toBe('Keep my team feedback');
});

it('reviews all100saved posts across channels and preserves composer and pending edits through409 and explicit refresh', async () => {
  sharedReviewWorkspace('admin');
  fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Caption' }), { target: { value: 'My unsaved caption' } });
  const composer = screen.getByRole('textbox', { name: 'Team composer' });
  fireEvent.change(composer, { target: { value: 'My unsent team feedback' } });
  const original = reviewFixture(true, 100);
  const next: MarketingReview = { ...original, reviewRevision: 2, snapshotHash: 'c'.repeat(64), snapshot: { ...original.snapshot, drafts: original.snapshot.drafts.map((row, index) => index === 99 ? { ...row, body: 'Changed last post', contentRevision: 2 } : row) } };
  vi.mocked(readReview).mockResolvedValueOnce(original).mockResolvedValue(next);
  vi.mocked(approveReview).mockRejectedValueOnce(new api.MarketingRequestError(409));
  fireEvent.click(screen.getByRole('button', { name: 'See the full plan' }));
  await screen.findByText('Review post 99');
  expect(screen.getByText('100 posts · 50 Instagram · 50 LinkedIn. Approval covers every saved post, across all channels.')).toBeTruthy();
  expect(screen.getByText('Review post 0')).toBeTruthy();
  expect(screen.queryByText('Saved caption')).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Caption' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Approve this plan' }));
  await screen.findByText('This plan changed. Review the latest version, then approve it again.');
  expect(approveReview).toHaveBeenCalledTimes(1);
  expect(approveReview).toHaveBeenLastCalledWith(installation.id, saved.id, expect.objectContaining({ expectedReviewRevision: 1, snapshotHash: original.snapshotHash }));
  expect(readReview).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Review post 99')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Approve this plan' }) as HTMLButtonElement).disabled).toBe(true);
  expect((composer as HTMLTextAreaElement).value).toBe('My unsent team feedback');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan review' }));
  await screen.findByText('Changed last post');
  expect(screen.queryByText('Review post 99')).toBeNull();
  expect(approveReview).toHaveBeenCalledTimes(1);
  const approved: MarketingReview = { ...next, state: 'approved' };
  vi.mocked(approveReview).mockResolvedValueOnce({ receipt: { kind: 'review.approved', installationId: installation.id, campaignId: saved.id, approvalId: 'approval' }, review: approved });
  fireEvent.click(screen.getByRole('button', { name: 'Approve this plan' }));
  await screen.findByText('Plan approved. Publishing is not connected.');
  expect(approveReview).toHaveBeenLastCalledWith(installation.id, saved.id, expect.objectContaining({ expectedReviewRevision: 2, snapshotHash: next.snapshotHash }));
  expect(vi.mocked(approveReview).mock.calls[0]?.[2].mutationId).not.toBe(vi.mocked(approveReview).mock.calls[1]?.[2].mutationId);
  fireEvent.click(screen.getByRole('button', { name: 'See the full plan' }));
  expect((screen.getByRole('textbox', { name: 'Caption' }) as HTMLTextAreaElement).value).toBe('My unsaved caption');
  expect((composer as HTMLTextAreaElement).value).toBe('My unsent team feedback');
});

it('offers an admin explicit editorial approval within the complete plan disclosure', async () => {
  sharedReviewWorkspace('admin');
  await screen.findByRole('button', { name: 'Edit draft' });
  const composer = screen.getByRole('textbox', { name: 'Team composer' });
  fireEvent.change(composer, { target: { value: 'My unsent team feedback' } });
  fireEvent.click(screen.getByRole('button', { name: 'See the full plan' }));
  expect(await screen.findByRole('button', { name: 'Approve this plan' })).toBeTruthy();
  expect((composer as HTMLTextAreaElement).value).toBe('My unsent team feedback');
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(screen.getByText('Publishing is not connected.')).toBeTruthy();
  expect(useMarketingConversation).not.toHaveBeenCalled();
});
