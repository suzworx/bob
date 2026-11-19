import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { DEFAULT_MARKETING_CONFIG } from '../../src/bob-apps/marketing-schemas.ts';
import { MARKETING_PACKAGE_VERSION } from '../../src/bob-apps/marketing-registry.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { packing } from './fixtures.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

async function sharedPackage(actor: string): Promise<{ installation: string; member: string }> {
  const member = await addAccount(pg);
  const space = await createSpace(db, actor, { kind: 'group', name: 'Team drafts' });
  await addMember(db, actor, space.id, member.userId, 'member');
  const appId = randomUUID();
  const installation = randomUUID();
  await withUser(db, actor, async (tx) => {
    await tx.query('insert into bob.bob_apps(id,user_id,space_id,definition,state) values($1,null,$2,$3::text::jsonb,\'{}\')', [appId, space.id, JSON.stringify(packing)]);
    await tx.query(`insert into bob.bob_app_installations(id,user_id,app_id,package_id,package_version,config,granted_capabilities)
      values($1,null,$2,'bob-marketing',$3,$4::text::jsonb,array['campaign.read','campaign.draft','campaign.configure'])`, [installation, appId, MARKETING_PACKAGE_VERSION, JSON.stringify(DEFAULT_MARKETING_CONFIG)]);
  });
  return { installation, member: member.userId };
}

it('a member cannot rewrite attribution on retained shared content', async () => {
  const owner = await addAccount(pg);
  const { installation, member } = await sharedPackage(owner.userId);
  const campaign = randomUUID();
  await withUser(db, owner.userId, (tx) => tx.query(`insert into bob.bob_app_campaigns(id,user_id,installation_id,name,goal,channels,pack_revision)
    values($1,null,$2,'One small story','curiosity',array['instagram'],repeat('0',64))`, [campaign, installation]));
  await expect(withUser(db, member, (tx) => tx.query('update bob.bob_app_campaigns set created_by=$2 where id=$1', [campaign, member]))).rejects.toThrow();
  expect((await withUser(db, owner.userId, (tx) => tx.query<{ created_by: string }>('select created_by from bob.bob_app_campaigns where id=$1', [campaign])))[0]?.created_by).toBe(owner.userId);
});

it('a member can propose config but cannot fabricate applied config history', async () => {
  const owner = await addAccount(pg);
  const { installation, member } = await sharedPackage(owner.userId);
  await expect(withUser(db, member, (tx) => tx.query(`insert into bob.marketing_config_versions(user_id,installation_id,revision,config,package_version)
    values(null,$1,2,$2::text::jsonb,$3)`, [installation, JSON.stringify(DEFAULT_MARKETING_CONFIG), MARKETING_PACKAGE_VERSION]))).rejects.toThrow();
});

it('config history cannot cite a proposal from another installation owned by the same actor', async () => {
  const owner = await addAccount(pg);
  const first = await sharedPackage(owner.userId);
  const second = await sharedPackage(owner.userId);
  const proposal = randomUUID();
  await withUser(db, owner.userId, (tx) => tx.query(`insert into bob.marketing_config_proposals(id,user_id,installation_id,base_config_revision,package_version,proposed_config,canonical_hash,preview_receipt)
    values($1,null,$2,1,$3,$4::text::jsonb,repeat('0',64),'{}')`, [proposal, first.installation, MARKETING_PACKAGE_VERSION, JSON.stringify(DEFAULT_MARKETING_CONFIG)]));
  await expect(withUser(db, owner.userId, (tx) => tx.query(`insert into bob.marketing_config_versions(user_id,installation_id,revision,config,package_version,source_proposal_id)
    values(null,$1,2,$2::text::jsonb,$3,$4)`, [second.installation, JSON.stringify(DEFAULT_MARKETING_CONFIG), MARKETING_PACKAGE_VERSION, proposal]))).rejects.toThrow();
});

it('a member cannot rewrite an existing applied config history version', async () => {
  const owner = await addAccount(pg);
  const { installation, member } = await sharedPackage(owner.userId);
  await withUser(db, owner.userId, (tx) => tx.query(`insert into bob.marketing_config_versions(user_id,installation_id,revision,config,package_version)
    values(null,$1,2,$2::text::jsonb,$3)`, [installation, JSON.stringify(DEFAULT_MARKETING_CONFIG), MARKETING_PACKAGE_VERSION]));
  await expect(withUser(db, member, (tx) => tx.query('update bob.marketing_config_versions set package_version=$2 where installation_id=$1', [installation, 'forged']))).rejects.toThrow();
});
