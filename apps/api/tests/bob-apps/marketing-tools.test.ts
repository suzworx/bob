import { randomUUID } from 'node:crypto';
import { createScriptedStubAgent } from '@bob/ai';
import type { ToolSet } from 'ai';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { changeMarketingLifecycle, installMarketingPackage } from '../../src/bob-apps/marketing-install.ts';
import { createMarketingTools, type MarketingToolContext } from '../../src/bob-apps/marketing-tools.ts';
import { applyMarketingConfigProposal, proposeMarketingConfig, readMarketingConfig } from '../../src/bob-apps/marketing-config-store.ts';
import { appendMessage } from '../../src/conversations/store.ts';
import { createCampaign, privateConversationSpace, saveWeekPlan, selectCampaign, updateCampaign, type WriteOrigin } from '../../src/bob-apps/marketing-store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace, ensurePrivateSpace } from '../../src/spaces/store.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { setToolPreference } from '../../src/tools/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

let pg: TestDb; let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

const OFFERED = [
  'create_campaign', 'list_campaigns', 'list_capabilities', 'list_drafts', 'marketing_context', 'read_campaign', 'read_draft',
  'research_sources', 'save_draft', 'save_plan_section', 'save_week_plan', 'select_campaign', 'update_draft',
];
const campaignArgs = { name: 'Spring beta', goal: 'beta_interest', channels: ['instagram', 'linkedin'] };

/** A live Marketing installation for one owner: installed, then activated. */
async function installed(owner: TestAccount): Promise<{ id: string; appId: string }> {
  const created = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  const active = await changeMarketingLifecycle(db, owner.userId, created.id, { operation: 'activate', expectedRevision: created.revision, mutationId: randomUUID() });
  return { id: active.id, appId: active.appId };
}
/** A private, nonarchived conversation in the owner's private space. */
async function conversation(userId: string): Promise<string> {
  const space = await ensurePrivateSpace(db, userId);
  const id = `conv_${randomUUID()}`;
  await withUser(db, userId, (tx) => tx.query('insert into bob.conversations (id,user_id,space_id,title) values ($1,$2,$3,$4)', [id, userId, space.id, 'test']));
  return id;
}
/** The tool set for one trusted turn. Turn anchors are persisted user identities, so one turn is one stable ID. */
async function scope(owner: TestAccount, installationId: string, conversationId: string, extra: Partial<MarketingToolContext> = {}, turnId = `msg_${randomUUID()}`) {
  if (await privateConversationSpace(db, owner.userId, conversationId)) {
    await appendMessage(db, owner.userId, conversationId, { id: turnId, role: 'user', parts: [{ type: 'text', text: 'Test campaign request' }] });
  }
  return createMarketingTools({ db, userId: owner.userId, installationId, conversationId, turnId, ...extra });
}
type Executable = { execute: (input: unknown, options: { toolCallId: string; messages: unknown[] }) => Promise<unknown> };
/** Runs one offered tool as the SDK would, with a model tool call ID that may change between retries. */
async function call(tools: Record<string, unknown>, name: string, input: unknown, callId: string = randomUUID()): Promise<Record<string, unknown>> {
  const executable = tools[name] as Executable | undefined;
  if (!executable) throw new Error(`tool not offered: ${name}`);
  return (await executable.execute(input, { toolCallId: callId, messages: [] })) as Record<string, unknown>;
}

const uiOrigin = (): WriteOrigin => ({ key: randomUUID(), scope: { source: 'ui' } });

it('links shared tool results to the resolved space and app instead of the personal app route', async () => {
  const owner = await addAccount(pg);
  const member = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Our Bob posts' });
  await addMember(db, owner.userId, space.id, member.userId, 'member');
  const draft = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, owner.sessionId);
  const active = await changeMarketingLifecycle(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
  const thread = await createThread(db, member.userId, { spaceId: space.id, title: 'This week' });
  const { message } = await postMessage(db, member.userId, { threadId: thread.id, body: 'Create our Bob campaign', clientMessageId: randomUUID() });
  const tools = await createMarketingTools({ db, userId: member.userId, installationId: active.id, conversationId: thread.id, turnId: message.id });
  const result = await call(tools, 'create_campaign', campaignArgs);
  expect(result).toMatchObject({ ok: true, data: { receipt: { kind: 'campaign.create' }, url: `/spaces/${space.id}/apps?app=${active.appId}` } });
});
async function campaignTargets(): Promise<{ owner: TestAccount; id: string; convo: string; first: string; second: string }> {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const convo = await conversation(owner.userId);
  const first = await createCampaign(db, owner.userId, id, { ...campaignArgs, name: 'Pinned A' }, uiOrigin());
  const second = await createCampaign(db, owner.userId, id, { ...campaignArgs, name: 'Pointer B' }, uiOrigin());
  if (!first.campaignId || !second.campaignId) throw new Error('Missing target fixture');
  await selectCampaign(db, owner.userId, id, convo, first.campaignId, uiOrigin());
  return { owner, id, convo, first: first.campaignId, second: second.campaignId };
}
function pin(selectedCampaignId: string | null): Partial<MarketingToolContext> {
  return { selectedCampaignId };
}
async function point(target: Awaited<ReturnType<typeof campaignTargets>>, campaignId: string): Promise<void> {
  await selectCampaign(db, target.owner.userId, target.id, target.convo, campaignId, uiOrigin());
}
async function expectDefaultDenied(tools: Record<string, unknown>): Promise<void> {
  if (Object.keys(tools).length === 0) return;
  const cases: Array<[string, Record<string, unknown>]> = [
    ['marketing_context', {}], ['read_campaign', {}], ['list_drafts', {}],
    ['save_plan_section', { section: 'brief', content: 'Must not write B', expectedRevision: 1 }],
    ['save_draft', { channel: 'linkedin', format: 'text', body: 'Must not write B' }],
  ];
  for (const [name, input] of cases) expect(await call(tools, name, input)).toMatchObject({ ok: false });
}

it('pins default campaign tools to the trusted target despite a later conversation selection', async () => {
  const target = await campaignTargets();
  const { owner, id, convo, first, second } = target;
  const tools = await scope(owner, id, convo, pin(first));
  await selectCampaign(db, owner.userId, id, convo, second, uiOrigin());
  const context = (await call(tools, 'marketing_context', {})).data as { selectedCampaign: unknown };
  expect(context.selectedCampaign).toMatchObject({ id: first, name: 'Pinned A' });
  expect(context.selectedCampaign).not.toHaveProperty('sections');
  expect(await call(tools, 'read_campaign', {})).toMatchObject({ ok: true, data: { id: first } });
  expect(await call(tools, 'save_plan_section', { section: 'brief', content: 'Pinned plan', expectedRevision: 1 })).toMatchObject({ ok: true, data: { receipt: { campaignId: first } } });
  const saved = await call(tools, 'save_draft', { channel: 'linkedin', format: 'text', body: 'Pinned draft' });
  expect(saved).toMatchObject({ ok: true, data: { receipt: { campaignId: first } } });
  const draftId = (saved.data as { receipt: { draftId: string } }).receipt.draftId;
  expect((await call(tools, 'list_drafts', {})).data).toMatchObject({ items: [{ id: draftId }] });
  expect((await call(tools, 'list_drafts', { campaignId: second })).data).toEqual({ items: [], nextCursor: null });
});

it('keeps an explicit new-campaign target empty while omitted targeting follows the conversation pointer', async () => {
  const target = await campaignTargets();
  const { owner, id, convo, first, second } = target;
  await point(target, second);
  const following = await scope(owner, id, convo);
  expect(await call(following, 'save_draft', { channel: 'linkedin', format: 'text', body: 'Only in B' })).toMatchObject({ ok: true, data: { receipt: { campaignId: second } } });
  const tools = await scope(owner, id, convo, pin(null));
  expect(await call(tools, 'marketing_context', {})).toMatchObject({ ok: true, data: { selectedCampaign: null } });
  expect((await call(tools, 'list_drafts', {})).data).toEqual({ items: [], nextCursor: null });
  expect(await call(tools, 'read_campaign', {})).toMatchObject({ ok: false, error: 'campaign_not_selected' });
  expect(await call(tools, 'save_plan_section', { section: 'brief', content: 'No implicit B', expectedRevision: 1 })).toMatchObject({ ok: false, error: 'campaign_not_selected' });
  expect(await call(tools, 'save_draft', { channel: 'linkedin', format: 'text', body: 'No implicit B' })).toMatchObject({ ok: false, error: 'campaign_not_selected' });
  expect(await call(tools, 'read_campaign', { campaignId: second })).toMatchObject({ ok: true, data: { id: second } });
  expect(await call(tools, 'save_draft', { campaignId: second, channel: 'linkedin', format: 'text', body: 'Explicit B' })).toMatchObject({ ok: true, data: { receipt: { campaignId: second } } });
  expect(await call(tools, 'marketing_context', {})).toMatchObject({ data: { selectedCampaign: null } });
  expect(await call(following, 'read_campaign', {})).toMatchObject({ data: { id: second } });
  await point(target, first);
  expect(await call(following, 'read_campaign', {})).toMatchObject({ data: { id: first } });
});

it('never falls back to the conversation selection for a missing, foreign or initially archived trusted target', async () => {
  const target = await campaignTargets();
  const { owner, id, convo, first, second } = target;
  await point(target, second);
  await expectDefaultDenied(await scope(owner, id, convo, pin(randomUUID())));
  const foreign = await campaignTargets();
  await expectDefaultDenied(await scope(owner, id, convo, pin(foreign.first)));
  await updateCampaign(db, owner.userId, id, first, { expectedRevision: 1, status: 'archived' }, uiOrigin());
  await expectDefaultDenied(await scope(owner, id, convo, pin(first)));
  const following = await scope(owner, id, convo);
  expect(await call(following, 'read_campaign', {})).toMatchObject({ data: { id: second, revision: 1 } });
  expect((await call(following, 'list_drafts', {})).data).toEqual({ items: [], nextCursor: null });
});

it('rechecks an already offered trusted campaign after it is archived without reading or writing the replacement selection', async () => {
  const target = await campaignTargets();
  const { owner, id, convo, first, second } = target;
  const tools = await scope(owner, id, convo, pin(first));
  expect(await call(tools, 'read_campaign', {})).toMatchObject({ data: { id: first } });
  await updateCampaign(db, owner.userId, id, first, { expectedRevision: 1, status: 'archived' }, uiOrigin());
  await point(target, second);
  await expectDefaultDenied(tools);
  expect(await call(await scope(owner, id, convo), 'read_campaign', {})).toMatchObject({ data: { id: second, revision: 1 } });
});

it('takes its local target from a successful create receipt and its replay while the stored pointer changes', async () => {
  const target = await campaignTargets();
  const { owner, id, convo, first, second } = target;
  const tools = await scope(owner, id, convo, pin(first));
  const args = { ...campaignArgs, name: 'Created within this turn' };
  const created = await call(tools, 'create_campaign', args);
  expect(created).toMatchObject({ ok: true });
  const createdId = (created.data as { receipt: { campaignId: string } }).receipt.campaignId;
  await point(target, second);
  expect(await call(tools, 'read_campaign', {})).toMatchObject({ data: { id: createdId } });
  expect(await call(tools, 'select_campaign', { campaignId: first })).toMatchObject({ ok: true });
  await point(target, second);
  expect(await call(tools, 'create_campaign', args)).toEqual(created);
  expect(await call(tools, 'read_campaign', {})).toMatchObject({ data: { id: createdId } });
  expect(await call(await scope(owner, id, convo), 'read_campaign', {})).toMatchObject({ data: { id: second } });
});

it('takes its local target from successful selection and clear receipts, including replays that do not rewrite the stored pointer', async () => {
  const target = await campaignTargets();
  const { owner, id, convo, first, second } = target;
  const tools = await scope(owner, id, convo, pin(first));
  const selected = await call(tools, 'select_campaign', { campaignId: second });
  expect(selected).toMatchObject({ ok: true });
  await point(target, first);
  expect(await call(tools, 'read_campaign', {})).toMatchObject({ data: { id: second } });
  await call(tools, 'select_campaign', { campaignId: first });
  expect(await call(tools, 'select_campaign', { campaignId: second })).toEqual(selected);
  expect(await call(tools, 'read_campaign', {})).toMatchObject({ data: { id: second } });
  expect(await call(await scope(owner, id, convo), 'read_campaign', {})).toMatchObject({ data: { id: first } });
  const cleared = await call(tools, 'select_campaign', { campaignId: null });
  expect(cleared).toMatchObject({ ok: true });
  await point(target, second);
  expect(await call(tools, 'read_campaign', {})).toMatchObject({ ok: false, error: 'campaign_not_selected' });
  await call(tools, 'select_campaign', { campaignId: first });
  expect(await call(tools, 'select_campaign', { campaignId: null })).toEqual(cleared);
  expect(await call(tools, 'marketing_context', {})).toMatchObject({ data: { selectedCampaign: null } });
  expect((await call(tools, 'list_drafts', {})).data).toEqual({ items: [], nextCursor: null });
  expect(await call(await scope(owner, id, convo), 'read_campaign', {})).toMatchObject({ data: { id: second } });
});

it('offers exactly the marketing tools by their real names to an installed owner', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const tools = await scope(owner, id, await conversation(owner.userId));
  expect(Object.keys(tools).sort()).toEqual(OFFERED);
});

it('offers no tools for a missing or another owner installation', async () => {
  const owner = await addAccount(pg);
  const stranger = await addAccount(pg);
  const { id } = await installed(stranger);
  const convo = await conversation(owner.userId);
  expect(await scope(owner, randomUUID(), convo)).toEqual({});
  expect(await scope(owner, id, convo)).toEqual({});
});

it('offers nothing outside a live private conversation and denies an already-offered tool once the conversation is archived', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const convo = await conversation(owner.userId);
  expect(await scope(owner, id, `conv_${randomUUID()}`)).toEqual({});
  const tools = await scope(owner, id, convo);
  await withUser(db, owner.userId, (tx) => tx.query('update bob.conversations set archived_at=now() where id=$1', [convo]));
  // The policy wrapper resolves the scope first, so an archived conversation fails closed before any Marketing read.
  await expect(call(tools, 'list_campaigns', {})).rejects.toThrow('tool_policy_unavailable');
  expect(await scope(owner, id, convo)).toEqual({});
});

it('rechecks the live installation on every execution: a pause stops a tool offered earlier', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const tools = await scope(owner, id, await conversation(owner.userId));
  await changeMarketingLifecycle(db, owner.userId, id, { operation: 'pause', expectedRevision: 2, mutationId: randomUUID() });
  expect(await call(tools, 'list_campaigns', {})).toEqual({ ok: false, error: 'marketing_unavailable' });
});

it('requires a persisted user anchor from the exact owner conversation', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const first = await conversation(owner.userId);
  const second = await conversation(owner.userId);
  const turnId = `msg_${randomUUID()}`;
  const tools = await scope(owner, id, first, {}, turnId);
  expect(await createMarketingTools({ db, userId: owner.userId, installationId: id, conversationId: first, turnId: 'unpersisted' })).toEqual({});
  expect(await createMarketingTools({ db, userId: owner.userId, installationId: id, conversationId: second, turnId })).toEqual({});
  await withUser(db, owner.userId, (tx) => tx.query('update bob.messages set tombstoned_at=now() where id=$1', [turnId]));
  expect(await call(tools, 'list_campaigns', {})).toMatchObject({ ok: false, error: 'private_conversation_required' });
});

it('keeps list tool responses within 8 KiB and preserves cursor access to every campaign', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const tools = await scope(owner, id, await conversation(owner.userId));
  for (let index = 0; index < 20; index += 1) {
    expect(await call(tools, 'create_campaign', { ...campaignArgs, name: `Campaign ${index}`, goalNote: 'x'.repeat(500) })).toMatchObject({ ok: true });
  }
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await call(tools, 'list_campaigns', cursor === null ? {} : { cursor });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(8192);
    const page = result.data as { items: Array<{ id: string }>; nextCursor: string | null };
    for (const item of page.items) ids.add(item.id);
    cursor = page.nextCursor;
  } while (cursor !== null);
  expect(ids.size).toBe(20);
});

it('rechecks a revoked per-tool grant after tools were offered', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const tools = await scope(owner, id, await conversation(owner.userId));
  await withUser(db, owner.userId, (tx) => tx.query("update bob.bob_app_installations set granted_capabilities=array['campaign.read'] where id=$1", [id]));
  expect(await call(tools, 'research_sources', { query: 'test' })).toMatchObject({ error: 'capability_unavailable' });
  // campaign.configure was removed, so an already offered create cannot reach the write.
  expect(await call(tools, 'create_campaign', campaignArgs)).toMatchObject({ ok: false, error: 'marketing_permission_denied' });
});

it('denies execution when the tool policy disables the tool, even though it was offered', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const tools = await scope(owner, id, await conversation(owner.userId));
  await setToolPreference(db, owner.userId, { scope: 'account', toolId: 'save_draft', enabled: false });
  try {
    // The policy wrapper rechecks before our code runs, so a disabled tool fails closed with the policy code.
    await expect(call(tools, 'save_draft', { format: 'text', body: 'Hi' })).rejects.toThrow('tool_disabled');
  } finally {
    await setToolPreference(db, owner.userId, { scope: 'account', toolId: 'save_draft', enabled: null });
  }
});
it('rejects unknown keys, identity and channel smuggled through model arguments with repairable issues', async () => {
  const owner = await addAccount(pg);
  const stranger = await addAccount(pg);
  const { id } = await installed(owner);
  const tools = await scope(owner, id, await conversation(owner.userId), { selectedChannel: 'instagram' });
  const injected = await call(tools, 'create_campaign', { ...campaignArgs, userId: stranger.userId, installationId: randomUUID() });
  expect(injected).toMatchObject({ ok: false, error: 'invalid_marketing_input', retryable: true });
  expect(await call(tools, 'create_campaign', { ...campaignArgs, selectedChannel: 'linkedin' })).toMatchObject({ ok: false, error: 'invalid_marketing_input' });
  expect(await call(tools, 'read_campaign', { campaignId: 'not-a-uuid' })).toMatchObject({ ok: false, error: 'invalid_marketing_input' });
  expect((await call(tools, 'list_campaigns', {})).data).toEqual({ items: [], nextCursor: null });
});

it('creates a campaign, selects it for this conversation and returns IDs, revisions and a link', async () => {
  const owner = await addAccount(pg);
  const { id, appId } = await installed(owner);
  const convo = await conversation(owner.userId);
  const tools = await scope(owner, id, convo);
  const created = await call(tools, 'create_campaign', campaignArgs);
  expect(created).toMatchObject({ ok: true, untrusted: true, data: { receipt: { kind: 'campaign.create', revision: 1 }, url: `/apps/${appId}` } });
  const campaignId = ((created.data as { receipt: { campaignId: string } }).receipt).campaignId;
  expect(await call(tools, 'read_campaign', {})).toMatchObject({ ok: true, data: { id: campaignId, name: 'Spring beta' } });
  const other = await scope(owner, id, await conversation(owner.userId));
  expect(await call(other, 'read_campaign', {})).toMatchObject({ ok: false, error: 'campaign_not_selected' });
});

it('derives one operation key per turn, so a retry with a new tool call ID never duplicates a write', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const turn = `turn_${randomUUID()}`;
  const tools = await scope(owner, id, await conversation(owner.userId), {}, turn);
  const first = await call(tools, 'create_campaign', campaignArgs, 'call-a');
  const retry = await call(tools, 'create_campaign', campaignArgs, 'call-b');
  expect(retry).toEqual(first);
  const listed = await call(tools, 'list_campaigns', {});
  expect((listed.data as { items: unknown[] }).items).toHaveLength(1);
  await call(tools, 'create_campaign', { ...campaignArgs, name: 'Different intent' }, 'call-c');
  expect(((await call(tools, 'list_campaigns', {})).data as { items: unknown[] }).items).toHaveLength(2);
});

it('defaults the channel to the selected channel only when the campaign carries it', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const linkedin = await scope(owner, id, await conversation(owner.userId), { selectedChannel: 'linkedin' });
  await call(linkedin, 'create_campaign', { name: 'LinkedIn only', goal: 'awareness', channels: ['linkedin', 'instagram'] });
  const draft = await call(linkedin, 'save_draft', { format: 'text', body: 'Hello colleagues' });
  const draftId = ((draft.data as { receipt: { draftId: string } }).receipt).draftId;
  expect(await call(linkedin, 'read_draft', { draftId })).toMatchObject({ data: { channel: 'linkedin', state: 'needs_check' } });
  const instagramOnly = await scope(owner, id, await conversation(owner.userId), { selectedChannel: 'linkedin' });
  const created = await call(instagramOnly, 'create_campaign', { name: 'Instagram only', goal: 'curiosity', channels: ['instagram'] });
  expect(created.ok).toBe(true);
  const fallback = await call(instagramOnly, 'save_draft', { format: 'image' });
  expect(fallback).toMatchObject({ ok: true });
  const fallbackId = ((fallback.data as { receipt: { draftId: string } }).receipt).draftId;
  expect(await call(instagramOnly, 'read_draft', { draftId: fallbackId })).toMatchObject({ data: { channel: 'instagram' } });
  // The Instagram rule is a schema refinement, so a text Instagram post is refused as repairable input before any write.
  expect(await call(instagramOnly, 'save_draft', { format: 'text', channel: 'instagram' })).toMatchObject({ ok: false, error: 'invalid_marketing_input' });
});

it('uses applied app channel defaults, with selected network and explicit input taking precedence', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const convo = await conversation(owner.userId);
  // Offer before applying, proving execution uses the freshly persisted configuration.
  const tools = await scope(owner, id, convo);
  const current = await readMarketingConfig(db, owner.userId, id);
  const { proposal } = await proposeMarketingConfig(db, owner.userId, id, {
    expectedConfigRevision: current.installation.configRevision, mutationId: randomUUID(),
    config: { ...current.installation.config, defaultChannels: ['linkedin'] },
  });
  if (!proposal) throw new Error('proposal missing');
  await applyMarketingConfigProposal(db, owner.userId, id, {
    proposalId: proposal.id, hash: proposal.canonicalHash, expectedConfigRevision: proposal.baseConfigRevision, mutationId: randomUUID(),
  });
  expect(await call(tools, 'create_campaign', { name: 'Configured channels', goal: 'awareness' })).toMatchObject({ ok: true });
  expect(await call(tools, 'read_campaign', {})).toMatchObject({ data: { channels: ['linkedin'] } });
  expect(await call(tools, 'create_campaign', { name: 'Explicit channels', goal: 'awareness', channels: ['instagram'] })).toMatchObject({ ok: true });
  expect(await call(tools, 'read_campaign', {})).toMatchObject({ data: { channels: ['instagram'] } });
  const networkTools = await scope(owner, id, convo, { selectedChannel: 'instagram' });
  expect(await call(networkTools, 'create_campaign', { name: 'Selected network', goal: 'awareness' })).toMatchObject({ ok: true });
  expect(await call(networkTools, 'read_campaign', {})).toMatchObject({ data: { channels: ['instagram'] } });
  expect(await call(networkTools, 'create_campaign', { name: 'Explicit beats selected', goal: 'awareness', channels: ['linkedin'] })).toMatchObject({ ok: true });
  expect(await call(networkTools, 'read_campaign', {})).toMatchObject({ data: { channels: ['linkedin'] } });
});

it('checks draft references against the real pack and reports research and capabilities truthfully', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const tools = await scope(owner, id, await conversation(owner.userId), { selectedChannel: 'instagram' });
  await call(tools, 'create_campaign', campaignArgs);
  expect(await call(tools, 'save_draft', { format: 'image', approvedAssetIds: ['bob-unknown'] })).toMatchObject({ ok: false, error: 'marketing_asset_unknown' });
  expect(await call(tools, 'save_draft', { format: 'image', claimIds: ['claim.invented'] })).toMatchObject({ ok: false, error: 'marketing_claim_unknown' });
  const saved = await call(tools, 'save_draft', { format: 'image', approvedAssetIds: ['bob-playful'], claimIds: ['mission.lightens-moods'] });
  expect(saved).toMatchObject({ ok: true, data: { receipt: { kind: 'draft.create', revision: 1 } } });
  expect(await call(tools, 'research_sources', { query: 'what is trending' })).toEqual({ ok: false, error: 'capability_unavailable' });
  const capabilities = (await call(tools, 'list_capabilities', {})).data as { capabilities: Array<{ id: string; status: string }> };
  expect(capabilities.capabilities.find((item) => item.id === 'drafting')?.status).toBe('available');
  expect(capabilities.capabilities.find((item) => item.id === 'publishing')?.status).toBe('unavailable');
  const context = (await call(tools, 'marketing_context', {})).data as { selectedChannel: string; draftFormats: Record<string, string[]> };
  expect(context.selectedChannel).toBe('instagram');
  expect(context.draftFormats.instagram).toEqual(['image', 'carousel']);
});

const weekPost = (day: number, channel: 'instagram' | 'linkedin' = day % 2 === 0 ? 'linkedin' : 'instagram') => ({
  day, channel, pillar: 'Small joys', beat: `Beat ${day}`, body: `Post for day ${day}.`,
  ...(channel === 'instagram' ? { altText: 'Bob waving hello', approvedAssetIds: ['bob-playful'] } : {}), claimIds: ['mission.lightens-moods'],
});
const weekPlan = (posts: unknown[] = [1, 2, 3, 4, 5, 6, 7].map((day) => weekPost(day))) => ({
  name: 'First week', goal: 'beta_interest', channels: ['instagram', 'linkedin'], story: 'Bob spends a week trying to make one person smile.', posts,
});
async function weekScope(): Promise<{ owner: TestAccount; id: string; appId: string; convo: string; tools: Awaited<ReturnType<typeof scope>> }> {
  const owner = await addAccount(pg);
  const { id, appId } = await installed(owner);
  const convo = await conversation(owner.userId);
  return { owner, id, appId, convo, tools: await scope(owner, id, convo) };
}
const campaignCount = async (tools: Record<string, unknown>): Promise<number> => ((await call(tools, 'list_campaigns', {})).data as { items: unknown[] }).items.length;

it('saves one week in one write: campaign, story, calendar and labelled drafts, selected for the conversation', async () => {
  const { appId, tools } = await weekScope();
  const saved = await call(tools, 'save_week_plan', weekPlan());
  expect(saved).toMatchObject({ ok: true, data: { receipt: { kind: 'campaign.week_plan', draftId: null, revision: 1 }, postCount: 7, url: `/apps/${appId}` } });
  const campaignId = (saved.data as { receipt: { campaignId: string } }).receipt.campaignId;
  const campaign = (await call(tools, 'read_campaign', {})).data as { id: string; draftCount: number; revision: number; sections: Array<{ section: string; content: string }> };
  expect(campaign).toMatchObject({ id: campaignId, draftCount: 7, revision: 1 });
  expect(campaign.sections.find((item) => item.section === 'brief')?.content).toBe('Bob spends a week trying to make one person smile.');
  const calendar = campaign.sections.find((item) => item.section === 'calendar')?.content ?? '';
  expect(calendar.split('\n')).toHaveLength(7);
  expect(calendar.split('\n')[0]).toBe('Day 1 · Instagram · image · Small joys · Beat 1');
  const listed = (await call(tools, 'list_drafts', {})).data as { items: Array<{ id: string }> };
  const drafts = await Promise.all(listed.items.map(async (item) => (await call(tools, 'read_draft', { draftId: item.id })).data as { pillar: string; channel: string; format: string; state: string; claimIds: string[] }));
  const first = drafts.find((draft) => draft.pillar === 'Day 1 · Small joys · Beat 1');
  expect(first).toMatchObject({ channel: 'instagram', format: 'image', state: 'needs_check', claimIds: ['mission.lightens-moods'] });
  expect(drafts.find((draft) => draft.pillar === 'Day 2 · Small joys · Beat 2')).toMatchObject({ channel: 'linkedin', format: 'text' });
});

it.each([
  ['more than seven posts', () => weekPlan([1, 2, 3, 4, 5, 6, 7].map((day) => weekPost(day)).concat(weekPost(1, 'linkedin')))],
  ['no posts', () => weekPlan([])],
  ['a day outside the week', () => weekPlan([weekPost(8)])],
  ['the same day and channel twice', () => weekPlan([weekPost(1), { ...weekPost(1), beat: 'Again' }])],
  ['a channel outside the campaign', () => ({ ...weekPlan([weekPost(1, 'instagram')]), channels: ['linkedin'] })],
  ['a text Instagram post', () => weekPlan([{ ...weekPost(1, 'instagram'), format: 'text' }])],
  ['an oversized body', () => weekPlan([{ ...weekPost(1), body: 'x'.repeat(1201) }])],
  ['an oversized story', () => ({ ...weekPlan(), story: 'x'.repeat(801) })],
  ['an oversized beat', () => weekPlan([{ ...weekPost(1), beat: 'x'.repeat(73) }])],
  ['the label separator in a pillar', () => weekPlan([{ ...weekPost(1), pillar: 'a · b' }])],
  ['identity in the arguments', () => ({ ...weekPlan(), userId: randomUUID() })],
])('refuses %s as repairable input before any write', async (_name, input) => {
  const { tools } = await weekScope();
  expect(await call(tools, 'save_week_plan', input())).toMatchObject({ ok: false, error: 'invalid_marketing_input', retryable: true });
  expect(await campaignCount(tools)).toBe(0);
});

it('keeps the largest allowed plan inside the specialist output limit', async () => {
  const claimIds = ['claim.xxxxxxxxxxxxxxxxxxxxxxxxxx', 'claim.yyyyyyyyyyyyyyyyyyyyyyyyyy', 'claim.zzzzzzzzzzzzzzzzzzzzzzzzzz', 'claim.wwwwwwwwwwwwwwwwwwwwwwwwww'];
  const posts = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, channel: 'linkedin', format: 'carousel', pillar: 'p'.repeat(32), beat: 'b'.repeat(72), body: 'word '.repeat(240), altText: 'word '.repeat(40), approvedAssetIds: ['bob-playful', 'bob-helper'], claimIds, cta: 'waitlist' }));
  const plan = { name: 'n'.repeat(80), goal: 'beta_interest', channels: ['instagram', 'linkedin'], story: 'word '.repeat(160), posts };
  // Four characters a token is the usual English estimate; 3.5 leaves room for JSON punctuation.
  expect(JSON.stringify(plan).length / 3.5).toBeLessThan(4096);
  const { tools } = await weekScope();
  expect(await call(tools, 'save_week_plan', plan)).toMatchObject({ ok: false, error: 'marketing_claim_unknown' });
});

it('replays the same plan in one turn to the same receipt without another campaign or draft', async () => {
  const { tools } = await weekScope();
  const first = await call(tools, 'save_week_plan', weekPlan(), 'call-a');
  expect(first).toMatchObject({ ok: true });
  expect(await call(tools, 'save_week_plan', weekPlan(), 'call-b')).toEqual(first);
  expect(await campaignCount(tools)).toBe(1);
  expect((await call(tools, 'read_campaign', {})).data).toMatchObject({ draftCount: 7 });
});

it('refuses another owner: their installation offers nothing and an already offered tool cannot cross', async () => {
  const { id, tools } = await weekScope();
  const stranger = await addAccount(pg);
  const convo = await conversation(stranger.userId);
  expect(await scope(stranger, id, convo)).toEqual({});
  expect(await createMarketingTools({ db, userId: stranger.userId, installationId: id, conversationId: convo, turnId: `msg_${randomUUID()}` })).toEqual({});
  await expect(saveWeekPlan(db, stranger.userId, id, weekPlan(), uiOrigin())).rejects.toThrow('marketing_installation_not_found');
  expect(await campaignCount(tools)).toBe(0);
});

it.each(['save_week_plan', 'create_campaign', 'save_plan_section', 'save_draft'])('refuses the whole plan when policy disables %s', async (toolId) => {
  const { owner, id, tools, convo } = await weekScope();
  await setToolPreference(db, owner.userId, { scope: 'account', toolId, enabled: false });
  try {
    if (toolId === 'save_week_plan') await expect(call(tools, 'save_week_plan', weekPlan())).rejects.toThrow('tool_disabled');
    else expect(await call(tools, 'save_week_plan', weekPlan())).toMatchObject({ ok: false, error: 'tool_disabled' });
  } finally {
    await setToolPreference(db, owner.userId, { scope: 'account', toolId, enabled: null });
  }
  expect(await campaignCount(await scope(owner, id, convo))).toBe(0);
});

it.each([['campaign.configure', ['campaign.read', 'campaign.draft']], ['campaign.draft', ['campaign.read', 'campaign.configure']]] as const)('needs %s as well as the other write grant', async (_missing, grants) => {
  const { owner, id, tools } = await weekScope();
  await withUser(db, owner.userId, (tx) => tx.query('update bob.bob_app_installations set granted_capabilities=$2::text[] where id=$1', [id, `{${grants.join(',')}}`]));
  expect(await call(tools, 'save_week_plan', weekPlan())).toMatchObject({ ok: false, error: 'marketing_permission_denied' });
  expect(await campaignCount(tools)).toBe(0);
});

it('rolls back the campaign, sections and earlier drafts when a later post fails', async () => {
  const { tools } = await weekScope();
  const posts = [1, 2, 3, 4, 5, 6].map((day) => weekPost(day)).concat({ ...weekPost(7), claimIds: ['claim.invented'] });
  expect(await call(tools, 'save_week_plan', weekPlan(posts))).toMatchObject({ ok: false, error: 'marketing_claim_unknown' });
  expect(await campaignCount(tools)).toBe(0);
  expect((await call(tools, 'list_drafts', {})).data).toEqual({ items: [], nextCursor: null });
  expect(await call(tools, 'read_campaign', {})).toMatchObject({ ok: false, error: 'campaign_not_selected' });
  expect(await call(tools, 'save_week_plan', weekPlan())).toMatchObject({ ok: true });
});

it('saves the scripted week through the real tool, with no provider', async () => {
  const { tools } = await weekScope();
  const result = await createScriptedStubAgent(tools as ToolSet, { BOB_AI_STUB: 'scripted' }).generate({ prompt: 'e2e plan a week called Small joys' });
  expect(result.text).toBe('Stub: save_week_plan finished.');
  expect((await call(tools, 'read_campaign', {})).data).toMatchObject({ name: 'Small joys', draftCount: 7 });
});
