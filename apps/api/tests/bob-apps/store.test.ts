import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createBobApp, deleteBobApp, getBobApp, listBobApps, mutateBobApp, runBobAppAction } from '../../src/bob-apps/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { eraseAccountRow } from '../../src/account/erasure-store.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
const definition = { schemaVersion: 1, title: 'Things', lifecycle: 'keep', tables: [{ id: 'items', fields: [{ id: 'title', type: 'text' }] }], actions: [{ id: 'add', table: 'items', operation: 'create' }], metrics: [], views: [{ id: 'list', kind: 'table', title: 'Things', table: 'items', fields: ['title'], actions: ['add'] }] };
it('isolates accounts and makes retries atomic without losing newer data', async () => {
  const a = await addAccount(pg); const b = await addAccount(pg);
  const request = { definition, mutationId: randomUUID() };
  const app = await createBobApp(db, a.userId, request);
  expect((await createBobApp(db, a.userId, request)).id).toBe(app.id);
  expect(await listBobApps(db, b.userId)).toEqual([]);
  await expect(getBobApp(db, b.userId, app.id)).rejects.toThrow('app_not_found');
  const activate = { operation: 'activate', expectedRevision: 1, mutationId: randomUUID() };
  const active = await mutateBobApp(db, a.userId, app.id, activate);
  expect(active.revision).toBe(2);
  expect((await mutateBobApp(db, a.userId, app.id, activate)).revision).toBe(2);
  await expect(mutateBobApp(db, a.userId, app.id, { ...activate, mutationId: randomUUID() })).rejects.toThrow('app_revision_conflict');
});
it('atomically serializes concurrent edits, rejects forged writes, and deduplicates records', async () => {
  const owner = await addAccount(pg); const stranger = await addAccount(pg);
  const draft = await createBobApp(db, owner.userId, { definition, mutationId: randomUUID() });
  const app = await mutateBobApp(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: 1, mutationId: randomUUID() });
  const input = { expectedRevision: app.revision, mutationId: randomUUID(), command: { operation: 'write', action: 'add', id: 'first', values: { title: 'First' } } };
  await expect(runBobAppAction(db, stranger.userId, app.id, input)).rejects.toThrow('app_not_found');
  const other = { ...input, mutationId: randomUUID(), command: { ...input.command, id: 'second' } };
  const results = await Promise.allSettled([runBobAppAction(db, owner.userId, app.id, input), runBobAppAction(db, owner.userId, app.id, other)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const saved = await getBobApp(db, owner.userId, app.id); expect(saved.state.items).toHaveLength(1);
  const winner = results[0]?.status === 'fulfilled' ? input : other;
  expect((await runBobAppAction(db, owner.userId, app.id, winner)).state.items).toHaveLength(1);
  await expect(createBobApp(db, owner.userId, { definition, mutationId: winner.mutationId })).rejects.toThrow('app_mutation_conflict');
});
it('RLS rejects forged ownership and receipt retention stores bounded metadata', async () => {
  const owner = await addAccount(pg); const stranger = await addAccount(pg);
  await expect(withUser(db, owner.userId, (tx) => tx.query('insert into bob.bob_apps(user_id,definition,state) values($1,$2::text::jsonb,$3::text::jsonb)', [stranger.userId, JSON.stringify(definition), '{}']))).rejects.toThrow();
  await withUser(db, owner.userId, (tx) => tx.query(`insert into bob.bob_app_mutations(user_id,mutation_id,fingerprint,app_id)
    select $1,gen_random_uuid(),'seed',gen_random_uuid() from generate_series(1,1001)`, [owner.userId]));
  await createBobApp(db, owner.userId, { definition, mutationId: randomUUID() });
  const rows = await withUser(db, owner.userId, (tx) => tx.query<{ count: number }>('select count(*)::int as count from bob.bob_app_mutations'));
  expect(rows[0]?.count).toBe(1000);
  await expect(withUser(db, owner.userId, (tx) => tx.query('select bob_private.purge_bob_apps($1)', [owner.userId]))).rejects.toThrow();
});
it('duplicates independent data, paginates summaries, deletes idempotently and purges account data', async () => {
  const owner = await addAccount(pg);
  const app = await createBobApp(db, owner.userId, { definition, mutationId: randomUUID() });
  const copy = await mutateBobApp(db, owner.userId, app.id, { operation: 'duplicate', expectedRevision: 1, mutationId: randomUUID() });
  expect(copy.id).not.toBe(app.id); expect(copy.lifecycle).toBe('draft');
  const first = await listBobApps(db, owner.userId, { limit: 1 });
  const next = await listBobApps(db, owner.userId, { limit: 1, cursor: first[0]?.id });
  expect(next).toHaveLength(1); expect(next[0]?.id).not.toBe(first[0]?.id); expect(first[0]).not.toHaveProperty('state');
  const deletion = { expectedRevision: 1, mutationId: randomUUID() };
  await deleteBobApp(db, owner.userId, app.id, deletion); await deleteBobApp(db, owner.userId, app.id, deletion);
  await expect(getBobApp(db, owner.userId, app.id)).rejects.toThrow('app_not_found');
  await eraseAccountRow(db, owner.userId, Date.now());
  expect(await listBobApps(db, owner.userId)).toEqual([]);
  expect(await withUser(db, owner.userId, (tx) => tx.query('select mutation_id from bob.bob_app_mutations'))).toEqual([]);
});
it('enforces owner quota and rejects oversize or invalid initial records', async () => {
  const owner = await addAccount(pg);
  await expect(createBobApp(db, owner.userId, { definition, mutationId: randomUUID(), state: { items: [{ id: 'one', values: { unknown: 'x' } }] } })).rejects.toThrow();
  for (let index = 0; index < 30; index++) await createBobApp(db, owner.userId, { definition, mutationId: randomUUID() });
  await expect(createBobApp(db, owner.userId, { definition, mutationId: randomUUID() })).rejects.toThrow('app_quota_reached');
});
it('keeps bound tables read-only and disables scheduling on archive and restore', async () => {
  const owner = await addAccount(pg);
  const draft = await createBobApp(db, owner.userId, { definition, mutationId: randomUUID() });
  const active = await mutateBobApp(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: 1, mutationId: randomUUID() });
  await withUser(db, owner.userId, (tx) => tx.query(`insert into bob.bob_app_refresh_settings(app_id,user_id,target_table,enabled,config,next_run_at) values($1,$2,'items',true,'{}',now())`, [active.id, owner.userId]));
  await expect(runBobAppAction(db, owner.userId, active.id, { expectedRevision: active.revision, mutationId: randomUUID(), command: { operation: 'write', action: 'add', id: 'one', values: { title: 'One' } } })).rejects.toThrow('app_table_automatically_updated');
  const archived = await mutateBobApp(db, owner.userId, active.id, { operation: 'archive', expectedRevision: active.revision, mutationId: randomUUID() });
  await mutateBobApp(db, owner.userId, active.id, { operation: 'restore', expectedRevision: archived.revision, mutationId: randomUUID() });
  const settings = await withUser(db, owner.userId, (tx) => tx.query<{ enabled: boolean; next_run_at: Date | null; revision: number }>('select enabled,next_run_at,revision from bob.bob_app_refresh_settings where app_id=$1', [active.id]));
  expect(settings[0]).toMatchObject({ enabled: false, next_run_at: null, revision: 3 });
  await eraseAccountRow(db, owner.userId, Date.now());
  expect(await withUser(db, owner.userId, (tx) => tx.query('select app_id from bob.bob_app_refresh_settings'))).toEqual([]);
});
it('previews revisions, preserves records on apply and undo, rejects incompatible definitions', async () => {
  const a = await addAccount(pg);
  let app = await createBobApp(db, a.userId, { definition, state: { items: [{ id: 'one', values: { title: 'One' } }] }, mutationId: randomUUID() });
  const change = async (operation: string, extra = {}): Promise<void> => { app = await mutateBobApp(db, a.userId, app.id, { operation, expectedRevision: app.revision, mutationId: randomUUID(), ...extra }); };
  await change('activate');
  await change('revise', { definition: { ...definition, title: 'New title' } });
  expect(app.definition.title).toBe('Things');
  await change('apply_revision'); expect(app.definition.title).toBe('New title');
  await change('undo'); expect(app.definition.title).toBe('Things'); expect(app.state.items).toHaveLength(1);
  await expect(change('revise', { definition: { ...definition, tables: [{ id: 'items', fields: [{ id: 'title', type: 'number' }] }] } })).rejects.toThrow();
  await change('archive');
  await expect(runBobAppAction(db, a.userId, app.id, { expectedRevision: app.revision, mutationId: randomUUID(), command: { operation: 'write', action: 'add', id: 'two', values: { title: 'Two' } } })).rejects.toThrow('app_not_active');
});
