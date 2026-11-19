import { beforeEach, expect, it, vi } from 'vitest';
import { campaigns, drafts, installMarketing, type Draft, type Installation } from './marketing-api';
import { fetchWithAuth } from '@/lib/auth/use-session';
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth: vi.fn() }));
beforeEach(() => vi.mocked(fetchWithAuth).mockReset());
it('continues past a full archived page so a live campaign remains selectable', async () => {
  const installationId = crypto.randomUUID();
  const row = (status: 'archived' | 'draft') => ({ id: crypto.randomUUID(), installationId, name: status === 'draft' ? 'Live campaign' : 'Archived campaign', goal: 'curiosity', goalNote: null, channels: ['instagram'], status, revision: 1, draftCount: 0, updatedAt: 1 });
  const archived = Array.from({ length: 20 }, () => row('archived'));
  const live = row('draft');
  const cursor = archived.at(-1)?.id;
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(Response.json({ items: archived, nextCursor: cursor })).mockResolvedValueOnce(Response.json({ items: [live], nextCursor: null }));
  const result = await campaigns(installationId);
  expect(result).toHaveLength(21);
  expect(result.at(-1)?.name).toBe('Live campaign');
  expect(fetchWithAuth).toHaveBeenLastCalledWith(`/api/bob-apps/marketing/installations/${installationId}/campaigns?cursor=${cursor}`, expect.any(Object));
});

it.each([20, 100])('loads %i full drafts in content pages without per-draft requests', async (count) => {
  const installation = crypto.randomUUID();
  const campaign = crypto.randomUUID();
  const rows: Draft[] = Array.from({ length: count }, (_, index) => ({ id: crypto.randomUUID(), campaignId: campaign, channel: 'instagram', format: 'image', body: `Caption ${index}`, altText: 'Original Bob', pillar: 'Joy', approvedAssetIds: [], claimIds: [], cta: 'none', state: 'needs_check', contentRevision: 1, packRevision: 'a'.repeat(64), createdAt: 1, updatedAt: 1 }));
  for (let offset = 0; offset < rows.length; offset += 20) {
    const items = rows.slice(offset, offset + 20);
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(Response.json({ items, nextCursor: offset + 20 < count ? items.at(-1)?.id : null }));
  }
  const controller = new AbortController();
  const result = await drafts(installation, campaign, controller.signal).then((items) => items, () => null);
  expect(fetchWithAuth).toHaveBeenCalledTimes(count / 20);
  expect(result).toEqual(rows);
  expect(fetchWithAuth).toHaveBeenNthCalledWith(1, `/api/bob-apps/marketing/installations/${installation}/drafts?campaignId=${campaign}&projection=content`, expect.objectContaining({ signal: controller.signal }));
  for (const [path] of vi.mocked(fetchWithAuth).mock.calls) expect(String(path)).not.toMatch(/drafts\/[0-9a-f-]+/);
});

const row = (state: Installation['state'], revision = 1): Installation => ({ id: '00000000-0000-4000-8000-000000000001', appId: '00000000-0000-4000-8000-000000000002', spaceId: null, canManage: true, state, grantedCapabilities: [], revision, configRevision: 1, config: { visibleViews: [], contentGrouping: 'none', defaultChannels: [] }, package: { packageId: 'bob-marketing', name: 'Bob', version: '1.0.0' }, createdAt: 1, updatedAt: 1 });
it('installing activates in the same step at the installed revision', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(Response.json({ installation: row('draft') })).mockResolvedValueOnce(Response.json({ installation: row('active', 2) }));
  expect((await installMarketing('00000000-0000-4000-8000-000000000003')).state).toBe('active');
  const [path, init] = vi.mocked(fetchWithAuth).mock.calls[1] ?? [];
  expect(path).toBe(`/api/bob-apps/marketing/installations/${row('draft').id}/lifecycle`);
  expect(JSON.parse(String(init?.body))).toMatchObject({ operation: 'activate', expectedRevision: 1 });
});
it('a failed activation still returns the installed app, so its workspace can offer Activate', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(Response.json({ installation: row('draft') })).mockResolvedValueOnce(new Response(null, { status: 503 }));
  expect((await installMarketing('00000000-0000-4000-8000-000000000003')).state).toBe('draft');
});
