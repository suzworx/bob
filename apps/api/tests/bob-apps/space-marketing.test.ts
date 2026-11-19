import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { installMarketingPackage, changeMarketingLifecycle, listMarketingInstallations } from '../../src/bob-apps/marketing-install.ts';
import { createCampaign, getCampaign, readSelectedCampaign, selectCampaign } from '../../src/bob-apps/marketing-store.ts';
import { authorizeMarketingInvocation, preflightMarketingTurn } from '../../src/bob-apps/marketing-turn.ts';
import { archiveThread, createThread, getThread, listMessages, postMessage } from '../../src/conversations/thread-store.ts';
import { createBobApp, deleteBobApp } from '../../src/bob-apps/store.ts';
import { packing } from './fixtures.ts';
import { openAppConversation } from '../../src/workflows/workflow-app-conversation.ts';
import { runInvocation } from '../../src/workflows/workflow-thread-invocation.ts';
import { createAgentHarness } from '../support/agent-harness.ts';
import type { createBobAgent } from '@bob/ai';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
async function setup() {
  const owner = await addAccount(pg);
  const member = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Bob team' });
  await addMember(db, owner.userId, space.id, member.userId, 'member');
  return { owner, member, space };
}
const origin = () => ({ key: randomUUID(), scope: { source: 'ui' } });

it('lets an admin install Marketing for the group and keeps a personal package separate', async () => {
  const { owner, member, space } = await setup();
  const personal = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  const shared = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, owner.sessionId);
  expect(shared).toMatchObject({ spaceId: space.id, canManage: true });
  expect(shared.id).not.toBe(personal.id);
  await expect(installMarketingPackage(db, member.userId, { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, member.sessionId)).rejects.toThrow('app_management_required');
  expect((await listMarketingInstallations(db, member.userId, { spaceId: space.id })).map((item) => item.id)).toEqual([shared.id]);
  expect((await listMarketingInstallations(db, owner.userId)).map((item) => item.id)).toEqual([personal.id]);
});

it('shares authored campaigns while selections belong to each member and revoked retries fail', async () => {
  const { owner, member, space } = await setup();
  const draft = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, owner.sessionId);
  const app = await changeMarketingLifecycle(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
  const thread = await createThread(db, owner.userId, { spaceId: space.id, title: 'Our week' });
  const firstInput = { name: 'A little joy', goal: 'awareness', channels: ['instagram'] };
  const write = origin();
  const first = await createCampaign(db, member.userId, app.id, firstInput, write, thread.id);
  const second = await createCampaign(db, owner.userId, app.id, { ...firstInput, name: 'A bright week' }, origin(), thread.id);
  expect((await getCampaign(db, owner.userId, app.id, first.campaignId ?? '')).name).toBe('A little joy');
  expect((await readSelectedCampaign(db, member.userId, app.id, thread.id))?.id).toBe(first.campaignId);
  expect((await readSelectedCampaign(db, owner.userId, app.id, thread.id))?.id).toBe(second.campaignId);
  await selectCampaign(db, member.userId, app.id, thread.id, null, origin());
  expect(await readSelectedCampaign(db, member.userId, app.id, thread.id)).toBeNull();
  expect((await readSelectedCampaign(db, owner.userId, app.id, thread.id))?.id).toBe(second.campaignId);
  await revokeMember(db, owner.userId, space.id, member.userId);
  await expect(createCampaign(db, member.userId, app.id, firstInput, write, thread.id)).rejects.toThrow();
});

it('requires an explicit app binding matching its group and never adopts a personal default', async () => {
  const { owner, space } = await setup();
  const draft = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, owner.sessionId);
  await changeMarketingLifecycle(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
  const thread = await createThread(db, owner.userId, { spaceId: space.id, title: 'Our week' });
  const binding = { installationId: draft.id, mode: 'run' as const };
  await withUser(db, owner.userId, (tx) => authorizeMarketingInvocation(tx, owner.userId, binding, thread.id));
  await expect(preflightMarketingTurn(db, owner.userId, binding, thread.id)).rejects.toThrow('marketing_binding_unavailable');
  expect(await preflightMarketingTurn(db, owner.userId, undefined, thread.id)).toBeNull();
  const other = await createSpace(db, owner.userId, { kind: 'group', name: 'Other team' });
  const otherThread = await createThread(db, owner.userId, { spaceId: other.id, title: 'Other week' });
  await expect(withUser(db, owner.userId, (tx) => authorizeMarketingInvocation(tx, owner.userId, binding, otherThread.id))).rejects.toThrow('marketing_binding_unavailable');
});

it('opens one shared app thread for concurrent members and revokes cached thread access', async () => {
  const { owner, member, space } = await setup();
  const installation = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, owner.sessionId);
  const [first, second] = await Promise.all([openAppConversation(db, owner.userId, installation.appId), openAppConversation(db, member.userId, installation.appId)]);
  expect(first).toEqual(second);
  expect(first.spaceId).toBe(space.id);
  const personal = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  await expect(openAppConversation(db, owner.userId, personal.appId)).rejects.toThrow('shared_app_required');
  const generic = await createBobApp(db, member.userId, { spaceId: space.id, definition: packing, mutationId: randomUUID() });
  const genericThread = await openAppConversation(db, member.userId, generic.id);
  expect(genericThread.spaceId).toBe(space.id);
  expect(genericThread.conversationId).not.toBe(first.conversationId);
  await revokeMember(db, owner.userId, space.id, member.userId);
  await expect(openAppConversation(db, member.userId, installation.appId)).rejects.toThrow('app_not_found');
});

it('enforces package audience and uniqueness in SQL while allowing multiple generic apps', async () => {
  const { owner, space } = await setup();
  const installation = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, owner.sessionId);
  await expect(withUser(db, owner.userId, async (tx) => {
    const [app] = await tx.query<{ id: string }>(`insert into bob.bob_apps(user_id,space_id,definition,state)
      select null,space_id,definition,'{}' from bob.bob_apps where id=$1 returning id`, [installation.appId]);
    await tx.query(`insert into bob.bob_app_installations(user_id,app_id,package_id,package_version,granted_capabilities,config)
      select null,$2,package_id,package_version,granted_capabilities,config from bob.bob_app_installations where id=$1`, [installation.id, app?.id]);
  })).rejects.toThrow('bob_app_installations_space_package_key');
  const other = await createSpace(db, owner.userId, { kind: 'group', name: 'Other group' });
  await expect(withUser(db, owner.userId, (tx) => tx.query('update bob.bob_app_installations set space_id=$2 where id=$1', [installation.id, other.id]))).rejects.toThrow();
  const first = await createBobApp(db, owner.userId, { definition: packing, spaceId: space.id, mutationId: randomUUID() });
  const second = await createBobApp(db, owner.userId, { definition: packing, spaceId: space.id, mutationId: randomUUID() });
  expect(first.installationId).not.toBe(second.installationId);
});

it('reopens the same archived app thread for an authorized member without losing its history', async () => {
  const { owner, member, space } = await setup();
  const app = await createBobApp(db, owner.userId, { definition: packing, spaceId: space.id, mutationId: randomUUID() });
  const opened = await openAppConversation(db, owner.userId, app.id);
  const { message } = await postMessage(db, member.userId, { threadId: opened.conversationId, body: 'Keep our shared story.', clientMessageId: randomUUID() });
  await archiveThread(db, owner.userId, opened.conversationId);
  const outsider = await addAccount(pg);
  await expect(openAppConversation(db, outsider.userId, app.id)).rejects.toThrow('app_not_found');
  expect((await getThread(db, owner.userId, opened.conversationId)).archivedAt).not.toBeNull();
  expect(await openAppConversation(db, member.userId, app.id)).toEqual(opened);
  expect((await getThread(db, member.userId, opened.conversationId)).archivedAt).toBeNull();
  expect((await listMessages(db, member.userId, opened.conversationId, { limit: 20 })).messages).toContainEqual(expect.objectContaining({ id: message.id, body: 'Keep our shared story.' }));
});

for (const change of ['revoke', 'pause', 'remove'] as const) {
  it(`cancels a bound group reply when ${change} completes during generation`, async () => {
    const { owner, member, space } = await setup();
    const draft = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, owner.sessionId);
    const active = await changeMarketingLifecycle(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
    const conversation = await openAppConversation(db, member.userId, draft.appId);
    const { message } = await postMessage(db, member.userId, { threadId: conversation.conversationId, body: 'Please plan our Bob week', clientMessageId: randomUUID() });
    let started: () => void = () => undefined;
    let release: () => void = () => undefined;
    const generating = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const harness = createAgentHarness([[{ type: 'text', text: 'A bright week together.' }]]);
    // Pause the SDK's mock provider, keeping ToolLoopAgent.generate untouched.
    const doGenerate = harness.model.doGenerate.bind(harness.model);
    vi.spyOn(harness.model, 'doGenerate').mockImplementation(async (...args) => { started(); await gate; return doGenerate(...args); });
    const factory = vi.fn<typeof createBobAgent>(() => harness.agent);
    const context = { actorUserId: member.userId, spaceId: space.id, threadId: conversation.conversationId, triggerMessageId: message.id, contextHighWater: message.sequence, appBinding: { installationId: draft.id, mode: 'run' as const, intent: 'posts' as const } };
    const running = runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent: factory });
    try {
      await generating;
      expect(factory.mock.calls[0]?.[0]).toMatchObject({ mode: 'shared_app_run', memoryTools: {} });
      expect(Object.keys(factory.mock.calls[0]?.[0]?.capabilityTools ?? {})).toContain('save_week_plan');
      if (change === 'revoke') await revokeMember(db, owner.userId, space.id, member.userId);
      if (change === 'pause') await changeMarketingLifecycle(db, owner.userId, draft.id, { operation: 'pause', expectedRevision: active.revision, mutationId: randomUUID() });
      if (change === 'remove') await deleteBobApp(db, owner.userId, draft.appId, { expectedRevision: 2, mutationId: randomUUID() });
      const campaignTool = factory.mock.calls[0]?.[0]?.capabilityTools?.create_campaign;
      if (!campaignTool?.execute) throw new Error('missing bound create_campaign tool');
      const deniedWrite = await Promise.resolve(campaignTool.execute({ name: 'Queued after removal', goal: 'awareness', channels: ['instagram'] }, { toolCallId: randomUUID(), messages: [], context: undefined }))
        .catch((error: unknown) => { expect(error).toMatchObject({ message: 'tool_policy_unavailable' }); return { ok: false }; });
      expect(deniedWrite).toMatchObject({ ok: false });
      const [count] = await withUser(db, owner.userId, (tx) => tx.query<{ n: number }>('select count(*)::int as n from bob.bob_app_campaigns where installation_id=$1', [draft.id]));
      expect(count?.n).toBe(0);
      release();
      expect(await running).toMatchObject({ outcome: 'cancelled', resultMessageId: null });
      await expect(runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent: factory })).rejects.toThrow();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(harness.calls()).toBe(1);
    } finally { release(); await running.catch(() => undefined); }
  });
}
