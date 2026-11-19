import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createBobApp, getBobApp, mutateBobApp, runBobAppAction } from '../../src/bob-apps/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { upsertPreference } from '../../src/notifications/store.ts';
import { deleteAccount, type AccountDeletionDeps } from '../../src/workflows/workflow-account-deletion.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';

// Run the complete deletion workflow; suppress only external provider/device/email boundaries.
vi.mock('../../src/notifications/email-client.ts', async (original) => ({
  ...(await original<typeof import('../../src/notifications/email-client.ts')>()),
  recipientEmail: vi.fn(async () => null),
}));

let pg: TestDb;
let db: Db;
let adminUrl: string;
beforeAll(async () => {
  pg = await createTestDb(); db = asDb(pg);
  adminUrl = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
});
afterAll(async () => { if (pg) await closeTestDb(pg); });

const definition = {
  schemaVersion: 1, title: 'Shared joy', lifecycle: 'keep',
  tables: [{ id: 'items', fields: [{ id: 'title', type: 'text' }] }],
  actions: [{ id: 'add', table: 'items', operation: 'create' }], metrics: [],
  views: [{ id: 'list', kind: 'checklist', title: 'Shared joy', table: 'items', fields: ['title'], actions: ['add'] }],
};

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Pause one real SQL boundary while preserving its transaction and all database behavior. */
function gate(base: Db, match: (sql: string) => boolean, after: boolean): { db: Db; reached: Promise<void>; release: () => void } {
  const reached = signal(); const released = signal();
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
      tx<T>(work: (tx: Db) => Promise<T>): Promise<T> { return inner.tx((tx) => work(wrap(tx))); },
    };
  }
  return { db: wrap(base), reached: reached.promise, release: released.resolve };
}

function deletionDeps(database: Db): AccountDeletionDeps {
  return {
    db: database, now: () => Date.parse('2026-11-01T00:00:00Z'),
    googleConnection: { revoke: vi.fn(async () => undefined) },
    deviceSessions: { closeDevice: vi.fn() },
  };
}

async function team() {
  const owner = (await addAccount(pg)).userId;
  const actor = (await addAccount(pg)).userId;
  const teammate = (await addAccount(pg)).userId;
  const space = await createSpace(db, owner, { kind: 'group', name: 'Our team' });
  await addMember(db, owner, space.id, actor, 'member');
  await addMember(db, owner, space.id, teammate, 'member');
  const personal = await createBobApp(db, actor, { definition, mutationId: randomUUID() });
  const draft = await createBobApp(db, actor, { definition, spaceId: space.id, mutationId: randomUUID() });
  const app = await mutateBobApp(db, owner, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
  // Notification preferences belong to the person even while their authored work belongs to a space.
  for (const userId of [actor, teammate]) {
    await upsertPreference(db, userId, { type: 'reminder', muted: true });
  }
  return { owner, actor, teammate, app, personal };
}

for (const replay of [false, true]) {
  for (const eraseFirst of [false, true]) {
    it(`serializes full erasure with shared ${replay ? 'receipt replay' : 'write'} (${eraseFirst ? 'erasure' : 'action'} first)`, async () => {
      const { actor, teammate, app, personal } = await team();
      const input = {
        expectedRevision: app.revision, mutationId: randomUUID(),
        command: { operation: 'write', action: 'add', id: 'kept', values: { title: 'A little joy' } },
      };
      const cached = replay ? await runBobAppAction(db, actor, app.id, input) : null;
      const actionGate = gate(db, (sql) => sql.includes('lock_thread_audience_revision'), !eraseFirst);
      // Erasure-first holds revoked membership uncommitted; action-first stops before erasure waits for its audience lock.
      const eraseGate = gate(db, (sql) => sql.includes(eraseFirst ? 'bob_private.erase_account(' : 'bob_private.lock_account_app_audiences('), eraseFirst);
      const action = (): Promise<unknown> => runBobAppAction(actionGate.db, actor, app.id, input).catch((error: unknown) => error);
      const erase = (): Promise<unknown> => deleteAccount(deletionDeps(eraseGate.db), { userId: actor });
      const firstGate = eraseFirst ? eraseGate : actionGate;
      const secondGate = eraseFirst ? actionGate : eraseGate;
      const first = eraseFirst ? erase() : action();
      await firstGate.reached;
      const second = eraseFirst ? action() : erase();
      try {
        await secondGate.reached;
        secondGate.release(); firstGate.release();
        const outcomes = await Promise.all([first, second]);
        expect(outcomes[eraseFirst ? 0 : 1]).toEqual({ outcome: 'deleted' });
        const result = outcomes[eraseFirst ? 1 : 0];
        if (eraseFirst) expect(result).toMatchObject({ message: 'app_not_found' });
        else if (cached) expect(result).toEqual(cached);
        else expect(result).toMatchObject({ state: { items: [{ id: 'kept', values: { title: 'A little joy' } }] } });
      } finally {
        firstGate.release(); secondGate.release();
        await Promise.allSettled([first, second]);
      }

      const current = await getBobApp(db, teammate, app.id);
      const keptRows = replay || !eraseFirst ? 1 : 0;
      expect(current.state.items ?? []).toHaveLength(keptRows);
      expect(current.revision).toBe(app.revision + keptRows);
      const attribution = await withUser(db, teammate, (tx) => tx.query<{ created_by: string | null; installer: string | null }>(
        'select a.created_by,i.created_by as installer from bob.bob_apps a join bob.bob_app_installations i on i.app_id=a.id where a.id=$1', [app.id]));
      expect(attribution).toEqual([{ created_by: null, installer: null }]);
      await withAdmin(adminUrl, async (sql) => {
        const [counts] = await sql<{ personal: number; preferences: number; receipts: number; teammate: number }[]>`select
          (select count(*)::int from bob.bob_apps where id=${personal.id}) as personal,
          (select count(*)::int from bob.notification_preferences where user_id=${actor}) as preferences,
          (select count(*)::int from bob.bob_app_mutations where user_id=${actor}) as receipts,
          (select count(*)::int from bob.notification_preferences where user_id=${teammate} and muted) as teammate`;
        expect(counts).toEqual({ personal: 0, preferences: 0, receipts: 0, teammate: 1 });
      });
      await expect(runBobAppAction(db, actor, app.id, input)).rejects.toThrow('app_not_found');
      await expect(runBobAppAction(db, actor, app.id, { ...input, expectedRevision: current.revision, mutationId: randomUUID() })).rejects.toThrow('app_not_found');
      expect(await getBobApp(db, teammate, app.id)).toEqual(current);
      const continued = await runBobAppAction(db, teammate, app.id, {
        expectedRevision: current.revision, mutationId: randomUUID(),
        command: { operation: 'write', action: 'add', id: 'next', values: { title: 'Still together' } },
      });
      expect(continued.state.items).toHaveLength(keptRows + 1);
    });
  }
}
