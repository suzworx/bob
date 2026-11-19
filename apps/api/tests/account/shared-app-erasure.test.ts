import { createHash, randomUUID } from 'node:crypto';
import { bobMarketingPack } from '@bob/ai';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createBobApp, getBobApp, mutateBobApp } from '../../src/bob-apps/store.ts';
import { addMember, createSpace, getSpace, listMembers, transferOwnership } from '../../src/spaces/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { deleteAccount, type AccountDeletionDeps } from '../../src/workflows/workflow-account-deletion.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { changeMarketingLifecycle, installMarketingPackage } from '../../src/bob-apps/marketing-install.ts';
import { createCampaign, createDraft, saveCampaignSection } from '../../src/bob-apps/marketing-store.ts';
import { applyMarketingConfigProposal, proposeMarketingConfig } from '../../src/bob-apps/marketing-config-store.ts';
import { MARKETING_BASELINE_GRANTS, MARKETING_PACKAGE_VERSION, MARKETING_WORKSPACE_DEFINITION } from '../../src/bob-apps/marketing-registry.ts';
import { DEFAULT_MARKETING_CONFIG, MARKETING_PACKAGE_ID } from '../../src/bob-apps/marketing-schemas.ts';
import { createThread } from '../../src/conversations/thread-store.ts';

// Keep the full deletion workflow and real stores. Only the outbound email boundary is suppressed.
vi.mock('../../src/notifications/email-client.ts', async (original) => ({
  ...(await original<typeof import('../../src/notifications/email-client.ts')>()),
  recipientEmail: vi.fn(async () => null),
}));

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

const NOW = Date.parse('2026-11-01T00:00:00Z');
const definition = {
  schemaVersion: 1, title: 'Team work', lifecycle: 'keep',
  tables: [{ id: 'items', fields: [{ id: 'title', type: 'text' }] }],
  actions: [], metrics: [],
  views: [{ id: 'list', kind: 'table', title: 'Team work', table: 'items', fields: ['title'], actions: [] }],
};
const authoredState = { items: [{ id: 'kept', values: { title: 'A contribution for the team' } }] };
const personalState = { items: [{ id: 'personal', values: { title: 'Only mine' } }] };

function deletionDeps(database: Db = db): AccountDeletionDeps {
  return {
    db: database,
    googleConnection: { revoke: vi.fn(async () => undefined) },
    deviceSessions: { closeDevice: vi.fn() },
    now: () => NOW,
  };
}

/** Observes the actual app purge without replacing its implementation or transaction. */
function observeAppPurge(base: Db, seen: () => void): Db {
  return {
    query<T>(text: string, params?: unknown[]): Promise<T[]> {
      if (/bob_private\.purge_bob_apps\(/i.test(text)) seen();
      return base.query<T>(text, params);
    },
    tx: <T>(work: (tx: Db) => Promise<T>): Promise<T> => base.tx((tx) => work(observeAppPurge(tx, seen))),
  };
}

/** Read only from this test's disposable DB, proving deletion instead of relying on lost RLS visibility. */
async function physicalAppCount(appId: string): Promise<number> {
  const databaseName = (pg as unknown as { databaseName: string }).databaseName;
  return withAdmin(await adminDatabaseUrl(databaseName), async (sql) => {
    const rows = await sql<{ count: number }[]>`select count(*)::int as count from bob.bob_apps where id=${appId}`;
    return rows[0]?.count ?? 0;
  });
}

async function privateApp(owner: TestAccount): Promise<Awaited<ReturnType<typeof createBobApp>>> {
  return createBobApp(db, owner.userId, { definition, state: personalState, mutationId: randomUUID() });
}

async function sharedApp(authorId: string, managerId: string, spaceId: string): Promise<Awaited<ReturnType<typeof mutateBobApp>>> {
  const draft = await createBobApp(db, authorId, { definition, state: authoredState, spaceId, mutationId: randomUUID() });
  return mutateBobApp(db, managerId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
}

async function retainedBy(memberId: string, appId: string, installationId: string, spaceId: string, erasedId: string): Promise<void> {
  expect(await getBobApp(db, memberId, appId)).toMatchObject({
    id: appId, installationId, spaceId, lifecycle: 'active', definition, state: authoredState,
  });
  const rows = await withUser(db, memberId, (tx) => tx.query<{ created_by: string | null }>('select created_by from bob.bob_apps where id=$1', [appId]));
  expect(rows).toEqual([{ created_by: null }]);
  await expect(getBobApp(db, erasedId, appId)).rejects.toThrow('app_not_found');
}

it.each(['member', 'admin'] as const)('retains a group app after its %s installer completes the account-deletion workflow', async (role) => {
  const owner = await addAccount(pg);
  const installer = await addAccount(pg);
  const teammate = await addAccount(pg);
  const other = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Retained team' });
  await addMember(db, owner.userId, space.id, installer.userId, role);
  await addMember(db, owner.userId, space.id, teammate.userId, 'member');
  const personal = await privateApp(installer);
  const unrelated = await privateApp(other);
  const shared = await sharedApp(installer.userId, owner.userId, space.id);

  expect(await deleteAccount(deletionDeps(), { userId: installer.userId })).toEqual({ outcome: 'deleted' });

  await retainedBy(teammate.userId, shared.id, shared.installationId, space.id, installer.userId);
  expect(await physicalAppCount(personal.id)).toBe(0);
  expect(await getBobApp(db, other.userId, unrelated.id)).toEqual(unrelated);
  expect((await listMembers(db, owner.userId, space.id)).some((member) => member.userId === installer.userId)).toBe(false);
});

it('hands a co-owned group to its remaining owner and retains the erased owner-installer app', async () => {
  const installer = await addAccount(pg);
  const successor = await addAccount(pg);
  const space = await createSpace(db, installer.userId, { kind: 'group', name: 'Co-owned team' });
  await addMember(db, installer.userId, space.id, successor.userId, 'owner');
  const personal = await privateApp(installer);
  const shared = await sharedApp(installer.userId, installer.userId, space.id);

  expect(await deleteAccount(deletionDeps(), { userId: installer.userId })).toEqual({ outcome: 'deleted' });

  expect((await getSpace(db, successor.userId, space.id)).ownerUserId).toBe(successor.userId);
  await retainedBy(successor.userId, shared.id, shared.installationId, space.id, installer.userId);
  expect(await physicalAppCount(personal.id)).toBe(0);
});

it.each(['admin', 'member'] as const)('refuses a sole owner with only an %s teammate before purging any app', async (role) => {
  const owner = await addAccount(pg);
  const teammate = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Still owned' });
  await addMember(db, owner.userId, space.id, teammate.userId, role);
  const shared = await sharedApp(owner.userId, owner.userId, space.id);
  const personal = await privateApp(owner);
  const memberships = await listMembers(db, owner.userId, space.id);
  const purge = vi.fn();
  const deps = deletionDeps(observeAppPurge(db, purge));

  expect(await deleteAccount(deps, { userId: owner.userId })).toEqual({ outcome: 'owns_groups', count: 1 });

  expect(purge).not.toHaveBeenCalled();
  expect(deps.googleConnection?.revoke).not.toHaveBeenCalled();
  expect(deps.deviceSessions.closeDevice).not.toHaveBeenCalled();
  expect(await getBobApp(db, owner.userId, shared.id)).toEqual(shared);
  expect(await getBobApp(db, owner.userId, personal.id)).toEqual(personal);
  expect(await listMembers(db, owner.userId, space.id)).toEqual(memberships);
  expect(await physicalAppCount(shared.id)).toBe(1);
  expect(await physicalAppCount(personal.id)).toBe(1);
});

it('retains the same shared work when a refused installer transfers ownership and retries deletion', async () => {
  const installer = await addAccount(pg);
  const successor = await addAccount(pg);
  const space = await createSpace(db, installer.userId, { kind: 'group', name: 'Transferred team' });
  await addMember(db, installer.userId, space.id, successor.userId, 'member');
  const shared = await sharedApp(installer.userId, installer.userId, space.id);
  const personal = await privateApp(installer);
  expect(await deleteAccount(deletionDeps(), { userId: installer.userId })).toEqual({ outcome: 'owns_groups', count: 1 });
  await transferOwnership(db, installer.userId, space.id, successor.userId);

  expect(await deleteAccount(deletionDeps(), { userId: installer.userId })).toEqual({ outcome: 'deleted' });

  await retainedBy(successor.userId, shared.id, shared.installationId, space.id, installer.userId);
  expect(await physicalAppCount(personal.id)).toBe(0);
});

type MarketingRows = { appId: string; installationId: string; campaignId: string; draftId: string; proposalId: string };
type RetainedRow = { resource: string; id: string; user_id: string | null; created_by: string | null; content: unknown };
const narrowConfig = { visibleViews: ['content'], contentGrouping: 'channel', defaultChannels: ['linkedin'] };

/** Until shared installation HTTP exists, seed a genuine package envelope as an authorized admin, never a generic app with fabricated grants. */
async function sharedMarketingRows(authorId: string, spaceId: string): Promise<MarketingRows> {
  const rows = { appId: randomUUID(), installationId: randomUUID(), campaignId: randomUUID(), draftId: randomUUID(), proposalId: randomUUID() };
  const packHash = createHash('sha256').update(JSON.stringify(bobMarketingPack)).digest('hex');
  await withUser(db, authorId, async (tx) => {
    await tx.query('select bob_private.lock_thread_audience_revision($1)', [spaceId]);
    await tx.query(`insert into bob.bob_apps(id,user_id,space_id,definition,state)
      values($1,null,$2,$3::text::jsonb,'{}')`, [rows.appId, spaceId, JSON.stringify(MARKETING_WORKSPACE_DEFINITION)]);
    await tx.query(`insert into bob.bob_app_installations(id,user_id,app_id,kind,package_id,package_version,state,granted_capabilities,config)
      values($1,null,$2,'package',$3,$4,'active',$5::text[],$6::text::jsonb)`,
    [rows.installationId, rows.appId, MARKETING_PACKAGE_ID, MARKETING_PACKAGE_VERSION, `{${MARKETING_BASELINE_GRANTS.join(',')}}`, JSON.stringify(DEFAULT_MARKETING_CONFIG)]);
    await tx.query("update bob.bob_apps set lifecycle='active' where id=$1", [rows.appId]);
    await tx.query(`insert into bob.bob_app_campaigns(id,user_id,installation_id,name,goal,channels,pack_revision)
      values($1,null,$2,'A retained week','curiosity','{linkedin}',$3)`, [rows.campaignId, rows.installationId, packHash]);
    await tx.query(`insert into bob.bob_app_campaign_sections(user_id,installation_id,campaign_id,section,content)
      values(null,$1,$2,'brief','The team keeps this story.')`, [rows.installationId, rows.campaignId]);
    await tx.query(`insert into bob.bob_app_campaign_drafts(id,user_id,installation_id,campaign_id,channel,format,body,pack_revision)
      values($1,null,$2,$3,'linkedin','text','A contribution the team can still edit.',$4)`, [rows.draftId, rows.installationId, rows.campaignId, packHash]);
    await tx.query(`insert into bob.marketing_config_proposals(id,user_id,installation_id,base_config_revision,package_version,proposed_config,canonical_hash,required_capabilities,preview_receipt)
      values($1,null,$2,1,$3,$4::text::jsonb,repeat('a',64),'{campaign.configure}','{"changes":[],"dependencies":[]}')`,
    [rows.proposalId, rows.installationId, MARKETING_PACKAGE_VERSION, JSON.stringify(narrowConfig)]);
    await tx.query(`insert into bob.marketing_config_versions(user_id,installation_id,revision,config,package_version)
      values(null,$1,1,$2::text::jsonb,$3)`, [rows.installationId, JSON.stringify(DEFAULT_MARKETING_CONFIG), MARKETING_PACKAGE_VERSION]);
  });
  return rows;
}

/** Existing private package APIs must still erase all descendants through the personal app cascade. */
async function personalMarketingRows(owner: TestAccount): Promise<MarketingRows> {
  const installed = await installMarketingPackage(db, owner.userId, { packageId: MARKETING_PACKAGE_ID, mutationId: randomUUID() }, owner.sessionId);
  await changeMarketingLifecycle(db, owner.userId, installed.id, { operation: 'activate', expectedRevision: installed.revision, mutationId: randomUUID() });
  const origin = () => ({ key: randomUUID(), scope: { source: 'ui' } });
  const campaign = await createCampaign(db, owner.userId, installed.id, { name: 'Private work', goal: 'curiosity', channels: ['linkedin'] }, origin());
  if (!campaign.campaignId) throw new Error('campaign missing');
  await saveCampaignSection(db, owner.userId, installed.id, campaign.campaignId, { section: 'brief', content: 'Only mine.', expectedRevision: 1 }, origin());
  const draft = await createDraft(db, owner.userId, installed.id, {
    campaignId: campaign.campaignId, channel: 'linkedin', format: 'text', body: 'Private copy', altText: null, pillar: null,
    approvedAssetIds: [], claimIds: [], cta: 'none',
  }, origin());
  const proposed = await proposeMarketingConfig(db, owner.userId, installed.id, { expectedConfigRevision: 1, config: narrowConfig, mutationId: randomUUID() });
  if (!proposed.proposal || !draft.draftId) throw new Error('private fixture missing');
  await applyMarketingConfigProposal(db, owner.userId, installed.id, {
    proposalId: proposed.proposal.id, hash: proposed.proposal.canonicalHash, expectedConfigRevision: 1, mutationId: randomUUID(),
  });
  return { appId: installed.appId, installationId: installed.id, campaignId: campaign.campaignId, draftId: draft.draftId, proposalId: proposed.proposal.id };
}

async function retainedMarketingRows(memberId: string, rows: MarketingRows): Promise<RetainedRow[]> {
  return withUser(db, memberId, (tx) => tx.query<RetainedRow>(`
    select 'bob_apps' as resource,id::text,user_id,created_by,jsonb_build_object('definition',definition,'state',state,'revision',revision,'lifecycle',lifecycle) as content from bob.bob_apps where id=$1
    union all select 'bob_app_installations',id::text,user_id,created_by,jsonb_build_object('kind',kind,'package',package_id,'version',package_version,'grants',granted_capabilities,'config',config,'revision',revision,'configRevision',config_revision,'state',state) from bob.bob_app_installations where id=$2
    union all select 'bob_app_campaigns',id::text,user_id,created_by,jsonb_build_object('name',name,'goal',goal,'channels',channels,'revision',revision,'pack',pack_revision) from bob.bob_app_campaigns where id=$3
    union all select 'bob_app_campaign_sections',campaign_id::text||':'||section,user_id,created_by,jsonb_build_object('content',content) from bob.bob_app_campaign_sections where campaign_id=$3
    union all select 'bob_app_campaign_drafts',id::text,user_id,created_by,jsonb_build_object('body',body,'revision',content_revision,'state',state,'pack',pack_revision) from bob.bob_app_campaign_drafts where id=$4
    union all select 'marketing_config_proposals',id::text,user_id,created_by,jsonb_build_object('config',proposed_config,'hash',canonical_hash,'status',status,'revision',base_config_revision) from bob.marketing_config_proposals where id=$5
    union all select 'marketing_config_versions',installation_id::text||':'||revision,user_id,created_by,jsonb_build_object('config',config,'revision',revision,'proposal',source_proposal_id,'version',package_version) from bob.marketing_config_versions where installation_id=$2
    order by resource,id`, [rows.appId, rows.installationId, rows.campaignId, rows.draftId, rows.proposalId]));
}

async function physicalMarketingCount(rows: MarketingRows): Promise<number> {
  const databaseName = (pg as unknown as { databaseName: string }).databaseName;
  return withAdmin(await adminDatabaseUrl(databaseName), async (sql) => {
    const [count] = await sql<{ count: number }[]>`select
      (select count(*) from bob.bob_apps where id=${rows.appId})+
      (select count(*) from bob.bob_app_installations where id=${rows.installationId})+
      (select count(*) from bob.bob_app_campaigns where id=${rows.campaignId})+
      (select count(*) from bob.bob_app_campaign_sections where campaign_id=${rows.campaignId})+
      (select count(*) from bob.bob_app_campaign_drafts where id=${rows.draftId})+
      (select count(*) from bob.marketing_config_proposals where id=${rows.proposalId})+
      (select count(*) from bob.marketing_config_versions where installation_id=${rows.installationId}) as count`;
    return Number(count?.count ?? 0);
  });
}

/** These are actor-personal even when their installation/content belongs to a group. */
async function actorMarketingRows(actorId: string, rows: MarketingRows, conversationId: string): Promise<void> {
  await withUser(db, actorId, async (tx) => {
    await tx.query('insert into bob.bob_app_selection(user_id,installation_id,expires_at) values($1,$2,$3)', [actorId, rows.installationId, new Date(NOW + 3600000)]);
    await tx.query('insert into bob.bob_app_campaign_selection(user_id,installation_id,conversation_id,campaign_id) values($1,$2,$3,$4)', [actorId, rows.installationId, conversationId, rows.campaignId]);
    await tx.query(`insert into bob.bob_app_campaign_operations(user_id,installation_id,operation_key,canonical_hash,receipt)
      values($1,$2,$3,repeat('b',64),$4::text::jsonb)`, [actorId, rows.installationId, randomUUID(), JSON.stringify({ kind: 'campaign.select', campaignId: rows.campaignId, draftId: null, revision: null })]);
    await tx.query(`insert into bob.marketing_config_operations(user_id,installation_id,mutation_id,fingerprint,receipt)
      values($1,$2,$3,repeat('c',64),$4::text::jsonb)`, [actorId, rows.installationId, randomUUID(), JSON.stringify({ kind: 'proposed', installationId: rows.installationId, proposalId: rows.proposalId, configRevision: 1, noChange: false })]);
  });
}

async function physicalActorMarketingCount(actorId: string, installationId: string): Promise<number> {
  const databaseName = (pg as unknown as { databaseName: string }).databaseName;
  return withAdmin(await adminDatabaseUrl(databaseName), async (sql) => {
    const [count] = await sql<{ count: number }[]>`select
      (select count(*) from bob.bob_app_selection where user_id=${actorId} and installation_id=${installationId})+
      (select count(*) from bob.bob_app_campaign_selection where user_id=${actorId} and installation_id=${installationId})+
      (select count(*) from bob.bob_app_campaign_operations where user_id=${actorId} and installation_id=${installationId})+
      (select count(*) from bob.marketing_config_operations where user_id=${actorId} and installation_id=${installationId}) as count`;
    return Number(count?.count ?? 0);
  });
}

it('retains every shared attribution resource through full erasure while physically purging private Marketing work', async () => {
  const owner = await addAccount(pg), installer = await addAccount(pg), teammate = await addAccount(pg), outsider = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Retained marketing team' });
  await addMember(db, owner.userId, space.id, installer.userId, 'admin');
  await addMember(db, owner.userId, space.id, teammate.userId, 'member');
  const unrelated = await privateApp(outsider);
  const personal = await personalMarketingRows(installer);
  const shared = await sharedMarketingRows(installer.userId, space.id);
  const thread = await createThread(db, owner.userId, { spaceId: space.id, title: 'Shared review' });
  await actorMarketingRows(installer.userId, shared, thread.id);
  await actorMarketingRows(teammate.userId, shared, thread.id);
  const before = await retainedMarketingRows(teammate.userId, shared);
  expect(before).toHaveLength(7);
  expect(before.every((row) => row.created_by === installer.userId && row.user_id === null)).toBe(true);
  expect(await retainedMarketingRows(outsider.userId, shared)).toEqual([]);
  expect(await physicalMarketingCount(personal)).toBeGreaterThanOrEqual(7);
  expect(await physicalActorMarketingCount(installer.userId, shared.installationId)).toBe(4);
  expect(await physicalActorMarketingCount(teammate.userId, shared.installationId)).toBe(4);

  expect(await deleteAccount(deletionDeps(), { userId: installer.userId })).toEqual({ outcome: 'deleted' });

  expect(await retainedMarketingRows(teammate.userId, shared)).toEqual(before.map((row) => ({ ...row, created_by: null })));
  expect(await retainedMarketingRows(installer.userId, shared)).toEqual([]);
  expect(await physicalMarketingCount(shared)).toBe(7);
  expect(await physicalMarketingCount(personal)).toBe(0);
  expect(await physicalActorMarketingCount(installer.userId, shared.installationId)).toBe(0);
  expect(await physicalActorMarketingCount(teammate.userId, shared.installationId)).toBe(4);
  expect(await getBobApp(db, outsider.userId, unrelated.id)).toEqual(unrelated);
});
