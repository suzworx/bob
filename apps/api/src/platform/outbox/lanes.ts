/**
 * Outbox lanes (S1 of #1322): several drain workers over ONE outbox, each
 * claiming only its own event types through a filtered claim, so a slow
 * handler in one lane (routine runs, from S2 on) can never delay a short one
 * in another. Exactly one lane is the catch-all default; its claim excludes
 * everything the other lanes include, so no event type falls between lanes
 * and every type has exactly one owner. Validation runs at composition time
 * and fails fast on a wiring bug: a type registered by two lanes, a handler
 * outside its lane's include, an include with no handler behind it, an empty
 * effective set, or a missing/duplicated default.
 *
 * Each lane is an OutboxWorker under the hood: its own claim filter, its own
 * concurrency/timeout/lease and its own lease owner (`<owner>:<lane>`), which
 * the store's lease scoping and the reclaim path already separate.
 */
import type { Db } from '../db/db.ts';
import type { JournalFields } from '../logger.ts';
import { pendingOutboxCount } from './store.ts';
import { createOutboxWorker, type OutboxHealth, type OutboxHandler, type OutboxWorker } from './worker.ts';

/** The health/owner key of the catch-all lane. */
const DEFAULT_LANE = 'default';

type OutboxLaneOptions = {
  /** Lane name — the journal `lane` field and the owner suffix. The catch-all
   *  default lane is the one without a name and it must not set filters. */
  name?: string;
  /** The event types this lane claims exclusively. */
  include?: string[];
  /** Event types this lane skips even though its include covers them (the
   *  default lane's exclude is DERIVED from the other lanes' includes and is
   *  never set here). */
  exclude?: string[];
  handlers: Readonly<Record<string, OutboxHandler>>;
  concurrency?: number;
  timeoutMs?: number;
};

export type OutboxLanesOptions = {
  db: Db;
  owner: string;
  lanes: OutboxLaneOptions[];
  batchSize?: number;
  leaseMs?: number;
  pollMs?: number;
  maxAttempts?: number;
  baseRetryMs?: number;
  retryCapMs?: number;
  now?: () => number;
  journal?: (event: string, fields?: JournalFields) => void;
};

/** Aggregate health: the lanes' own gauges, plus the table-wide pending count
 *  (a lane cannot count its own pending, its claim round is the whole table). */
type OutboxLanesHealth = {
  pending: number;
  inFlight: number;
  parked: number;
  lanes: Record<string, OutboxHealth>;
};

export type OutboxLanes = {
  start(): void;
  stop(): Promise<void>;
  health(): Promise<OutboxLanesHealth>;
};

/** One validated lane ready to become a worker. The filter arrays already
 *  carry the lane's include and exclude (for the default, the union of the
 *  other lanes' includes); `undefined` keeps the byte-identical unfiltered
 *  claim, which the default lane with no siblings uses. */
type LanePlan = {
  key: string;
  owner: string;
  include?: string[];
  exclude?: string[];
  lane: OutboxLaneOptions;
};

const laneKey = (lane: OutboxLaneOptions): string => lane.name ?? DEFAULT_LANE;

/** Refuses a lane wiring that would break lane isolation (message names the
 *  offending type where there is one). */
function validate(lanes: OutboxLaneOptions[]): void {
  const defaultLanes = lanes.filter((lane) => lane.name === undefined);
  if (defaultLanes.length !== 1) {
    throw new Error('outbox lanes: exactly one lane must be the catch-all default (no name, no include)');
  }
  validateLaneNames(lanes);
  validateLaneHandlers(lanes);
}

function validateLaneNames(lanes: OutboxLaneOptions[]): void {
  const seenNames = new Set<string>(['default']);
  for (const lane of lanes) {
    if (lane.name !== undefined) {
      if (seenNames.has(lane.name)) {
        throw new Error(`outbox lanes: duplicate lane name: ${lane.name}`);
      }
      if (lane.name === 'default') {
        throw new Error(`outbox lanes: 'default' is a reserved lane name`);
      }
      seenNames.add(lane.name);
    }
  }
}

function validateLaneHandlers(lanes: OutboxLaneOptions[]): void {
  const owners = new Map<string, string>();
  const claim = (type: string, key: string): void => {
    const existing = owners.get(type);
    if (existing !== undefined) {
      throw new Error(`outbox lanes: event type ${type} is registered by lanes ${existing} and ${key}`);
    }
    owners.set(type, key);
  };
  for (const lane of lanes) {
    const key = laneKey(lane);
    const claimed = claimedTypes(lane, key);
    for (const type of Object.keys(lane.handlers)) {
      if (!claimed.includes(type)) {
        throw new Error(`outbox lanes: lane ${key} registers handler ${type} outside its claimed event types`);
      }
    }
    for (const type of claimed) {
      if (lane.handlers[type] === undefined) {
        throw new Error(`outbox lanes: lane ${key} claims ${type} without a handler`);
      }
      claim(type, key);
    }
  }
}

/** The event types a lane would claim: the default's handler keys (it owns
 *  everything the filtered lanes do not include), a filtered lane's include
 *  minus its own exclude. Empty means the lane can never deliver anything. */
function claimedTypes(lane: OutboxLaneOptions, key: string): string[] {
  if (lane.name === undefined) {
    if (lane.include !== undefined || lane.exclude !== undefined) {
      throw new Error(`outbox lanes: the default lane (${key}) must not set include/exclude`);
    }
    const types = Object.keys(lane.handlers);
    if (types.length === 0) {
      throw new Error(`outbox lanes: lane ${key} claims no event types`);
    }
    return types;
  }
  const effective = (lane.include ?? []).filter((type) => lane.exclude?.includes(type) !== true);
  if (effective.length === 0) {
    throw new Error(`outbox lanes: lane ${key} claims no event types (empty effective include)`);
  }
  return effective;
}

/** Computes every lane's claim filter. A single default lane takes the
 *  unfiltered claim (byte-identical to the pre-lanes worker); any filtered
 *  sibling turns the default's claim into its complement. */
function planLanes(lanes: OutboxLaneOptions[], owner: string): LanePlan[] {
  validate(lanes);
  return lanes.map((lane) => {
    const key = laneKey(lane);
    if (lane.name === undefined) {
      const others = lanes.filter((other) => other.name !== undefined);
      if (others.length === 0) {
        return { key, owner, lane };
      }
      const exclude = others.flatMap((other) => claimedTypes(other, laneKey(other)));
      return { key, owner, exclude, lane };
    }
    return { key, owner: `${owner}:${lane.name}`, include: lane.include, exclude: lane.exclude, lane };
  });
}

export function createOutboxLanes(options: OutboxLanesOptions): OutboxLanes {
  const plans = planLanes(options.lanes, options.owner);
  const workers = new Map<string, OutboxWorker>();
  for (const plan of plans) {
    workers.set(plan.key, createOutboxWorker({
      db: options.db,
      owner: plan.owner,
      handlers: plan.lane.handlers,
      include: plan.include,
      exclude: plan.exclude,
      lane: plan.lane.name,
      concurrency: plan.lane.concurrency,
      timeoutMs: plan.lane.timeoutMs,
      batchSize: options.batchSize,
      leaseMs: options.leaseMs,
      pollMs: options.pollMs,
      maxAttempts: options.maxAttempts,
      baseRetryMs: options.baseRetryMs,
      retryCapMs: options.retryCapMs,
      now: options.now,
      journal: options.journal,
    }));
  }

  return {
    start(): void {
      for (const worker of workers.values()) worker.start();
    },
    async stop(): Promise<void> {
      await Promise.all([...workers.values()].map((worker) => worker.stop()));
    },
    async health(): Promise<OutboxLanesHealth> {
      let inFlight = 0;
      let parked = 0;
      const rows: Record<string, OutboxHealth> = {};
      for (const [key, worker] of workers) {
        const perLane = await worker.health();
        inFlight += perLane.inFlight;
        parked += perLane.parked;
        rows[key] = perLane;
      }
      return { pending: await pendingOutboxCount(options.db), inFlight, parked, lanes: rows };
    },
  };
}
