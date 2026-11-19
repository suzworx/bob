import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createBobApp, deleteBobApp, getBobApp, mutateBobApp, runBobAppAction } from '../../src/bob-apps/store.ts';
import { getMarketingInstallation, installMarketingPackage, listMarketingInstallations, resolveActiveMarketingInstallation, selectMarketingInstallation } from '../../src/bob-apps/marketing-install.ts';
import { addMember, createSpace, type StoredSpace } from '../../src/spaces/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

const definition = {
  schemaVersion: 1, title: 'Team checklist', lifecycle: 'keep',
  tables: [{ id: 'items', fields: [{ id: 'title', type: 'text' }] }],
  actions: [{ id: 'add', table: 'items', operation: 'create' }], metrics: [],
  views: [{ id: 'list', kind: 'checklist', title: 'Team checklist', table: 'items', fields: ['title'], actions: ['add'] }],
};

type InstallationRow = {
  id: string; kind: string; package_id: string | null; package_version: string | null;
  granted_capabilities: string[]; config: unknown;
};

async function installations(actorId: string, appId: string): Promise<InstallationRow[]> {
  return withUser(db, actorId, (tx) => tx.query<InstallationRow>('select * from bob.bob_app_installations where app_id=$1', [appId]));
}

type Team = { owner: TestAccount; admin: TestAccount; member: TestAccount; outsider: TestAccount; space: StoredSpace };

async function team(): Promise<Team> {
  const owner = await addAccount(pg);
  const admin = await addAccount(pg);
  const member = await addAccount(pg);
  const outsider = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Bob team' });
  await addMember(db, owner.userId, space.id, admin.userId, 'admin');
  await addMember(db, owner.userId, space.id, member.userId, 'member');
  return { owner, admin, member, outsider, space };
}

it('gives an ordinary personal app one durable generic installation without changing saved work', async () => {
  const owner = await addAccount(pg);
  const request = { definition, state: { items: [{ id: 'personal', values: { title: 'Only mine' } }] }, mutationId: randomUUID() };
  const app = await createBobApp(db, owner.userId, request);
  const rows = await installations(owner.userId, app.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'generic', package_id: null, package_version: null, granted_capabilities: [], config: {} });
  expect((await createBobApp(db, owner.userId, request)).id).toBe(app.id);
  expect(await installations(owner.userId, app.id)).toEqual(rows);
  expect(await getBobApp(db, owner.userId, app.id)).toMatchObject({ revision: 1, lifecycle: 'draft', definition, state: request.state });
});

it('never resolves or selects a generic installation as Marketing while a real package still works', async () => {
  const owner = await addAccount(pg);
  const app = await createBobApp(db, owner.userId, { definition, mutationId: randomUUID() });
  const rows = await installations(owner.userId, app.id);
  expect(rows).toHaveLength(1);
  const genericId = rows[0]?.id ?? '';
  await expect(getMarketingInstallation(db, owner.userId, genericId)).rejects.toThrow('marketing_installation_not_found');
  await expect(resolveActiveMarketingInstallation(db, owner.userId, genericId)).rejects.toThrow('marketing_installation_not_found');
  await expect(selectMarketingInstallation(db, owner.userId, { installationId: genericId, mutationId: randomUUID() }, owner.sessionId)).rejects.toThrow('marketing_installation_not_found');
  const marketing = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  expect(marketing.appId).not.toBe(app.id);
  expect((await listMarketingInstallations(db, owner.userId)).map((item) => item.id)).toEqual([marketing.id]);
  expect(await installations(owner.userId, app.id)).toEqual(rows);
});

it('lets a group member edit its app while personal work and outsider access remain isolated', async () => {
  const { owner, admin, member, outsider, space } = await team();
  const personalState = { items: [{ id: 'private', values: { title: 'Personal plans' } }] };
  const personal = await createBobApp(db, owner.userId, { definition, state: personalState, mutationId: randomUUID() });
  const draft = await createBobApp(db, owner.userId, { definition, spaceId: space.id, mutationId: randomUUID() });
  expect(draft).toMatchObject({ spaceId: space.id, lifecycle: 'draft' });
  const active = await mutateBobApp(db, admin.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
  expect((await getBobApp(db, member.userId, active.id)).state.items ?? []).toEqual([]);
  const input = {
    expectedRevision: active.revision, mutationId: randomUUID(),
    command: { operation: 'write', action: 'add', id: 'shared', values: { title: 'Make someone smile' } },
  };
  const changed = await runBobAppAction(db, member.userId, active.id, input);
  expect(changed.state.items).toEqual([{ id: 'shared', values: { title: 'Make someone smile' } }]);
  expect((await getBobApp(db, owner.userId, active.id)).state).toEqual(changed.state);
  await expect(getBobApp(db, outsider.userId, active.id)).rejects.toThrow('app_not_found');
  await expect(runBobAppAction(db, outsider.userId, active.id, input)).rejects.toThrow('app_not_found');
  await expect(getBobApp(db, member.userId, personal.id)).rejects.toThrow('app_not_found');
  expect((await getBobApp(db, owner.userId, personal.id)).state).toEqual(personalState);
});

it('lets members create draft work and propose changes while only admins activate, apply, archive or remove it', async () => {
  const { admin, member, space } = await team();
  const draft = await createBobApp(db, member.userId, { definition, spaceId: space.id, mutationId: randomUUID() });
  expect(draft).toMatchObject({ spaceId: space.id, lifecycle: 'draft' });
  const activation = { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() };
  await expect(mutateBobApp(db, member.userId, draft.id, activation)).rejects.toThrow();
  const active = await mutateBobApp(db, admin.userId, draft.id, { ...activation, mutationId: randomUUID() });
  const proposed = await mutateBobApp(db, member.userId, draft.id, {
    operation: 'revise', expectedRevision: active.revision, mutationId: randomUUID(), definition: { ...definition, title: 'Small joys' },
  });
  expect(proposed.definition.title).toBe('Team checklist');
  expect(proposed.pendingDefinition?.title).toBe('Small joys');
  for (const operation of ['apply_revision', 'archive']) {
    await expect(mutateBobApp(db, member.userId, draft.id, { operation, expectedRevision: proposed.revision, mutationId: randomUUID() })).rejects.toThrow();
  }
  await expect(deleteBobApp(db, member.userId, draft.id, { expectedRevision: proposed.revision, mutationId: randomUUID() })).rejects.toThrow();
  expect((await getBobApp(db, admin.userId, draft.id)).revision).toBe(proposed.revision);
  const applied = await mutateBobApp(db, admin.userId, draft.id, { operation: 'apply_revision', expectedRevision: proposed.revision, mutationId: randomUUID() });
  expect(applied.definition.title).toBe('Small joys');
  const archived = await mutateBobApp(db, admin.userId, draft.id, { operation: 'archive', expectedRevision: applied.revision, mutationId: randomUUID() });
  expect(archived.lifecycle).toBe('archived');
  await deleteBobApp(db, admin.userId, draft.id, { expectedRevision: archived.revision, mutationId: randomUUID() });
  await expect(getBobApp(db, member.userId, draft.id)).rejects.toThrow('app_not_found');
});
