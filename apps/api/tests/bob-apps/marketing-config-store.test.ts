import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { changeMarketingLifecycle, installMarketingPackage } from '../../src/bob-apps/marketing-install.ts';
import { getBobApp, mutateBobApp } from '../../src/bob-apps/store.ts';
import { eraseAccountRow } from '../../src/account/erasure-store.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { MARKETING_WORKSPACE_DEFINITION } from '../../src/bob-apps/marketing-registry.ts';
import {
  applyMarketingConfigProposal, discardMarketingConfigProposal, proposeMarketingConfig, readMarketingConfig, restoreMarketingConfigVersion,
} from '../../src/bob-apps/marketing-config-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { MarketingConfigChangeSchema } from '../../src/bob-apps/marketing-config-schemas.ts';
import { createCampaign, createDraft, getCampaign, getDraft, saveCampaignSection } from '../../src/bob-apps/marketing-store.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

const DEFAULT = { visibleViews: ['campaign', 'content', 'schedule', 'results'], contentGrouping: 'none', defaultChannels: ['instagram', 'linkedin'] };
const NARROW = { visibleViews: ['campaign', 'results'], contentGrouping: 'channel', defaultChannels: ['linkedin'] };

async function activeInstallation(owner: TestAccount): Promise<{ id: string; appId: string }> {
  const draft = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  const active = await changeMarketingLifecycle(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
  return { id: active.id, appId: active.appId };
}
/** A proposal always carries its view on propose, so the helper narrows the nullable type once, here. */
async function propose(owner: TestAccount, id: string, config: unknown, expectedConfigRevision = 1, mutationId = randomUUID()) {
  const result = await proposeMarketingConfig(db, owner.userId, id, { expectedConfigRevision, config, mutationId });
  if (!result.proposal) throw new Error('proposal view missing');
  return { receipt: result.receipt, proposal: result.proposal };
}
const apply = (owner: TestAccount, id: string, proposalId: string, hash: string, expectedConfigRevision: number, mutationId = randomUUID()) =>
  applyMarketingConfigProposal(db, owner.userId, id, { proposalId, hash, expectedConfigRevision, mutationId });
const sql = <T>(owner: TestAccount, text: string, params: unknown[] = []) => withUser(db, owner.userId, (tx) => tx.query<T>(text, params));

it.each(['pause', 'revoke', 'delete'] as const)('reauthorizes every exact operation replay after %s', async (action) => {
  const owner = await addAccount(pg);
  const { id, appId } = await activeInstallation(owner);
  const proposedId = randomUUID();
  const proposed = await propose(owner, id, NARROW, 1, proposedId);
  const appliedId = randomUUID();
  await apply(owner, id, proposed.proposal.id, proposed.proposal.canonicalHash, 1, appliedId);
  const discarded = await propose(owner, id, DEFAULT, 2);
  const discardInput = { proposalId: discarded.proposal.id, expectedConfigRevision: 2, mutationId: randomUUID() };
  await discardMarketingConfigProposal(db, owner.userId, id, discardInput);
  const restoreInput = { versionRevision: 1, expectedConfigRevision: 2, mutationId: randomUUID() };
  await restoreMarketingConfigVersion(db, owner.userId, id, restoreInput);
  if (action === 'pause') await sql(owner, "update bob.bob_app_installations set state='paused' where id=$1", [id]);
  if (action === 'revoke') await sql(owner, "update bob.bob_app_installations set granted_capabilities='{campaign.read}' where id=$1", [id]);
  if (action === 'delete') await sql(owner, 'delete from bob.bob_apps where id=$1', [appId]);
  for (const retry of [
    () => propose(owner, id, NARROW, 1, proposedId),
    () => apply(owner, id, proposed.proposal.id, proposed.proposal.canonicalHash, 1, appliedId),
    () => discardMarketingConfigProposal(db, owner.userId, id, discardInput),
    () => restoreMarketingConfigVersion(db, owner.userId, id, restoreInput),
  ]) await expect(retry()).rejects.toThrow(action === 'delete' ? 'marketing_installation_not_found' : action === 'pause' ? 'marketing_not_active' : 'marketing_permission_denied');
});

it('rejects tampered stored capability requirements without changing config', async () => {
  const owner = await addAccount(pg); const { id } = await activeInstallation(owner);
  const { proposal } = await propose(owner, id, NARROW);
  await sql(owner, "update bob.marketing_config_proposals set required_capabilities='{}' where id=$1", [proposal.id]);
  await expect(apply(owner, id, proposal.id, proposal.canonicalHash, 1)).rejects.toThrow('marketing_proposal_tampered');
  expect((await readMarketingConfig(db, owner.userId, id)).installation.configRevision).toBe(1);
});

it('rejects changed stored config, preview, base and package binding and revalidates restore compatibility', async () => {
  const owner = await addAccount(pg); const { id } = await activeInstallation(owner);
  const proposal = (await propose(owner, id, NARROW)).proposal;
  await sql(owner, "update bob.marketing_config_proposals set proposed_config=jsonb_set(proposed_config,'{contentGrouping}','\"pillar\"') where id=$1", [proposal.id]);
  await expect(apply(owner, id, proposal.id, proposal.canonicalHash, 1)).rejects.toThrow('marketing_proposal_tampered');
  const preview = (await propose(owner, id, NARROW)).proposal;
  await sql(owner, "update bob.marketing_config_proposals set preview_receipt=jsonb_set(preview_receipt,'{dataImpact}','\"changed\"') where id=$1", [preview.id]);
  await expect(apply(owner, id, preview.id, preview.canonicalHash, 1)).rejects.toThrow('marketing_proposal_tampered');
  for (const column of ['base_config_revision=2', "package_version='0.0.0'"]) {
    const stale = (await propose(owner, id, NARROW)).proposal;
    await sql(owner, `update bob.marketing_config_proposals set ${column} where id=$1`, [stale.id]);
    await expect(apply(owner, id, stale.id, stale.canonicalHash, 1)).rejects.toThrow('marketing_config_stale');
  }
  const valid = (await propose(owner, id, NARROW)).proposal;
  await apply(owner, id, valid.id, valid.canonicalHash, 1);
  await withAdmin(await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName), async (admin) => {
    await admin`update bob.marketing_config_versions set package_version='0.0.0' where installation_id=${id} and revision=1`;
  });
  await expect(restoreMarketingConfigVersion(db, owner.userId, id, { versionRevision: 1, expectedConfigRevision: 2, mutationId: randomUUID() })).rejects.toThrow('marketing_version_unavailable');
  expect((await readMarketingConfig(db, owner.userId, id)).installation.configRevision).toBe(2);
});

it('validates preview values against their discriminated config field', () => {
  expect(MarketingConfigChangeSchema.safeParse({ field: 'contentGrouping', before: [], after: 'channel' }).success).toBe(false);
  expect(MarketingConfigChangeSchema.safeParse({ field: 'defaultChannels', before: ['linkedin'], after: ['email'] }).success).toBe(false);
});

it('enforces expected revision on a fresh discard of an already discarded proposal', async () => {
  const owner = await addAccount(pg); const { id } = await activeInstallation(owner);
  const { proposal } = await propose(owner, id, NARROW);
  const input = { proposalId: proposal.id, expectedConfigRevision: 1, mutationId: randomUUID() };
  const original = await discardMarketingConfigProposal(db, owner.userId, id, input);
  const change = await propose(owner, id, NARROW);
  await apply(owner, id, change.proposal.id, change.proposal.canonicalHash, 1);
  expect(await discardMarketingConfigProposal(db, owner.userId, id, input)).toEqual(original);
  await expect(discardMarketingConfigProposal(db, owner.userId, id, { ...input, mutationId: randomUUID() })).rejects.toThrow('marketing_revision_conflict');
});

it('cascades installation receipts on app deletion while preserving another owner', async () => {
  const owner = await addAccount(pg); const other = await addAccount(pg);
  const installed = await activeInstallation(owner); const kept = await activeInstallation(other);
  await propose(owner, installed.id, NARROW); await propose(other, kept.id, NARROW);
  await sql(owner, 'delete from bob.bob_apps where id=$1', [installed.appId]);
  const counts = await withAdmin(await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName), async (admin) => {
    return admin<{ user_id: string; n: number }[]>`select user_id,count(*)::int as n from bob.marketing_config_operations where user_id in (${owner.userId},${other.userId}) group by user_id`;
  });
  expect(counts).toEqual([{ user_id: other.userId, n: 1 }]);
  expect((await readMarketingConfig(db, other.userId, kept.id)).pending).toHaveLength(1);
});

it('enforces 20 pending proposals and 10000 lifetime receipts, retaining exact retries at capacity', async () => {
  const owner = await addAccount(pg); const { id } = await activeInstallation(owner);
  const key = randomUUID(); const first = await propose(owner, id, NARROW, 1, key);
  for (let index = 1; index < 20; index += 1) await propose(owner, id, NARROW);
  await expect(propose(owner, id, NARROW)).rejects.toThrow('marketing_proposal_limit');
  await withAdmin(await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName), async (admin) => {
    await admin`insert into bob.marketing_config_operations(user_id,installation_id,mutation_id,fingerprint,receipt)
      select ${owner.userId},${id},gen_random_uuid(),repeat('a',64),'{}'::jsonb from generate_series(1,9980)`;
  });
  expect(await propose(owner, id, NARROW, 1, key)).toEqual(first);
  await expect(propose(owner, id, DEFAULT)).rejects.toThrow('marketing_operation_limit');
});

it('proposes a full replacement without changing the active config, and previews with no data impact', async () => {
  const owner = await addAccount(pg);
  const { id, appId } = await activeInstallation(owner);
  const { proposal, receipt } = await propose(owner, id, NARROW);
  expect(proposal).toMatchObject({ status: 'pending', baseConfigRevision: 1, dataImpact: 'none', requiresApply: true });
  expect(proposal).toHaveProperty('appUrl', `/apps/${appId}`);
  expect(proposal.changes.map((change) => change.field).sort()).toEqual(['contentGrouping', 'defaultChannels', 'visibleViews']);
  expect(receipt).toMatchObject({ kind: 'proposed', configRevision: 1, proposalId: proposal.id });
  const detail = await readMarketingConfig(db, owner.userId, id);
  expect(detail.installation).toMatchObject({ configRevision: 1, config: DEFAULT });
  expect(detail.pending.map((item) => item.id)).toEqual([proposal.id]);
});

it('applies a proposal exactly once: a new config version, replay of the original receipt, and changed intent conflicts', async () => {
  const owner = await addAccount(pg);
  const { id } = await activeInstallation(owner);
  const { proposal } = await propose(owner, id, NARROW);
  const mutationId = randomUUID();
  const first = await apply(owner, id, proposal.id, proposal.canonicalHash, 1, mutationId);
  expect(first.receipt).toMatchObject({ kind: 'applied', configRevision: 2, noChange: false });
  expect(await apply(owner, id, proposal.id, proposal.canonicalHash, 1, mutationId)).toEqual(first);
  await expect(discardMarketingConfigProposal(db, owner.userId, id, { proposalId: proposal.id, expectedConfigRevision: 2, mutationId }))
    .rejects.toThrow('marketing_mutation_conflict');
  const detail = await readMarketingConfig(db, owner.userId, id);
  expect(detail.installation).toMatchObject({ configRevision: 2, config: NARROW });
  expect(detail.versions.map((version) => version.revision)).toEqual([2, 1]);
});

it('rejects stale, tampered and cross-owner proposals before any change', async () => {
  const owner = await addAccount(pg); const stranger = await addAccount(pg);
  const { id } = await activeInstallation(owner);
  const { proposal } = await propose(owner, id, NARROW);
  await expect(apply(owner, id, proposal.id, 'f'.repeat(64), 1)).rejects.toThrow('marketing_proposal_tampered');
  await expect(apply(owner, id, proposal.id, proposal.canonicalHash, 2)).rejects.toThrow('marketing_revision_conflict');
  await expect(readMarketingConfig(db, stranger.userId, id)).rejects.toThrow('marketing_installation_not_found');
  await expect(apply(stranger, id, proposal.id, proposal.canonicalHash, 1)).rejects.toThrow('marketing_installation_not_found');
  await expect(readMarketingConfig(db, owner.userId, id)).resolves.toMatchObject({ installation: { configRevision: 1 } });
});

it('refuses proposals on a draft installation but still reads it', async () => {
  const owner = await addAccount(pg);
  const draft = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  await expect(propose(owner, draft.id, NARROW)).rejects.toThrow('marketing_not_active');
  await expect(readMarketingConfig(db, owner.userId, draft.id)).resolves.toMatchObject({ installation: { state: 'draft' } });
});

it('config apply and restore, and generic apply and undo, preserve authoritative campaign rows, receipts and grants', async () => {
  const owner = await addAccount(pg);
  const { id, appId } = await activeInstallation(owner);
  const origin = () => ({ key: randomUUID(), scope: { source: 'ui' as const } });
  const campaign = await createCampaign(db, owner.userId, id, { name: 'Beta campaign', goal: 'beta_interest', channels: ['linkedin'] }, origin());
  if (!campaign.campaignId) throw new Error('campaign missing');
  await saveCampaignSection(db, owner.userId, id, campaign.campaignId, { section: 'brief', content: 'Owner campaign brief', expectedRevision: 1 }, origin());
  const draft = await createDraft(db, owner.userId, id, { campaignId: campaign.campaignId, channel: 'linkedin', format: 'text', body: 'Draft for review', approvedAssetIds: [], claimIds: [], cta: 'none' }, origin());
  if (!draft.draftId) throw new Error('draft missing');
  const snapshot = async () => ({
    campaign: await getCampaign(db, owner.userId, id, campaign.campaignId as string),
    draft: await getDraft(db, owner.userId, id, draft.draftId as string),
    grants: await sql(owner, 'select granted_capabilities from bob.bob_app_installations where id=$1', [id]),
    receipts: await sql(owner, 'select operation_key,canonical_hash,receipt from bob.bob_app_campaign_operations where installation_id=$1 order by operation_key', [id]),
  });
  const authoritative = await snapshot();
  const { proposal } = await propose(owner, id, NARROW);
  await apply(owner, id, proposal.id, proposal.canonicalHash, 1);
  const before = (await getBobApp(db, owner.userId, appId)).revision;
  const restored = await restoreMarketingConfigVersion(db, owner.userId, id, { versionRevision: 1, expectedConfigRevision: 2, mutationId: randomUUID() });
  expect(restored.receipt).toMatchObject({ kind: 'restored', configRevision: 3 });
  expect((await readMarketingConfig(db, owner.userId, id)).installation.config).toEqual(DEFAULT);
  expect((await getBobApp(db, owner.userId, appId)).revision).toBe(before);
  expect(await snapshot()).toEqual(authoritative);
  let app = await getBobApp(db, owner.userId, appId);
  app = await mutateBobApp(db, owner.userId, appId, { operation: 'revise', definition: { ...MARKETING_WORKSPACE_DEFINITION, title: 'Owner layout' }, expectedRevision: app.revision, mutationId: randomUUID() });
  app = await mutateBobApp(db, owner.userId, appId, { operation: 'apply_revision', expectedRevision: app.revision, mutationId: randomUUID() });
  await mutateBobApp(db, owner.userId, appId, { operation: 'undo', expectedRevision: app.revision, mutationId: randomUUID() });
  expect((await readMarketingConfig(db, owner.userId, id)).installation).toMatchObject({ configRevision: 3, config: DEFAULT });
  expect(await snapshot()).toEqual(authoritative);
});

it('discards a pending proposal idempotently and never applies it', async () => {
  const owner = await addAccount(pg);
  const { id } = await activeInstallation(owner);
  const { proposal } = await propose(owner, id, NARROW);
  await discardMarketingConfigProposal(db, owner.userId, id, { proposalId: proposal.id, expectedConfigRevision: 1, mutationId: randomUUID() });
  await discardMarketingConfigProposal(db, owner.userId, id, { proposalId: proposal.id, expectedConfigRevision: 1, mutationId: randomUUID() });
  await expect(apply(owner, id, proposal.id, proposal.canonicalHash, 1)).rejects.toThrow('marketing_proposal_not_pending');
  expect((await readMarketingConfig(db, owner.userId, id)).installation.configRevision).toBe(1);
});

it('rejects strict-schema violations, publishing and grant keys, and an extension with no real dependency', async () => {
  const owner = await addAccount(pg);
  const { id } = await activeInstallation(owner);
  for (const config of [{ ...NARROW, publish: true }, { ...NARROW, grants: ['campaign.publish'] }, { ...NARROW, cadence: 'daily' }]) {
    await expect(propose(owner, id, config)).rejects.toThrow();
  }
  expect((await sql<{ count: number }>(owner, 'select count(*)::int as count from bob.marketing_config_proposals'))[0]?.count).toBe(0);
});

it('a no-op apply consumes the proposal but creates no version', async () => {
  const owner = await addAccount(pg);
  const { id } = await activeInstallation(owner);
  const { proposal } = await propose(owner, id, DEFAULT);
  const result = await apply(owner, id, proposal.id, proposal.canonicalHash, 1);
  expect(result.receipt).toMatchObject({ kind: 'applied', configRevision: 1, noChange: true });
  expect((await readMarketingConfig(db, owner.userId, id)).installation.configRevision).toBe(1);
});

it('pausing blocks a pending apply, and a generic app revise never changes the config', async () => {
  const owner = await addAccount(pg);
  const { id, appId } = await activeInstallation(owner);
  const { proposal } = await propose(owner, id, NARROW);
  const generic = await mutateBobApp(db, owner.userId, appId, { operation: 'revise', definition: MARKETING_WORKSPACE_DEFINITION, expectedRevision: (await getBobApp(db, owner.userId, appId)).revision, mutationId: randomUUID() });
  expect(generic.pendingDefinition).not.toBeNull();
  expect((await readMarketingConfig(db, owner.userId, id)).installation).toMatchObject({ configRevision: 1, config: DEFAULT });
  const installation = (await withUser(db, owner.userId, (tx) => tx.query<{ revision: number }>('select revision from bob.bob_app_installations where id=$1', [id])))[0]!;
  await changeMarketingLifecycle(db, owner.userId, id, { operation: 'pause', expectedRevision: installation.revision, mutationId: randomUUID() });
  await expect(apply(owner, id, proposal.id, proposal.canonicalHash, 1)).rejects.toThrow('marketing_not_active');
});

it('keeps the current revision and the latest 100 past versions, drops older ones explicitly, and never prunes a pending proposal', async () => {
  const owner = await addAccount(pg);
  const { id } = await activeInstallation(owner);
  const pending = await propose(owner, id, NARROW);
  for (let step = 0; step < 102; step += 1) {
    const current = (await readMarketingConfig(db, owner.userId, id)).installation.configRevision;
    // Alternates the config each step so every apply is a real change and writes exactly one version.
    const { proposal } = await propose(owner, id, current % 2 === 1 ? NARROW : DEFAULT, current);
    await apply(owner, id, proposal.id, proposal.canonicalHash, current);
  }
  const counts = await withAdmin(await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName), async (sql) => ({
    versions: (await sql<{ n: number }[]>`select count(*)::int as n from bob.marketing_config_versions where installation_id = ${id}`)[0]!.n,
    applied: (await sql<{ n: number }[]>`select count(*)::int as n from bob.marketing_config_proposals where installation_id = ${id} and status = 'applied'`)[0]!.n,
    pending: (await sql<{ n: number }[]>`select count(*)::int as n from bob.marketing_config_proposals where installation_id = ${id} and status = 'pending'`)[0]!.n,
  }));
  expect(counts).toEqual({ versions: 101, applied: 100, pending: 1 });
  const reached: number[] = [];
  let beforeRevision: number | undefined;
  do {
    const page = await readMarketingConfig(db, owner.userId, id, beforeRevision);
    reached.push(...page.versions.map((version) => version.revision));
    beforeRevision = page.nextBeforeRevision ?? undefined;
  } while (beforeRevision !== undefined);
  expect(reached).toEqual(Array.from({ length: 101 }, (_, index) => 103 - index));
  await expect(restoreMarketingConfigVersion(db, owner.userId, id, { versionRevision: 1, expectedConfigRevision: 103, mutationId: randomUUID() }))
    .rejects.toThrow('marketing_version_unavailable');
  expect(pending.proposal.status).toBe('pending');
}, 120_000);

it('erasing the account removes its config proposals, versions and operation receipts', async () => {
  const owner = await addAccount(pg);
  const { id } = await activeInstallation(owner);
  const { proposal } = await propose(owner, id, NARROW);
  await apply(owner, id, proposal.id, proposal.canonicalHash, 1);
  await eraseAccountRow(db, owner.userId, Date.now());
  const remaining = await withAdmin(await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName), async (sql) => {
    const [row] = await sql<{ n: number }[]>`select (select count(*) from bob.marketing_config_versions where user_id = ${owner.userId})
      + (select count(*) from bob.marketing_config_proposals where user_id = ${owner.userId})
      + (select count(*) from bob.marketing_config_operations where user_id = ${owner.userId}) as n`;
    return row?.n ?? -1;
  });
  expect(Number(remaining)).toBe(0);
});
