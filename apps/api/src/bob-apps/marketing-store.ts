import { createHash } from 'node:crypto';
import { bobMarketingPack } from '@bob/ai';
import { z } from 'zod';
import { requireMarketingInstallation, getMarketingInstallation, lockMarketingInstallation } from './marketing-install.ts';
import {
  CreateCampaignIntentSchema, CreateDraftIntentSchema, MAX_CAMPAIGNS_PER_INSTALLATION, MAX_DRAFTS_PER_CAMPAIGN, MarketingOperationReceiptSchema,
  SaveSectionIntentSchema, SaveWeekPlanIntentSchema, UpdateCampaignIntentSchema, UpdateDraftIntentSchema, draftFormatAllowed, PLAN_SECTIONS, LIST_PAGE_CAMPAIGNS, LIST_PAGE_DRAFTS,
  CONTENT_PAGE_BYTES, CONTENT_PAGE_DRAFTS, type DraftContentListResponseSchema,
  type CampaignSchema, type CampaignSummarySchema, type DraftSchema, type DraftSummarySchema, type MarketingOverviewSchema,
} from './marketing-campaign-schemas.ts';
import { StoreConflictError, StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { assertToolEnabled } from '../tools/policy.ts';

// Authoritative campaign store. Every write holds the installation audience/owner lock and re-checks the live
// installation and capability inside the same transaction. Each write stores one exact minimal receipt under its
// operation key. Replays return that receipt after reauthorizing; a reused key with different intent conflicts. Keys are
// never pruned: at the installation cap, new writes stop with operation_limit_reached while exact replays keep working.
// Installation pause uses its independent lifecycle control. No transcript or content is ever stored in a receipt.
export type WriteOrigin = { key: string; scope: Record<string, string> };
export type MarketingReceipt = z.infer<typeof MarketingOperationReceiptSchema>;
type Capability = 'campaign.draft' | 'campaign.configure' | 'campaign.read';
type Channel = 'instagram' | 'linkedin';
type Format = 'text' | 'image' | 'carousel';

const OPERATION_LIMIT = 10000;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Stable JSON: object keys sorted, arrays keep their meaningful order. Used for pack and intent fingerprints only. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
/** The compiled pack hash is stamped on every campaign and draft write. It is server-computed, never model input. */
const PACK_HASH = sha256(canonicalJson(bobMarketingPack));
const KNOWN_CLAIMS: ReadonlySet<string> = new Set<string>(bobMarketingPack.claims.map((claim) => claim.id));
const KNOWN_ASSETS: ReadonlySet<string> = new Set<string>(Object.keys(bobMarketingPack.assets));
const pgArray = (values: readonly string[]): string => `{${values.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(',')}}`;
const millis = (value: Date | string): number => new Date(value).getTime();

interface Guard {
  installationId: string; capability: Capability; origin: WriteOrigin; kind: MarketingReceipt['kind']; path: string; intent: unknown; conversationId?: string; allowPaused?: boolean;
  /** A compound write must not get around a grant or policy that stops the single writes it stands for. */
  alsoCapabilities?: readonly Capability[]; alsoTools?: readonly string[];
}

async function guardConversation(tx: Db, owner: string, guard: Guard): Promise<void> {
  const scope = guard.origin.scope;
  const anchored = scope.source === 'tool' || scope.source === 'binding';
  const conversationId = guard.conversationId ?? (anchored ? scope.conversationId : undefined);
  if (conversationId === undefined) return;
  if (anchored && !scope.turnId) throw new StoreNotFoundError('marketing_scope_unavailable');
  const spaceId = await conversationSpaceOf(tx, owner, guard.installationId, conversationId, anchored ? scope.turnId : undefined);
  if (spaceId === null) throw new StoreNotFoundError('marketing_scope_unavailable');
  if (scope.source === 'tool') {
    if (!scope.tool || !scope.turnId) throw new StoreNotFoundError('marketing_scope_unavailable');
    for (const tool of [scope.tool, ...(guard.alsoTools ?? [])]) await assertToolEnabled(tx, owner, tool, { spaceId, conversationId });
  }
}

/**
 * One guarded write. Order: audience/owner lock, live installation with the capability (every replay too), exact replay or
 * conflict, operation cap, then the work and its one receipt. Installation pause remains independent of this quota.
 */
async function guarded(db: Db, owner: string, guard: Guard, work: (tx: Db) => Promise<MarketingReceipt>): Promise<MarketingReceipt> {
  return withUser(db, owner, async (tx) => {
    await lockMarketingInstallation(tx, owner, guard.installationId, 'write');
    await requireMarketingInstallation(tx, guard.installationId, guard.capability, guard.allowPaused);
    for (const capability of guard.alsoCapabilities ?? []) await requireMarketingInstallation(tx, guard.installationId, capability, guard.allowPaused);
    await guardConversation(tx, owner, guard);
    const hash = sha256(canonicalJson({ kind: guard.kind, owner, installation: guard.installationId, scope: guard.origin.scope, path: guard.path, intent: guard.intent }));
    const [prior] = await tx.query<{ canonical_hash: string; receipt: MarketingReceipt }>(
      'select canonical_hash,receipt from bob.bob_app_campaign_operations where user_id=$1 and installation_id=$2 and operation_key=$3',
      [owner, guard.installationId, guard.origin.key]);
    if (prior) {
      if (prior.canonical_hash !== hash) throw new StoreConflictError('marketing_mutation_conflict');
      return prior.receipt;
    }
    const [count] = await tx.query<{ n: number }>('select count(*)::int as n from bob.bob_app_campaign_operations where user_id=$1 and installation_id=$2', [owner, guard.installationId]);
    if ((count?.n ?? 0) >= OPERATION_LIMIT) throw new StoreError('operation_limit_reached');
    const receipt = await work(tx);
    await tx.query('insert into bob.bob_app_campaign_operations (user_id,installation_id,operation_key,canonical_hash,receipt) values ($1,$2,$3,$4,$5::text::jsonb)',
      [owner, guard.installationId, guard.origin.key, hash, JSON.stringify(receipt)]);
    return receipt;
  });
}
/** A private, nonarchived conversation of the owner, read in the caller's transaction. Null for group, pair or unscoped. */
async function privateSpaceOf(tx: Db, owner: string, conversationId: string, turnId?: string): Promise<string | null> {
  const [row] = await tx.query<{ space_id: string }>(`select c.space_id from bob.conversations c join bob.spaces s on s.id=c.space_id
    where c.id=$1 and c.user_id=$2 and c.archived_at is null and s.kind='private' and s.owner_user_id=$2 and s.archived_at is null
    and ($3::text is null or exists (select 1 from bob.messages m where m.id=$3 and m.conversation_id=c.id
      and m.user_id=$2 and m.author_user_id=$2 and m.role='user' and m.tombstoned_at is null))`, [conversationId, owner, turnId ?? null]);
  return row?.space_id ?? null;
}
async function writeSelection(tx: Db, owner: string, installationId: string, conversationId: string, campaignId: string | null): Promise<void> {
  if ((await conversationSpaceOf(tx, owner, installationId, conversationId)) === null) throw new StoreNotFoundError('marketing_scope_unavailable');
  if (campaignId === null) {
    await tx.query('delete from bob.bob_app_campaign_selection where user_id=$1 and installation_id=$2 and conversation_id=$3', [owner, installationId, conversationId]);
    return;
  }
  await tx.query(`insert into bob.bob_app_campaign_selection (user_id,installation_id,conversation_id,campaign_id) values ($1,$2,$3,$4)
    on conflict (user_id,installation_id,conversation_id) do update set campaign_id=excluded.campaign_id, selected_at=now()`,
  [owner, installationId, conversationId, campaignId]);
}
interface CampaignRow { id: string; installation_id: string; name: string; goal: string; goal_note: string | null; channels: string[]; status: string; revision: number; pack_revision: string; updated_at: Date | string; draft_count: number }
const CAMPAIGN_SQL = `select c.id,c.installation_id,c.name,c.goal,c.goal_note,c.channels,c.status,c.revision,c.pack_revision,c.updated_at,
  (select count(*)::int from bob.bob_app_campaign_drafts d where d.campaign_id=c.id) as draft_count from bob.bob_app_campaigns c`;
const summaryOf = (row: CampaignRow): z.infer<typeof CampaignSummarySchema> => ({
  id: row.id, installationId: row.installation_id, name: row.name, goal: row.goal as 'awareness' | 'curiosity' | 'beta_interest',
  goalNote: row.goal_note, channels: row.channels as Channel[], status: row.status as 'draft' | 'paused' | 'archived',
  revision: row.revision, draftCount: row.draft_count, updatedAt: millis(row.updated_at),
});
async function liveCampaignCount(tx: Db, owner: string, installationId: string): Promise<number> {
  const [row] = await tx.query<{ n: number }>("select count(*)::int as n from bob.bob_app_campaigns where (user_id=$1 or user_id is null) and installation_id=$2 and status<>'archived'", [owner, installationId]);
  return row?.n ?? 0;
}
/** An owned campaign in one installation. Another owner's or another installation's ID is not found. */
async function loadCampaign(tx: Db, owner: string, installationId: string, campaignId: string): Promise<CampaignRow> {
  const [row] = await tx.query<CampaignRow>(`${CAMPAIGN_SQL} where c.id=$1 and (c.user_id=$2 or c.user_id is null) and c.installation_id=$3`, [campaignId, owner, installationId]);
  if (!row) throw new StoreNotFoundError('marketing_campaign_not_found');
  return row;
}

async function insertCampaign(tx: Db, owner: string, installationId: string, input: { name: string; goal: string; goalNote?: string | null; channels: readonly string[] }, select?: string): Promise<string> {
  if ((await liveCampaignCount(tx, owner, installationId)) >= MAX_CAMPAIGNS_PER_INSTALLATION) throw new StoreError('campaign_quota_reached');
  const [row] = await tx.query<{ id: string }>(
    'insert into bob.bob_app_campaigns (user_id,created_by,installation_id,name,goal,goal_note,channels,pack_revision) values ((select user_id from bob.bob_app_installations where id=$2),$1,$2,$3,$4,$5,$6::text[],$7) returning id',
    [owner, installationId, input.name, input.goal, input.goalNote ?? null, pgArray(input.channels), PACK_HASH]);
  if (!row) throw new StoreError('marketing_unavailable');
  if (select !== undefined) await writeSelection(tx, owner, installationId, select, row.id);
  return row.id;
}
async function upsertSection(tx: Db, owner: string, installationId: string, campaignId: string, section: string, content: string): Promise<void> {
  await tx.query(
    `insert into bob.bob_app_campaign_sections (user_id,created_by,installation_id,campaign_id,section,content) values ((select user_id from bob.bob_app_installations where id=$2),$1,$2,$3,$4,$5)
     on conflict (campaign_id,section) do update set content=excluded.content, updated_at=now()`,
    [owner, installationId, campaignId, section, content]);
}
export async function createCampaign(db: Db, owner: string, installationId: string, value: unknown, origin: WriteOrigin, select?: string): Promise<MarketingReceipt> {
  const input = CreateCampaignIntentSchema.parse(value);
  return guarded(db, owner, { installationId, capability: 'campaign.configure', origin, kind: 'campaign.create', path: installationId, intent: { input, select: select ?? null }, conversationId: select }, async (tx) => {
    return { kind: 'campaign.create', campaignId: await insertCampaign(tx, owner, installationId, input, select), draftId: null, revision: 1 };
  });
}
export async function updateCampaign(db: Db, owner: string, installationId: string, campaignId: string, value: unknown, origin: WriteOrigin): Promise<MarketingReceipt> {
  const input = UpdateCampaignIntentSchema.parse(value);
  return guarded(db, owner, { installationId, capability: 'campaign.configure', origin, kind: 'campaign.update', path: campaignId, intent: input }, async (tx) => {
    const row = await loadCampaign(tx, owner, installationId, campaignId);
    if (row.revision !== input.expectedRevision) throw new StoreConflictError('marketing_revision_conflict');
    const status = input.status ?? row.status;
    if (row.status === 'archived' && status !== 'archived' && (await liveCampaignCount(tx, owner, installationId)) >= MAX_CAMPAIGNS_PER_INSTALLATION) {
      throw new StoreError('campaign_quota_reached');
    }
    const next = {
      name: input.name ?? row.name, goal: input.goal ?? row.goal, goalNote: input.goalNote === undefined ? row.goal_note : input.goalNote,
      channels: input.channels ?? row.channels, status,
    };
    const [updated] = await tx.query<{ revision: number }>(
      `update bob.bob_app_campaigns set name=$2,goal=$3,goal_note=$4,channels=$5::text[],status=$6,revision=revision+1,pack_revision=$8,updated_at=now()
       where id=$1 and revision=$7 returning revision`,
      [campaignId, next.name, next.goal, next.goalNote, pgArray(next.channels), next.status, row.revision, PACK_HASH]);
    if (!updated) throw new StoreConflictError('marketing_revision_conflict');
    if (status === 'archived') await tx.query('delete from bob.bob_app_campaign_selection where campaign_id=$1', [campaignId]);
    return { kind: 'campaign.update', campaignId, draftId: null, revision: updated.revision };
  });
}
export async function saveCampaignSection(db: Db, owner: string, installationId: string, campaignId: string, value: unknown, origin: WriteOrigin): Promise<MarketingReceipt> {
  const input = SaveSectionIntentSchema.parse(value);
  return guarded(db, owner, { installationId, capability: 'campaign.draft', origin, kind: 'campaign.section', path: `${campaignId}/${input.section}`, intent: input }, async (tx) => {
    const row = await loadCampaign(tx, owner, installationId, campaignId);
    if (row.status === 'archived') throw new StoreConflictError('marketing_campaign_archived');
    if (row.revision !== input.expectedRevision) throw new StoreConflictError('marketing_revision_conflict');
    await upsertSection(tx, owner, installationId, campaignId, input.section, input.content);
    const [updated] = await tx.query<{ revision: number }>('update bob.bob_app_campaigns set revision=revision+1,pack_revision=$3,updated_at=now() where id=$1 and revision=$2 returning revision',
      [campaignId, row.revision, PACK_HASH]);
    if (!updated) throw new StoreConflictError('marketing_revision_conflict');
    return { kind: 'campaign.section', campaignId, draftId: null, revision: updated.revision };
  });
}
/** Selects one live campaign for this conversation, or clears it with null. Archived campaigns are not selectable. The owner's picker also works while paused; turns and tools do not. */
export async function selectCampaign(db: Db, owner: string, installationId: string, conversationId: string, campaignId: string | null, origin: WriteOrigin): Promise<MarketingReceipt> {
  return guarded(db, owner, { installationId, capability: 'campaign.read', origin, kind: 'campaign.select', path: conversationId, intent: { campaignId }, conversationId, allowPaused: origin.scope.source === 'ui' }, async (tx) => {
    if (campaignId === null) {
      await writeSelection(tx, owner, installationId, conversationId, null);
      return { kind: 'campaign.select', campaignId: null, draftId: null, revision: null };
    }
    const row = await loadCampaign(tx, owner, installationId, campaignId);
    if (row.status === 'archived') throw new StoreNotFoundError('marketing_campaign_not_found');
    await writeSelection(tx, owner, installationId, conversationId, campaignId);
    return { kind: 'campaign.select', campaignId, draftId: null, revision: row.revision };
  });
}
interface DraftRow {
  id: string; campaign_id: string; channel: Channel; format: Format; body: string; alt_text: string | null; pillar: string | null;
  approved_asset_ids: string[]; claim_ids: string[]; cta: 'none' | 'waitlist' | 'signin'; state: 'draft' | 'needs_check';
  content_revision: number; pack_revision: string; created_at: Date | string; updated_at: Date | string;
}
const DRAFT_SQL = `select id,campaign_id,channel,format,body,alt_text,pillar,approved_asset_ids,claim_ids,cta,state,content_revision,pack_revision,created_at,updated_at from bob.bob_app_campaign_drafts`;
/** An owned draft in one installation. Another owner's or another installation's ID is not found. */
async function loadDraft(tx: Db, owner: string, installationId: string, draftId: string): Promise<DraftRow> {
  const [row] = await tx.query<DraftRow>(`${DRAFT_SQL} where id=$1 and (user_id=$2 or user_id is null) and installation_id=$3`, [draftId, owner, installationId]);
  if (!row) throw new StoreNotFoundError('marketing_draft_not_found');
  return row;
}
/** Reference validity only: every asset and claim must be a real pack ID. This is never a claim of semantic accuracy. */
function assertReferences(refs: { approvedAssetIds: readonly string[]; claimIds: readonly string[] }): void {
  if (refs.approvedAssetIds.some((id) => !KNOWN_ASSETS.has(id))) throw new StoreError('marketing_asset_unknown');
  if (refs.claimIds.some((id) => !KNOWN_CLAIMS.has(id))) throw new StoreError('marketing_claim_unknown');
}
function assertChannel(campaign: CampaignRow, channel: Channel): void {
  if (!campaign.channels.includes(channel)) throw new StoreError('marketing_channel_not_in_campaign');
}

type DraftInsert = { campaignId: string; channel: Channel; format: Format; body: string; altText?: string | null; pillar?: string | null; approvedAssetIds: readonly string[]; claimIds: readonly string[]; cta: string };
async function insertDraft(tx: Db, owner: string, installationId: string, input: DraftInsert): Promise<string> {
  assertReferences(input);
  const [row] = await tx.query<{ id: string }>(
    `insert into bob.bob_app_campaign_drafts (user_id,created_by,installation_id,campaign_id,channel,format,body,alt_text,pillar,approved_asset_ids,claim_ids,cta,state,pack_revision)
     values ((select user_id from bob.bob_app_installations where id=$2),$1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::text[],$11,'needs_check',$12) returning id`,
    [owner, installationId, input.campaignId, input.channel, input.format, input.body, input.altText ?? null, input.pillar ?? null,
      pgArray(input.approvedAssetIds), pgArray(input.claimIds), input.cta, PACK_HASH]);
  if (!row) throw new StoreError('marketing_unavailable');
  return row.id;
}
/** The workspace shows and edits one pillar field, so a week post's day and story beat travel in it: "Day N · pillar · beat". */
const weekDraftLabel = (post: { day: number; pillar: string; beat: string }): string => `Day ${post.day} · ${post.pillar.trim()} · ${post.beat.trim()}`;
const CHANNEL_LABELS: Record<Channel, string> = { instagram: 'Instagram', linkedin: 'LinkedIn' };
/**
 * One week, all or nothing, under one operation key: campaign and selection, the story as the brief, a calendar built
 * from the posts, and every post as a needs_check draft. It stands for create_campaign, save_plan_section and save_draft,
 * so it needs their grants and policy too.
 */
export async function saveWeekPlan(db: Db, owner: string, installationId: string, value: unknown, origin: WriteOrigin, select?: string): Promise<MarketingReceipt> {
  const input = SaveWeekPlanIntentSchema.parse(value);
  const guard: Guard = {
    installationId, capability: 'campaign.draft', alsoCapabilities: ['campaign.configure'], alsoTools: ['create_campaign', 'save_plan_section', 'save_draft'],
    origin, kind: 'campaign.week_plan', path: installationId, intent: { input, select: select ?? null }, conversationId: select,
  };
  return guarded(db, owner, guard, async (tx) => {
    const campaignId = await insertCampaign(tx, owner, installationId, input, select);
    const posts = input.posts.map((post) => ({ ...post, format: post.format ?? (post.channel === 'linkedin' ? 'text' as const : 'image' as const) })).sort((a, b) => a.day - b.day);
    for (const post of posts) await insertDraft(tx, owner, installationId, { ...post, campaignId, pillar: weekDraftLabel(post) });
    await upsertSection(tx, owner, installationId, campaignId, 'brief', input.story.trim());
    await upsertSection(tx, owner, installationId, campaignId, 'calendar', posts.map((post) =>
      `Day ${post.day} · ${CHANNEL_LABELS[post.channel]} · ${post.format} · ${post.pillar.trim()} · ${post.beat.trim()}`).join('\n'));
    return { kind: 'campaign.week_plan', campaignId, draftId: null, revision: 1 };
  });
}
export async function createDraft(db: Db, owner: string, installationId: string, value: unknown, origin: WriteOrigin): Promise<MarketingReceipt> {
  const input = CreateDraftIntentSchema.parse(value);
  return guarded(db, owner, { installationId, capability: 'campaign.draft', origin, kind: 'draft.create', path: input.campaignId, intent: input }, async (tx) => {
    const campaign = await loadCampaign(tx, owner, installationId, input.campaignId);
    if (campaign.status === 'archived') throw new StoreConflictError('marketing_campaign_archived');
    assertChannel(campaign, input.channel);
    const [count] = await tx.query<{ n: number }>('select count(*)::int as n from bob.bob_app_campaign_drafts where campaign_id=$1', [input.campaignId]);
    if ((count?.n ?? 0) >= MAX_DRAFTS_PER_CAMPAIGN) throw new StoreError('draft_quota_reached');
    return { kind: 'draft.create', campaignId: input.campaignId, draftId: await insertDraft(tx, owner, installationId, input), revision: 1 };
  });
}
export async function updateDraft(db: Db, owner: string, installationId: string, draftId: string, value: unknown, origin: WriteOrigin): Promise<MarketingReceipt> {
  const input = UpdateDraftIntentSchema.parse(value);
  return guarded(db, owner, { installationId, capability: 'campaign.draft', origin, kind: 'draft.update', path: draftId, intent: input }, async (tx) => {
    const draft = await loadDraft(tx, owner, installationId, draftId);
    const campaign = await loadCampaign(tx, owner, installationId, draft.campaign_id);
    if (campaign.status === 'archived') throw new StoreConflictError('marketing_campaign_archived');
    if (draft.content_revision !== input.expectedContentRevision) throw new StoreConflictError('marketing_revision_conflict');
    const next = mergedDraft(draft, input);
    if (!draftFormatAllowed(next.channel, next.format)) throw new StoreError('marketing_format_not_allowed');
    assertChannel(campaign, next.channel);
    assertReferences(next);
    const [updated] = await tx.query<{ content_revision: number }>(
      `update bob.bob_app_campaign_drafts set channel=$2,format=$3,body=$4,alt_text=$5,pillar=$6,approved_asset_ids=$7::text[],claim_ids=$8::text[],
       cta=$9,state='needs_check',content_revision=content_revision+1,pack_revision=$10,updated_at=now()
       where id=$1 and content_revision=$11 returning content_revision`,
      [draftId, next.channel, next.format, next.body, next.altText, next.pillar, pgArray(next.approvedAssetIds), pgArray(next.claimIds),
        next.cta, PACK_HASH, draft.content_revision]);
    if (!updated) throw new StoreConflictError('marketing_revision_conflict');
    return { kind: 'draft.update', campaignId: draft.campaign_id, draftId, revision: updated.content_revision };
  });
}
function mergedDraft(draft: DraftRow, input: z.infer<typeof UpdateDraftIntentSchema>) {
  return {
    channel: input.channel ?? draft.channel, format: input.format ?? draft.format, body: input.body ?? draft.body,
    altText: input.altText === undefined ? draft.alt_text : input.altText, pillar: input.pillar === undefined ? draft.pillar : input.pillar,
    approvedAssetIds: input.approvedAssetIds ?? draft.approved_asset_ids, claimIds: input.claimIds ?? draft.claim_ids, cta: input.cta ?? draft.cta,
  };
}
/** The owner's installation row: another owner's or a missing ID is not found, never a count or a hint. */
async function ownedInstallation(tx: Db, installationId: string): Promise<void> {
  const [row] = await tx.query<{ id: string }>('select id from bob.bob_app_installations where id=$1', [installationId]);
  if (!row) throw new StoreNotFoundError('marketing_installation_not_found');
}
export async function getMarketingOverview(db: Db, owner: string, installationId: string): Promise<z.infer<typeof MarketingOverviewSchema>> {
  const installation = await getMarketingInstallation(db, owner, installationId);
  return withUser(db, owner, async (tx) => {
    const [counts] = await tx.query<{ campaigns: number; live: number; drafts: number; needs: number }>(
      `select (select count(*)::int from bob.bob_app_campaigns where (user_id=$1 or user_id is null) and installation_id=$2) as campaigns,
        (select count(*)::int from bob.bob_app_campaigns where (user_id=$1 or user_id is null) and installation_id=$2 and status<>'archived') as live,
        (select count(*)::int from bob.bob_app_campaign_drafts where (user_id=$1 or user_id is null) and installation_id=$2) as drafts,
        (select count(*)::int from bob.bob_app_campaign_drafts where (user_id=$1 or user_id is null) and installation_id=$2 and state='needs_check') as needs`,
      [owner, installationId]);
    return {
      installation: { id: installation.id, state: installation.state, revision: installation.revision },
      counts: { campaigns: counts?.campaigns ?? 0, liveCampaigns: counts?.live ?? 0, drafts: counts?.drafts ?? 0, needsCheck: counts?.needs ?? 0 },
      analytics: { status: 'unavailable' as const, reason: 'Metrics are not collected yet, so reports show not available.' },
    };
  });
}
/** Stable ID order with a cursor on the last ID returned. The list is bounded: twenty campaigns at most per page. */
export async function listCampaigns(db: Db, owner: string, installationId: string, cursor: string | null): Promise<{ items: Array<z.infer<typeof CampaignSummarySchema>>; nextCursor: string | null }> {
  return withUser(db, owner, async (tx) => {
    await ownedInstallation(tx, installationId);
    const rows = await tx.query<CampaignRow>(`${CAMPAIGN_SQL} where (c.user_id=$1 or c.user_id is null) and c.installation_id=$2 and ($3::uuid is null or c.id > $3::uuid)
      order by c.id limit ${LIST_PAGE_CAMPAIGNS + 1}`, [owner, installationId, cursor]);
    const page = rows.slice(0, LIST_PAGE_CAMPAIGNS);
    return { items: page.map(summaryOf), nextCursor: rows.length > LIST_PAGE_CAMPAIGNS ? (page.at(-1)?.id ?? null) : null };
  });
}
export async function getCampaign(db: Db, owner: string, installationId: string, campaignId: string): Promise<z.infer<typeof CampaignSchema>> {
  return withUser(db, owner, async (tx) => {
    const row = await loadCampaign(tx, owner, installationId, campaignId);
    const stored = await tx.query<{ section: string; content: string }>('select section,content from bob.bob_app_campaign_sections where campaign_id=$1', [campaignId]);
    const sections = PLAN_SECTIONS.map((section) => ({ section, content: stored.find((item) => item.section === section)?.content ?? '' }));
    return { ...summaryOf(row), packRevision: row.pack_revision, sections };
  });
}
/** Compact owned campaign projection for trusted turn targeting; never includes saved section text. */
export async function getCampaignSummary(db: Db, owner: string, installationId: string, campaignId: string): Promise<z.infer<typeof CampaignSummarySchema>> {
  return withUser(db, owner, async (tx) => summaryOf(await loadCampaign(tx, owner, installationId, campaignId)));
}
export async function listDrafts(db: Db, owner: string, installationId: string, filter: { campaignId: string | null; cursor: string | null }): Promise<{ items: Array<z.infer<typeof DraftSummarySchema>>; nextCursor: string | null }> {
  return withUser(db, owner, async (tx) => {
    await ownedInstallation(tx, installationId);
    if (filter.campaignId !== null) await loadCampaign(tx, owner, installationId, filter.campaignId);
    const rows = await tx.query<{ id: string; campaign_id: string; channel: Channel; format: Format; state: DraftRow['state']; content_revision: number; updated_at: Date | string }>(
      `select id,campaign_id,channel,format,state,content_revision,updated_at from bob.bob_app_campaign_drafts
       where (user_id=$1 or user_id is null) and installation_id=$2 and ($3::uuid is null or campaign_id=$3::uuid) and ($4::uuid is null or id > $4::uuid)
       order by id limit ${LIST_PAGE_DRAFTS + 1}`, [owner, installationId, filter.campaignId, filter.cursor]);
    const page = rows.slice(0, LIST_PAGE_DRAFTS);
    const items = page.map((row) => ({ id: row.id, campaignId: row.campaign_id, channel: row.channel, format: row.format, state: row.state, contentRevision: row.content_revision, updatedAt: millis(row.updated_at) }));
    return { items, nextCursor: rows.length > LIST_PAGE_DRAFTS ? (page.at(-1)?.id ?? null) : null };
  });
}
export async function getDraft(db: Db, owner: string, installationId: string, draftId: string): Promise<z.infer<typeof DraftSchema>> {
  return withUser(db, owner, async (tx) => {
    const row = await loadDraft(tx, owner, installationId, draftId);
    return draftOf(row);
  });
}
export function draftOf(row: DraftRow): z.infer<typeof DraftSchema> {
  return {
    id: row.id, campaignId: row.campaign_id, channel: row.channel, format: row.format, body: row.body, altText: row.alt_text, pillar: row.pillar,
    approvedAssetIds: row.approved_asset_ids, claimIds: row.claim_ids, cta: row.cta, state: row.state, contentRevision: row.content_revision,
    packRevision: row.pack_revision, createdAt: millis(row.created_at), updatedAt: millis(row.updated_at),
  };
}
/** Browser content projection. Model tools retain the smaller summary contract above. */
export async function listDraftContent(db: Db, owner: string, installationId: string, filter: { campaignId: string; cursor: string | null; channel?: Channel }): Promise<z.infer<typeof DraftContentListResponseSchema>> {
  return withUser(db, owner, async (tx) => {
    await ownedInstallation(tx, installationId);
    await loadCampaign(tx, owner, installationId, filter.campaignId);
    const rows = await tx.query<DraftRow>(`${DRAFT_SQL} where (user_id=$1 or user_id is null) and installation_id=$2 and campaign_id=$3
      and ($4::uuid is null or id>$4::uuid) and ($5::text is null or channel=$5) order by id limit ${CONTENT_PAGE_DRAFTS + 1}`,
    [owner, installationId, filter.campaignId, filter.cursor, filter.channel ?? null]);
    return contentPage(rows);
  });
}
function contentPage(rows: DraftRow[]): z.infer<typeof DraftContentListResponseSchema> {
  const items: Array<z.infer<typeof DraftSchema>> = [];
  for (const row of rows.slice(0, CONTENT_PAGE_DRAFTS)) {
    const item = draftOf(row);
    const candidate = { items: [...items, item], nextCursor: item.id };
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > CONTENT_PAGE_BYTES) break;
    items.push(item);
  }
  // Database field bounds guarantee one full draft fits. Refuse a future incompatible row instead of looping an empty page.
  if (rows.length > 0 && items.length === 0) throw new StoreError('marketing_content_too_large');
  return { items, nextCursor: rows.length > items.length ? items.at(-1)?.id ?? null : null };
}
/** The conversation's selected campaign unless archived. Like every read it survives a pause; tools gate on a live installation first. */
export async function readSelectedCampaign(db: Db, owner: string, installationId: string, conversationId: string): Promise<z.infer<typeof CampaignSummarySchema> | null> {
  return withUser(db, owner, async (tx) => {
    if ((await conversationSpaceOf(tx, owner, installationId, conversationId)) === null) return null;
    const [row] = await tx.query<CampaignRow>(`${CAMPAIGN_SQL} join bob.bob_app_campaign_selection s on s.campaign_id=c.id
      where s.user_id=$1 and s.installation_id=$2 and s.conversation_id=$3 and c.status<>'archived'
      and exists (select 1 from bob.bob_app_installations i where i.id=$2 and 'campaign.read'=any(i.granted_capabilities))`, [owner, installationId, conversationId]);
    return row ? summaryOf(row) : null;
  });
}
export async function privateConversationSpace(db: Db, owner: string, conversationId: string, turnId?: string): Promise<string | null> {
  return withUser(db, owner, (tx) => privateSpaceOf(tx, owner, conversationId, turnId));
}

/** Installation audience and conversation audience must match; anchor belongs to the actual sender. */
async function conversationSpaceOf(tx: Db, actor: string, installationId: string, conversationId: string, turnId?: string): Promise<string | null> {
  const [row] = await tx.query<{ space_id: string }>(`select c.space_id from bob.conversations c
    join bob.spaces s on s.id=c.space_id join bob.bob_app_installations i on i.id=$4
    where c.id=$1 and c.archived_at is null and s.archived_at is null
    and ((i.space_id is null and c.user_id=$2 and s.kind='private' and s.owner_user_id=$2)
      or (i.space_id=c.space_id and bob_private.bob_app_space_member(i.space_id)))
    and ($3::text is null or exists(select 1 from bob.messages m where m.id=$3 and m.conversation_id=c.id
      and m.author_user_id=$2 and m.role='user' and m.tombstoned_at is null))`, [conversationId, actor, turnId ?? null, installationId]);
  return row?.space_id ?? null;
}
export async function marketingConversationSpace(db: Db, actor: string, installationId: string, conversationId: string, turnId?: string): Promise<string | null> {
  return withUser(db, actor, (tx) => conversationSpaceOf(tx, actor, installationId, conversationId, turnId));
}
