// test:db suite (S14-OUTBOX): store/outbox.ts against the LOCAL Supabase stack
// (db-harness brings it up and creates throwaway users), the same pattern as
// store-action-items.db.test.ts. Two behaviours a single-connection test cannot prove:
//  1. two claimers running concurrently over 50 rows claim every row exactly
//     once and never the same row twice (the FOR UPDATE SKIP LOCKED claim);
//  2. a claimer that dies (lease left to expire, no ack) has its row reclaimed
//     and delivered by the second claimer exactly once.
// The outbox is server-only (FORCE RLS, no policies); the db-harness connects
// as bob_server, the same role the drain worker will act under. A direct
// DELETE from that connection is silently filtered by RLS, so row cleanup here
// goes through the same claim/ack path as real delivery (flushOutbox below).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ackOutbox,
  claimOutboxBatch,
  enqueueOutbox,
  pendingOutboxCount,
  reclaimExpiredOutbox,
  type StoredOutboxRow,
} from '../../src/platform/outbox/store.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

// Unique per process, so re-running the suite against the same local stack can
// never collide with delivered rows left by an earlier run (enqueueOutbox's
// ON CONFLICT would otherwise silently re-resolve them, hiding the new rows).
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;

function newRow(effectKey: string) {
  const resourceId = randomUUID();
  return {
    eventType: 'task.completed',
    resourceType: 'task',
    resourceId,
    effectKey,
    payload: { resource_id: resourceId, event_type: 'task.completed' },
  };
}

/** Clears every undelivered outbox row an earlier run may have left behind
 *  (e.g. a crashed run's leased rows), so pending-count assertions are
 *  absolute. A direct DELETE from this bob_server connection is silently
 *  filtered by FORCE RLS, so cleanup must reclaim expired leases and then
 *  claim-and-ack like real delivery. */
async function flushOutbox(db: Db): Promise<void> {
  await reclaimExpiredOutbox(db, { now: Date.now() + 10_000_000 });
  for (;;) {
    const stale = await claimOutboxBatch(db, { owner: 'cleanup', limit: 1000, leaseMs: 5_000, now: Date.now() + 10_000_000 });
    if (stale.length === 0) break;
    for (const r of stale) {
      await ackOutbox(db, { owner: 'cleanup', id: r.id });
    }
  }
}

describe('outbox store on the local stack (S14-OUTBOX)', () => {
  let env: MemoryTestDb;

  beforeAll(async () => {
    env = await setupMemoryTestDb();
    await flushOutbox(env.db);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('two concurrent claimers over 50 rows claim every row exactly once', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => newRow(`conc-${runId}-${i}`));
    await enqueueOutbox(env.db, rows);

    const started = Date.now() + 3_000_000; // far future so nothing is due-based
    const claimedA: StoredOutboxRow[] = [];
    const claimedB: StoredOutboxRow[] = [];
    // Two claimers racing over the same batch. Each drains the queue, so the
    // union covers every row and no id appears in both claimers.
    await Promise.all([
      (async () => {
        for (;;) {
          const batch = await claimOutboxBatch(env.db, { owner: 'racer-a', limit: 10, leaseMs: 30_000, now: started });
          if (batch.length === 0) break;
          claimedA.push(...batch);
        }
      })(),
      (async () => {
        for (;;) {
          const batch = await claimOutboxBatch(env.db, { owner: 'racer-b', limit: 10, leaseMs: 30_000, now: started });
          if (batch.length === 0) break;
          claimedB.push(...batch);
        }
      })(),
    ]);

    const all = [...claimedA, ...claimedB];
    expect(all).toHaveLength(50);
    const ids = all.map((r) => r.id);
    expect(new Set(ids).size).toBe(50); // every row exactly once, no duplicates
    expect(all.every((r) => r.leaseOwner === 'racer-a' || r.leaseOwner === 'racer-b')).toBe(true);

    // Deliver every claimed row so the next test starts clean.
    for (const r of all) {
      await ackOutbox(env.db, { owner: r.leaseOwner!, id: r.id });
    }
    expect(await pendingOutboxCount(env.db)).toBe(0);
  });

  it('a dead claimer is reclaimed and delivered by the second claimer exactly once', async () => {
    await enqueueOutbox(env.db, [newRow(`dead-claimer-${runId}`)]);

    const started = Date.now() + 6_000_000;
    // Claimer w1 claims and then dies: lease left to expire, no ack.
    const [first] = await claimOutboxBatch(env.db, { owner: 'dead-w1', limit: 10, leaseMs: 5_000, now: started });
    expect(first).toBeDefined();

    // w2 cannot claim while the lease is live.
    expect(await claimOutboxBatch(env.db, { owner: 'dead-w2', limit: 10, leaseMs: 30_000, now: started })).toHaveLength(0);

    // The lease expires; reclaim clears it; w2 claims and acks the same row once.
    const reclaimed = await reclaimExpiredOutbox(env.db, { now: started + 5_001 });
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const [second] = await claimOutboxBatch(env.db, { owner: 'dead-w2', limit: 10, leaseMs: 30_000, now: started + 5_001 });
    expect(second).toBeDefined();
    expect(second!.id).toBe(first!.id);

    const acked = await ackOutbox(env.db, { owner: 'dead-w2', id: second!.id });
    expect(acked).toBe(true);

    // No undelivered rows remain: delivered exactly once.
    expect(await pendingOutboxCount(env.db)).toBe(0);
  });

  it('a filtered claimer and the default complement partition the event types exactly once (lanes, #1322 S1)', async () => {
    // Two event types; the lanes partition them by include/exclude.
    for (let i = 0; i < 20; i += 1) {
      await enqueueOutbox(env.db, [
        { eventType: 'lane.a', resourceType: 'task', resourceId: randomUUID(),
          effectKey: `lane-a-${runId}-${i}`, payload: { event_type: 'lane.a' } },
        { eventType: 'lane.b', resourceType: 'task', resourceId: randomUUID(),
          effectKey: `lane-b-${runId}-${i}`, payload: { event_type: 'lane.b' } },
      ]);
    }

    const started = Date.now() + 8_000_000; // far future so nothing is due-based
    const claimedByLane: StoredOutboxRow[] = [];
    const claimedByDefault: StoredOutboxRow[] = [];
    // Two claimers racing over the same growth: the filtered one claims only
    // lane.a through the include filter, the complement claims only lane.b
    // through the derived exclude; FOR UPDATE SKIP LOCKED still applies, so
    // neither list shares a row and the union is every row exactly once.
    await Promise.all([
      (async () => {
        for (;;) {
          const batch = await claimOutboxBatch(env.db, {
            owner: 'lane-a', limit: 10, leaseMs: 30_000, now: started, include: ['lane.a'],
          });
          if (batch.length === 0) break;
          claimedByLane.push(...batch);
        }
      })(),
      (async () => {
        for (;;) {
          const batch = await claimOutboxBatch(env.db, {
            owner: 'lane-default', limit: 10, leaseMs: 30_000, now: started, exclude: ['lane.a'],
          });
          if (batch.length === 0) break;
          claimedByDefault.push(...batch);
        }
      })(),
    ]);

    const all = [...claimedByLane, ...claimedByDefault];
    expect(all).toHaveLength(40);
    expect(new Set(all.map((r) => r.id)).size).toBe(40);
    expect(claimedByLane.every((r) => r.eventType === 'lane.a')).toBe(true);
    expect(claimedByDefault.every((r) => r.eventType === 'lane.b')).toBe(true);

    // Deliver every claimed row so the next test starts clean.
    for (const r of all) {
      await ackOutbox(env.db, { owner: r.leaseOwner!, id: r.id });
    }
    expect(await pendingOutboxCount(env.db)).toBe(0);
  });
});