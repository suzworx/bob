import { createHash } from 'node:crypto';
import { bobMarketingPack } from '@bob/ai';
import type { z } from 'zod';
import { StoreConflictError, StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { assertToolEnabled } from '../tools/policy.ts';
import { lockMarketingInstallation, requireMarketingInstallation, requireMarketingSession } from './marketing-install.ts';
import { canonicalJson, draftOf, getCampaign, marketingConversationSpace, type WriteOrigin } from './marketing-store.ts';
import { MarketingReviewApproveSchema, MarketingReviewNoteTextSchema, MarketingReviewSchema } from './marketing-review-schemas.ts';

type Review = z.infer<typeof MarketingReviewSchema>;
type Installation = Awaited<ReturnType<typeof lockMarketingInstallation>>;
type SharedInstallation = Installation & { spaceId: string };
type Metadata = { review_revision: number; lifecycle_generation: number; status: string; app_state: string };
type Attribution = { author_user_id: string | null; created_at: Date };
type DecisionRow = Attribution & { id: string; snapshot_hash: string; review_revision: number };
type NoteRow = Attribution & { id: string; text: string };
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const PACK_REVISION = hash(bobMarketingPack);

async function lockReview(tx: Db, actor: string, installationId: string, campaignId: string, manage = false): Promise<SharedInstallation> {
  const installation = await lockMarketingInstallation(tx, actor, installationId, manage ? 'manage' : 'read');
  if (!installation.spaceId) throw new StoreNotFoundError('review_not_found');
  await tx.query('select id from bob.bob_app_installations where id=$1 for update', [installationId]);
  if (!(await tx.query('select id from bob.bob_app_campaigns where id=$1 and installation_id=$2 for update', [campaignId, installationId])).length) throw new StoreNotFoundError('review_not_found');
  const [version] = await tx.query<{ locked: boolean }>('select bob_private.lock_marketing_review_revision($1,$2) as locked', [installationId, campaignId]);
  if (!version?.locked) throw new StoreNotFoundError('review_not_found');
  return { ...installation, spaceId: installation.spaceId };
}

/** Audience/app/campaign locks keep every query in this complete projection atomic with content writes. */
async function projection(tx: Db, actor: string, installation: Installation, campaignId: string): Promise<Review> {
  const campaign = await getCampaign(tx, actor, installation.id, campaignId);
  const rows = await tx.query<Parameters<typeof draftOf>[0]>('select * from bob.bob_app_campaign_drafts where installation_id=$1 and campaign_id=$2 order by id limit 101', [installation.id, campaignId]);
  if (rows.length > 100) throw new StoreError('review_snapshot_full');
  const drafts = rows.map(draftOf);
  const [meta] = await tx.query<Metadata>(`select cv.review_revision,c.status,a.lifecycle as app_state,
    (av.generation::bigint+iv.generation+cv.generation)::float8 as lifecycle_generation
    from bob.bob_app_campaigns c join bob.bob_app_installations i on i.id=c.installation_id
    join bob.bob_apps a on a.id=i.app_id
    join bob.marketing_review_app_versions av on av.app_id=a.id
    join bob.marketing_review_installation_versions iv on iv.installation_id=i.id
    join bob.marketing_review_campaign_versions cv on cv.campaign_id=c.id and cv.installation_id=i.id
    where c.id=$1 and i.id=$2`, [campaignId, installation.id]);
  if (!meta) throw new StoreNotFoundError('review_not_found');
  const snapshotHash = hash({ installationId: installation.id, campaignId, reviewRevision: meta.review_revision,
    lifecycleGeneration: meta.lifecycle_generation, packRevision: PACK_REVISION,
    campaign: { ...campaign, updatedAt: undefined }, drafts: drafts.map(({ createdAt: _created, updatedAt: _updated, ...content }) => content) });
  const people = await tx.query<{ user_id: string; display_name: string | null }>('select user_id,display_name from bob_private.space_member_profiles($1)', [installation.spaceId]);
  const author = (id: string | null): Review['notes'][number]['author'] => {
    const person = people.find((item) => item.user_id === id);
    return person ? { id: person.user_id, label: person.display_name?.trim().slice(0, 200) || 'Team member' } : null;
  };
  const decisions = await tx.query<DecisionRow>('select id,snapshot_hash,review_revision,author_user_id,created_at from bob.marketing_review_decisions where installation_id=$1 and campaign_id=$2 order by created_at desc,id desc limit 20', [installation.id, campaignId]);
  const history = decisions.map((row) => ({ id: row.id, snapshotHash: row.snapshot_hash, reviewRevision: row.review_revision, author: author(row.author_user_id), createdAt: new Date(row.created_at).getTime() }));
  const live = installation.state === 'active' && meta.app_state === 'active' && meta.status === 'draft' && drafts.length > 0;
  const approval = live ? history.find((item) => item.snapshotHash === snapshotHash) ?? null : null;
  const notes = await tx.query<NoteRow>('select id,text,author_user_id,created_at from bob.marketing_review_notes where installation_id=$1 and campaign_id=$2 order by created_at,id limit 100', [installation.id, campaignId]);
  return MarketingReviewSchema.parse({ installationId: installation.id, campaignId, state: approval ? 'approved' : 'needs_review',
    reviewRevision: meta.review_revision, snapshotHash, lifecycleGeneration: meta.lifecycle_generation, packRevision: PACK_REVISION,
    canApprove: installation.canManage && live && installation.grantedCapabilities.includes('campaign.configure'), snapshot: { campaign, drafts }, notes: notes.map((row) => ({ id: row.id, text: row.text, author: author(row.author_user_id), createdAt: new Date(row.created_at).getTime() })), approval, history });
}

export async function getMarketingReview(db: Db, actor: string, installationId: string, campaignId: string): Promise<Review> {
  return withUser(db, actor, async (tx) => projection(tx, actor, await lockReview(tx, actor, installationId, campaignId), campaignId));
}

type Operation = { fingerprint: string; kind: string; result_id: string };
async function replay(tx: Db, actor: string, installationId: string, key: string, fingerprint: string): Promise<Operation | undefined> {
  const [prior] = await tx.query<Operation>('select fingerprint,kind,result_id from bob.marketing_review_operations where installation_id=$1 and actor_user_id=$2 and operation_key=$3', [installationId, actor, key]);
  if (prior && prior.fingerprint !== fingerprint) throw new StoreConflictError('review_conflict');
  return prior;
}
async function record(tx: Db, actor: string, installationId: string, campaignId: string, key: string, fingerprint: string, kind: string, result: string): Promise<void> {
  await tx.query('insert into bob.marketing_review_operations(actor_user_id,installation_id,campaign_id,operation_key,fingerprint,kind,result_id) values($1,$2,$3,$4,$5,$6,$7)', [actor, installationId, campaignId, key, fingerprint, kind, result]);
}
async function requireLive(tx: Db, installation: Installation, review: Review): Promise<void> {
  await requireMarketingInstallation(tx, installation.id, 'campaign.configure');
  if (review.snapshot.campaign.status !== 'draft') throw new StoreConflictError('review_conflict');
}

/** Explicit editorial action only; model tools cannot call this capability. */
export async function approveMarketingPlan(db: Db, actor: string, installationId: string, campaignId: string, value: unknown, sessionId: string) {
  const input = MarketingReviewApproveSchema.parse(value);
  const fingerprint = hash({ kind: 'review.approved', installationId, campaignId, actor, input });
  return withUser(db, actor, async (tx) => {
    const installation = await lockReview(tx, actor, installationId, campaignId, true);
    await requireMarketingSession(tx, sessionId);
    const current = await projection(tx, actor, installation, campaignId);
    await requireLive(tx, installation, current);
    const prior = await replay(tx, actor, installationId, input.mutationId, fingerprint);
    if (prior) return { receipt: { kind: 'review.approved' as const, installationId, campaignId, approvalId: prior.result_id }, review: current };
    if (!current.canApprove || current.reviewRevision !== input.expectedReviewRevision || current.snapshotHash !== input.snapshotHash) throw new StoreConflictError('review_conflict');
    const [decision] = await tx.query<{ id: string }>('insert into bob.marketing_review_decisions(installation_id,campaign_id,author_user_id,session_id,review_revision,snapshot_hash) values($1,$2,$3,$4,$5,$6) returning id', [installationId, campaignId, actor, sessionId, current.reviewRevision, current.snapshotHash]);
    if (!decision) throw new StoreError('review_unavailable');
    await record(tx, actor, installationId, campaignId, input.mutationId, fingerprint, 'review.approved', decision.id);
    return { receipt: { kind: 'review.approved' as const, installationId, campaignId, approvalId: decision.id }, review: await projection(tx, actor, installation, campaignId) };
  });
}

export async function addMarketingReviewNote(db: Db, actor: string, installationId: string, campaignId: string, value: unknown, origin: WriteOrigin) {
  const text = MarketingReviewNoteTextSchema.parse(value);
  const fingerprint = hash({ kind: 'review.note', installationId, campaignId, actor, text, scope: origin.scope });
  return withUser(db, actor, async (tx) => {
    const installation = await lockReview(tx, actor, installationId, campaignId);
    await requireMarketingInstallation(tx, installationId, 'campaign.draft');
    const { source, tool, conversationId, turnId } = origin.scope;
    if (source !== 'tool' || tool !== 'add_marketing_review_note' || !conversationId || !turnId || !await marketingConversationSpace(tx, actor, installationId, conversationId, turnId)) throw new StoreNotFoundError('review_scope_unavailable');
    await assertToolEnabled(tx, actor, tool, { spaceId: installation.spaceId, conversationId });
    if ((await getCampaign(tx, actor, installationId, campaignId)).status !== 'draft') throw new StoreConflictError('review_conflict');
    const prior = await replay(tx, actor, installationId, origin.key, fingerprint);
    if (prior) return { kind: 'review.note' as const, installationId, campaignId, noteId: prior.result_id };
    const [count] = await tx.query<{ n: number }>('select count(*)::int as n from bob.marketing_review_notes where installation_id=$1 and campaign_id=$2', [installationId, campaignId]);
    if ((count?.n ?? 0) >= 100) throw new StoreError('review_note_limit');
    const [note] = await tx.query<{ id: string }>('insert into bob.marketing_review_notes(installation_id,campaign_id,author_user_id,source_message_id,source_conversation_id,text) values($1,$2,$3,$4,$5,$6) returning id', [installationId, campaignId, actor, turnId, conversationId, text]);
    if (!note) throw new StoreError('review_unavailable');
    await record(tx, actor, installationId, campaignId, origin.key, fingerprint, 'review.note', note.id);
    return { kind: 'review.note' as const, installationId, campaignId, noteId: note.id };
  });
}
