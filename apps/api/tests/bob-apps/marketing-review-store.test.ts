import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { installMarketingPackage, changeMarketingLifecycle } from '../../src/bob-apps/marketing-install.ts';
import { createCampaign, createDraft, updateDraft, updateCampaign } from '../../src/bob-apps/marketing-store.ts';
import { addMarketingReviewNote, approveMarketingPlan, getMarketingReview } from '../../src/bob-apps/marketing-review-store.ts';
import { createMarketingTools } from '../../src/bob-apps/marketing-tools.ts';
import { proposeMarketingConfig, applyMarketingConfigProposal } from '../../src/bob-apps/marketing-config-store.ts';
import { mutateBobApp } from '../../src/bob-apps/store.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { setMemberRole } from '../../src/spaces/member-roles.ts';
import { deleteAccount } from '../../src/workflows/workflow-account-deletion.ts';
import { runInvocation } from '../../src/workflows/workflow-thread-invocation.ts';
import { createScriptedAgent } from '../../src/voice/agent-adapters.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

vi.mock('../../src/notifications/email-client.ts', async (original) => ({ ...(await original<typeof import('../../src/notifications/email-client.ts')>()), recipientEmail: vi.fn(async () => null) }));
let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
afterEach(() => { vi.unstubAllEnvs(); });
const origin = () => ({ key: randomUUID(), scope: { source: 'ui' } });
async function setup() {
  const owner = await addAccount(pg);
  const member = await addAccount(pg);
  const admin = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Review team' });
  await addMember(db, owner.userId, space.id, member.userId, 'member');
  await addMember(db, owner.userId, space.id, admin.userId, 'admin');
  const installed = await installMarketingPackage(db, admin.userId, { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, admin.sessionId);
  const app = await changeMarketingLifecycle(db, owner.userId, installed.id, { operation: 'activate', expectedRevision: installed.revision, mutationId: randomUUID() });
  const campaign = await createCampaign(db, member.userId, app.id, { name: 'A shared story', goal: 'awareness', channels: ['instagram', 'linkedin'] }, origin());
  if (!campaign.campaignId) throw new Error('campaign missing');
  const campaignId = campaign.campaignId;
  const draft = await createDraft(db, member.userId, app.id, { campaignId, channel: 'linkedin', format: 'text', body: 'A little joy.', approvedAssetIds: [], claimIds: [], cta: 'none' }, origin());
  if (!draft.draftId) throw new Error('draft missing');
  const thread = await createThread(db, member.userId, { spaceId: space.id, title: 'Review notes' });
  const { message } = await postMessage(db, member.userId, { threadId: thread.id, body: 'Make Monday warmer.', clientMessageId: randomUUID() });
  const noteOrigin = { key: randomUUID(), scope: { source: 'tool', tool: 'add_marketing_review_note', conversationId: thread.id, turnId: message.id } };
  return { owner, member, admin, space, app, campaignId, draftId: draft.draftId, noteOrigin };
}
type Team = Awaited<ReturnType<typeof setup>>;
async function target(team: Team) {
  const review = await getMarketingReview(db, team.admin.userId, team.app.id, team.campaignId);
  return { expectedReviewRevision: review.reviewRevision, snapshotHash: review.snapshotHash, mutationId: randomUUID() };
}

it('approves all100 saved posts across channels rather than one browser page', async () => {
  const t = await setup();
  await withUser(db, t.member.userId, (tx) => tx.query(`insert into bob.bob_app_campaign_drafts(user_id,installation_id,campaign_id,channel,format,body,pack_revision)
    select null,installation_id,campaign_id,case when n%2=0 then 'instagram' else 'linkedin' end,'image','Post '||n,pack_revision
    from bob.bob_app_campaign_drafts cross join generate_series(2,100) n where id=$1`, [t.draftId]));
  const displayed = await getMarketingReview(db, t.admin.userId, t.app.id, t.campaignId);
  expect(displayed.snapshot.drafts).toHaveLength(100);
  expect(new Set(displayed.snapshot.drafts.map((post) => post.channel)).size).toBe(2);
  expect(displayed.snapshot.drafts.map((post) => post.id)).toEqual(displayed.snapshot.drafts.map((post) => post.id).sort());
  const approved = await approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, await target(t), t.admin.sessionId);
  expect(approved.review.state).toBe('approved');
  const last = displayed.snapshot.drafts.at(-1);
  if (!last) throw new Error('post missing');
  await updateDraft(db, t.member.userId, t.app.id, last.id, { expectedContentRevision: last.contentRevision, body: 'Changed beyond first page.' }, origin());
  expect((await getMarketingReview(db, t.owner.userId, t.app.id, t.campaignId)).state).toBe('needs_review');
});

it('requires a new target after edit-and-revert and rejects counter rollback in authenticated SQL', async () => {
  const t = await setup();
  const input = await target(t);
  await approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, input, t.admin.sessionId);
  await updateDraft(db, t.member.userId, t.app.id, t.draftId, { expectedContentRevision: 1, body: 'Changed.' }, origin());
  await updateDraft(db, t.member.userId, t.app.id, t.draftId, { expectedContentRevision: 2, body: 'A little joy.' }, origin());
  const current = await getMarketingReview(db, t.admin.userId, t.app.id, t.campaignId);
  expect(current.reviewRevision).toBeGreaterThan(input.expectedReviewRevision);
  expect(current.snapshotHash).not.toBe(input.snapshotHash);
  expect(current.state).toBe('needs_review');
  await expect(approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, { ...input, mutationId: randomUUID() }, t.admin.sessionId)).rejects.toThrow('review_conflict');
  await expect(withUser(db, t.admin.userId, (tx) => tx.query('update bob.marketing_review_campaign_versions set review_revision=1 where campaign_id=$1', [t.campaignId]))).rejects.toThrow('permission denied');
});

it.each(['installation', 'app', 'campaign'] as const)('does not revive approval after %s pause/archive and resume/restore', async (kind) => {
  const t = await setup();
  const input = await target(t);
  await approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, input, t.admin.sessionId);
  if (kind === 'installation') {
    const paused = await changeMarketingLifecycle(db, t.owner.userId, t.app.id, { operation: 'pause', expectedRevision: t.app.revision, mutationId: randomUUID() });
    await changeMarketingLifecycle(db, t.owner.userId, t.app.id, { operation: 'resume', expectedRevision: paused.revision, mutationId: randomUUID() });
  } else if (kind === 'app') {
    const archived = await mutateBobApp(db, t.owner.userId, t.app.appId, { operation: 'archive', expectedRevision: 2, mutationId: randomUUID() });
    await mutateBobApp(db, t.owner.userId, t.app.appId, { operation: 'restore', expectedRevision: archived.revision, mutationId: randomUUID() });
    const [installation] = await withUser(db, t.owner.userId, (tx) => tx.query<{ revision: number }>('select revision from bob.bob_app_installations where id=$1', [t.app.id]));
    await changeMarketingLifecycle(db, t.owner.userId, t.app.id, { operation: 'resume', expectedRevision: installation?.revision, mutationId: randomUUID() });
  } else {
    const paused = await updateCampaign(db, t.owner.userId, t.app.id, t.campaignId, { expectedRevision: 1, status: 'paused' }, origin());
    await updateCampaign(db, t.owner.userId, t.app.id, t.campaignId, { expectedRevision: paused.revision, status: 'draft' }, origin());
  }
  const current = await getMarketingReview(db, t.admin.userId, t.app.id, t.campaignId);
  expect(current.state).toBe('needs_review');
  expect(current.snapshotHash).not.toBe(input.snapshotHash);
  await expect(approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, { ...input, mutationId: randomUUID() }, t.admin.sessionId)).rejects.toThrow('review_conflict');
});

it('keeps notes and view configuration outside approval hash and returns fresh projections on replay', async () => {
  const t = await setup();
  const input = await target(t);
  const approved = await approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, input, t.admin.sessionId);
  const receipt = await addMarketingReviewNote(db, t.member.userId, t.app.id, t.campaignId, 'Make Monday warmer.', t.noteOrigin);
  expect(await addMarketingReviewNote(db, t.member.userId, t.app.id, t.campaignId, 'Make Monday warmer.', t.noteOrigin)).toEqual(receipt);
  await expect(addMarketingReviewNote(db, t.member.userId, t.app.id, t.campaignId, 'Different note.', t.noteOrigin)).rejects.toThrow('review_conflict');
  const proposal = await proposeMarketingConfig(db, t.member.userId, t.app.id, { expectedConfigRevision: 1, config: { visibleViews: ['content'], contentGrouping: 'channel', defaultChannels: ['linkedin'] }, mutationId: randomUUID() });
  if (!proposal.proposal) throw new Error('proposal missing');
  await applyMarketingConfigProposal(db, t.owner.userId, t.app.id, { proposalId: proposal.proposal.id, hash: proposal.proposal.canonicalHash, expectedConfigRevision: 1, mutationId: randomUUID() });
  const replayed = await approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, input, t.admin.sessionId);
  expect(replayed.receipt).toEqual(approved.receipt);
  expect(replayed.review.state).toBe('approved');
  expect(replayed.review.snapshotHash).toBe(input.snapshotHash);
  expect(replayed.review.notes).toHaveLength(1);
  await withUser(db, t.member.userId, (tx) => tx.query("update bob.bob_app_campaign_drafts set updated_at=updated_at+interval '1 second' where id=$1", [t.draftId]));
  expect((await getMarketingReview(db, t.admin.userId, t.app.id, t.campaignId)).snapshotHash).toBe(input.snapshotHash);
});

it('reauthorizes current manager, session and membership before exact approval/note replays', async () => {
  const t = await setup();
  const input = await target(t);
  await approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, input, t.admin.sessionId);
  await expect(approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, input, t.owner.sessionId)).rejects.toThrow('marketing_session_inactive');
  await setMemberRole(db, t.owner.userId, t.space.id, t.admin.userId, 'member');
  await expect(approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, input, t.admin.sessionId)).rejects.toThrow('app_management_required');
  await addMarketingReviewNote(db, t.member.userId, t.app.id, t.campaignId, 'Keep this feedback.', t.noteOrigin);
  await revokeMember(db, t.owner.userId, t.space.id, t.member.userId);
  await expect(addMarketingReviewNote(db, t.member.userId, t.app.id, t.campaignId, 'Keep this feedback.', t.noteOrigin)).rejects.toThrow();
});

it('reports lost configure authority and refuses an approval receipt replay after grant revocation', async () => {
  const t = await setup();
  const input = await target(t);
  await approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, input, t.admin.sessionId);
  await withUser(db, t.owner.userId, (tx) => tx.query("update bob.bob_app_installations set granted_capabilities=array['campaign.read','campaign.draft'] where id=$1", [t.app.id]));
  expect((await getMarketingReview(db, t.admin.userId, t.app.id, t.campaignId)).canApprove).toBe(false);
  await expect(approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, input, t.admin.sessionId)).rejects.toThrow('marketing_permission_denied');
});

it('retains authored notes and decisions through supported installer erasure without cached attribution', async () => {
  const t = await setup();
  const input = await target(t);
  expect((await withUser(db, t.owner.userId, (tx) => tx.query<{ created_by: string }>('select created_by from bob.bob_app_installations where id=$1', [t.app.id])))[0]?.created_by).toBe(t.admin.userId);
  await approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, input, t.admin.sessionId);
  await addMarketingReviewNote(db, t.member.userId, t.app.id, t.campaignId, 'Keep this feedback.', t.noteOrigin);
  const deps = { db, now: () => Date.now(), googleConnection: { revoke: vi.fn(async () => undefined) }, deviceSessions: { closeDevice: vi.fn() } };
  expect(await deleteAccount(deps, { userId: t.member.userId })).toEqual({ outcome: 'deleted' });
  expect(await deleteAccount(deps, { userId: t.admin.userId })).toEqual({ outcome: 'deleted' });
  const retained = await getMarketingReview(db, t.owner.userId, t.app.id, t.campaignId);
  expect(retained.state).toBe('approved');
  expect(retained.notes).toMatchObject([{ text: 'Keep this feedback.', author: null }]);
  expect(retained.approval?.author).toBeNull();
  await withUser(db, t.owner.userId, async (tx) => {
    expect(await tx.query('select author_user_id,source_message_id,source_conversation_id from bob.marketing_review_notes where campaign_id=$1', [t.campaignId])).toEqual([{ author_user_id: null, source_message_id: null, source_conversation_id: null }]);
    expect(await tx.query('select author_user_id,session_id from bob.marketing_review_decisions where campaign_id=$1', [t.campaignId])).toEqual([{ author_user_id: null, session_id: null }]);
    expect(await tx.query('select * from bob.marketing_review_operations where campaign_id=$1', [t.campaignId])).toEqual([]);
  });
});

it('executes the actual scripted shared note tool with the sender and selected campaign', async () => {
  vi.stubEnv('BOB_AI_STUB', 'scripted');
  vi.stubEnv('BOB_PRODUCTION', '0');
  const t = await setup();
  const { message } = await postMessage(db, t.member.userId, { threadId: t.noteOrigin.scope.conversationId, body: 'e2e add a marketing review note called Make Monday warmer.', clientMessageId: randomUUID() });
  const result = await runInvocation({ actorUserId: t.member.userId, spaceId: t.space.id, threadId: message.threadId, triggerMessageId: message.id, contextHighWater: message.sequence,
    appBinding: { installationId: t.app.id, mode: 'run', campaignId: t.campaignId } }, { appTurnTools: createAppTurnExtension(saveAppIdea), db, agent: createScriptedAgent() });
  expect(result).toMatchObject({ outcome: 'completed' });
  const review = await getMarketingReview(db, t.owner.userId, t.app.id, t.campaignId);
  expect(review.notes).toMatchObject([{ text: 'Make Monday warmer.', author: { id: t.member.userId } }]);
  expect(await withUser(db, t.owner.userId, (tx) => tx.query('select author_user_id,source_message_id,source_conversation_id from bob.marketing_review_notes where campaign_id=$1', [t.campaignId]))).toEqual([{ author_user_id: t.member.userId, source_message_id: message.id, source_conversation_id: message.threadId }]);
  expect(review.state).toBe('needs_review');
});

it('offers only the group note tool and rejects fake sender anchors and private review', async () => {
  const t = await setup();
  const tools = await createMarketingTools({ db, userId: t.member.userId, installationId: t.app.id, conversationId: t.noteOrigin.scope.conversationId, turnId: t.noteOrigin.scope.turnId, selectedCampaignId: t.campaignId });
  expect(Object.keys(tools)).toContain('add_marketing_review_note');
  expect(Object.keys(tools)).not.toContain('approve_marketing_plan');
  await expect(addMarketingReviewNote(db, t.admin.userId, t.app.id, t.campaignId, 'Not my source.', t.noteOrigin)).rejects.toThrow('review_scope_unavailable');
  const privateApp = await installMarketingPackage(db, t.owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, t.owner.sessionId);
  await expect(getMarketingReview(db, t.owner.userId, privateApp.id, t.campaignId)).rejects.toThrow('review_not_found');
  const otherSpace = await createSpace(db, t.owner.userId, { kind: 'group', name: 'Other group' });
  const other = await installMarketingPackage(db, t.owner.userId, { packageId: 'bob-marketing', spaceId: otherSpace.id, mutationId: randomUUID() }, t.owner.sessionId);
  await expect(getMarketingReview(db, t.owner.userId, other.id, t.campaignId)).rejects.toThrow('review_not_found');
  const outsider = await addAccount(pg);
  await expect(getMarketingReview(db, outsider.userId, t.app.id, t.campaignId)).rejects.toThrow();
});

it('bounds retained notes at100 even through authenticated SQL and never prunes earlier notes', async () => {
  const t = await setup();
  await withUser(db, t.member.userId, (tx) => tx.query(`insert into bob.marketing_review_notes(installation_id,campaign_id,author_user_id,source_message_id,source_conversation_id,text)
    select $1,$2,$3,$4,$5,'Note '||n from generate_series(1,100) n`, [t.app.id, t.campaignId, t.member.userId, t.noteOrigin.scope.turnId, t.noteOrigin.scope.conversationId]));
  await expect(addMarketingReviewNote(db, t.member.userId, t.app.id, t.campaignId, 'One more note.', t.noteOrigin)).rejects.toThrow('review_note_limit');
  await expect(withUser(db, t.member.userId, (tx) => tx.query(`insert into bob.marketing_review_notes(installation_id,campaign_id,author_user_id,source_message_id,source_conversation_id,text)
    values($1,$2,$3,$4,$5,'Too many')`, [t.app.id, t.campaignId, t.member.userId, t.noteOrigin.scope.turnId, t.noteOrigin.scope.conversationId]))).rejects.toThrow('review_note_limit');
  const review = await getMarketingReview(db, t.owner.userId, t.app.id, t.campaignId);
  expect(review.notes).toHaveLength(100);
  expect(new Set(review.notes.map((note) => note.text)).size).toBe(100);
});

it('keeps review records append-only and rejects stale draft pack revisions', async () => {
  const t = await setup();
  const input = await target(t);
  await approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, input, t.admin.sessionId);
  await addMarketingReviewNote(db, t.member.userId, t.app.id, t.campaignId, 'Keep this note.', t.noteOrigin);
  for (const table of ['marketing_review_notes', 'marketing_review_decisions']) {
    await expect(withUser(db, t.owner.userId, (tx) => tx.query(`delete from bob.${table} where campaign_id=$1`, [t.campaignId]))).rejects.toThrow();
  }
  await expect(withUser(db, t.owner.userId, (tx) => tx.query('update bob.marketing_review_notes set text=$2 where campaign_id=$1', [t.campaignId, 'Rewritten.']))).rejects.toThrow();
  await withUser(db, t.member.userId, (tx) => tx.query("update bob.bob_app_campaign_drafts set pack_revision=repeat('a',64) where id=$1", [t.draftId]));
  await expect(approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, { ...input, mutationId: randomUUID() }, t.admin.sessionId)).rejects.toThrow('review_conflict');
  const current = await getMarketingReview(db, t.owner.userId, t.app.id, t.campaignId);
  expect(current.state).toBe('needs_review');
});
