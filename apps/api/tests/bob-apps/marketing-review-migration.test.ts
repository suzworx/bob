import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createBobApp, getBobApp } from '../../src/bob-apps/store.ts';
import { changeMarketingLifecycle, installMarketingPackage } from '../../src/bob-apps/marketing-install.ts';
import { createCampaign, createDraft, getCampaign, getDraft, saveCampaignSection, updateDraft } from '../../src/bob-apps/marketing-store.ts';
import { getMarketingReview } from '../../src/bob-apps/marketing-review-store.ts';
import { createMigratedDb } from '../support/pg-template.ts';
import { addAccount, asDb, closeTestDb, type TestDb } from '../support/test-db.ts';
import { packing } from './fixtures.ts';

const migration = '20261031221232_marketing_plan_review.sql';
let pg: TestDb;
let db: Db;
beforeAll(async () => {
  pg = await createMigratedDb({ before: migration });
  db = asDb(pg);
}, 60_000);
afterAll(async () => { if (pg) await closeTestDb(pg); });

const origin = () => ({ key: randomUUID(), scope: { source: 'ui' } });
const oldTables = ['bob_apps', 'bob_app_installations', 'bob_app_campaigns', 'bob_app_campaign_sections',
  'bob_app_campaign_drafts', 'bob_app_mutations', 'bob_app_marketing_operations', 'bob_app_campaign_operations'];

/** The single-connection migration harness prepares these identical statements before and after DDL. */
async function warmLegacyRows(actor: string): Promise<Record<string, unknown[]>> {
  return withUser(db, actor, async (tx) => {
    const result: Record<string, unknown[]> = {};
    for (const table of oldTables) result[table] = await tx.query(`select * from bob.${table} order by 1,2`);
    return result;
  });
}

/** Compare every legacy column, including timestamps, attribution, grants and receipt fingerprints. */
async function legacySnapshot(actor: string): Promise<Record<string, unknown[]>> {
  return withUser(db, actor, async (tx) => {
    const result: Record<string, unknown[]> = {};
    for (const table of oldTables) {
      result[table] = await tx.query(`select to_jsonb(t) as row from bob.${table} t order by to_jsonb(t)::text`);
    }
    return result;
  });
}

it('preserves populated private and group work exactly while adding independent review counters', async () => {
  const owner = await addAccount(pg);
  const member = await addAccount(pg);
  const outsider = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Existing team' });
  await addMember(db, owner.userId, space.id, member.userId, 'member');
  const genericInput = { definition: packing, state: { items: [{ id: 'kept', values: { label: 'Saved work', packed: false } }] }, mutationId: randomUUID() };
  const personalApp = await createBobApp(db, owner.userId, genericInput);
  const sharedApp = await createBobApp(db, member.userId, { ...genericInput, spaceId: space.id, mutationId: randomUUID() });
  const fixtures = [];
  for (const audience of [undefined, space.id]) {
    const installInput = { packageId: 'bob-marketing', ...(audience ? { spaceId: audience } : {}), mutationId: randomUUID() };
    const installation = await installMarketingPackage(db, owner.userId, installInput, owner.sessionId);
    await changeMarketingLifecycle(db, owner.userId, installation.id, {
      operation: 'activate', expectedRevision: installation.revision, mutationId: randomUUID(),
    });
    const author = audience ? member.userId : owner.userId;
    const campaignInput = { name: 'Existing week', goal: 'awareness', channels: ['linkedin'] };
    const campaignOrigin = origin();
    const campaign = await createCampaign(db, author, installation.id, campaignInput, campaignOrigin);
    if (!campaign.campaignId) throw new Error('Missing fixture campaign');
    await saveCampaignSection(db, author, installation.id, campaign.campaignId, {
      section: 'brief', content: 'The saved brief stays.', expectedRevision: 1,
    }, origin());
    const draft = await createDraft(db, author, installation.id, {
      campaignId: campaign.campaignId, channel: 'linkedin', format: 'text', body: 'Original saved caption.',
      cta: 'waitlist', approvedAssetIds: [], claimIds: ['mission.lightens-moods'],
    }, origin());
    if (!draft.draftId) throw new Error('Missing fixture draft');
    await updateDraft(db, author, installation.id, draft.draftId, {
      expectedContentRevision: 1, body: 'Existing edited caption.',
    }, origin());
    fixtures.push({ author, installation, installInput, campaignInput, campaignOrigin, campaign, draft });
  }
  const before = await legacySnapshot(owner.userId);
  const memberBefore = await legacySnapshot(member.userId);
  const warmed = await warmLegacyRows(owner.userId);
  const connectionBefore = await pg.query<{ pid: number }>('select pg_backend_pid() as pid');
  // Avoid a vacuous empty-table comparison: all eight legacy tables are populated.
  for (const rows of Object.values(before)) expect(rows.length).toBeGreaterThan(0);
  expect(await withUser(db, owner.userId, (tx) => tx.query(`select column_name from information_schema.columns
    where table_schema='bob' and table_name='bob_app_campaigns' and column_name='review_revision'`))).toEqual([]);

  await pg.exec(readFileSync(new URL(`../../../../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  const connectionAfter = await pg.query<{ pid: number }>('select pg_backend_pid() as pid');
  expect(connectionAfter.rows).toEqual(connectionBefore.rows);
  expect(await warmLegacyRows(owner.userId)).toEqual(warmed);

  expect(await legacySnapshot(owner.userId)).toEqual(before);
  expect(await legacySnapshot(member.userId)).toEqual(memberBefore);
  expect((await getBobApp(db, owner.userId, personalApp.id)).state).toEqual(genericInput.state);
  expect((await getBobApp(db, member.userId, sharedApp.id)).state).toEqual(genericInput.state);
  await expect(getBobApp(db, member.userId, personalApp.id)).rejects.toThrow();
  await expect(getBobApp(db, outsider.userId, sharedApp.id)).rejects.toThrow();

  for (const fixture of fixtures) {
    const { author, installation, installInput, campaignInput, campaignOrigin, campaign, draft } = fixture;
    const campaignId = campaign.campaignId ?? '';
    const draftId = draft.draftId ?? '';
    expect((await installMarketingPackage(db, owner.userId, installInput, owner.sessionId)).id).toBe(installation.id);
    expect(await createCampaign(db, author, installation.id, campaignInput, campaignOrigin)).toEqual(campaign);
    expect(await getCampaign(db, author, installation.id, campaignId)).toMatchObject({ revision: 2, status: 'draft' });
    expect(await getDraft(db, author, installation.id, draftId)).toMatchObject({ body: 'Existing edited caption.', contentRevision: 2, state: 'needs_check' });
    expect(await withUser(db, author, (tx) => tx.query('select review_revision,generation from bob.marketing_review_campaign_versions where installation_id=$1 and campaign_id=$2', [installation.id, campaignId])))
      .toEqual([{ review_revision: 1, generation: 0 }]);
    expect(await withUser(db, author, (tx) => tx.query('select generation from bob.marketing_review_app_versions where app_id=$1', [installation.appId])))
      .toEqual([{ generation: 0 }]);
    if (installation.spaceId) {
      expect(await getMarketingReview(db, member.userId, installation.id, campaignId)).toMatchObject({ state: 'needs_review', reviewRevision: 1, lifecycleGeneration: 0 });
    } else {
      await expect(getMarketingReview(db, owner.userId, installation.id, campaignId)).rejects.toThrow('review_not_found');
    }
    await updateDraft(db, author, installation.id, draftId, { expectedContentRevision: 2, body: 'A new edit after upgrading.' }, origin());
    expect(await withUser(db, author, (tx) => tx.query(`select v.review_revision,c.revision from bob.marketing_review_campaign_versions v
      join bob.bob_app_campaigns c on c.id=v.campaign_id and c.installation_id=v.installation_id where c.id=$1`, [campaignId])))
      .toEqual([{ review_revision: 2, revision: 2 }]);
    expect(await getDraft(db, author, installation.id, draftId)).toMatchObject({ contentRevision: 3, state: 'needs_check' });
    await changeMarketingLifecycle(db, owner.userId, installation.id, { operation: 'pause', expectedRevision: 2, mutationId: randomUUID() });
    expect(await withUser(db, author, (tx) => tx.query(`select v.generation,i.revision from bob.marketing_review_installation_versions v
      join bob.bob_app_installations i on i.id=v.installation_id where i.id=$1`, [installation.id])))
      .toEqual([{ generation: 1, revision: 3 }]);
    expect(await withUser(db, author, (tx) => tx.query('select generation from bob.marketing_review_app_versions where app_id=$1', [installation.appId])))
      .toEqual([{ generation: 0 }]); // Existing package pause deliberately leaves the app active.
  }
}, 60_000);
