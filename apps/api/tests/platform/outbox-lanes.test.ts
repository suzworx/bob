/**
 * Outbox lanes (S1 of #1322): several workers over one outbox, each claiming
 * only its own event types. createOutboxLanes derives the DEFAULT lane's
 * exclude from the other lanes' handler keys, so no event type falls between
 * lanes, and it refuses two lanes registering the same event type (and a
 * filtered lane claiming an event type it has no handler for). The db-backed
 * cases run against a per-file template copy (createTestDb), the same pattern
 * as outbox-worker.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import { createOutboxLanes } from '../../src/platform/outbox/lanes.ts';
import type { OutboxHandler } from '../../src/platform/outbox/worker.ts';
import type { StoredOutboxRow } from '../../src/platform/outbox/store.ts';
import { enqueueOutbox, pendingOutboxCount } from '../../src/platform/outbox/store.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

// bob.outbox sits behind FORCE RLS with zero policies, so row cleanup and
// the raw column assertions run on the admin connection (pg-template.ts), the
// same seam outbox-worker.test.ts uses.
async function outboxAdminQuery<T>(sql: string): Promise<T[]> {
  const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
  return withAdmin(url, (admin) => admin.unsafe<T[]>(sql));
}

async function resetOutbox(): Promise<void> {
  await outboxAdminQuery('DELETE FROM bob.outbox');
}

/** True when `promise` settles within `ms` (the absence check for "stop() has
 *  not resolved yet"; see the same helper in outbox-worker.test.ts). */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true, () => true), bound]);
  } finally {
    clearTimeout(timer);
  }
}

beforeEach(async () => {
  await resetOutbox();
});

// A fixed now far in the future, so rows enqueued with available_at = real
// now() are always already due (the same pinned-clock pattern the worker
// tests use).
const nowMs = Date.now() + 3_000_000;

function longRow(effectKey: string) {
  return {
    eventType: 'routine.dispatch',
    resourceType: 'routine_run',
    resourceId: '00000000-0000-4000-8000-000000000009',
    effectKey,
    payload: { resource_id: '00000000-0000-4000-8000-000000000009', event_type: 'routine.dispatch' },
  };
}

function defaultRow(effectKey: string) {
  return {
    eventType: 'task.completed',
    resourceType: 'task',
    resourceId: '00000000-0000-4000-8000-000000000001',
    effectKey,
    payload: { resource_id: '00000000-0000-4000-8000-000000000001', event_type: 'task.completed' },
  };
}

describe('outbox lanes', () => {
  it('throws when two lanes register the same event type', () => {
    const handler = vi.fn<OutboxHandler>(async () => undefined);
    expect(() =>
      createOutboxLanes({
        db,
        owner: 'lanes',
        journal: vi.fn(),
        now: () => nowMs,
        lanes: [
          { handlers: { 'task.completed': handler } },
          { name: 'long', include: ['routine.dispatch'], handlers: { 'routine.dispatch': handler } },
          { name: 'extra', include: ['task.completed'], handlers: { 'task.completed': handler } },
        ],
      }),
    ).toThrow('task.completed');
  });

  it('throws when a filtered lane registers a handler outside its include', () => {
    const handler = vi.fn<OutboxHandler>(async () => undefined);
    expect(() =>
      createOutboxLanes({
        db,
        owner: 'lanes',
        journal: vi.fn(),
        now: () => nowMs,
        lanes: [
          { name: 'long', include: ['email.notification'], handlers: { 'routine.dispatch': handler } },
          { handlers: { 'task.completed': handler } },
        ],
      }),
    ).toThrow('routine.dispatch');
  });

  it('throws when a filtered lane claims an event type it has no handler for', () => {
    const handler = vi.fn<OutboxHandler>(async () => undefined);
    expect(() =>
      createOutboxLanes({
        db,
        owner: 'lanes',
        journal: vi.fn(),
        now: () => nowMs,
        lanes: [
          { name: 'long', include: ['routine.dispatch', 'task.completed'], handlers: { 'routine.dispatch': handler } },
          { handlers: { 'email.notification': handler } },
        ],
      }),
    ).toThrow('task.completed');
  });

  it('throws unless exactly one lane is the catch-all default', () => {
    const handler = vi.fn<OutboxHandler>(async () => undefined);
    expect(() =>
      createOutboxLanes({
        db,
        owner: 'lanes',
        journal: vi.fn(),
        now: () => nowMs,
        lanes: [
          { name: 'one', include: ['task.completed'], handlers: { 'task.completed': handler } },
          { name: 'two', include: ['email.notification'], handlers: { 'email.notification': handler } },
        ],
      }),
    ).toThrow(/default/);
  });

  it('a long lane stuck in its handler never delays a default-lane row (no head-of-line blocking)', async () => {
    await enqueueOutbox(db, [longRow('hol-d1'), defaultRow('hol-d2')]);
    let releaseBlocked: () => void = () => undefined;
    const blocked = vi.fn<OutboxHandler>(
      async () => new Promise<void>((resolve) => { releaseBlocked = resolve; }),
    );
    const deliver = vi.fn<OutboxHandler>(async () => undefined);
    const lanes = createOutboxLanes({
      db,
      owner: 'hol',
      journal: vi.fn(),
      now: () => nowMs,
      pollMs: 50,
      lanes: [
        { name: 'long', include: ['routine.dispatch'], handlers: { 'routine.dispatch': blocked }, timeoutMs: 60_000 },
        { handlers: { 'task.completed': deliver } },
      ],
    });
    lanes.start();
    // The default lane claims only d2 and acks it while d1's handler is
    // still blocked; the long lane claimed only d1.
    await vi.waitFor(async () => {
      const rows = await outboxAdminQuery<{ k: string; delivered: boolean }>(
        `SELECT effect_key AS k, delivered_at IS NOT NULL AS delivered FROM bob.outbox`,
      );
      expect(rows.find((row) => row.k === 'hol-d2')?.delivered).toBe(true);
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0]!.effectKey).toBe('hol-d2');
    const claimed = await outboxAdminQuery<{ lease_owner: string | null }>(
      `SELECT lease_owner FROM bob.outbox WHERE effect_key = 'hol-d1'`,
    );
    expect(claimed[0]!.lease_owner).toBe('hol:long');

    // stop() must NOT release d1 while its handler still runs (another replica
    // would claim it and send twice, PR #1329 review): it waits for the
    // handler, and the row is then acked.
    const stopping = lanes.stop();
    expect(await settlesWithin(stopping, 300)).toBe(false);
    const during = await outboxAdminQuery<{ lease_owner: string | null; last_error_code: string | null }>(
      `SELECT lease_owner, last_error_code FROM bob.outbox WHERE effect_key = 'hol-d1'`,
    );
    expect(during[0]!.lease_owner).toBe('hol:long');
    expect(during[0]!.last_error_code).toBeNull();
    releaseBlocked();
    await stopping;
    const after = await outboxAdminQuery<{ attempts: number; last_error_code: string | null; delivered: boolean }>(
      `SELECT attempts, last_error_code, delivered_at IS NOT NULL AS delivered FROM bob.outbox WHERE effect_key = 'hol-d1'`,
    );
    expect(after[0]!.delivered).toBe(true);
    expect(after[0]!.last_error_code).toBeNull();
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(await pendingOutboxCount(db)).toBe(0);
  });

  it('throws when two lanes share a name', () => {
    const handler = vi.fn<OutboxHandler>(async () => undefined);
    expect(() =>
      createOutboxLanes({
        db,
        owner: 'lanes',
        journal: vi.fn(),
        now: () => nowMs,
        lanes: [
          { handlers: { 'task.completed': handler } },
          { name: 'long', include: ['routine.dispatch'], handlers: { 'routine.dispatch': handler } },
          { name: 'long', include: ['email.notification'], handlers: { 'email.notification': handler } },
        ],
      }),
    ).toThrow(/long/);
  });

  it('throws when a named lane is called default', () => {
    const handler = vi.fn<OutboxHandler>(async () => undefined);
    expect(() =>
      createOutboxLanes({
        db,
        owner: 'lanes',
        journal: vi.fn(),
        now: () => nowMs,
        lanes: [
          { handlers: { 'task.completed': handler } },
          { name: 'default', include: ['routine.dispatch'], handlers: { 'routine.dispatch': handler } },
        ],
      }),
    ).toThrow(/default/);
  });

  it('the default lane claims a type a sibling includes but also excludes (derived exclude uses the effective set)', async () => {
    // Sibling includes [lane.a, lane.b] and excludes [lane.b]: it owns only
    // lane.a, so the default (which has the lane.b handler) must claim lane.b.
    await enqueueOutbox(db, [{
      eventType: 'lane.b',
      resourceType: 'task',
      resourceId: '00000000-0000-4000-8000-000000000001',
      effectKey: 'effective-b',
      payload: { resource_id: '00000000-0000-4000-8000-000000000001', event_type: 'lane.b' },
    }]);
    const siblingA = vi.fn<OutboxHandler>(async () => undefined);
    const defaultB = vi.fn<OutboxHandler>(async () => undefined);
    const lanes = createOutboxLanes({
      db,
      owner: 'effective',
      journal: vi.fn(),
      now: () => nowMs,
      pollMs: 20,
      lanes: [
        { name: 'side', include: ['lane.a', 'lane.b'], exclude: ['lane.b'], handlers: { 'lane.a': siblingA } },
        { handlers: { 'lane.b': defaultB } },
      ],
    });
    lanes.start();
    try {
      await vi.waitFor(() => expect(defaultB).toHaveBeenCalledTimes(1), { timeout: 1_500 });
      expect(siblingA).not.toHaveBeenCalled();
    } finally {
      await lanes.stop();
    }
    expect(await pendingOutboxCount(db)).toBe(0);
  });

  it('health() names every lane and the owners carry the lane suffix', async () => {
    let releaseBlocked: () => void = () => undefined;
    const blocked = vi.fn<OutboxHandler>(
      async () => new Promise<void>((resolve) => { releaseBlocked = resolve; }),
    );
    const deliver = vi.fn<OutboxHandler>(async () => undefined);
    const lanes = createOutboxLanes({
      db,
      owner: 'health-check',
      journal: vi.fn(),
      now: () => nowMs,
      pollMs: 50,
      lanes: [
        { name: 'long', include: ['routine.dispatch'], handlers: { 'routine.dispatch': blocked }, timeoutMs: 60_000 },
        { handlers: { 'task.completed': deliver } },
      ],
    });
    await enqueueOutbox(db, [longRow('health-d1')]);
    lanes.start();
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(1));
    const health = await lanes.health();
    expect(Object.keys(health.lanes).sort()).toEqual(['default', 'long']);
    expect(health.lanes.long!.owner).toBe('health-check:long');
    expect(health.lanes.long!.inFlight).toBe(1);
    expect(health.inFlight).toBe(1);
    expect(health.pending).toBe(1);
    releaseBlocked();
    await lanes.stop();
    expect((await lanes.health()).inFlight).toBe(0);
  });
});
