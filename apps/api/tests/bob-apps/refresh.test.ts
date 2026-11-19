import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { createBobApp, getBobApp, mutateBobApp } from '../../src/bob-apps/store.ts';
import { configureBobAppRefresh, getBobAppRefresh, listBobAppRuns } from '../../src/bob-apps/refresh-store.ts';
import { dispatchBobAppRefreshes, tryHandleBobAppRun } from '../../src/bob-apps/refresh.ts';
import { withUser } from '../../src/platform/db/db.ts';
import { deleteBobApp } from '../../src/bob-apps/store.ts';
import { createTask } from '../../src/tasks/store.ts';
import { createSpace, addMember, transferOwnership, revokeMember } from '../../src/spaces/store.ts';
import { setToolPreference } from '../../src/tools/store.ts';

const definition = { schemaVersion: 1, title: 'Tasks dashboard', lifecycle: 'keep', tables: [{ id: 'tasks', fields: [{ id: 'title', type: 'text' }, { id: 'completed', type: 'boolean' }] }], actions: [], metrics: [{ id: 'count', table: 'tasks', operation: 'count' }], views: [{ id: 'overview', kind: 'dashboard', title: 'My tasks', metrics: ['count'] }] };
const now = Date.UTC(2026, 9, 24, 8);
describe('Bob App durable scheduled refresh', () => {
  let pg: TestDb;
  beforeAll(async () => { pg = await createTestDb(); });
  afterAll(async () => { await closeTestDb(pg); });
  async function setup(): Promise<{ owner: string; appId: string; spaceId: string }> {
    const db = asDb(pg); const owner = (await addAccount(pg)).userId;
    const space = await createSpace(db, owner, { kind: 'group', name: 'Tasks' });
    await createTask(db, owner, space.id, { title: 'Pack a smile' });
    const draft = await createBobApp(db, owner, { definition, mutationId: randomUUID() });
    const app = await mutateBobApp(db, owner, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
    await configureBobAppRefresh(db, owner, app.id, { enabled: true, consent: true, expectedRevision: app.revision, mutationId: randomUUID(), config: { source: 'tasks', spaceId: space.id, targetTable: 'tasks', schedule: { weekdays: [1,2,3,4,5,6,7], localTime: '09:00', timeZone: 'UTC' } } }, now);
    return { owner, appId: app.id, spaceId: space.id };
  }
  it('publishes without an open client and repeated delivery is harmless', async () => {
    const db = asDb(pg); const { owner, appId } = await setup();
    expect(await dispatchBobAppRefreshes(db, now)).toBeGreaterThan(0);
    const run = (await listBobAppRuns(db, owner, appId)).runs[0];
    expect(run).toBeDefined();
    await tryHandleBobAppRun(db, run?.id ?? '', new AbortController().signal, now);
    const first = await getBobApp(db, owner, appId);
    expect(first.metrics.count).toBe(1);
    expect(first.state.tasks?.[0]?.values.title).toBe('Pack a smile');
    await tryHandleBobAppRun(db, run?.id ?? '', new AbortController().signal, now);
    expect((await getBobApp(db, owner, appId)).revision).toBe(first.revision);
    expect((await getBobAppRefresh(db, owner, appId)).lastRefreshAt).toBe(now);
  });
  it('rejects another account and refuses publication after tool permission is revoked', async () => {
    const db = asDb(pg); const { owner, appId } = await setup();
    const other = (await addAccount(pg)).userId;
    await expect(getBobAppRefresh(db, other, appId)).rejects.toThrow();
    await dispatchBobAppRefreshes(db, now);
    const run = (await listBobAppRuns(db, owner, appId)).runs[0];
    await setToolPreference(db, owner, { scope: 'account', toolId: 'list_tasks', enabled: false });
    await tryHandleBobAppRun(db, run?.id ?? '', new AbortController().signal, now);
    expect((await getBobApp(db, owner, appId)).state).toEqual({});
    expect((await listBobAppRuns(db, owner, appId)).runs[0]?.status).toBe('failed');
  });
  it('does not publish a queued refresh over an archived app', async () => {
    const db = asDb(pg); const { owner, appId } = await setup();
    await dispatchBobAppRefreshes(db, now);
    const run = (await listBobAppRuns(db, owner, appId)).runs[0];
    const app = await getBobApp(db, owner, appId);
    await mutateBobApp(db, owner, appId, { operation: 'archive', expectedRevision: app.revision, mutationId: randomUUID() });
    await tryHandleBobAppRun(db, run?.id ?? '', new AbortController().signal, now);
    expect((await getBobApp(db, owner, appId)).state).toEqual({});
    expect((await listBobAppRuns(db, owner, appId)).runs[0]?.status).toBe('skipped');
  });
  it('concurrent dispatch deduplicates and bounds pending work during an outage', async () => {
    const db = asDb(pg); const { owner, appId } = await setup();
    await Promise.all([dispatchBobAppRefreshes(db, now), dispatchBobAppRefreshes(db, now)]);
    await dispatchBobAppRefreshes(db, now + 10 * 86400000);
    const runs = (await listBobAppRuns(db, owner, appId)).runs;
    expect(runs).toHaveLength(2);
    expect(runs.filter((run) => run.status === 'pending')).toHaveLength(1);
    expect(runs.filter((run) => run.status === 'failed')).toHaveLength(1);
  });
  it('configuration is revision-fenced, replay safe and pausing invalidates queued work', async () => {
    const db = asDb(pg); const { owner, appId } = await setup();
    await dispatchBobAppRefreshes(db, now);
    const run = (await listBobAppRuns(db, owner, appId)).runs[0];
    const before = await getBobApp(db, owner, appId);
    const input = { enabled: false, consent: true, expectedRevision: before.revision, mutationId: randomUUID(), config: null };
    await configureBobAppRefresh(db, owner, appId, input, now);
    const after = await getBobApp(db, owner, appId);
    expect(after.revision).toBe(before.revision + 1);
    await configureBobAppRefresh(db, owner, appId, input, now);
    expect((await getBobApp(db, owner, appId)).revision).toBe(after.revision);
    await expect(configureBobAppRefresh(db, owner, appId, { ...input, mutationId: randomUUID() }, now)).rejects.toThrow('app_revision_conflict');
    await tryHandleBobAppRun(db, run?.id ?? '', new AbortController().signal, now);
    expect((await listBobAppRuns(db, owner, appId)).runs[0]?.status).toBe('skipped');
  });
  it('a source over 500 rows fails closed and retains the last good snapshot', async () => {
    const db = asDb(pg); const { owner, appId, spaceId } = await setup();
    await dispatchBobAppRefreshes(db, now);
    await tryHandleBobAppRun(db, (await listBobAppRuns(db,owner,appId)).runs[0]?.id ?? '', new AbortController().signal, now);
    const good = await getBobApp(db,owner,appId);
    await withUser(db,owner,(tx) => tx.query(`insert into bob.tasks(space_id,title,status,order_key,revision,created_by)
      select $1,'Synthetic task','open',n::text,1,$2 from generate_series(1,500) n`,[spaceId,owner]));
    const later = now + 86400000;
    await dispatchBobAppRefreshes(db,later);
    await tryHandleBobAppRun(db,(await listBobAppRuns(db,owner,appId)).runs[0]?.id ?? '',new AbortController().signal,later);
    expect((await getBobApp(db,owner,appId)).state).toEqual(good.state);
    expect((await listBobAppRuns(db,owner,appId)).runs[0]?.status).toBe('failed');
    expect((await getBobAppRefresh(db,owner,appId)).enabled).toBe(false);
  });
  it('a schema edit fences queued work and deletion removes settings and runs', async () => {
    const db = asDb(pg); const { owner, appId } = await setup();
    await dispatchBobAppRefreshes(db,now);
    const run = (await listBobAppRuns(db,owner,appId)).runs[0];
    const app = await getBobApp(db,owner,appId);
    await mutateBobApp(db,owner,appId,{operation:'revise',definition:{...definition,title:'Changed'},expectedRevision:app.revision,mutationId:randomUUID()});
    await tryHandleBobAppRun(db,run?.id ?? '',new AbortController().signal,now);
    expect((await listBobAppRuns(db,owner,appId)).runs[0]?.status).toBe('skipped');
    const current = await getBobApp(db,owner,appId);
    await deleteBobApp(db,owner,appId,{expectedRevision:current.revision,mutationId:randomUUID()});
    expect(await tryHandleBobAppRun(db,run?.id ?? '',new AbortController().signal,now)).toBe(false);
    await expect(getBobAppRefresh(db,owner,appId)).rejects.toThrow();
  });
  it('requires explicit consent and source scope policy at configuration time', async () => {
    const db = asDb(pg); const { owner, appId,spaceId } = await setup();
    const app = await getBobApp(db,owner,appId);
    const input = {enabled:true,consent:true,expectedRevision:app.revision,mutationId:randomUUID(),config:{source:'tasks',spaceId,targetTable:'tasks',schedule:{weekdays:[1],localTime:'09:00',timeZone:'UTC'}}};
    await expect(configureBobAppRefresh(db,owner,appId,{...input,consent:false},now)).rejects.toThrow();
    await setToolPreference(db,owner,{scope:'space',scopeId:spaceId,toolId:'list_tasks',enabled:false});
    await expect(configureBobAppRefresh(db,owner,appId,input,now)).rejects.toThrow('tool_disabled');
  });  it('revoked source membership fails without publishing private source data', async () => {
    const db = asDb(pg); const { owner,appId,spaceId } = await setup();
    const successor = (await addAccount(pg)).userId;
    await addMember(db,owner,spaceId,successor,'member');
    await transferOwnership(db,owner,spaceId,successor);
    await dispatchBobAppRefreshes(db,now);
    const run = (await listBobAppRuns(db,owner,appId)).runs[0];
    await revokeMember(db,successor,spaceId,owner);
    await tryHandleBobAppRun(db,run?.id ?? '',new AbortController().signal,now);
    expect((await getBobApp(db,owner,appId)).state).toEqual({});
    expect((await listBobAppRuns(db,owner,appId)).runs[0]?.failureCode).toBe('permission_unavailable');
  });
  it('restoring and activating an archived app does not silently restore consent', async () => {
    const db = asDb(pg); const {owner,appId} = await setup();
    for (const operation of ['archive','restore','activate']) {
      const app = await getBobApp(db,owner,appId);
      await mutateBobApp(db,owner,appId,{operation,expectedRevision:app.revision,mutationId:randomUUID()});
    }
    expect((await getBobAppRefresh(db,owner,appId)).enabled).toBe(false);
    await dispatchBobAppRefreshes(db,now);
    expect((await listBobAppRuns(db,owner,appId)).runs).toHaveLength(0);
  });
  it('pause and re-enable supersede undelivered work and stale delivery cannot publish', async () => {
    const db = asDb(pg); const { owner, appId } = await setup();
    await dispatchBobAppRefreshes(db, now);
    const oldRun = (await listBobAppRuns(db, owner, appId)).runs[0];
    const config = (await getBobAppRefresh(db, owner, appId)).config;
    let app = await getBobApp(db, owner, appId);
    await configureBobAppRefresh(db, owner, appId, { enabled: false, consent: true, expectedRevision: app.revision, mutationId: randomUUID(), config: null }, now);
    app = await getBobApp(db, owner, appId);
    await configureBobAppRefresh(db, owner, appId, { enabled: true, consent: true, expectedRevision: app.revision, mutationId: randomUUID(), config }, now);
    await dispatchBobAppRefreshes(db, now);
    await tryHandleBobAppRun(db, oldRun?.id ?? '', new AbortController().signal, now);
    expect((await getBobApp(db, owner, appId)).state).toEqual({});
    const runs = (await listBobAppRuns(db, owner, appId)).runs;
    expect(runs.find((run) => run.id === oldRun?.id)?.status).toBe('skipped');
    const pending = runs.find((run) => run.status === 'pending');
    expect(pending).toBeDefined();
    await tryHandleBobAppRun(db, pending?.id ?? '', new AbortController().signal, now);
    expect((await getBobApp(db, owner, appId)).metrics.count).toBe(1);
  });
  it('invalid stored config cannot poison dispatch for another app', async () => {
    const db = asDb(pg); const invalid = await setup(); const valid = await setup();
    await withUser(db, invalid.owner, (tx) => tx.query("update bob.bob_app_refresh_settings set config='{}'::jsonb where app_id=$1", [invalid.appId]));
    await dispatchBobAppRefreshes(db, now);
    expect((await listBobAppRuns(db, valid.owner, valid.appId)).runs).toHaveLength(1);
    const settings = await withUser(db, invalid.owner, (tx) => tx.query<{enabled: boolean; last_error: string}>('select enabled,last_error from bob.bob_app_refresh_settings where app_id=$1', [invalid.appId]));
    expect(settings[0]).toMatchObject({ enabled: false, last_error: 'source_unavailable' });
  });
});
