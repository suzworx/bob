import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { installMarketingPackage, changeMarketingLifecycle } from '../../src/bob-apps/marketing-install.ts';
import { applyMarketingConfigProposal, discardMarketingConfigProposal, proposeMarketingConfig, readMarketingConfig, restoreMarketingConfigVersion } from '../../src/bob-apps/marketing-config-store.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { eraseAccountRow } from '../../src/account/erasure-store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { setMemberRole } from '../../src/spaces/member-roles.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { createMarketingConfigTools } from '../../src/bob-apps/marketing-config-tools.ts';
import { MarketingConfigProposalSchema } from '../../src/bob-apps/marketing-config-schemas.ts';
import type { Tool, ToolSet } from 'ai';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
const config = { visibleViews: ['content'], contentGrouping: 'channel', defaultChannels: ['linkedin'] };
async function setup() {
  const owner = await addAccount(pg);
  const member = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Our posts' });
  await addMember(db, owner.userId, space.id, member.userId, 'member');
  const draft = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, owner.sessionId);
  const app = await changeMarketingLifecycle(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
  return { owner, member, space, app };
}
function requiredProposal(result: Awaited<ReturnType<typeof proposeMarketingConfig>>) {
  if (!result.proposal) throw new Error('proposal missing');
  return result.proposal;
}
const proposeInput = () => ({ expectedConfigRevision: 1, config, mutationId: randomUUID() });

it('accepts only bounded personal or shared app links in proposal responses', () => {
  const appId = randomUUID();
  const spaceId = randomUUID();
  const schema = MarketingConfigProposalSchema.shape.appUrl;
  expect(schema.safeParse(`/apps/${appId}`).success).toBe(true);
  expect(schema.safeParse(`/spaces/${spaceId}/apps?app=${appId}`).success).toBe(true);
  for (const url of [`https://example.com/apps/${appId}`, `/spaces/${spaceId}/apps?app=${appId}&owner=other`, `/spaces/invalid/apps?app=${appId}`, `/spaces/${'a'.repeat(36)}/apps?app=${appId}`, `/spaces/${spaceId}/apps?app=${'a'.repeat(36)}`, `/apps/${appId}?space=${spaceId}`]) {
    expect(schema.safeParse(url).success).toBe(false);
  }
});

it('lets a member propose and an admin apply without making the member the owner', async () => {
  const { owner, member, space, app } = await setup();
  const result = await proposeMarketingConfig(db, member.userId, app.id, proposeInput());
  expect(result.proposal).not.toBeNull();
  const proposal = requiredProposal(result);
  const appUrl = `/spaces/${space.id}/apps?app=${app.appId}`;
  expect(proposal.appUrl).toBe(appUrl);
  expect((await readMarketingConfig(db, owner.userId, app.id)).pending.find((item) => item.id === proposal.id)?.appUrl).toBe(appUrl);
  expect((await readMarketingConfig(db, owner.userId, app.id)).pending.map((item) => item.id)).toContain(proposal.id);
  const apply = { proposalId: proposal.id, hash: proposal.canonicalHash, expectedConfigRevision: 1, mutationId: randomUUID() };
  await expect(applyMarketingConfigProposal(db, member.userId, app.id, apply)).rejects.toThrow('app_management_required');
  await expect(discardMarketingConfigProposal(db, member.userId, app.id, { proposalId: proposal.id, expectedConfigRevision: 1, mutationId: randomUUID() })).rejects.toThrow('app_management_required');
  await expect(restoreMarketingConfigVersion(db, member.userId, app.id, { versionRevision: 1, expectedConfigRevision: 1, mutationId: randomUUID() })).rejects.toThrow('app_management_required');
  const applied = await applyMarketingConfigProposal(db, owner.userId, app.id, apply);
  expect(applied.proposal?.appUrl).toBe(appUrl);
  expect(applied.receipt).toMatchObject({ kind: 'applied', configRevision: 2 });
  expect(await applyMarketingConfigProposal(db, owner.userId, app.id, apply)).toEqual(applied);
  const restored = await restoreMarketingConfigVersion(db, owner.userId, app.id, { versionRevision: 1, expectedConfigRevision: 2, mutationId: randomUUID() });
  expect(restored.receipt.configRevision).toBe(3);
  const pending = requiredProposal(await proposeMarketingConfig(db, member.userId, app.id, { ...proposeInput(), expectedConfigRevision: 3 }));
  const discarded = await discardMarketingConfigProposal(db, owner.userId, app.id, { proposalId: pending.id, expectedConfigRevision: 3, mutationId: randomUUID() });
  expect(discarded.proposal?.appUrl).toBe(appUrl);
  expect((await readMarketingConfig(db, member.userId, app.id)).pending).toEqual([]);
});

it('retains verifiable proposals after their author is erased', async () => {
  const { owner, member, app } = await setup();
  const result = await proposeMarketingConfig(db, member.userId, app.id, proposeInput());
  const proposal = requiredProposal(result);
  await eraseAccountRow(db, member.userId, Date.parse('2026-11-01T00:00:00Z'));
  const [retained] = await withUser(db, owner.userId, (tx) => tx.query<{ created_by: string | null }>('select created_by from bob.marketing_config_proposals where id=$1', [proposal.id]));
  expect(retained?.created_by).toBeNull();
  const applied = await applyMarketingConfigProposal(db, owner.userId, app.id, { proposalId: proposal.id, hash: proposal.canonicalHash, expectedConfigRevision: 1, mutationId: randomUUID() });
  expect(applied.receipt.configRevision).toBe(2);
});

it('reauthorizes proposal replay after membership loss', async () => {
  const { owner, member, space, app } = await setup();
  const input = proposeInput();
  await proposeMarketingConfig(db, member.userId, app.id, input);
  await revokeMember(db, owner.userId, space.id, member.userId);
  await expect(proposeMarketingConfig(db, member.userId, app.id, input)).rejects.toThrow();
});

it('scopes the same actor mutation UUID to its installation', async () => {
  const first = await setup();
  const otherSpace = await createSpace(db, first.owner.userId, { kind: 'group', name: 'Another team' });
  const draft = await installMarketingPackage(db, first.owner.userId, { packageId: 'bob-marketing', spaceId: otherSpace.id, mutationId: randomUUID() }, first.owner.sessionId);
  const other = await changeMarketingLifecycle(db, first.owner.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
  const input = proposeInput();
  const a = await proposeMarketingConfig(db, first.owner.userId, first.app.id, input);
  const b = await proposeMarketingConfig(db, first.owner.userId, other.id, input);
  expect(a.receipt.installationId).not.toBe(b.receipt.installationId);
});

it('denies both new management writes and exact replay after an admin loses the role', async () => {
  const { owner, member, space, app } = await setup();
  await setMemberRole(db, owner.userId, space.id, member.userId, 'admin');
  const proposal = requiredProposal(await proposeMarketingConfig(db, owner.userId, app.id, proposeInput()));
  const input = { proposalId: proposal.id, hash: proposal.canonicalHash, expectedConfigRevision: 1, mutationId: randomUUID() };
  await applyMarketingConfigProposal(db, member.userId, app.id, input);
  const next = requiredProposal(await proposeMarketingConfig(db, member.userId, app.id, { ...proposeInput(), expectedConfigRevision: 2 }));
  await setMemberRole(db, owner.userId, space.id, member.userId, 'member');
  await expect(applyMarketingConfigProposal(db, member.userId, app.id, input)).rejects.toThrow('app_management_required');
  await expect(applyMarketingConfigProposal(db, member.userId, app.id, { proposalId: next.id, hash: next.canonicalHash, expectedConfigRevision: 2, mutationId: randomUUID() })).rejects.toThrow('app_management_required');
  await expect(discardMarketingConfigProposal(db, member.userId, app.id, { proposalId: next.id, expectedConfigRevision: 2, mutationId: randomUUID() })).rejects.toThrow('app_management_required');
  await expect(restoreMarketingConfigVersion(db, member.userId, app.id, { versionRevision: 1, expectedConfigRevision: 2, mutationId: randomUUID() })).rejects.toThrow('app_management_required');
  expect((await readMarketingConfig(db, owner.userId, app.id)).installation.configRevision).toBe(2);
});

async function run(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const execute = (tools[name] as Tool<unknown, unknown> | undefined)?.execute;
  if (!execute) throw new Error('tool missing');
  return execute(input, { toolCallId: 'config-shared', messages: [], context: undefined });
}

it('offers team config tools only for the matching audience and actual persisted sender', async () => {
  const { owner, member, space, app } = await setup();
  const thread = await createThread(db, owner.userId, { spaceId: space.id, title: 'Marketing' });
  const { message } = await postMessage(db, member.userId, { threadId: thread.id, body: 'Group our posts by channel', clientMessageId: randomUUID() });
  const ctx = { db, userId: member.userId, installationId: app.id, conversationId: thread.id, turnId: message.id };
  const tools = await createMarketingConfigTools(ctx);
  expect(Object.keys(tools).sort()).toEqual(['propose_marketing_config', 'read_marketing_config']);
  expect(await run(tools, 'propose_marketing_config', { expectedConfigRevision: 1, config })).toMatchObject({ ok: true });
  expect(await createMarketingConfigTools({ ...ctx, userId: owner.userId })).toEqual({});
  const privateConversation = await createConversation(db, member.userId, 'Private chat');
  const privateTurn = `msg_${randomUUID()}`;
  await appendMessage(db, member.userId, privateConversation.id, { id: privateTurn, role: 'user', parts: [{ type: 'text', text: 'Change our team app' }] });
  expect(await createMarketingConfigTools({ ...ctx, conversationId: privateConversation.id, turnId: privateTurn })).toEqual({});
  const otherSpace = await createSpace(db, owner.userId, { kind: 'group', name: 'Other audience' });
  const otherThread = await createThread(db, owner.userId, { spaceId: otherSpace.id, title: 'Another app' });
  const otherMessage = await postMessage(db, owner.userId, { threadId: otherThread.id, body: 'Change config', clientMessageId: randomUUID() });
  expect(await createMarketingConfigTools({ ...ctx, userId: owner.userId, conversationId: otherThread.id, turnId: otherMessage.message.id })).toEqual({});
  await expect(proposeMarketingConfig(db, owner.userId, app.id, proposeInput(), { conversationId: otherThread.id, turnId: otherMessage.message.id })).rejects.toThrow('marketing_scope_required');
  await revokeMember(db, owner.userId, space.id, member.userId);
  expect(await run(tools, 'read_marketing_config', {})).toMatchObject({ ok: false });
});
