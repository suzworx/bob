import { randomUUID } from 'node:crypto';
import type { Tool, ToolSet } from 'ai';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMarketingConfigTools } from '../../src/bob-apps/marketing-config-tools.ts';
import { changeMarketingLifecycle, installMarketingPackage } from '../../src/bob-apps/marketing-install.ts';
import { readMarketingConfig } from '../../src/bob-apps/marketing-config-store.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { appendMessage } from '../../src/conversations/store.ts';
import { setToolPreference } from '../../src/tools/store.ts';

let pg: TestDb;
let db: Db;
let adminUrl: string;
beforeAll(async () => {
  pg = await createTestDb(); db = asDb(pg);
  adminUrl = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
});
afterAll(async () => { if (pg) await closeTestDb(pg); });

const NARROW = { visibleViews: ['campaign', 'results'], contentGrouping: 'channel', defaultChannels: ['linkedin'] };
async function activeInstallation(owner: TestAccount): Promise<string> {
  const draft = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  return (await changeMarketingLifecycle(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() })).id;
}
/** A real conversation in a private space the owner holds, or in a pair space, or archived. Seeded as admin so the scope is set explicitly. */
async function conversation(owner: TestAccount, kind: 'private' | 'pair' = 'private', archived = false): Promise<string> {
  const spaceId = kind === 'private' ? (await ensurePrivateSpace(db, owner.userId)).id : null;
  const id = `conv_${randomUUID()}`;
  await withAdmin(adminUrl, async (sql) => {
    const space = spaceId ?? (await sql<{ id: string }[]>`insert into bob.spaces (kind,name,owner_user_id) values ('pair','Pair',null) returning id`)[0]!.id;
    await sql`insert into bob.conversations (id,user_id,space_id,title,archived_at) values (${id}, ${owner.userId}, ${space}, 'Chat', ${archived ? new Date() : null})`;
  });
  return id;
}
const toolsFor = async (owner: TestAccount, installationId: string, conversationId: string, turnId = `msg_${randomUUID()}`): Promise<ToolSet> => {
  const [owned] = await withUser(db, owner.userId, (tx) => tx.query<{ id: string }>('select id from bob.conversations where id=$1 and user_id=$2', [conversationId, owner.userId]));
  const [persisted] = await withUser(db, owner.userId, (tx) => tx.query<{ id: string }>('select id from bob.messages where id=$1', [turnId]));
  if (owned && !persisted) await appendMessage(db, owner.userId, conversationId, { id: turnId, role: 'user', parts: [{ type: 'text', text: 'Test config request' }] });
  return createMarketingConfigTools({ db, userId: owner.userId, installationId, conversationId, turnId });
};
const run = (tools: ToolSet, name: string, input: unknown = {}): Promise<unknown> =>
  Promise.resolve((tools[name] as Tool<unknown, unknown>).execute!(input, { toolCallId: 'call-1', messages: [], context: undefined }));

function latch(): { promise: Promise<void>; release(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, release: () => resolve() };
}
/** Observes the real service entering its advisory-lock query; all queries and transactions still use Postgres. */
function observeOwnerLock(database: Db, reached: () => void): Db {
  return {
    query<T>(statement: string, params?: unknown[]): Promise<T[]> {
      if (statement.includes('pg_advisory_xact_lock')) reached();
      return database.query<T>(statement, params);
    },
    tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return database.tx((tx) => fn(observeOwnerLock(tx, reached)));
    },
  };
}

it.each([false, true])('rechecks source policy under the owner lock before a queued proposal (replay=%s)', async (replay) => {
  const owner = await addAccount(pg); const installationId = await activeInstallation(owner);
  const conversationId = await conversation(owner); const turnId = `msg_${randomUUID()}`;
  const input = { expectedConfigRevision: 1, config: NARROW };
  const initialTools = await toolsFor(owner, installationId, conversationId, turnId);
  if (replay) expect(await run(initialTools, 'propose_marketing_config', input)).toMatchObject({ ok: true });
  const queued = latch(); const locked = latch(); const release = latch();
  const tools = await createMarketingConfigTools({ db: observeOwnerLock(db, queued.release), userId: owner.userId, installationId, conversationId, turnId });
  const holder = withUser(db, owner.userId, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 1225))', [owner.userId]);
    locked.release();
    await release.promise;
  });
  await locked.promise;
  const pending = run(tools, 'propose_marketing_config', input);
  try {
    // The outer execution policy read completed, and the service is now waiting for the held lock.
    await queued.promise;
    await setToolPreference(db, owner.userId, { toolId: 'propose_marketing_config', scope: 'conversation', scopeId: conversationId, enabled: false });
  } finally {
    release.release();
    await holder;
  }
  expect(await pending).toMatchObject({ ok: false, error: 'marketing_unavailable' });
  const [counts] = await withUser(db, owner.userId, (tx) => tx.query<{ proposals: number; operations: number }>(
    `select (select count(*)::int from bob.marketing_config_proposals where installation_id=$1) as proposals,
      (select count(*)::int from bob.marketing_config_operations where installation_id=$1) as operations`, [installationId]));
  expect(counts).toEqual({ proposals: replay ? 1 : 0, operations: replay ? 1 : 0 });
});

it('exposes only the read and propose tools: no model apply, restore or discard', async () => {
  const owner = await addAccount(pg);
  const tools = await toolsFor(owner, await activeInstallation(owner), await conversation(owner));
  expect(Object.keys(tools).sort()).toEqual(['propose_marketing_config', 'read_marketing_config']);
});

it('reads the current config, allowed choices, pending diff and unavailable dependencies', async () => {
  const owner = await addAccount(pg);
  const installationId = await activeInstallation(owner);
  const tools = await toolsFor(owner, installationId, await conversation(owner));
  expect(await run(tools, 'read_marketing_config')).toMatchObject({ ok: true, untrusted: true, data: {
    configRevision: 1, config: { contentGrouping: 'none' }, allowedChoices: { contentGrouping: ['none', 'channel', 'pillar'] },
    pendingDiff: [], dependencies: expect.arrayContaining([expect.objectContaining({ id: 'weekly-metrics', status: 'unavailable' })]),
  } });
});

it('proposes a full replacement with requiresApply and no data impact, and never changes the active config', async () => {
  const owner = await addAccount(pg);
  const installationId = await activeInstallation(owner);
  const tools = await toolsFor(owner, installationId, await conversation(owner));
  const result = await run(tools, 'propose_marketing_config', { expectedConfigRevision: 1, config: NARROW });
  expect(result).toMatchObject({ ok: true, data: { requiresApply: true, dataImpact: 'none', status: 'pending' } });
  expect((await readMarketingConfig(db, owner.userId, installationId)).installation.configRevision).toBe(1);
});

it('replays the same intent in the same turn and never duplicates the proposal', async () => {
  const owner = await addAccount(pg);
  const installationId = await activeInstallation(owner);
  const conversationId = await conversation(owner);
  const turnId = randomUUID();
  const first = await run(await toolsFor(owner, installationId, conversationId, turnId), 'propose_marketing_config', { expectedConfigRevision: 1, config: NARROW });
  const second = await run(await toolsFor(owner, installationId, conversationId, turnId), 'propose_marketing_config', { expectedConfigRevision: 1, config: NARROW });
  expect(second).toEqual(first);
  expect((await readMarketingConfig(db, owner.userId, installationId)).pending).toHaveLength(1);
});

it('requires a persisted live user anchor in this owner conversation on every execution', async () => {
  const owner = await addAccount(pg); const other = await addAccount(pg);
  const installationId = await activeInstallation(owner); const conversationId = await conversation(owner);
  const foreignConversation = await conversation(other); const otherConversation = await conversation(owner);
  const foreignAnchor = `msg_${randomUUID()}`; const otherAnchor = `msg_${randomUUID()}`;
  await appendMessage(db, other.userId, foreignConversation, { id: foreignAnchor, role: 'user', parts: [{ type: 'text', text: 'Other request' }] });
  await appendMessage(db, owner.userId, otherConversation, { id: otherAnchor, role: 'user', parts: [{ type: 'text', text: 'Other request' }] });
  for (const turnId of [`msg_${randomUUID()}`, foreignAnchor, otherAnchor]) {
    const tools = await createMarketingConfigTools({ db, userId: owner.userId, installationId, conversationId, turnId });
    expect(tools).toEqual({});
  }
  const anchor = `msg_${randomUUID()}`;
  const tools = await toolsFor(owner, installationId, conversationId, anchor);
  expect(await run(tools, 'propose_marketing_config', { expectedConfigRevision: 1, config: NARROW })).toMatchObject({ ok: true });
  await withUser(db, owner.userId, (tx) => tx.query('update bob.messages set tombstoned_at=now() where id=$1', [anchor]));
  expect(await run(tools, 'propose_marketing_config', { expectedConfigRevision: 1, config: NARROW })).toMatchObject({ ok: false });
  expect(await createMarketingConfigTools({ db, userId: owner.userId, installationId, conversationId, turnId: anchor })).toEqual({});
  expect((await readMarketingConfig(db, owner.userId, installationId)).pending).toHaveLength(1);
  const wrongAuthor = `msg_${randomUUID()}`;
  const authorTools = await toolsFor(owner, installationId, conversationId, wrongAuthor);
  await withAdmin(adminUrl, async (admin) => { await admin`update bob.messages set author_user_id=${other.userId} where id=${wrongAuthor}`; });
  expect(await run(authorTools, 'propose_marketing_config', { expectedConfigRevision: 1, config: NARROW })).toMatchObject({ ok: false });
  expect(await createMarketingConfigTools({ db, userId: owner.userId, installationId, conversationId, turnId: wrongAuthor })).toEqual({});
});

it('refuses pair, archived and other-owner conversations and disabled policy before any write', async () => {
  const owner = await addAccount(pg); const stranger = await addAccount(pg);
  const installationId = await activeInstallation(owner);
  for (const conversationId of [await conversation(owner, 'pair'), await conversation(owner, 'private', true), await conversation(stranger)]) {
    expect(await toolsFor(owner, installationId, conversationId)).toEqual({});
  }
  const tools = await toolsFor(owner, installationId, await conversation(owner));
  await setToolPreference(db, owner.userId, { toolId: 'read_marketing_config', scope: 'account', enabled: false });
  expect(await run(tools, 'read_marketing_config')).toEqual({ ok: false, error: 'marketing_unavailable' });
  expect((await readMarketingConfig(db, owner.userId, installationId)).pending).toEqual([]);
});

it('offers only granted tools and rechecks grants on an already offered proposal', async () => {
  const owner = await addAccount(pg); const installationId = await activeInstallation(owner);
  const conversationId = await conversation(owner); const anchor = `msg_${randomUUID()}`;
  const offered = await toolsFor(owner, installationId, conversationId, anchor);
  await withUser(db, owner.userId, (tx) => tx.query("update bob.bob_app_installations set granted_capabilities='{campaign.read}' where id=$1", [installationId]));
  expect(Object.keys(await createMarketingConfigTools({ db, userId: owner.userId, installationId, conversationId, turnId: anchor }))).toEqual(['read_marketing_config']);
  expect(await run(offered, 'propose_marketing_config', { expectedConfigRevision: 1, config: NARROW })).toMatchObject({ ok: false });
  await withUser(db, owner.userId, (tx) => tx.query("update bob.bob_app_installations set granted_capabilities='{}' where id=$1", [installationId]));
  expect(await createMarketingConfigTools({ db, userId: owner.userId, installationId, conversationId, turnId: anchor })).toEqual({});
});

it('filters source policies at account, private space and conversation scopes before offering tools', async () => {
  const owner = await addAccount(pg); const installationId = await activeInstallation(owner);
  const conversationId = await conversation(owner); const anchor = `msg_${randomUUID()}`;
  await toolsFor(owner, installationId, conversationId, anchor);
  const current = () => createMarketingConfigTools({ db, userId: owner.userId, installationId, conversationId, turnId: anchor });
  await setToolPreference(db, owner.userId, { toolId: 'read_marketing_config', scope: 'account', enabled: false });
  expect(Object.keys(await current())).toEqual(['propose_marketing_config']);
  await setToolPreference(db, owner.userId, { toolId: 'read_marketing_config', scope: 'account', enabled: null });
  const space = await ensurePrivateSpace(db, owner.userId);
  await setToolPreference(db, owner.userId, { toolId: 'propose_marketing_config', scope: 'space', scopeId: space.id, enabled: false });
  expect(Object.keys(await current())).toEqual(['read_marketing_config']);
  await setToolPreference(db, owner.userId, { toolId: 'read_marketing_config', scope: 'conversation', scopeId: conversationId, enabled: false });
  expect(await current()).toEqual({});
  await setToolPreference(db, owner.userId, { toolId: 'propose_marketing_config', scope: 'space', scopeId: space.id, enabled: null });
  expect(Object.keys(await current())).toEqual(['propose_marketing_config']);
});

it('offers nothing for a paused or deleted installation', async () => {
  const owner = await addAccount(pg); const installationId = await activeInstallation(owner);
  const conversationId = await conversation(owner); const anchor = `msg_${randomUUID()}`;
  await toolsFor(owner, installationId, conversationId, anchor);
  await withUser(db, owner.userId, (tx) => tx.query("update bob.bob_app_installations set state='paused' where id=$1", [installationId]));
  const current = () => createMarketingConfigTools({ db, userId: owner.userId, installationId, conversationId, turnId: anchor });
  expect(await current()).toEqual({});
  await withUser(db, owner.userId, (tx) => tx.query('delete from bob.bob_apps where id in (select app_id from bob.bob_app_installations where id=$1)', [installationId]));
  expect(await current()).toEqual({});
});

it('refuses a model-supplied key that is not a config field, and extension requests as unavailable', async () => {
  const owner = await addAccount(pg);
  const installationId = await activeInstallation(owner);
  const tools = await toolsFor(owner, installationId, await conversation(owner));
  expect(await run(tools, 'propose_marketing_config', { expectedConfigRevision: 1, config: { ...NARROW, grants: ['campaign.publish'] } })).toMatchObject({ ok: false, error: 'invalid_marketing_config' });
  expect(await run(tools, 'propose_marketing_config', { expectedConfigRevision: 1, config: { ...NARROW, cadence: 'daily' } })).toMatchObject({ ok: false, error: 'marketing_extension_unavailable' });
  expect((await readMarketingConfig(db, owner.userId, installationId)).pending).toEqual([]);
});
