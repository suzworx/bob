/**
 * The supervised outbox drain worker (S14-SPINE-WORKER, issue #119; lanes S1
 * of #1322): a long-lived loop that delivers each outbox row exactly once.
 * One tick() reclaims expired leases, claims the next due batch, runs each
 * row's handler by event_type, acks on success, and releases on failure with
 * exponential backoff. Two additions for the lanes: handlers receive an
 * AbortSignal (the worker's stop, plus an optional per-lane timeout), the
 * delivery races that signal — an aborted delivery is released without
 * waiting for its handler — and a claimed batch may run through a small
 * concurrency pool instead of one row at a time. Lane options (lane name for
 * journal/span fields, include/exclude claim filters, per-lane retry policy)
 * let several workers of this module divide one outbox's event types among
 * themselves; createOutboxLanes in lanes.ts is their composition point.
 *
 * Exactly-once: the store already guarantees a live lease is never handed to
 * two claimers (claimOutboxBatch) and that a claimer which dies without acking
 * has its work reclaimed after the lease expires (reclaimExpiredOutbox). A
 * handler can therefore run more than once across a crash boundary — or when
 * its delivery is aborted and the row is retried — so delivery of an *effect*
 * exactly once per recipient rests on the handler being idempotent on row.
 * effectKey (the adapters implement that).
 */
import { OutboxDeferredError } from './deferred.ts';
import { recordObservationMetrics, traceSpan, updateActiveSpanMetadata } from '@bob/ai';
import type { JournalFields } from '../logger.ts';
import { moduleJournal } from '../logger.ts';
import type { Db } from '../db/db.ts';
import { traceDelivery } from '../observability/delivery-span.ts';
import { completeWorkflow, traceWorkflow, type SetWorkflowOutcome } from '../observability/workflow-diagnostics.ts';
import {
  ackOutbox,
  deferOutbox,
  claimOutboxBatch,
  heartbeatOutboxLease,
  pendingOutboxCount,
  reclaimExpiredOutbox,
  releaseOutbox,
  type StoredOutboxRow,
} from './store.ts';

const journalDefault = moduleJournal('platform');

/** One delivered effect for a row. Implementers must be idempotent on row.
 *  effectKey so a reclaimed or aborted-then-retried row cannot deliver twice. */
export type OutboxHandler = (row: StoredOutboxRow, signal: AbortSignal) => Promise<void>;

/** Stable machine codes for a failed delivery — never an error message, which
 *  can quote user content. */
const CODE_NO_HANDLER = 'no_handler';
const CODE_PARKED = 'parked';
const CODE_STOPPED = 'stopped';
const CODE_TIMEOUT = 'TimeoutError';
const CODE_STORE_ERROR = 'Error';

/** The code for a caught error. DOMException names are a fixed enum
 *  (AbortSignal.timeout aborts with TimeoutError), so they are safe to
 *  surface; a non-Error/thrown value stays content-free. */
function errorCode(error: unknown): string {
  if (error instanceof DOMException) return error.name;
  if (error instanceof Error) return error.name || CODE_STORE_ERROR;
  return 'UnknownError';
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_CONCURRENCY = 1;
/** Exponential-backoff floor: retryInMs doubles per attempt from here. */
export const BASE_RETRY_MS = 1_000;
/** Backoff ceiling, so a failing row retries at most every five minutes. */
const RETRY_CAP_MS = 5 * 60_000;
/** Parked rows (past maxAttempts) are released this far into the future, so a
 *  poison row can never spin the loop. */
const PARKED_RETRY_MS = 24 * 60 * 60 * 1000;

type OutboxWorkerOptions = {
  db: Db;
  /** event_type -> handler; a row with no registered handler is released with
   *  code `no_handler` and retried on a backoff, never acked. */
  handlers: Readonly<Record<string, OutboxHandler>>;
  /** The process that owns the leases this worker takes. */
  owner: string;
  /** Lane name added to this worker's journal fields and span metadata. */
  lane?: string;
  /** Event types this worker claims (20261028050000_outbox_lanes); a lane's
   *  include. Neither present means the unfiltered claim. */
  include?: string[];
  /** Event types this worker never claims (a lane's exclude — for the default
   *  lane, derive it from the other lanes' includes, see lanes.ts). */
  exclude?: string[];
  /** Rows delivered at once (a small pool, each row one handler call). */
  concurrency?: number;
  /** Aborts a delivery whose handler runs longer than this; the row is
   *  released with the same backoff as a failure. */
  timeoutMs?: number;
  batchSize?: number;
  leaseMs?: number;
  pollMs?: number;
  maxAttempts?: number;
  /** Per-lane retry policy; the defaults match the single-lane worker. */
  baseRetryMs?: number;
  retryCapMs?: number;
  /** Epoch-ms clock, injectable for deterministic tests. */
  now?: () => number;
  journal?: (event: string, fields?: JournalFields) => void;
};

type TickResult = {
  claimed: number;
  /** Acked (delivered) this tick. */
  acked: number;
  /** Released for a later retry after a handler or store failure. */
  released: number;
  /** Released because no handler is registered for the row's event_type. */
  noHandler: number;
  /** Released far into the future once a row reached maxAttempts. */
  parked: number;
};

export type OutboxHealth = {
  pending: number;
  lastTickAt: number | null;
  lastTickDurationMs: number | null;
  inFlight: number;
  parked: number;
  owner: string;
};

export type OutboxWorker = {
  tick(): Promise<TickResult>;
  start(): void;
  stop(): Promise<void>;
  health(): Promise<OutboxHealth>;
};

/** Unknown persisted/injected event types are bounded as `other`, never used as span names. */
export const OUTBOX_DISPATCH_VARIANTS = ['email.notification', 'email.admininvite'] as const;

function outboxAction(eventType: string): string {
  return OUTBOX_DISPATCH_VARIANTS.find((value) => value === eventType) ?? 'other';
}

/** Why a delivery's race settled. `aborted` fires without waiting for the
 *  handler: the row was released and the abandoned handler is ignored. */
type DeliverySettled =
  | { kind: 'delivered' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'aborted' };

export function createOutboxWorker(options: OutboxWorkerOptions): OutboxWorker {
  const { db, owner, handlers } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const baseRetryMs = options.baseRetryMs ?? BASE_RETRY_MS;
  const retryCapMs = options.retryCapMs ?? RETRY_CAP_MS;
  const clock = options.now ?? Date.now;
  const log = options.journal ?? journalDefault;

  /** Ends every in-flight delivery (and skips unstarted batch rows) the
   *  moment stop() runs; handlers watch this through their signal. */
  const stopSource = new AbortController();

  let started = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let parkedTotal = 0;
  let lastTickAt: number | null = null;
  let lastTickDurationMs: number | null = null;
  let emptyPolls = 0;
  let emptyPollsSince = clock();
  /** Ids this worker holds right now (the heartbeat set and the stop-release
   *  set): the FULL claimed batch, so a row never handed to a handler yet is
   *  still released by a clean stop. Rows already acked or released are
   *  dropped from it. */
  const batchIds: string[] = [];

  /** This worker's lane fields, or nothing for the single-lane worker. */
  function laneFields(): JournalFields {
    return options.lane === undefined ? {} : { lane: options.lane };
  }

  function laneMetadata(): Record<string, string> {
    return options.lane === undefined ? {} : { lane: options.lane };
  }

  /** retryInMs for a row that has failed `attempts` times so far. */
  function backoffMs(attempts: number): number {
    return Math.min(baseRetryMs * 2 ** attempts, retryCapMs);
  }

  /** Keeps the leases of the current batch live at about a third of leaseMs,
   *  so a slow handler never loses its lease to the reclaimer. */
  function startHeartbeat(ids: string[]): void {
    stopHeartbeat();
    const period = Math.max(1, Math.floor(leaseMs / 3));
    heartbeatTimer = setInterval(() => {
      void traceWorkflow('outbox-heartbeat', { detached: true, metadata: laneMetadata() },
        () => heartbeatOutboxLease(db, { owner, ids, leaseMs, now: clock() })).catch(() => undefined);
    }, period);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  /** The lane timeout for one delivery, if the lane sets one. Only this ends
   *  the race against a running handler. The handler's own signal also carries
   *  the stop (so it may finish early), but stop never settles the race. */
  function timeoutSignal(): AbortSignal | undefined {
    return options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
  }

  /** What the handler sees: aborts on stop and on the lane timeout. */
  function handlerSignal(timeout: AbortSignal | undefined): AbortSignal {
    return timeout === undefined ? stopSource.signal : AbortSignal.any([stopSource.signal, timeout]);
  }

  /** Removes a row whose lease this worker no longer holds (acked, released
   *  successfully, or lost to a reclaim) from the stop-release set. A row
   *  whose release FAILED stays: it is still leased, so stop() retries the
   *  release. */
  function dropBatchRow(id: string): void {
    const index = batchIds.indexOf(id);
    if (index !== -1) batchIds.splice(index, 1);
  }

  /** The handler promise, raced against the lane timeout only. `aborted` (the
   *  timeout) wins without waiting for the handler — later settlement of the
   *  abandoned handler is simply ignored (its effect must stay idempotent on
   *  row.effectKey). The loser's listener is removed so a settled delivery
   *  releases the signal. Without a timeout the handler alone decides. */
  function raceDelivery(run: Promise<void>, signal: AbortSignal | undefined): Promise<DeliverySettled> {
    const settled = run.then(
      (): DeliverySettled => ({ kind: 'delivered' }),
      (error: unknown): DeliverySettled => ({ kind: 'failed', error }),
    );
    if (signal === undefined) return settled;
    return new Promise<DeliverySettled>((resolve) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'aborted' });
      };
      void settled.then((outcome) => {
        // A promise resolved earlier ignores this later call; removing a
        // listener that was never registered (because abort won) is a no-op.
        signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      });
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
    });
  }

  /** One release from the drain path: bumps attempts (the SQL does), clears
   *  the lease and pushes available_at out by retryInMs. A store failure is
   *  journaled content-free and the row stays leased; stop() releases it
   *  later, or the reclaimer reclaims it at lease expiry. Never throws.
   *  The row's counting: `park` parks it, `noHandler` counts it as a
   *  registration gap (never a delivery failure), anything else is released
   *  for a later retry. */
  async function release(row: StoredOutboxRow, result: TickResult,
    request: { retryInMs: number; code: string; park?: boolean; noHandler?: boolean }): Promise<void> {
    try {
      await releaseOutbox(db, {
        owner,
        id: row.id,
        retryInMs: request.retryInMs,
        errorCode: request.code,
        now: clock(),
      });
      // Released: this worker no longer holds the lease, so stop() must not
      // release it a second time.
      dropBatchRow(row.id);
      if (request.park === true) {
        parkedTotal += 1;
        result.parked += 1;
      } else if (request.noHandler === true) {
        result.noHandler += 1;
      } else {
        result.released += 1;
      }
    } catch (error) {
      const fields = { error_name: errorCode(error), ...laneFields() };
      await traceDelivery('outbox-release-failed', fields, () => log('v2.outbox_release_failed', fields));
    }
  }

  /** A handler failed or was timed out: release with the backoff, parking at
   *  maxAttempts so a poison row cannot spin the loop. */
  async function releaseFailed(row: StoredOutboxRow, result: TickResult, outcome: SetWorkflowOutcome,
    code: string): Promise<void> {
    const park = row.attempts + 1 >= maxAttempts;
    outcome('failed');
    updateActiveSpanMetadata({ reason: park ? 'parked' : 'retry' });
    await release(row, result, {
      retryInMs: park ? PARKED_RETRY_MS : backoffMs(row.attempts),
      code: park ? CODE_PARKED : code,
      park,
    });
  }

  async function releaseDeliveryError(row: StoredOutboxRow, result: TickResult,
    outcome: SetWorkflowOutcome, error: unknown): Promise<void> {
    if (!(error instanceof OutboxDeferredError)) {
      await releaseFailed(row, result, outcome, errorCode(error));
      return;
    }
    await deferOutbox(db, { owner, id: row.id, retryInMs: error.retryInMs, now: clock() });
    dropBatchRow(row.id);
    result.released += 1;
    outcome('skipped');
  }

  /** The lane timeout won the race, so the handler may still be running. While
   *  the worker runs, release with the failure backoff. During stop, leave the
   *  lease to expire instead: an immediate release would let a sibling claim
   *  the row while the abandoned handler is still sending its effect. */
  async function releaseAborted(row: StoredOutboxRow, result: TickResult,
    outcome: SetWorkflowOutcome): Promise<void> {
    if (!stopSource.signal.aborted) {
      await releaseFailed(row, result, outcome, CODE_TIMEOUT);
      return;
    }
    outcome('failed');
    updateActiveSpanMetadata({ reason: 'timeout' });
    dropBatchRow(row.id);
  }

  async function deliverRow(row: StoredOutboxRow, result: TickResult, outcome: SetWorkflowOutcome): Promise<void> {
    try {
      const handler = handlers[row.eventType];
      if (handler === undefined) {
        outcome('rejected');
        updateActiveSpanMetadata({ reason: 'no_handler' });
        await release(row, result, { retryInMs: backoffMs(row.attempts), code: CODE_NO_HANDLER, noHandler: true });
        return;
      }
      if (stopSource.signal.aborted) {
        // stop() won the race before the row's turn came: release it cleanly
        // instead of building a handler call no one can watch.
        await release(row, result, { retryInMs: 0, code: CODE_STOPPED });
        return;
      }
      const timeout = timeoutSignal();
      const signal = handlerSignal(timeout);
      const run = Promise.resolve().then(() => handler(row, signal));
      const settled = await raceDelivery(run, timeout);
      if (settled.kind === 'aborted') {
        await releaseAborted(row, result, outcome);
        return;
      }
      if (settled.kind === 'failed') {
        await releaseDeliveryError(row, result, outcome, settled.error);
        return;
      }
      const acked = await ackOutbox(db, { owner, id: row.id });
      if (acked) {
        result.acked += 1;
        dropBatchRow(row.id);
      } else {
        // Lease lost (a reclaimer already moved the row on): it is not ours.
        outcome('skipped');
        updateActiveSpanMetadata({ reason: 'lease_lost' });
        dropBatchRow(row.id);
      }
    } catch {
      // A store failure between claim and settlement (an ack that could not
      // land, a release that failed above its own retry): release the row so
      // the work is not held for the whole lease. If even that release fails,
      // this journal line is the only evidence and stop()/reclaim still
      // cover the row.
      outcome('failed');
      try {
        await releaseOutbox(db, {
          owner,
          id: row.id,
          retryInMs: backoffMs(row.attempts),
          errorCode: CODE_STORE_ERROR,
          now: clock(),
        });
        dropBatchRow(row.id);
      } catch (releaseError) {
        const fields = { error_name: errorCode(releaseError), ...laneFields() };
        await traceDelivery('outbox-release-failed', fields, () => log('v2.outbox_release_failed', fields));
      }
    }
  }

  /** Runs one row through its handler; never throws. */
  async function processRow(row: StoredOutboxRow, result: TickResult): Promise<void> {
    return traceWorkflow('outbox-drain', {
      detached: true, workflowNamespace: 'outbox', turnId: row.id, tags: ['outbox'],
      metadata: { action: outboxAction(row.eventType), attempt: String(row.attempts + 1), ...laneMetadata() },
    }, (outcome) => deliverRow(row, result, outcome));
  }

  /** Delivers the claimed batch through at most `concurrency` lanes of work;
   *  the result object counts are shared by reference. */
  async function runBatch(batch: StoredOutboxRow[], result: TickResult): Promise<void> {
    const queue = [...batch];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, () =>
        (async () => {
          for (;;) {
            const row = queue.shift();
            if (row === undefined) return;
            await processRow(row, result);
          }
        })(),
      ),
    );
  }

  /** One drain pass: reclaim, claim, deliver, release. Never throws: a store
   *  outage is journaled and the next tick retries. */
  async function tick(): Promise<TickResult> {
    const startTime = new Date();
    const tickStarted = performance.now();
    const startedAt = clock();
    let failed = false;
    const result: TickResult = { claimed: 0, acked: 0, released: 0, noHandler: 0, parked: 0 };
    const task = (async () => {
      try {
        const batch = await claimBatch(startedAt);
        result.claimed = batch.length;
        if (batch.length > 0) {
          // Every claimed row is held work from this moment: the heartbeat
          // keeps its lease and stop() releases it even if its turn never
          // comes.
          for (const row of batch) batchIds.push(row.id);
          startHeartbeat(batch.map((row) => row.id));
        }
        try {
          await runBatch(batch, result);
        } finally {
          stopHeartbeat();
        }
      } catch (error) {
        failed = true;
        log('v2.outbox_tick_failed', { error_name: errorCode(error), ...laneFields() });
      } finally {
        lastTickAt = clock();
        lastTickDurationMs = lastTickAt - startedAt;
      }
    })();
    inFlight = task;
    await task;
    inFlight = null;
    const summary = {
      claimed: result.claimed,
      acked: result.acked,
      released: result.released + result.noHandler,
      parked: result.parked,
    };
    // Idle ticks are counted in poll summaries; work/errors retain actual batch duration and journal line.
    if (result.claimed > 0 || failed) {
      const outcome = failed || result.released + result.parked > 0 ? 'failed' : result.noHandler > 0 ? 'rejected' : 'ok';
      await completeWorkflow('outbox-tick', { detached: true, startTime, metadata: laneMetadata() },
        performance.now() - tickStarted, outcome);
      log('v2.outbox_tick', { ...summary, ...laneFields() });
    }
    return result;
  }

  async function flushEmptyPolls(): Promise<void> {
    if (emptyPolls === 0) return;
    const count = emptyPolls;
    emptyPolls = 0;
    emptyPollsSince = clock();
    await traceSpan('outbox.poll-summary', { detached: true, metadata: { outcome: 'idle' } },
      () => recordObservationMetrics([{ name: 'workflow.polls.empty', value: count }]));
  }

  async function claimBatch(now: number): Promise<StoredOutboxRow[]> {
    const startTime = new Date();
    const started = performance.now();
    try {
      const reclaimed = await reclaimExpiredOutbox(db, { now });
      const rows = await claimOutboxBatch(db, {
        owner, limit: batchSize, leaseMs, now,
        include: options.include, exclude: options.exclude,
      });
      if (rows.length > 0 || reclaimed > 0) {
        await completeWorkflow('outbox-claim', { detached: true, startTime, metadata: laneMetadata() },
          performance.now() - started, 'ok');
      } else {
        emptyPolls = Math.min(1000000, emptyPolls + 1);
        if (clock() - emptyPollsSince >= 60000) await flushEmptyPolls();
      }
      return rows;
    } catch (error) {
      await completeWorkflow('outbox-claim', { detached: true, startTime, metadata: laneMetadata() },
        performance.now() - started, 'failed');
      throw error;
    }
  }

  /** Runs ticks back-to-back with a pollMs gap; one tick at a time. */
  function start(): void {
    if (started) return;
    started = true;
    const loop = (): void => {
      if (!started) return;
      void tick()
        .catch(() => undefined)
        .finally(() => {
          if (!started) return;
          pollTimer = setTimeout(loop, pollMs);
          pollTimer.unref?.();
        });
    };
    loop();
  }

  /** Stops the scheduler and the heartbeat and aborts the stop signal: handlers
   *  may finish early, unstarted batch rows are released as `stopped`. A
   *  handler already running is awaited to settlement (ack or release written)
   *  — never released under it. Then any row still held (a failed release) is
   *  released so a sibling can claim it at once. */
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    started = false;
    stopSource.abort();
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    // Keep the running rows' leases alive while their handlers finish; the tick's finally also stops it.
    if (inFlight) await inFlight;
    stopHeartbeat();
    await flushEmptyPolls();
    inFlight = null;
    for (const id of [...batchIds]) {
      try {
        await traceWorkflow('outbox-release', { detached: true, metadata: laneMetadata() },
          () => releaseOutbox(db, { owner, id, retryInMs: 0, errorCode: CODE_STOPPED, now: clock() }));
      } catch {
        // Best effort during shutdown; a store outage must not block exit.
      }
    }
    batchIds.length = 0;
  }

  async function health(): Promise<OutboxHealth> {
    const pending = await pendingOutboxCount(db);
    return {
      pending,
      lastTickAt,
      lastTickDurationMs,
      inFlight: batchIds.length,
      parked: parkedTotal,
      owner,
    };
  }

  return { tick, start, stop, health };
}
