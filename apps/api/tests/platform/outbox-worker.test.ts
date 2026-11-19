// S14-SPINE-WORKER (issue #119): core/outbox-worker.ts tests. A per-file real
// Postgres test database, same setup as outbox.test.ts. tick() is driven directly with
// a pinned clock and fake handlers; nothing here runs the interval scheduler.
// The store tests already prove the SQL-level claim/ack/release/reclaim
// semantics; these prove the worker's loop on top of them: handler dispatch,
// backoff, no-handler release, park at maxAttempts, and stop() releasing
// still-leased rows. Exactly-once under restart is proven against the store's
// leased claim (a live lease is never handed to two claimers).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import {
  ackOutbox,
  claimOutboxBatch,
  enqueueOutbox,
  pendingOutboxCount,
} from '../../src/platform/outbox/store.ts';
import {
  BASE_RETRY_MS,
  createOutboxWorker,
  type OutboxHandler,
  type OutboxWorker,
} from '../../src/platform/outbox/worker.ts';
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
// teardown, and (below) for the assertions that read raw columns the store's
// definer-backed reads don't expose; every row a test asserts on is still
// created through the app's own enqueueOutbox/claimOutboxBatch/etc.
async function outboxAdminQuery<T>(sql: string): Promise<T[]> {
  const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
  return withAdmin(url, (admin) => admin.unsafe<T[]>(sql));
}

async function resetOutbox(): Promise<void> {
  await outboxAdminQuery('DELETE FROM bob.outbox');
}

/** True when `promise` settles within `ms`. Only for asserting that stop()
 *  has NOT resolved yet: the wrong behaviour settles within a few store round
 *  trips, so a short bound decides it without a sleep on the passing path. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true, () => true), bound]);
  } finally {
    clearTimeout(timer);
  }
}

// Each test starts with an empty table (the shared database persists rows
// between tests; pendingOutboxCount asserts are absolute).
beforeEach(async () => {
  await resetOutbox();
});

// A fixed now far in the future, so rows enqueued with available_at = real
// now() are always already due. Tests pin the worker's clock to this or
// advance a mutable copy.
const nowMs = Date.now() + 3_000_000;

function newRow(effectKey: string) {
  return {
    eventType: 'task.completed',
    resourceType: 'task',
    resourceId: '00000000-0000-4000-8000-000000000001',
    effectKey,
    payload: { resource_id: '00000000-0000-4000-8000-000000000001', event_type: 'task.completed' },
  };
}

function makeWorker(
  owner: string,
  handlers: Readonly<Record<string, OutboxHandler>>,
  options: {
    now?: () => number;
    maxAttempts?: number;
    leaseMs?: number;
    lane?: string;
    concurrency?: number;
    timeoutMs?: number;
    include?: string[];
    exclude?: string[];
    baseRetryMs?: number;
    retryCapMs?: number;
    pollMs?: number;
  } = {},
): OutboxWorker {
  return createOutboxWorker({
    db,
    handlers,
    owner,
    now: options.now ?? (() => nowMs),
    maxAttempts: options.maxAttempts,
    leaseMs: options.leaseMs,
    lane: options.lane,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    include: options.include,
    exclude: options.exclude,
    baseRetryMs: options.baseRetryMs,
    retryCapMs: options.retryCapMs,
    pollMs: options.pollMs,
    journal: vi.fn(),
  });
}

describe('outbox worker', () => {
  it('0: resetOutbox (the beforeEach teardown) genuinely empties the table -- a count on the bob_server connection would misreport 0 even if rows were still trapped behind FORCE RLS with zero policies, so this checks via the admin connection instead', async () => {
    await enqueueOutbox(db, [newRow('reset-proof')]);
    const beforeReset = await outboxAdminQuery<{ n: number }>('SELECT count(*)::int AS n FROM bob.outbox');
    expect(beforeReset[0]!.n).toBe(1);

    await resetOutbox();

    const afterReset = await outboxAdminQuery<{ n: number }>('SELECT count(*)::int AS n FROM bob.outbox');
    expect(afterReset[0]!.n).toBe(0);
  });

  it('1: a queued row is handed to the handler for its event_type and then acked', async () => {
    await enqueueOutbox(db, [newRow('acked')]);
    const handler = vi.fn<OutboxHandler>(async () => undefined);
    const worker = makeWorker('w1', { 'task.completed': handler });

    const result = await worker.tick();

    expect(result).toEqual({ claimed: 1, acked: 1, released: 0, noHandler: 0, parked: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'task.completed', effectKey: 'acked' }),
      expect.anything(),
    );
    // The handler got an abort signal to honour its own deadline.
    const signal = handler.mock.calls[0]![1];
    expect(signal).toBeInstanceOf(AbortSignal);
    const rows = await outboxAdminQuery<{ delivered: boolean }>(
      `SELECT delivered_at IS NOT NULL AS delivered FROM bob.outbox`,
    );
    expect(rows[0]!.delivered).toBe(true);
    expect(await pendingOutboxCount(db)).toBe(0);
  });

  it('2: a throwing handler leaves the row undelivered, attempts+1, available_at pushed out; an immediate re-tick does not retry it', async () => {
    await enqueueOutbox(db, [newRow('retry')]);
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const worker = makeWorker('w2', { 'task.completed': handler });

    const first = await worker.tick();
    expect(first).toEqual({ claimed: 1, acked: 0, released: 1, noHandler: 0, parked: 0 });
    expect(handler).toHaveBeenCalledTimes(1);

    const rows = await outboxAdminQuery<{
      attempts: number;
      delivered_at: Date | null;
      last_error_code: string | null;
      // The pg driver returns bigint/int8 columns as strings (precision
      // safety), which is exactly why the store's rowToOutbox() does
      // Number(row.availableAt) -- this raw admin read needs the same coercion.
      available_ms: string;
    }>(
      `SELECT attempts, delivered_at, last_error_code,
              floor(extract(epoch from available_at) * 1000)::bigint AS available_ms
       FROM bob.outbox`,
    );
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.delivered_at).toBeNull();
    expect(rows[0]!.last_error_code).toBe('Error');
    expect(Number(rows[0]!.available_ms)).toBe(nowMs + BASE_RETRY_MS);

    // A second immediate tick on the same pinned clock must NOT retry it.
    const second = await worker.tick();
    expect(second.claimed).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await pendingOutboxCount(db)).toBe(1);
  });

  it('3: exactly-once under restart — a dead claimer is reclaimed after lease expiry and delivered once by a sibling', async () => {
    await enqueueOutbox(db, [newRow('restart')]);
    // Worker w1 claims the row and then "dies" mid-delivery: the handler hangs
    // and no ack is ever sent, so the lease is left to expire. The guarantee
    // this worker makes is the store's exactly-once claim — a live lease is
    // never handed to two claimers — so the delivered effect is unique because
    // only the second worker acks. (Had a first handler completed an effect,
    // the adapters' effect_key idempotency — a later unit — would suppress the
    // duplicate; this worker never acks twice.)
    const hung = vi.fn(() => new Promise<void>(() => undefined));
    const w1 = makeWorker('restart-w1', { 'task.completed': hung }, { leaseMs: 60_000 });
    void w1.tick(); // claims; hangs; never acks
    await vi.waitFor(async () => {
      const rows = await outboxAdminQuery<{ lease_owner: string | null }>(`SELECT lease_owner FROM bob.outbox`);
      expect(rows[0]!.lease_owner).toBe('restart-w1');
    });
    expect(hung).toHaveBeenCalledTimes(1);

    // w1 holds the lease: a sibling sees nothing while it is live.
    expect(
      await claimOutboxBatch(db, { owner: 'restart-w2', limit: 10, leaseMs: 60_000, now: nowMs }),
    ).toHaveLength(0);

    // The lease expires; a fresh worker with a different owner reclaims the
    // row on its first tick and delivers it.
    const afterExpiry = nowMs + 60_001;
    const deliver = vi.fn(async () => undefined);
    const w2 = makeWorker('restart-w2', { 'task.completed': deliver }, { now: () => afterExpiry });
    const result = await w2.tick();
    expect(result).toEqual({ claimed: 1, acked: 1, released: 0, noHandler: 0, parked: 0 });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await pendingOutboxCount(db)).toBe(0);
  });

  it('4: a row with no registered handler is released with no_handler and never acked', async () => {
    await enqueueOutbox(db, [newRow('no-handler')]);
    const worker = makeWorker('w4', {});

    const result = await worker.tick();
    expect(result).toEqual({ claimed: 1, acked: 0, released: 0, noHandler: 1, parked: 0 });

    const rows = await outboxAdminQuery<{
      attempts: number;
      delivered_at: Date | null;
      last_error_code: string | null;
    }>(`SELECT attempts, delivered_at, last_error_code FROM bob.outbox`);
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.delivered_at).toBeNull();
    expect(rows[0]!.last_error_code).toBe('no_handler');
    expect(await pendingOutboxCount(db)).toBe(1);
  });

  it('5: a row that keeps failing is parked at maxAttempts and stops being claimed', async () => {
    await enqueueOutbox(db, [newRow('poison')]);
    let now = nowMs;
    const failing = vi.fn(async () => {
      throw new Error('always');
    });
    const worker = makeWorker('w5', { 'task.completed': failing }, { now: () => now, maxAttempts: 3 });

    // Attempts 1 and 2 release with a growing backoff; attempt 3 parks.
    for (let i = 0; i < 3; i += 1) {
      await worker.tick();
      now += 10_000; // far beyond the backoff for this attempt
    }

    const health = await worker.health();
    expect(health.parked).toBe(1);
    expect(health.pending).toBe(1);
    expect(failing).toHaveBeenCalledTimes(3);

    // Parked far into the future: further ticks claim nothing.
    const extra = await worker.tick();
    expect(extra.claimed).toBe(0);
    expect(failing).toHaveBeenCalledTimes(3);

    const rows = await outboxAdminQuery<{ last_error_code: string | null; attempts: number }>(
      `SELECT last_error_code, attempts FROM bob.outbox`,
    );
    expect(rows[0]!.last_error_code).toBe('parked');
    expect(rows[0]!.attempts).toBe(3);
  });

  it('6: stop() releases rows still leased so another worker can claim them immediately', async () => {
    await enqueueOutbox(db, [newRow('stop-release')]);
    // A store outage during release leaves the row leased; stop() must release
    // it (retry 0) so a sibling can claim it now instead of waiting for the
    // lease to expire.
    let allowRelease = false;
    const store: Db = {
      async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        if (sql.includes('outbox_release') && !allowRelease) throw new Error('store down');
        return db.query<T>(sql, params);
      },
      tx<T>(fn: (inner: Db) => Promise<T>): Promise<T> {
        return db.tx(fn);
      },
    };
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    const worker = createOutboxWorker({
      db: store,
      handlers: { 'task.completed': failing },
      owner: 'stop-w1',
      now: () => nowMs,
      journal: vi.fn(),
    });

    const result = await worker.tick();
    expect(result.claimed).toBe(1);
    expect(result.released).toBe(0);
    // The row is still leased by stop-w1.
    expect(
      await claimOutboxBatch(db, { owner: 'stop-w2', limit: 10, leaseMs: 60_000, now: nowMs }),
    ).toHaveLength(0);

    allowRelease = true;
    await worker.stop();
    expect(await pendingOutboxCount(db)).toBe(1);

    // stop() released the lease with retry 0, so a sibling claims it at once.
    const claimed = await claimOutboxBatch(db, {
      owner: 'stop-w2',
      limit: 10,
      leaseMs: 60_000,
      now: nowMs,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.leaseOwner).toBe('stop-w2');
    await ackOutbox(db, { owner: 'stop-w2', id: claimed[0]!.id });
    expect(await pendingOutboxCount(db)).toBe(0);
  });

  it('7: a handler that misses its timeout is aborted; the row is released with a content-free code and the lane\'s backoff', async () => {
    await enqueueOutbox(db, [newRow('timeout')]);
    // A holder object: the handler assignment across closures would narrow
    // `let seen` to null at the assertion.
    const seen: { signal?: AbortSignal } = {};
    // A handler that ignores its signal and never settles.
    const handler = vi.fn<OutboxHandler>((_row, signal) => {
      seen.signal = signal;
      return new Promise<void>(() => undefined);
    });
    const worker = makeWorker(
      'w-timeout',
      { 'task.completed': handler },
      { timeoutMs: 50, baseRetryMs: 250, retryCapMs: 400 },
    );

    const result = await worker.tick();

    expect(result).toEqual({ claimed: 1, acked: 0, released: 1, noHandler: 0, parked: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    // The signal the handler received did abort at the lane's timeout.
    expect(seen.signal?.aborted).toBe(true);

    const rows = await outboxAdminQuery<{ attempts: number; last_error_code: string | null; available_ms: string; delivered: boolean }>(
      `SELECT attempts, delivered_at IS NOT NULL AS delivered, last_error_code,
              floor(extract(epoch from available_at) * 1000)::bigint AS available_ms
       FROM bob.outbox`,
    );
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.last_error_code).toBe('TimeoutError');
    expect(rows[0]!.delivered).toBe(false);
    // The lane's own retry policy (baseRetryMs 250) pushed available_at out,
    // not the handler failure's message content.
    expect(Number(rows[0]!.available_ms)).toBe(nowMs + 250);
    expect(await pendingOutboxCount(db)).toBe(1);
  });

  it('8: stop() never releases a row whose handler is still running; it waits for the handler, then the row is acked (no double send)', async () => {
    // Review finding (PR #1329, High): releasing a row while its handler still
    // runs lets another replica claim it, so a non-cooperative handler (the
    // email sender) delivers twice. main's stop() waited for send+mark+ack.
    await enqueueOutbox(db, [newRow('stopper')]);
    let releaseHandler: () => void = () => undefined;
    let handlerSettled = false;
    const handler = vi.fn<OutboxHandler>(() => new Promise<void>((resolve) => {
      releaseHandler = () => { handlerSettled = true; resolve(); };
    }));
    const worker = makeWorker('w-stop-abort', { 'task.completed': handler });

    const pending = worker.tick();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    let stopSettledAfterHandler: boolean | null = null;
    const stopping = worker.stop().then(() => { stopSettledAfterHandler = handlerSettled; });
    // While the handler is still running, stop() has not resolved and the row
    // is still leased by this worker (not released for a sibling to claim).
    expect(await settlesWithin(stopping, 300)).toBe(false);
    const during = await outboxAdminQuery<{ lease_owner: string | null; last_error_code: string | null; attempts: number }>(
      `SELECT lease_owner, last_error_code, attempts FROM bob.outbox`,
    );
    expect(during[0]!.lease_owner).toBe('w-stop-abort');
    expect(during[0]!.last_error_code).toBeNull();
    expect(during[0]!.attempts).toBe(0);
    expect(
      await claimOutboxBatch(db, { owner: 'w-stop-sibling', limit: 10, leaseMs: 60_000, now: nowMs }),
    ).toHaveLength(0);

    releaseHandler();
    await stopping;
    const result = await pending;

    // stop() resolved only after the handler settled, and the row was acked.
    expect(stopSettledAfterHandler).toBe(true);
    expect(result).toEqual({ claimed: 1, acked: 1, released: 0, noHandler: 0, parked: 0 });
    const rows = await outboxAdminQuery<{ delivered: boolean; last_error_code: string | null }>(
      `SELECT delivered_at IS NOT NULL AS delivered, last_error_code FROM bob.outbox`,
    );
    expect(rows[0]!.delivered).toBe(true);
    expect(rows[0]!.last_error_code).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await pendingOutboxCount(db)).toBe(0);
  });

  it('9: a batch with concurrency 2 runs its rows through a two-wide pool', async () => {
    await enqueueOutbox(db, [newRow('pool-1'), newRow('pool-2'), newRow('pool-3')]);
    const release: Array<() => void> = [];
    const handler = vi.fn<OutboxHandler>(
      () => new Promise<void>((resolve) => { release.push(resolve); }),
    );
    const worker = makeWorker('w-pool', { 'task.completed': handler }, { concurrency: 2 });

    const pending = worker.tick();
    // Two handlers run at once; the third waits for the pool.
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    release.splice(0, 2).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
    release.forEach((resolve) => resolve());

    const result = await pending;
    expect(result).toEqual({ claimed: 3, acked: 3, released: 0, noHandler: 0, parked: 0 });
    expect(await pendingOutboxCount(db)).toBe(0);
  });

  it('10: a claimed batch sits in the stop-release set before its rows are processed', async () => {
    // A claimed batch (queued-2 was never handed to a handler) is still
    // leased work: stop() releases unstarted rows. The handler that was
    // running (queued-1) finishes and is acked, not released as stopped.
    // Separate calls: one call shares one now(), so created_at would tie and
    // the claim order (available_at, created_at) would be arbitrary.
    await enqueueOutbox(db, [newRow('queued-1')]);
    await enqueueOutbox(db, [newRow('queued-2')]);
    let enter: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { enter = resolve; });
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const handler = vi.fn<OutboxHandler>(async () => {
      enter();
      await finished;
    });
    const worker = makeWorker('w-queued', { 'task.completed': handler });
    const pending = worker.tick();

    await started;
    const stopPromise = worker.stop();
    finish();
    await Promise.all([stopPromise, pending]);
    expect(handler).toHaveBeenCalledTimes(1);

    const rows = await outboxAdminQuery<{ effect_key: string; attempts: number; last_error_code: string | null; available_ms: string }>(
      `SELECT effect_key, attempts, last_error_code, floor(extract(epoch from available_at) * 1000)::bigint AS available_ms
       FROM bob.outbox ORDER BY effect_key`,
    );
    expect(rows).toHaveLength(2);
    // queued-1: handler finished, delivery succeeded, acked
    expect(rows[0]!).toMatchObject({ effect_key: 'queued-1', attempts: 0, last_error_code: null });
    // queued-2: never started, released by stop with retry 0
    expect(rows[1]!).toMatchObject({ effect_key: 'queued-2', attempts: 1, last_error_code: 'stopped' });
    expect(Number(rows[1]!.available_ms)).toBe(nowMs);
  });
});