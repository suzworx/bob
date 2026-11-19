import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { changeMarketingLifecycle, installMarketingPackage } from '../../src/bob-apps/marketing-install.ts';
import { preflightMarketingTurn, marketingToolsForTurn, marketingTaskContext } from '../../src/bob-apps/marketing-turn.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { createCampaign, readSelectedCampaign, selectCampaign, listDrafts } from '../../src/bob-apps/marketing-store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

async function execute(tools: Record<string, unknown>, name: string, input: unknown): Promise<Record<string, unknown>> {
  const item = tools[name] as { execute: (input: unknown, options: { toolCallId: string; messages: unknown[] }) => Promise<Record<string, unknown>> };
  return item.execute(input, { toolCallId: randomUUID(), messages: [] });
}

it('pins explicit New even when its old binding receipt replays after another tab selects B, while omission follows B', async () => {
  const owner = await addAccount(pg);
  const installation = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  await changeMarketingLifecycle(db, owner.userId, installation.id, { operation: 'activate', expectedRevision: installation.revision, mutationId: randomUUID() });
  const created = await createCampaign(db, owner.userId, installation.id, { name: 'B', goal: 'curiosity', channels: ['instagram'] }, { key: randomUUID(), scope: { source: 'ui' } });
  if (!created.campaignId) throw new Error('Missing campaign');
  const convo = await withUser(db, owner.userId, (tx) => createConversation(tx, owner.userId, 'New target'));
  const message = await appendMessage(db, owner.userId, convo.id, { role: 'user', parts: [{ type: 'text', text: 'Write a new post' }] });
  const binding = await preflightMarketingTurn(db, owner.userId, { installationId: installation.id, mode: 'run', campaignId: null }, convo.id);
  await marketingToolsForTurn(db, owner.userId, binding, convo.id, message?.id ?? null);
  expect(await readSelectedCampaign(db, owner.userId, installation.id, convo.id)).toBeNull();
  await selectCampaign(db, owner.userId, installation.id, convo.id, created.campaignId, { key: randomUUID(), scope: { source: 'ui' } });
  const replayed = await marketingToolsForTurn(db, owner.userId, binding, convo.id, message?.id ?? null);
  expect((await readSelectedCampaign(db, owner.userId, installation.id, convo.id))?.id).toBe(created.campaignId);
  expect(await execute(replayed, 'marketing_context', {})).toMatchObject({ data: { selectedCampaign: null } });
  expect(await execute(replayed, 'list_drafts', {})).toMatchObject({ data: { items: [], nextCursor: null } });
  expect(await execute(replayed, 'save_draft', { format: 'image', body: 'Keep B unchanged' })).toMatchObject({ error: 'campaign_not_selected' });
  expect((await listDrafts(db, owner.userId, installation.id, { campaignId: created.campaignId, cursor: null })).items).toHaveLength(0);
  const following = await marketingToolsForTurn(db, owner.userId, { installationId: installation.id, mode: 'run' }, convo.id, message?.id ?? null);
  expect(await execute(following, 'save_draft', { format: 'image', body: 'Legacy follows B' })).toMatchObject({ ok: true });
  expect((await listDrafts(db, owner.userId, installation.id, { campaignId: created.campaignId, cursor: null })).items).toHaveLength(1);
});

it('rejects an explicit foreign or inactive binding and never falls back to the owners active app', async () => {
  const owner = await addAccount(pg);
  const other = await addAccount(pg);
  const draft = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  await expect(preflightMarketingTurn(db, owner.userId, { installationId: draft.id, mode: 'run' })).rejects.toThrow('marketing_binding_unavailable');
  await changeMarketingLifecycle(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
  await expect(preflightMarketingTurn(db, other.userId, { installationId: draft.id, mode: 'run' })).rejects.toThrow('marketing_binding_unavailable');
  await expect(preflightMarketingTurn(db, owner.userId, { installationId: randomUUID(), mode: 'run' })).rejects.toThrow('marketing_binding_unavailable');
});

it('offers Run or Refine tools only after an owned persisted user anchor exists', async () => {
  const owner = await addAccount(pg);
  const installation = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  await changeMarketingLifecycle(db, owner.userId, installation.id, { operation: 'activate', expectedRevision: installation.revision, mutationId: randomUUID() });
  const conversation = await withUser(db, owner.userId, (tx) => createConversation(tx, owner.userId, 'Marketing test'));
  const binding = await preflightMarketingTurn(db, owner.userId, { installationId: installation.id, mode: 'run', intent: 'posts', channel: 'instagram' }, conversation.id);
  expect(await marketingToolsForTurn(db, owner.userId, binding, conversation.id, null)).toEqual({});
  expect(await marketingToolsForTurn(db, owner.userId, binding, conversation.id, 'transient-turn')).toEqual({});
  const message = await appendMessage(db, owner.userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Prepare a campaign' }] });
  expect(message).toBeDefined();
  const run = await marketingToolsForTurn(db, owner.userId, binding, conversation.id, message?.id ?? null);
  expect(marketingTaskContext(binding, {})).toBeUndefined();
  expect(marketingTaskContext(null, run)).toBeUndefined();
  expect(marketingTaskContext(binding, run)).toEqual({ kind: 'marketing', intent: 'posts' });
  expect(Object.keys(run)).toContain('create_campaign');
  expect(Object.keys(run)).not.toContain('propose_marketing_config');
  const refine = await marketingToolsForTurn(db, owner.userId, { installationId: installation.id, mode: 'refine' }, conversation.id, message?.id ?? null);
  expect(Object.keys(refine).sort()).toEqual(['propose_marketing_config', 'read_marketing_config']);
  expect(marketingTaskContext({ installationId: installation.id, mode: 'refine', intent: 'posts' }, refine)).toBeUndefined();
});

it('validates a first-turn campaign target before writes and binds it only after the persisted anchor exists', async () => {
  const owner = await addAccount(pg);
  const installation = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  await changeMarketingLifecycle(db, owner.userId, installation.id, { operation: 'activate', expectedRevision: installation.revision, mutationId: randomUUID() });
  const receipt = await createCampaign(db, owner.userId, installation.id, { name: 'Already saved', goal: 'curiosity', channels: ['linkedin'] }, { key: randomUUID(), scope: { source: 'ui' } });
  if (!receipt.campaignId) throw new Error('Missing campaign');
  await expect(preflightMarketingTurn(db, owner.userId, { installationId: installation.id, mode: 'run', campaignId: randomUUID() })).rejects.toThrow('marketing_binding_unavailable');
  const binding = await preflightMarketingTurn(db, owner.userId, { installationId: installation.id, mode: 'run', campaignId: receipt.campaignId });
  const conversation = await withUser(db, owner.userId, (tx) => createConversation(tx, owner.userId, 'Existing campaign target'));
  expect(await marketingToolsForTurn(db, owner.userId, binding, conversation.id, null)).toEqual({});
  expect(await readSelectedCampaign(db, owner.userId, installation.id, conversation.id)).toBeNull();
  const stored = await appendMessage(db, owner.userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Continue this campaign' }] });
  await marketingToolsForTurn(db, owner.userId, binding, conversation.id, stored?.id ?? null);
  expect((await readSelectedCampaign(db, owner.userId, installation.id, conversation.id))?.id).toBe(receipt.campaignId);
});
