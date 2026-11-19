import { installationSchema, packageSchema, campaignSchema, campaignSummarySchema, draftContentPageSchema, configDetailSchema, type Installation, type MarketingPackage, type Campaign, type CampaignSummary, type Draft, type ConfigDetail } from './marketing-schemas';
import { fetchWithAuth } from '@/lib/auth/use-session';

export type { Installation, MarketingPackage, Campaign, CampaignSummary, Draft, ConfigDetail };
export class MarketingRequestError extends Error {
  constructor(readonly status: number) { super('marketing_request_failed'); }
}
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetchWithAuth(`/api/bob-apps/marketing${path}`, { method, signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new MarketingRequestError(response.status);
  return await response.json() as T;
}
export async function marketingCatalog(signal?: AbortSignal, spaceId?: string | null): Promise<{ package: MarketingPackage; installations: Installation[] }> {
  const [pack, list] = await Promise.all([request<{ package: MarketingPackage }>('/package', 'GET', undefined, signal), request<{ installations: Installation[] }>(`/installations${spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ''}`, 'GET', undefined, signal)]);
  return { package: packageSchema.parse(pack.package), installations: list.installations.map((item) => installationSchema.parse(item)) };
}
/** Installing is one step for the owner: it activates too. If activation fails the app still opens, and its workspace offers Activate. */
export async function installMarketing(mutationId: string, spaceId?: string | null): Promise<Installation> {
  const installed = installationSchema.parse((await request<{ installation: Installation }>('/install', 'POST', { packageId: 'bob-marketing', mutationId, ...(spaceId ? { spaceId } : {}) })).installation);
  if (installed.state === 'active' || installed.state === 'paused') return installed;
  return await marketingLifecycle(installed, 'activate', crypto.randomUUID()).catch(() => installed);
}
export async function marketingLifecycle(item: Installation, operation: 'activate' | 'pause' | 'resume', mutationId: string): Promise<Installation> {
  return installationSchema.parse((await request<{ installation: Installation }>(`/installations/${item.id}/lifecycle`, 'POST', { operation, expectedRevision: item.revision, mutationId })).installation);
}
export async function campaigns(id: string, signal?: AbortSignal): Promise<CampaignSummary[]> {
  const items: CampaignSummary[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: CampaignSummary[]; nextCursor: string | null } = await request(`/installations/${id}/campaigns${cursor ? `?cursor=${cursor}` : ''}`, 'GET', undefined, signal);
    items.push(...page.items.map((item) => campaignSummarySchema.parse(item)));
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
export async function campaign(id: string, campaignId: string, signal?: AbortSignal): Promise<Campaign> {
  return campaignSchema.parse((await request<{ campaign: Campaign }>(`/installations/${id}/campaigns/${campaignId}`, 'GET', undefined, signal)).campaign);
}
export async function drafts(id: string, campaignId: string, signal?: AbortSignal, channel?: Draft['channel']): Promise<Draft[]> {
  const items: Draft[] = [];
  let cursor: string | null = null;
  do {
    const page = draftContentPageSchema.parse(await request(`/installations/${id}/drafts?campaignId=${campaignId}&projection=content${channel ? `&channel=${channel}` : ''}${cursor ? `&cursor=${cursor}` : ''}`, 'GET', undefined, signal));
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
export async function selectedCampaign(id: string, conversationId: string, signal?: AbortSignal): Promise<CampaignSummary | null> {
  return campaignSummarySchema.nullable().parse((await request<{ campaign: CampaignSummary | null }>(`/installations/${id}/conversations/${conversationId}/selection`, 'GET', undefined, signal)).campaign);
}
export async function selectCampaign(id: string, conversationId: string, campaignId: string | null, mutationId: string): Promise<void> {
  await request(`/installations/${id}/conversations/${conversationId}/selection`, 'POST', { campaignId, mutationId });
}
export async function saveDraft(id: string, draft: Draft, fields: { body: string; altText: string | null; pillar: string | null }, mutationId: string): Promise<void> {
  await request(`/installations/${id}/drafts/${draft.id}`, 'PATCH', { ...fields, expectedContentRevision: draft.contentRevision, mutationId });
}
export async function configDetail(id: string, signal?: AbortSignal, beforeRevision?: number): Promise<ConfigDetail> {
  return configDetailSchema.parse(await request(`/installations/${id}/config${beforeRevision ? `?beforeRevision=${beforeRevision}` : ''}`, 'GET', undefined, signal));
}
export async function configMutation(id: string, action: 'apply' | 'discard' | 'restore', body: unknown): Promise<void> {
  await request(`/installations/${id}/config/${action}`, 'POST', body);
}
