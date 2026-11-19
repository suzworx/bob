import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { changeMarketingLifecycle, installMarketingPackage } from '../../src/bob-apps/marketing-install.ts';
import {
  createCampaign, createDraft, getCampaign, getDraft, getMarketingOverview, listCampaigns, listDrafts, privateConversationSpace,
  readSelectedCampaign, saveCampaignSection, selectCampaign, updateCampaign, updateDraft, type WriteOrigin,
} from '../../src/bob-apps/marketing-store.ts';
import { deleteBobApp, getBobApp, mutateBobApp } from '../../src/bob-apps/store.ts';
import { StoreConflictError, StoreError, StoreNotFoundError, withUser, type Db } from '../../src/platform/db/db.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';

let pg: TestDb; let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

const ui = (key = randomUUID()): WriteOrigin => ({ key, scope: { source: 'ui' } });
const databaseName = (): string => (pg as unknown as { databaseName: string }).databaseName;
const campaignIntent = { name: 'Spring beta', goal: 'beta_interest', channels: ['instagram', 'linkedin'] };
const draftIntent = { channel: 'linkedin', format: 'text', body: 'Hello from Bob', altText: null, pillar: null, approvedAssetIds: [], claimIds: ['mission.lightens-moods'], cta: 'none' };
const KNOWN_CLAIM = 'mission.lightens-moods';

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
const campaignOf = (owner: TestAccount, installationId: string, name = campaignIntent.name) =>
  createCampaign(db, owner.userId, installationId, { ...campaignIntent, name }, ui());
const draftOf = (owner: TestAccount, installationId: string, campaignId: string, overrides: Record<string, unknown> = {}) =>
  createDraft(db, owner.userId, installationId, { ...draftIntent, campaignId, ...overrides }, ui());

it('persists a campaign, saves a plan section and reads the full record back by ID', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const receipt = await campaignOf(owner, id);
  expect(receipt).toEqual({ kind: 'campaign.create', campaignId: expect.any(String), draftId: null, revision: 1 });
  const saved = await saveCampaignSection(db, owner.userId, id, receipt.campaignId as string,
    { section: 'brief', content: 'Early beta interest only.', expectedRevision: 1 }, ui());
  expect(saved).toMatchObject({ kind: 'campaign.section', revision: 2 });
  const campaign = await getCampaign(db, owner.userId, id, receipt.campaignId as string) as {
    name: string; revision: number; channels: string[]; sections: Array<{ section: string; content: string }>; packRevision: string;
  };
  expect(campaign).toMatchObject({ name: 'Spring beta', revision: 2, channels: ['instagram', 'linkedin'] });
  expect(campaign.sections.find((section) => section.section === 'brief')?.content).toBe('Early beta interest only.');
  expect(campaign.sections.find((section) => section.section === 'review')?.content).toBe('');
  expect(campaign.packRevision).toMatch(/^[0-9a-f]{64}$/);
});

it('stamps the current server pack hash on campaign metadata and plan edits', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const { campaignId } = await campaignOf(owner, id);
  const current = (await getCampaign(db, owner.userId, id, campaignId as string)).packRevision;
  const markOldPack = () => withAdmin(adminUrl, (sql) => sql`update bob.bob_app_campaigns set pack_revision=repeat('a',64) where id=${campaignId}`);
  const adminUrl = await adminDatabaseUrl(databaseName());
  await markOldPack();
  await updateCampaign(db, owner.userId, id, campaignId as string, { name: 'Renamed', expectedRevision: 1 }, ui());
  expect((await getCampaign(db, owner.userId, id, campaignId as string)).packRevision).toBe(current);
  await markOldPack();
  await saveCampaignSection(db, owner.userId, id, campaignId as string, { section: 'brief', content: 'Updated', expectedRevision: 2 }, ui());
  expect((await getCampaign(db, owner.userId, id, campaignId as string)).packRevision).toBe(current);
});

it('hides another owner’s campaigns and refuses to write into another owner’s installation', async () => {
  const owner = await addAccount(pg);
  const stranger = await addAccount(pg);
  const { id } = await installed(owner);
  const { campaignId } = await campaignOf(owner, id);
  await expect(getCampaign(db, stranger.userId, id, campaignId as string)).rejects.toBeInstanceOf(StoreNotFoundError);
  await expect(createCampaign(db, stranger.userId, id, campaignIntent, ui())).rejects.toBeInstanceOf(StoreNotFoundError);
  await expect(updateCampaign(db, stranger.userId, id, campaignId as string, { name: 'Mine now', expectedRevision: 1 }, ui())).rejects.toBeInstanceOf(StoreNotFoundError);
  expect((await listCampaigns(db, owner.userId, id, null) as { items: unknown[] }).items).toHaveLength(1);
});

it('denies a forged draft row that points at a campaign of another installation (composite foreign key)', async () => {
  const owner = await addAccount(pg);
  const first = await installed(owner);
  const campaign = await campaignOf(owner, first.id);
  // The campaign belongs to `first`; the forged row names a different installation of the same owner.
  await expect(withUser(db, owner.userId, (tx) => tx.query(
    `insert into bob.bob_app_campaign_drafts (user_id,installation_id,campaign_id,channel,format,pack_revision)
     values ($1,$2,$3,'linkedin','text',$4)`,
    [owner.userId, randomUUID(), campaign.campaignId, 'a'.repeat(64)],
  ))).rejects.toThrow(/foreign key|violates/i);
  // A stranger cannot insert into the owner's campaign at all: row-level security rejects the row.
  const stranger = await addAccount(pg);
  await expect(withUser(db, stranger.userId, (tx) => tx.query(
    `insert into bob.bob_app_campaign_drafts (user_id,installation_id,campaign_id,channel,format,pack_revision)
     values ($1,$2,$3,'linkedin','text',$4)`,
    [stranger.userId, first.id, campaign.campaignId, 'a'.repeat(64)],
  ))).rejects.toThrow(/row-level security|foreign key|violates/i);
});

it('replays the exact stored receipt for a repeated key and refuses changed intent under the same key', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const key = randomUUID();
  const first = await createCampaign(db, owner.userId, id, campaignIntent, ui(key));
  const replay = await createCampaign(db, owner.userId, id, campaignIntent, ui(key));
  expect(replay).toEqual(first);
  expect((await listCampaigns(db, owner.userId, id, null) as { items: unknown[] }).items).toHaveLength(1);
  await expect(createCampaign(db, owner.userId, id, { ...campaignIntent, name: 'Changed' }, ui(key)))
    .rejects.toMatchObject({ message: 'marketing_mutation_conflict' });
  await expect(createCampaign(db, owner.userId, id, campaignIntent, ui(key))).resolves.toEqual(first);
});

it('stores only the minimal receipt: IDs and a revision, never the request content', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const key = randomUUID();
  await createCampaign(db, owner.userId, id, { ...campaignIntent, goalNote: 'SECRET-NOTE-ALPHA' }, ui(key));
  const rows = await withUser(db, owner.userId, (tx) => tx.query<{ receipt: Record<string, unknown> }>(
    'select receipt from bob.bob_app_campaign_operations where operation_key=$1', [key]));
  expect(rows).toHaveLength(1);
  expect(Object.keys(rows[0]?.receipt ?? {}).sort()).toEqual(['campaignId', 'draftId', 'kind', 'revision']);
  expect(JSON.stringify(rows)).not.toContain('SECRET-NOTE-ALPHA');
});

it('admits at most twenty live campaigns under concurrent creates and refuses the twenty-first atomically', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const results = await Promise.allSettled(Array.from({ length: 21 }, (_, index) =>
    createCampaign(db, owner.userId, id, { ...campaignIntent, name: `Parallel ${index}` }, ui())));
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  expect(fulfilled).toHaveLength(20);
  expect(refused).toHaveLength(1);
  expect(refused[0]?.reason).toBeInstanceOf(StoreError);
  expect((refused[0]?.reason as StoreError).message).toBe('campaign_quota_reached');
  expect((await listCampaigns(db, owner.userId, id, null) as { items: unknown[] }).items).toHaveLength(20);
});

it('refuses a stale campaign revision with a conflict and leaves the campaign unchanged', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const { campaignId } = await campaignOf(owner, id);
  await updateCampaign(db, owner.userId, id, campaignId as string, { name: 'Renamed', expectedRevision: 1 }, ui());
  await expect(updateCampaign(db, owner.userId, id, campaignId as string, { name: 'Stale', expectedRevision: 1 }, ui()))
    .rejects.toBeInstanceOf(StoreConflictError);
  expect(await getCampaign(db, owner.userId, id, campaignId as string)).toMatchObject({ name: 'Renamed', revision: 2 });
});

it('validates draft channel, format and pack references and never raises the campaign revision', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const { campaignId } = await campaignOf(owner, id);
  await expect(draftOf(owner, id, campaignId as string, { channel: 'instagram', format: 'text' })).rejects.toThrow(/image or carousel/i);
  await expect(draftOf(owner, id, campaignId as string, { approvedAssetIds: ['bob-unknown'] })).rejects.toMatchObject({ message: 'marketing_asset_unknown' });
  await expect(draftOf(owner, id, campaignId as string, { claimIds: ['claim.invented'] })).rejects.toMatchObject({ message: 'marketing_claim_unknown' });
  const created = await draftOf(owner, id, campaignId as string, { approvedAssetIds: ['bob-playful'], claimIds: [KNOWN_CLAIM] });
  expect(created).toEqual({ kind: 'draft.create', campaignId, draftId: expect.any(String), revision: 1 });
  expect(await getCampaign(db, owner.userId, id, campaignId as string)).toMatchObject({ revision: 1 });
  const draft = await getDraft(db, owner.userId, id, created.draftId as string) as { state: string; contentRevision: number; body: string };
  expect(draft).toMatchObject({ state: 'needs_check', contentRevision: 1, body: 'Hello from Bob' });
  await expect(updateDraft(db, owner.userId, id, created.draftId as string, { expectedContentRevision: 9, body: 'Late' }, ui()))
    .rejects.toBeInstanceOf(StoreConflictError);
  const updated = await updateDraft(db, owner.userId, id, created.draftId as string, { expectedContentRevision: 1, body: 'Edited' }, ui());
  expect(updated).toMatchObject({ kind: 'draft.update', revision: 2 });
});

it('pages campaigns and drafts by stable ID with bounded pages and a cursor', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const { campaignId } = await campaignOf(owner, id, 'Page one');
  for (let index = 1; index < 20; index += 1) await campaignOf(owner, id, `Page ${index}`);
  const campaigns = await listCampaigns(db, owner.userId, id, null) as { items: Array<{ id: string }>; nextCursor: string | null };
  expect(campaigns.items).toHaveLength(20);
  expect(campaigns.nextCursor).toBeNull();
  expect(campaigns.items.map((item) => item.id)).toEqual([...campaigns.items.map((item) => item.id)].sort());
  for (let index = 0; index < 51; index += 1) await draftOf(owner, id, campaignId as string, { body: `Draft ${index}` });
  const first = await listDrafts(db, owner.userId, id, { campaignId: campaignId as string, cursor: null }) as { items: Array<{ id: string }>; nextCursor: string | null };
  expect(first.items).toHaveLength(50);
  expect(first.nextCursor).toBe(first.items.at(-1)?.id);
  const second = await listDrafts(db, owner.userId, id, { campaignId: campaignId as string, cursor: first.nextCursor }) as { items: unknown[]; nextCursor: string | null };
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
});

it('scopes the selection to one private conversation and clears it on archive', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const first = await conversation(owner.userId);
  const second = await conversation(owner.userId);
  const { campaignId } = await campaignOf(owner, id);
  await selectCampaign(db, owner.userId, id, first, campaignId as string, ui());
  expect(await readSelectedCampaign(db, owner.userId, id, first)).toMatchObject({ id: campaignId });
  expect(await readSelectedCampaign(db, owner.userId, id, second)).toBeNull();
  await expect(selectCampaign(db, owner.userId, id, `conv_${randomUUID()}`, campaignId as string, ui())).rejects.toBeInstanceOf(StoreNotFoundError);
  expect(await privateConversationSpace(db, owner.userId, `conv_${randomUUID()}`)).toBeNull();
  await updateCampaign(db, owner.userId, id, campaignId as string, { status: 'archived', expectedRevision: 1 }, ui());
  expect(await readSelectedCampaign(db, owner.userId, id, first)).toBeNull();
  await expect(selectCampaign(db, owner.userId, id, first, campaignId as string, ui())).rejects.toBeInstanceOf(StoreNotFoundError);
  await selectCampaign(db, owner.userId, id, first, null, ui());
  expect(await readSelectedCampaign(db, owner.userId, id, first)).toBeNull();
});

it('applies a pause at once to writes and replays, while the owner keeps reading and choosing the selection', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const convo = await conversation(owner.userId);
  const { campaignId } = await campaignOf(owner, id);
  const replayKey = randomUUID();
  const created = await createCampaign(db, owner.userId, id, { ...campaignIntent, name: 'Replayed' }, ui(replayKey));
  await selectCampaign(db, owner.userId, id, convo, campaignId as string, ui());
  const paused = await changeMarketingLifecycle(db, owner.userId, id, { operation: 'pause', expectedRevision: 2, mutationId: randomUUID() });
  expect(paused.state).toBe('paused');
  expect(await readSelectedCampaign(db, owner.userId, id, convo)).toMatchObject({ id: campaignId });
  await selectCampaign(db, owner.userId, id, convo, null, ui());
  expect(await readSelectedCampaign(db, owner.userId, id, convo)).toBeNull();
  await selectCampaign(db, owner.userId, id, convo, campaignId as string, ui());
  expect(await readSelectedCampaign(db, owner.userId, id, convo)).toMatchObject({ id: campaignId });
  const anchored = { key: randomUUID(), scope: { source: 'binding', conversationId: convo, turnId: 'turn' } };
  await expect(selectCampaign(db, owner.userId, id, convo, null, anchored)).rejects.toMatchObject({ message: 'marketing_not_active' });
  await expect(draftOf(owner, id, campaignId as string)).rejects.toMatchObject({ message: 'marketing_not_active' });
  await expect(createCampaign(db, owner.userId, id, { ...campaignIntent, name: 'Replayed' }, ui(replayKey))).rejects.toMatchObject({ message: 'marketing_not_active' });
  expect(created.kind).toBe('campaign.create');
});

it('refuses the owner\'s selection on a paused installation whose app is archived', async () => {
  const owner = await addAccount(pg);
  const { id, appId } = await installed(owner);
  const convo = await conversation(owner.userId);
  const { campaignId } = await campaignOf(owner, id);
  await changeMarketingLifecycle(db, owner.userId, id, { operation: 'pause', expectedRevision: 2, mutationId: randomUUID() });
  await selectCampaign(db, owner.userId, id, convo, campaignId as string, ui());
  const app = await getBobApp(db, owner.userId, appId);
  await mutateBobApp(db, owner.userId, appId, { operation: 'archive', expectedRevision: app.revision, mutationId: randomUUID() });
  await expect(selectCampaign(db, owner.userId, id, convo, null, ui())).rejects.toMatchObject({ message: 'marketing_not_active' });
  expect(await readSelectedCampaign(db, owner.userId, id, convo)).toMatchObject({ id: campaignId });
});

it('drops access to a saved selection and its replay when its conversation is archived', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const convo = await conversation(owner.userId);
  const { campaignId } = await campaignOf(owner, id);
  const origin = ui();
  await selectCampaign(db, owner.userId, id, convo, campaignId, origin);
  await withUser(db, owner.userId, (tx) => tx.query('update bob.conversations set archived_at=now() where id=$1', [convo]));
  expect(await readSelectedCampaign(db, owner.userId, id, convo)).toBeNull();
  await expect(selectCampaign(db, owner.userId, id, convo, campaignId, origin)).rejects.toBeInstanceOf(StoreNotFoundError);
});

it('cascades installation deletion to campaigns, drafts, selections and receipts', async () => {
  const owner = await addAccount(pg);
  const { id, appId } = await installed(owner);
  const convo = await conversation(owner.userId);
  const { campaignId } = await campaignOf(owner, id);
  await draftOf(owner, id, campaignId as string);
  await selectCampaign(db, owner.userId, id, convo, campaignId as string, ui());
  await deleteBobApp(db, owner.userId, appId, { expectedRevision: (await getBobApp(db, owner.userId, appId)).revision, mutationId: randomUUID() });
  const remaining = await withAdmin(await adminDatabaseUrl(databaseName()), (sql) => sql<{ n: number }[]>`
    select (select count(*)::int from bob.bob_app_campaigns where user_id=${owner.userId})
      + (select count(*)::int from bob.bob_app_campaign_drafts where user_id=${owner.userId})
      + (select count(*)::int from bob.bob_app_campaign_selection where user_id=${owner.userId})
      + (select count(*)::int from bob.bob_app_campaign_operations where user_id=${owner.userId}) as n`);
  expect(remaining[0]?.n).toBe(0);
});

it('stops all new campaign writes at the operation cap while exact replay and installation pause still work', async () => {
  const owner = await addAccount(pg);
  const { id } = await installed(owner);
  const firstKey = randomUUID();
  const { campaignId } = await createCampaign(db, owner.userId, id, campaignIntent, ui(firstKey));
  await withAdmin(await adminDatabaseUrl(databaseName()), (sql) => sql`
    insert into bob.bob_app_campaign_operations (user_id,installation_id,operation_key,canonical_hash,receipt)
    select ${owner.userId}::uuid, ${id}::uuid, gen_random_uuid()::text, repeat('a', 64), '{}'::jsonb
    from generate_series(1, 9999)`);
  await expect(createCampaign(db, owner.userId, id, { ...campaignIntent, name: 'Over the cap' }, ui()))
    .rejects.toMatchObject({ message: 'operation_limit_reached' });
  await expect(createCampaign(db, owner.userId, id, campaignIntent, ui(firstKey))).resolves.toMatchObject({ campaignId });
  await expect(updateCampaign(db, owner.userId, id, campaignId as string, { status: 'archived', expectedRevision: 1 }, ui()))
    .rejects.toMatchObject({ message: 'operation_limit_reached' });
  expect(await changeMarketingLifecycle(db, owner.userId, id, { operation: 'pause', expectedRevision: 2, mutationId: randomUUID() }))
    .toMatchObject({ state: 'paused' });
});
