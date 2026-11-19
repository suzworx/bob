import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createBobApp, deleteBobApp, getBobApp, mutateBobApp, runBobAppAction } from '../../src/bob-apps/store.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { configureBobAppRefresh, getBobAppRefresh, listBobAppRuns } from '../../src/bob-apps/refresh-store.ts';
import { setMemberRole } from '../../src/spaces/member-roles.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
const definition = {
  schemaVersion: 1, title: 'Together', lifecycle: 'keep',
  tables: [{ id: 'items', fields: [{ id: 'title', type: 'text' }] }],
  actions: [{ id: 'add', table: 'items', operation: 'create' }], metrics: [],
  views: [{ id: 'list', kind: 'checklist', title: 'Together', table: 'items', fields: ['title'], actions: ['add'] }],
};

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Pause at an actual SQL lock boundary; no scheduling sleeps or timing guesses. */
function gate(base: Db, match: (sql: string) => boolean, after: boolean): { db: Db; reached: Promise<void>; release: () => void } {
  const reached = signal();
  const released = signal();
  let used = false;
  function wrap(inner: Db): Db {
    return {
      async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        if (used || !match(sql)) return inner.query<T>(sql, params);
        used = true;
        const rows = after ? await inner.query<T>(sql, params) : undefined;
        reached.resolve();
        await released.promise;
        return rows ?? inner.query<T>(sql, params);
      },
      tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> { return inner.tx((tx) => fn(wrap(tx))); },
    };
  }
  return { db: wrap(base), reached: reached.promise, release: released.resolve };
}

async function team(): Promise<{ owner: string; member: string; app: Awaited<ReturnType<typeof createBobApp>>; spaceId: string }> {
  const owner = (await addAccount(pg)).userId;
  const member = (await addAccount(pg)).userId;
  const space = await createSpace(db, owner, { kind: 'group', name: 'Team' });
  await addMember(db, owner, space.id, member, 'admin');
  const draft = await createBobApp(db, owner, { definition, spaceId: space.id, mutationId: randomUUID() });
  const app = await mutateBobApp(db, owner, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
  return { owner, member, app, spaceId: space.id };
}

for (const removalFirst of [false, true]) {
  it(`serializes record writes with membership removal (${removalFirst ? 'removal' : 'write'} first)`, async () => {
    const { owner, member, app, spaceId } = await team();
    const writeGate = gate(db, (sql) => sql.includes('lock_thread_audience_revision'), !removalFirst);
    const removeGate = gate(db, (sql) => sql.includes('bump_membership_revision'), removalFirst);
    const input = { expectedRevision: app.revision, mutationId: randomUUID(), command: { operation: 'write', action: 'add', id: 'one', values: { title: 'A little joy' } } };
    const write = (): Promise<unknown> => runBobAppAction(writeGate.db, member, app.id, input).then((value) => value, (error: unknown) => error);
    const remove = (): Promise<void> => revokeMember(removeGate.db, owner, spaceId, member);
    const first = removalFirst ? remove() : write();
    const firstGate = removalFirst ? removeGate : writeGate;
    const secondGate = removalFirst ? writeGate : removeGate;
    await firstGate.reached;
    const second = removalFirst ? write() : remove();
    try {
      await secondGate.reached;
      secondGate.release();
      firstGate.release();
      const results = await Promise.all([first, second]);
      const outcome = results[removalFirst ? 1 : 0];
      if (removalFirst) expect(outcome).toMatchObject({ message: 'app_not_found' });
      else expect(outcome).toMatchObject({ state: { items: [{ id: 'one', values: { title: 'A little joy' } }] } });
      expect((await getBobApp(db, owner, app.id)).state.items ?? []).toHaveLength(removalFirst ? 0 : 1);
      await expect(runBobAppAction(db, member, app.id, input)).rejects.toThrow('app_not_found');
    } finally { firstGate.release(); secondGate.release(); await Promise.allSettled([first, second]); }
  });
}

it('rechecks admin authority after a waiting apply and before a deleted-app retry', async () => {
  const { owner, member, app, spaceId } = await team();
  const proposed = await mutateBobApp(db, member, app.id, { operation: 'revise', expectedRevision: app.revision, mutationId: randomUUID(), definition: { ...definition, title: 'Small joys' } });
  const demoteGate = gate(db, (sql) => sql.includes('FROM bob.spaces s') && sql.includes('FOR UPDATE'), true);
  const applyGate = gate(db, (sql) => sql.includes('lock_thread_audience_revision'), false);
  const demote = setMemberRole(demoteGate.db, owner, spaceId, member, 'member');
  await demoteGate.reached;
  const apply = mutateBobApp(applyGate.db, member, app.id, { operation: 'apply_revision', expectedRevision: proposed.revision, mutationId: randomUUID() }).catch((error: unknown) => error);
  try {
    await applyGate.reached;
    applyGate.release(); demoteGate.release();
    await demote;
    expect(await apply).toMatchObject({ message: 'app_management_required' });
  } finally { applyGate.release(); demoteGate.release(); await Promise.allSettled([apply, demote]); }
  await setMemberRole(db, owner, spaceId, member, 'admin');
  const deletion = { expectedRevision: proposed.revision, mutationId: randomUUID() };
  await deleteBobApp(db, member, app.id, deletion);
  await deleteBobApp(db, member, app.id, deletion);
  await setMemberRole(db, owner, spaceId, member, 'member');
  await expect(deleteBobApp(db, member, app.id, deletion)).rejects.toThrow('app_management_required');
  await revokeMember(db, owner, spaceId, member);
  await expect(deleteBobApp(db, member, app.id, deletion)).rejects.toThrow('app_not_found');
});

it('keeps same mutation UUID receipts separate between installations and duplicates only once', async () => {
  const { owner, app, spaceId } = await team();
  const second = await createBobApp(db, owner, { definition, spaceId, mutationId: randomUUID() });
  const mutationId = randomUUID();
  const copyInput = { operation: 'duplicate', expectedRevision: app.revision, mutationId };
  const copy = await mutateBobApp(db, owner, app.id, copyInput);
  expect((await mutateBobApp(db, owner, app.id, copyInput)).id).toBe(copy.id);
  const activated = await mutateBobApp(db, owner, second.id, { operation: 'activate', expectedRevision: second.revision, mutationId });
  expect(activated.id).toBe(second.id);
  expect(activated.lifecycle).toBe('active');
});

it('finishes an authorized apply before a waiting admin demotion', async () => {
  const { owner, member, app, spaceId } = await team();
  const proposed = await mutateBobApp(db, member, app.id, { operation: 'revise', expectedRevision: app.revision, mutationId: randomUUID(), definition: { ...definition, title: 'Small joys' } });
  const applyGate = gate(db, (sql) => sql.includes('lock_thread_audience_revision'), true);
  const demoteGate = gate(db, (sql) => sql.includes('FROM bob.spaces s') && sql.includes('FOR UPDATE'), false);
  const apply = mutateBobApp(applyGate.db, member, app.id, { operation: 'apply_revision', expectedRevision: proposed.revision, mutationId: randomUUID() });
  await applyGate.reached;
  const demote = setMemberRole(demoteGate.db, owner, spaceId, member, 'member');
  try {
    await demoteGate.reached;
    demoteGate.release(); applyGate.release();
    expect((await apply).definition.title).toBe('Small joys');
    await demote;
    const current = await getBobApp(db, member, app.id);
    await expect(mutateBobApp(db, member, app.id, { operation: 'pause', expectedRevision: current.revision, mutationId: randomUUID() })).rejects.toThrow('app_management_required');
  } finally { applyGate.release(); demoteGate.release(); await Promise.allSettled([apply, demote]); }
});

it('keeps shared apps out of personal automatic refresh and lets admins pause and resume', async () => {
  const { owner, member, app, spaceId } = await team();
  await expect(configureBobAppRefresh(db, owner, app.id, { enabled: false, consent: true, expectedRevision: app.revision, mutationId: randomUUID(), config: null })).rejects.toThrow('shared_app_refresh_unavailable');
  expect(await getBobAppRefresh(db, member, app.id)).toMatchObject({ enabled: false });
  expect((await listBobAppRuns(db, member, app.id)).runs).toEqual([]);
  const paused = await mutateBobApp(db, member, app.id, { operation: 'pause', expectedRevision: app.revision, mutationId: randomUUID() });
  expect(paused.lifecycle).toBe('paused');
  const resumed = await mutateBobApp(db, owner, app.id, { operation: 'resume', expectedRevision: paused.revision, mutationId: randomUUID() });
  expect(resumed.lifecycle).toBe('active');
  await setMemberRole(db, owner, spaceId, member, 'member');
  await expect(mutateBobApp(db, member, app.id, { operation: 'pause', expectedRevision: resumed.revision, mutationId: randomUUID() })).rejects.toThrow('app_management_required');
});
