// store/outbox.ts tests (S14-OUTBOX). A per-file real Postgres test database,
// same setup as store-tasks.test.ts. Behavioural, not structural: exercises enqueue-in-tx
// atomicity, leased exactly-once claiming, expiry reclaim, single ack, retry
// delay, effect_key idempotency and the payload allowlist. RLS on bob.outbox
// is forced with no policies, so bob_server sees no rows through a bare query;
// these tests drive the store functions directly, exactly as the bob_server
// drain worker will through the narrow access path.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import {
  ackOutbox,
  claimOutboxBatch,
  enqueueOutbox,
  outboxPayloadSchema,
  pendingOutboxCount,
  reclaimExpiredOutbox,
  releaseOutbox,
} from '../../src/platform/outbox/store.ts';
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

// bob.outbox is FORCE RLS with ZERO policies (by design: every access goes
// through the bob_private.outbox_* SECURITY DEFINER functions the store
// calls). `db`/`pg` connect as bob_server, so a plain query on that
// connection is denied every row -- `db.query('DELETE FROM bob.outbox')`
// deleted 0 rows and raised no error, which let earlier tests' rows leak into
// later ones once the suite moved off a bypass-RLS superuser role.
// This helper runs on a SEPARATE admin (postgres superuser) connection to this
// same per-test database -- the harness's existing admin seam in
// pg-template.ts -- which bypasses RLS and genuinely sees the rows. Used for
// teardown only; every row a test asserts on is still created through the
// app's own enqueueOutbox/claimOutboxBatch/etc.
async function outboxAdminQuery<T>(sql: string): Promise<T[]> {
  const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
  return withAdmin(url, (admin) => admin.unsafe<T[]>(sql));
}

async function resetOutbox(): Promise<void> {
  await outboxAdminQuery('DELETE FROM bob.outbox');
}

// Each test starts with an empty table (the shared database persists rows
// between tests; pendingOutboxCount asserts are absolute).
beforeEach(async () => {
  await resetOutbox();
});

// A fixed now far in the future, so rows enqueued with the default
// available_at = now() (the machine clock) are always already due for claim.
const nowMs = Date.now() + 3_000_000;

function newRow(effectKey: string, extra: Partial<Parameters<typeof enqueueOutbox>[1][number]> = {}) {
  return {
    eventType: 'task.completed',
    resourceType: 'task',
    resourceId: '00000000-0000-4000-8000-000000000001',
    effectKey,
    payload: { resource_id: '00000000-0000-4000-8000-000000000001', event_type: 'task.completed' },
    ...extra,
  };
}

describe('outbox store', () => {
  it('0: resetOutbox (the beforeEach teardown) genuinely empties the table -- a count on the bob_server connection would misreport 0 even if rows were still trapped behind FORCE RLS with zero policies, so this checks via the admin connection instead', async () => {
    await enqueueOutbox(db, [newRow('reset-proof')]);
    const beforeReset = await outboxAdminQuery<{ n: number }>('SELECT count(*)::int AS n FROM bob.outbox');
    expect(beforeReset[0]!.n).toBe(1);

    await resetOutbox();

    const afterReset = await outboxAdminQuery<{ n: number }>('SELECT count(*)::int AS n FROM bob.outbox');
    expect(afterReset[0]!.n).toBe(0);
  });

  it('1: a row enqueued inside db.tx(...) that then throws is NOT in the table', async () => {
    await db.tx(async (tx) => {
      await enqueueOutbox(tx, [newRow('tx-abort')]);
      throw new Error('rollback');
    }).catch(() => undefined);
    expect(await pendingOutboxCount(db)).toBe(0);
  });

  it('2: claimOutboxBatch leases what it returns; a second claim by another owner sees none', async () => {
    await enqueueOutbox(db, [newRow('claim-a'), newRow('claim-b')]);
    const first = await claimOutboxBatch(db, { owner: 'w1', limit: 10, leaseMs: 60_000, now: nowMs });
    expect(first).toHaveLength(2);
    expect(first.every((r) => r.leaseOwner === 'w1')).toBe(true);
    expect(first.every((r) => r.leaseExpiresAt === nowMs + 60_000)).toBe(true);

    const second = await claimOutboxBatch(db, { owner: 'w2', limit: 10, leaseMs: 60_000, now: nowMs });
    expect(second).toHaveLength(0);
  });

  it('3: an expired lease is reclaimed and claimable again', async () => {
    await enqueueOutbox(db, [newRow('reclaim')]);
    const claimed = await claimOutboxBatch(db, { owner: 'w1', limit: 10, leaseMs: 60_000, now: nowMs });
    expect(claimed).toHaveLength(1);

    // w2 claims nothing while w1's lease is live.
    expect(
      await claimOutboxBatch(db, { owner: 'w2', limit: 10, leaseMs: 60_000, now: nowMs }),
    ).toHaveLength(0);

    // Lease expires; reclaim clears it; w2 can now claim the same row.
    const reclaimed = await reclaimExpiredOutbox(db, { now: nowMs + 60_001 });
    expect(reclaimed).toBe(1);
    const reClaimed = await claimOutboxBatch(db, { owner: 'w2', limit: 10, leaseMs: 60_000, now: nowMs + 60_001 });
    expect(reClaimed).toHaveLength(1);
    expect(reClaimed[0]!.id).toBe(claimed[0]!.id);
    expect(reClaimed[0]!.leaseOwner).toBe('w2');
  });

  it('4: ackOutbox marks delivery once; a replayed ack is a no-op', async () => {
    await enqueueOutbox(db, [newRow('ack')]);
    const [row] = await claimOutboxBatch(db, { owner: 'w1', limit: 10, leaseMs: 60_000, now: nowMs });
    expect(row).toBeDefined();

    expect(await ackOutbox(db, { owner: 'w1', id: row!.id })).toBe(true);
    expect(await ackOutbox(db, { owner: 'w1', id: row!.id })).toBe(false);
    expect(await pendingOutboxCount(db)).toBe(0);
  });

  it('5: releaseOutbox delays the row past available_at and increments attempts', async () => {
    await enqueueOutbox(db, [newRow('release')]);
    const [row] = await claimOutboxBatch(db, { owner: 'w1', limit: 10, leaseMs: 60_000, now: nowMs });
    expect(row).toBeDefined();

    const released = await releaseOutbox(db, {
      owner: 'w1',
      id: row!.id,
      retryInMs: 60_000,
      errorCode: 'transient',
      now: nowMs,
    });
    expect(released).not.toBeNull();
    expect(released!.attempts).toBe(1);
    expect(released!.lastErrorCode).toBe('transient');
    expect(released!.leaseOwner).toBeNull();
    expect(released!.availableAt).toBe(nowMs + 60_000);

    // Not due yet, so no claimer sees it.
    expect(await claimOutboxBatch(db, { owner: 'w2', limit: 10, leaseMs: 60_000, now: nowMs })).toHaveLength(0);
    // Once due, it is claimable again.
    const again = await claimOutboxBatch(db, { owner: 'w2', limit: 10, leaseMs: 60_000, now: nowMs + 60_000 });
    expect(again).toHaveLength(1);
  });

  it('6: enqueueOutbox with the same effect_key twice yields ONE row', async () => {
    await enqueueOutbox(db, [newRow('dupe')]);
    const second = await enqueueOutbox(db, [newRow('dupe')]);
    expect(second).toHaveLength(1);
    expect(await pendingOutboxCount(db)).toBe(1);
  });

  it('7: outboxPayloadSchema rejects title/body/email and unknown keys', async () => {
    expect(outboxPayloadSchema.safeParse({ title: 'x' }).success).toBe(false);
    expect(outboxPayloadSchema.safeParse({ body: 'x' }).success).toBe(false);
    expect(outboxPayloadSchema.safeParse({ email: 'x' }).success).toBe(false);
    // The allowlisted keys pass.
    expect(
      outboxPayloadSchema.safeParse({ resource_id: 'a', resource_type: 'task', revision: 1 }).success,
    ).toBe(true);
  });
});