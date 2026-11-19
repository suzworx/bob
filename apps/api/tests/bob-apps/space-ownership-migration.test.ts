import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMigratedDb } from '../support/pg-template.ts';
import { addAccount, asDb, closeTestDb, type TestDb } from '../support/test-db.ts';
import { asServer, withUser, type Db } from '../../src/platform/db/db.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';
import { createBobApp, deleteBobApp, getBobApp, mutateBobApp } from '../../src/bob-apps/store.ts';
import { installMarketingPackage } from '../../src/bob-apps/marketing-install.ts';
import { DEFAULT_MARKETING_CONFIG } from '../../src/bob-apps/marketing-schemas.ts';
import { MARKETING_BASELINE_GRANTS, MARKETING_PACKAGE_VERSION, MARKETING_WORKSPACE_DEFINITION } from '../../src/bob-apps/marketing-registry.ts';
import { packing } from './fixtures.ts';

const migration = '20261031191847_space_owned_bob_apps.sql';
let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createMigratedDb({ before: migration }); db = asDb(pg); }, 60_000);
afterAll(async () => { if (pg) await closeTestDb(pg); });
const hash = (input: unknown): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');

async function snapshot(owner: string): Promise<unknown> {
  return withUser(db, owner, async (tx) => {
    const tables: Array<[string, string]> = [
      ['bob_apps', 'id,user_id,lifecycle,revision,definition,state,pending_definition,undo_definition'],
      ['bob_app_installations', 'id,user_id,app_id,package_id,package_version,state,granted_capabilities,revision,config_revision,config'],
      ['bob_app_campaigns', 'id,user_id,installation_id,name,goal,channels,status,revision,pack_revision'],
      ['bob_app_campaign_sections', 'user_id,installation_id,campaign_id,section,content'],
      ['bob_app_campaign_drafts', 'id,user_id,installation_id,campaign_id,channel,format,body,content_revision'],
      ['marketing_config_proposals', 'id,user_id,installation_id,base_config_revision,proposed_config,canonical_hash,status'],
      ['marketing_config_versions', 'user_id,installation_id,revision,config,source_proposal_id'],
      ['bob_app_mutations', 'user_id,mutation_id,fingerprint,app_id'],
      ['bob_app_marketing_operations', 'user_id,mutation_id,fingerprint,installation_id'],
      ['bob_app_selection', 'user_id,installation_id,expires_at'],
      ['bob_app_campaign_selection', 'user_id,installation_id,conversation_id,campaign_id,selected_at'],
      ['bob_app_campaign_operations', 'user_id,installation_id,operation_key,canonical_hash,receipt'],
      ['marketing_config_operations', 'user_id,installation_id,mutation_id,fingerprint,receipt'],
      ['bob_app_refresh_settings', 'app_id,user_id,enabled,revision,config,target_table,next_run_at'],
      ['bob_app_runs', 'id,app_id,user_id,config_revision,app_revision,scheduled_at,completed_at,status,failure_code'],
    ];
    const result: Record<string, unknown> = {};
    for (const [table, columns] of tables) {
      result[table] = await tx.query(`select ${columns} from bob.${table} order by 1,2`);
    }
    return result;
  });
}

it('preserves populated personal data, package identity and old receipt fingerprints while backfilling generic identity', async () => {
  const owner = await addAccount(pg);
  const personalSpace = await ensurePrivateSpace(db, owner.userId);
  const conversation = await withUser(db, owner.userId, (tx) => createConversation(tx, owner.userId, 'An existing campaign'));
  const appId = randomUUID();
  const copyId = randomUUID();
  const deletedId = randomUUID();
  const state = { items: [{ id: 'original', values: { label: 'Keep this saved work', packed: false } }] };
  // This is the pre-migration wire order and fingerprint recipe, independently
  // recorded here without calling the new store/schema to seed the old rows.
  const create = { definition: packing, state, mutationId: randomUUID() };
  const duplicate = { expectedRevision: 7, mutationId: randomUUID(), operation: 'duplicate' };
  const deletion = { expectedRevision: 1, mutationId: randomUUID() };
  const refreshAppId = randomUUID();
  const scheduledAt = new Date('2030-06-10T10:00:00Z');
  const refreshDefinition = {
    schemaVersion: 1, title: 'Personal tasks', lifecycle: 'keep',
    tables: [{ id: 'tasks', fields: [{ id: 'title', type: 'text' }, { id: 'completed', type: 'boolean' }] }],
    actions: [], metrics: [{ id: 'count', table: 'tasks', operation: 'count' }],
    views: [{ id: 'overview', kind: 'dashboard', title: 'My tasks', metrics: ['count'] }],
  };
  const refreshConfig = { source: 'tasks', spaceId: personalSpace.id, targetTable: 'tasks', schedule: { weekdays: [1,2,3,4,5,6,7], localTime: '10:00', timeZone: 'UTC' } };
  await withUser(db, owner.userId, async (tx) => {
    for (const id of [appId, copyId]) await tx.query(`insert into bob.bob_apps(id,user_id,definition,state,revision)
      values($1,$2,$3::text::jsonb,$4::text::jsonb,7)`, [id, owner.userId, JSON.stringify(packing), JSON.stringify(state)]);
    for (const [key, digest, result] of [[create.mutationId, hash(create), appId], [duplicate.mutationId, hash({ id: appId, input: duplicate }), copyId], [deletion.mutationId, hash({ id: deletedId, delete: deletion }), deletedId]]) {
      await tx.query('insert into bob.bob_app_mutations(user_id,mutation_id,fingerprint,app_id) values($1,$2,$3,$4)', [owner.userId, key, digest, result]);
    }
    await tx.query(`insert into bob.bob_app_refresh_settings(app_id,user_id,enabled,revision,config,target_table,next_run_at)
      values($1,$2,false,3,'{}','items',null)`, [appId, owner.userId]);
    await tx.query(`insert into bob.bob_apps(id,user_id,definition,state,lifecycle,revision)
      values($1,$2,$3::text::jsonb,'{}','active',5)`, [refreshAppId, owner.userId, JSON.stringify(refreshDefinition)]);
    await tx.query(`insert into bob.bob_app_refresh_settings(app_id,user_id,enabled,revision,config,target_table,next_run_at)
      values($1,$2,true,3,$3::text::jsonb,'tasks',$4)`, [refreshAppId, owner.userId, JSON.stringify(refreshConfig), scheduledAt]);
  });
  const [dispatched] = await asServer(db, (tx) => tx.query<{ run: string | null }>('select bob_private.bob_app_dispatch($1,3,$2,$3) as run', [refreshAppId, new Date(scheduledAt.getTime() + 86_400_000), scheduledAt]));
  expect(dispatched?.run).toEqual(expect.any(String));
  const installed = { id: randomUUID(), appId: randomUUID() };
  const installInput = { packageId: 'bob-marketing', mutationId: randomUUID() };
  // Seed the exact legacy columns, independent of today's service queries.
  await withUser(db, owner.userId, async (tx) => {
    await tx.query("insert into bob.bob_apps(id,user_id,definition,state) values($1,$2,$3::text::jsonb,'{}')", [installed.appId, owner.userId, JSON.stringify(MARKETING_WORKSPACE_DEFINITION)]);
    await tx.query(`insert into bob.bob_app_installations(id,user_id,app_id,package_id,package_version,granted_capabilities,config)
      values($1,$2,$3,'bob-marketing',$4,$5::text[],$6::text::jsonb)`, [installed.id, owner.userId, installed.appId, MARKETING_PACKAGE_VERSION, `{${MARKETING_BASELINE_GRANTS.join(',')}}`, JSON.stringify(DEFAULT_MARKETING_CONFIG)]);
    await tx.query('insert into bob.bob_app_marketing_operations(user_id,mutation_id,fingerprint,installation_id) values($1,$2,$3,$4)', [owner.userId, installInput.mutationId, hash(installInput), installed.id]);
    await tx.query("update bob.bob_apps set lifecycle='active',revision=2 where id=$1", [installed.appId]);
    await tx.query("update bob.bob_app_installations set state='active',revision=2 where id=$1", [installed.id]);
    await tx.query("insert into bob.bob_app_selection(user_id,installation_id,expires_at) values($1,$2,'2030-06-11T10:00:00Z')", [owner.userId, installed.id]);
  });
  const campaign = randomUUID();
  const proposal = randomUUID();
  await withUser(db, owner.userId, async (tx) => {
    await tx.query(`insert into bob.bob_app_campaigns(id,user_id,installation_id,name,goal,channels,pack_revision,revision)
      values($1,$2,$3,'An existing story','curiosity',array['instagram'],repeat('a',64),4)`, [campaign, owner.userId, installed.id]);
    await tx.query('insert into bob.bob_app_campaign_selection(user_id,installation_id,conversation_id,campaign_id) values($1,$2,$3,$4)', [owner.userId, installed.id, conversation.id, campaign]);
    await tx.query(`insert into bob.bob_app_campaign_sections(user_id,installation_id,campaign_id,section,content)
      values($1,$2,$3,'brief','The existing story stays.')`, [owner.userId, installed.id, campaign]);
    await tx.query(`insert into bob.bob_app_campaign_drafts(user_id,installation_id,campaign_id,channel,format,body,pack_revision,content_revision)
      values($1,$2,$3,'instagram','image','Keep this draft.',repeat('a',64),3)`, [owner.userId, installed.id, campaign]);
    await tx.query(`insert into bob.marketing_config_proposals(id,user_id,installation_id,base_config_revision,package_version,proposed_config,canonical_hash,preview_receipt)
      values($1,$2,$3,1,$4,$5::text::jsonb,repeat('a',64),'{}')`, [proposal, owner.userId, installed.id, MARKETING_PACKAGE_VERSION, JSON.stringify(DEFAULT_MARKETING_CONFIG)]);
    await tx.query(`insert into bob.marketing_config_versions(user_id,installation_id,revision,config,package_version,source_proposal_id)
      values($1,$2,1,$3::text::jsonb,$4,$5)`, [owner.userId, installed.id, JSON.stringify(DEFAULT_MARKETING_CONFIG), MARKETING_PACKAGE_VERSION, proposal]);
    await tx.query(`insert into bob.bob_app_campaign_operations(user_id,installation_id,operation_key,canonical_hash,receipt)
      values($1,$2,$3,repeat('a',64),'{}')`, [owner.userId, installed.id, randomUUID()]);
    await tx.query(`insert into bob.marketing_config_operations(user_id,installation_id,mutation_id,fingerprint,receipt)
      values($1,$2,$3,repeat('a',64),'{}')`, [owner.userId, installed.id, randomUUID()]);
  });
  const before = await snapshot(owner.userId);
  await pg.exec(readFileSync(new URL(`../../../../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  const after = await snapshot(owner.userId) as Record<string, unknown[]>;
  const previous = before as Record<string, unknown[]>;
  // Only new generic installation rows are additive; all old package rows stay exact.
  expect(after.bob_app_installations?.filter((row) => (row as { id: string }).id === installed.id)).toEqual(previous.bob_app_installations);
  const beforeData = Object.fromEntries(Object.entries(previous).filter(([table]) => table !== 'bob_app_installations'));
  const afterData = Object.fromEntries(Object.entries(after).filter(([table]) => table !== 'bob_app_installations'));
  expect(afterData).toEqual(beforeData);
  await pg.exec(readFileSync(new URL('../../../../supabase/migrations/20261031194551_space_app_runtime.sql', import.meta.url), 'utf8'));
  expect(await snapshot(owner.userId)).toEqual(after);
  expect((await installMarketingPackage(db, owner.userId, installInput, owner.sessionId)).id).toBe(installed.id);
  expect(await withUser(db, owner.userId, (tx) => tx.query('select app_id,kind,package_id,granted_capabilities from bob.bob_app_installations where app_id=$1', [appId]))).toEqual([{ app_id: appId, kind: 'generic', package_id: null, granted_capabilities: [] }]);
  expect((await createBobApp(db, owner.userId, create)).id).toBe(appId);
  expect((await mutateBobApp(db, owner.userId, appId, duplicate)).id).toBe(copyId);
  await deleteBobApp(db, owner.userId, deletedId, deletion);
  expect((await getBobApp(db, owner.userId, appId)).state).toEqual(state);

  // A still-running old server writes no installation. The deferred trigger
  // supplies one at commit, while real package installation remains atomic.
  const legacyId = randomUUID();
  await withUser(db, owner.userId, (tx) => tx.query('insert into bob.bob_apps(id,user_id,definition,state) values($1,$2,$3::text::jsonb,\'{}\')', [legacyId, owner.userId, JSON.stringify(packing)]));
  expect(await withUser(db, owner.userId, (tx) => tx.query('select kind from bob.bob_app_installations where app_id=$1', [legacyId]))).toEqual([{ kind: 'generic' }]);
}, 60_000);
