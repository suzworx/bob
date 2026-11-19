import type { Tool } from 'ai';
import { createHash } from 'node:crypto';
import { StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { isMarketingPaused, listMarketingInstallations, readSelectedMarketingInstallationId, resolveActiveMarketingInstallation, lockMarketingInstallation, requireMarketingInstallation } from './marketing-install.ts';
import { getCampaign, privateConversationSpace, marketingConversationSpace, selectCampaign } from './marketing-store.ts';
import { createMarketingTools } from './marketing-tools.ts';
import { createMarketingConfigTools } from './marketing-config-tools.ts';

/** Validated convenience context. Identity and grants are resolved from the owner's installation. */
export interface MarketingTurnBinding {
  installationId: string;
  mode: 'run' | 'refine';
  intent?: 'posts' | 'campaign';
  channel?: 'instagram' | 'linkedin';
  campaignId?: string | null;
}

/** Structured task context is admitted only after the bound tool factory authorized this turn. */
export function marketingTaskContext(binding: MarketingTurnBinding | null, tools: Record<string, Tool>): { kind: 'marketing'; intent: 'posts' | 'campaign' } | undefined {
  if (binding?.mode !== 'run' || !binding.intent || Object.keys(tools).length === 0) return undefined;
  return { kind: 'marketing', intent: binding.intent };
}

/** The owner's explicit binding names their own paused app. Everything else unavailable stays one undifferentiated error. */
export class MarketingPausedError extends Error {
  constructor() { super('marketing_paused'); this.name = 'MarketingPausedError'; }
}

/** Run before creating a conversation, changing its pointer or truncating/appending messages. Explicit denial never falls back. */
export async function preflightMarketingTurn(db: Db, userId: string, explicit?: MarketingTurnBinding, conversationId?: string): Promise<MarketingTurnBinding | null> {
  if (!explicit) return defaultMarketingBinding(db, userId, conversationId);
  try {
    const installation = await resolveActiveMarketingInstallation(db, userId, explicit.installationId);
    if (installation?.spaceId) throw new Error('marketing_binding_unavailable');
    if (!installation || (conversationId && !await privateConversationSpace(db, userId, conversationId))) throw new Error('marketing_binding_unavailable');
    if (explicit.campaignId && (await getCampaign(db, userId, explicit.installationId, explicit.campaignId)).status === 'archived') throw new Error('marketing_binding_unavailable');
    return explicit;
  } catch {
    if (await isMarketingPaused(db, userId, explicit.installationId).catch(() => false)) throw new MarketingPausedError();
    throw new Error('marketing_binding_unavailable');
  }
}

/** Global chat degrades closed; unreadable/legacy/shared scopes never acquire Marketing tools. */
async function defaultMarketingBinding(db: Db, userId: string, conversationId?: string): Promise<MarketingTurnBinding | null> {
  try {
    // Independent reads, started together; a conversation that is not private still yields no binding.
    const [isPrivate, selected] = await Promise.all([
      conversationId ? privateConversationSpace(db, userId, conversationId) : true,
      readSelectedMarketingInstallationId(db, userId),
    ]);
    if (!isPrivate) return null;
    if (selected && (await resolveActiveMarketingInstallation(db, userId, selected))?.spaceId === null) return { installationId: selected, mode: 'run' };
    const candidates = await listMarketingInstallations(db, userId);
    const active = (await Promise.all(candidates.map((item) => resolveActiveMarketingInstallation(db, userId, item.id)))).filter((item) => item !== null);
    return active.length === 1 && active[0] ? { installationId: active[0].id, mode: 'run' } : null;
  } catch {
    return null;
  }
}

/** Called inside the invocation claim/persist transaction before any receipt is returned. */
export async function authorizeMarketingInvocation(tx: Db, actor: string, binding: MarketingTurnBinding, conversationId: string): Promise<void> {
  const installation = await lockMarketingInstallation(tx, actor, binding.installationId, 'write');
  if (!installation.spaceId || !await marketingConversationSpace(tx, actor, installation.id, conversationId)) throw new StoreNotFoundError('marketing_binding_unavailable');
  await requireMarketingInstallation(tx, installation.id, binding.mode === 'refine' ? 'campaign.configure' : 'campaign.read');
  if (binding.campaignId && (await getCampaign(tx, actor, installation.id, binding.campaignId)).status === 'archived') throw new StoreNotFoundError('marketing_binding_unavailable');
}

/** Factories reauthorize the installation, scope and persisted user anchor, including every subsequent execution. */
export async function marketingToolsForTurn(db: Db, userId: string, binding: MarketingTurnBinding | null, conversationId: string, userMessageAnchor: string | null): Promise<Record<string, Tool>> {
  if (!binding || !userMessageAnchor) return {};
  try {
    const context = { db, userId, installationId: binding.installationId, conversationId, turnId: userMessageAnchor };
    if (binding.mode === 'run' && binding.campaignId !== undefined) {
      const key = createHash('sha256').update(JSON.stringify([userId, binding.installationId, conversationId, userMessageAnchor, 'campaign.select', binding.campaignId])).digest('hex');
      await selectCampaign(db, userId, binding.installationId, conversationId, binding.campaignId, { key, scope: { source: 'binding', conversationId, turnId: userMessageAnchor } });
    }
    return binding.mode === 'refine' ? await createMarketingConfigTools(context) : await createMarketingTools({ ...context, ...(binding.channel ? { selectedChannel: binding.channel } : {}), ...(binding.campaignId !== undefined ? { selectedCampaignId: binding.campaignId } : {}) });
  } catch {
    return {};
  }
}
