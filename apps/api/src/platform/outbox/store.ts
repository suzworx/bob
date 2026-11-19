/**
 * The durable outbox store (S14-OUTBOX, specs/014-family-collaboration/
 * data-model.md "outbox, jobs"). The event spine: a domain write and its
 * delivery record commit together (enqueueOutbox is called INSIDE the caller's
 * db.tx(...), never on its own), and a restarted worker reclaims leased work
 * without delivering anything twice (leased, exactly-once claiming).
 *
 * Storage layer only: the table, its claim helpers and the store module. The
 * drain worker, the inbox and the durable cursors are separate units. Every
 * function here is server-only: it runs as the bob_server role through the
 * Db it is given, and — because bob.outbox is FORCE RLS with no policies and
 * bob_server is nobypassrls, so a direct query would be denied every row —
 * each call goes through the bob_private.outbox_* SECURITY DEFINER functions
 * the migration defines (option A, the memory-extract-queue.ts pattern). The
 * asServer wrapper enforces that too: its query() rejects any SQL that does not
 * call an bob_private.* function. payload holds IDs, types and revisions
 * ONLY — outboxPayloadSchema rejects any other key, the SQL twin of the
 * migration's allowlist CHECK. No journal() call below carries a payload
 * value, a resource id or free text (AGENTS.md logging rule).
 */
import { z } from 'zod';
import { asServer, type Db } from '../db/db.ts';

/** The code-side twin of the SQL payload allowlist: exactly the allowlisted
 *  keys, all optional, strict so an unknown key is rejected. */
export const outboxPayloadSchema = z
  .object({
    space_id: z.string().optional(),
    resource_id: z.string().optional(),
    resource_type: z.string().optional(),
    revision: z.number().optional(),
    actor_user_id: z.string().optional(),
    recipient_user_id: z.string().optional(),
    occurrence_key: z.string().optional(),
    event_type: z.string().optional(),
  })
  .strict();

/** The outbox row as the worker sees it. Timestamps are epoch-ms; payload is
 *  the already-validated allowlisted object. */
export type StoredOutboxRow = {
  id: string;
  spaceId: string | null;
  eventType: string;
  resourceType: string;
  resourceId: string;
  revision: number;
  effectKey: string;
  payload: Record<string, unknown>;
  availableAt: number;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  deliveredAt: number | null;
  lastErrorCode: string | null;
  createdAt: number;
};

/** A raw row as the bob_private.outbox_* functions return it (the columns
 *  are already aliased and timestamps are epoch-ms). */
type OutboxRow = {
  id: unknown;
  spaceId: unknown;
  eventType: unknown;
  resourceType: unknown;
  resourceId: unknown;
  revision: unknown;
  effectKey: unknown;
  payload: unknown;
  availableAt: unknown;
  attempts: unknown;
  leaseOwner: unknown;
  leaseExpiresAt: unknown;
  deliveredAt: unknown;
  lastErrorCode: unknown;
  createdAt: unknown;
};

/** Raw row -> StoredOutboxRow. */
function rowToOutbox(row: OutboxRow): StoredOutboxRow {
  return {
    id: String(row.id),
    spaceId: row.spaceId === null ? null : String(row.spaceId),
    eventType: String(row.eventType),
    resourceType: String(row.resourceType),
    resourceId: String(row.resourceId),
    revision: Number(row.revision),
    effectKey: String(row.effectKey),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    availableAt: Number(row.availableAt),
    attempts: Number(row.attempts),
    leaseOwner: row.leaseOwner === null ? null : String(row.leaseOwner),
    leaseExpiresAt: row.leaseExpiresAt === null ? null : Number(row.leaseExpiresAt),
    deliveredAt: row.deliveredAt === null ? null : Number(row.deliveredAt),
    lastErrorCode: row.lastErrorCode === null ? null : String(row.lastErrorCode),
    createdAt: Number(row.createdAt),
  };
}

/** A new outbox row to enqueue. effectKey is the idempotency key for the effect
 *  this row causes, so a retried command is idempotent. */
type NewOutboxRow = {
  spaceId?: string | null;
  eventType: string;
  resourceType: string;
  resourceId: string;
  revision?: number;
  effectKey: string;
  payload: Record<string, unknown>;
};

function validateEventType(eventType: string): string {
  if (!/^[a-z][a-z0-9]*(\.([a-z][a-z0-9]*))+$/.test(eventType)) {
    throw new Error('outbox: event_type must be lowercase dotted (e.g. task.completed)');
  }
  return eventType;
}

/**
 * Enqueues outbox rows through the Db it is GIVEN, so a caller inside
 * db.tx(...) commits them with its domain write — this never opens its own
 * transaction. A duplicate effect_key resolves to the existing row (on conflict
 * (effect_key) do nothing plus a re-select) so a retried command is idempotent:
 * the same effect is never enqueued twice.
 */
export async function enqueueOutbox(db: Db, rows: NewOutboxRow[]): Promise<StoredOutboxRow[]> {
  if (rows.length === 0) return [];
  // Column arrays feed one set-returning bob_private.outbox_enqueue call,
  // which inserts (on conflict (effect_key) do nothing) and re-selects so a
  // retried command still yields exactly one row per effect_key. asServer keeps
  // the call on the Db it is given, so inside db.tx(...) the outbox row commits
  // with the caller's domain write.
  const rowsOut = await asServer(db, (server) =>
    server.query<OutboxRow>(
      `SELECT * FROM bob_private.outbox_enqueue(
         $1::uuid[], $2::text[], $3::text[], $4::uuid[], $5::int[], $6::text[], $7::jsonb[]
       )`,
      [
        rows.map((r) => r.spaceId ?? null),
        rows.map((r) => validateEventType(r.eventType)),
        rows.map((r) => r.resourceType),
        rows.map((r) => r.resourceId),
        rows.map((r) => r.revision ?? 1),
        rows.map((r) => r.effectKey),
        rows.map((r) => outboxPayloadSchema.parse(r.payload)),
      ],
    ),
  );
  return rowsOut.map(rowToOutbox);
}

/** claimOutboxBatch options. now defaults to Date.now(). include/exclude
 *  (20261028050000_outbox_lanes) filter by event_type for the outbox lanes;
 *  either present switches to the 6-argument claim, both omitted keep the
 *  byte-identical unfiltered call. */
type ClaimOptions = {
  owner: string;
  limit: number;
  leaseMs: number;
  now?: number;
  include?: string[];
  exclude?: string[];
};

/**
 * Claims undelivered, due rows: for update skip locked, sets the lease, returns
 * them ordered by available_at then created_at. A lease is all-or-nothing
 * (owner + expires set together). Rows another worker already holds are skipped
 * by the lock, so the same row is never handed to two claimers. With include/
 * exclude the claim takes only the event types the lane owns (or none of the
 * excluded ones); with neither, the unfiltered claim of the original migration.
 */
export async function claimOutboxBatch(
  db: Db,
  { owner, limit, leaseMs, now, include, exclude }: ClaimOptions,
): Promise<StoredOutboxRow[]> {
  const at = new Date(now ?? Date.now());
  const filtered = include !== undefined || exclude !== undefined;
  // One atomic statement inside bob_private.outbox_claim_batch: set the lease
  // on exactly the due, undelivered rows the FOR UPDATE SKIP LOCKED scan picks,
  // and return them already leased, so no row is ever handed to two claimers.
  // RETURNING order is unspecified, so the result is re-sorted by available_at
  // then created_at.
  const rows = await asServer(db, (server) =>
    server.query<OutboxRow>(
      filtered
        ? `SELECT * FROM bob_private.outbox_claim_batch($1::text, $2::int, $3::int, $4::timestamptz, $5::text[], $6::text[])`
        : `SELECT * FROM bob_private.outbox_claim_batch($1::text, $2::int, $3::int, $4::timestamptz)`,
      filtered ? [owner, limit, leaseMs, at, include ?? null, exclude ?? null] : [owner, limit, leaseMs, at],
    ),
  );
  return rows.map(rowToOutbox).sort((a, b) => {
    if (a.availableAt !== b.availableAt) return a.availableAt - b.availableAt;
    return a.createdAt - b.createdAt;
  });
}

/** Extends the leases of rows still held by that owner; returns how many. */
export async function heartbeatOutboxLease(
  db: Db,
  options: { owner: string; ids: string[]; leaseMs: number; now?: number },
): Promise<number> {
  const at = new Date(options.now ?? Date.now());
  if (options.ids.length === 0) return 0;
  const rows = await asServer(db, (server) =>
    server.query<{ updated: unknown }>(
      `SELECT bob_private.outbox_heartbeat($1::text, $2::uuid[], $3::int, $4::timestamptz) AS updated`,
      [options.owner, options.ids, options.leaseMs, at],
    ),
  );
  return Number(rows[0]?.updated ?? 0);
}

/**
 * Marks a row delivered and clears its lease, only for a row that owner still
 * holds. A replayed ack on an already-delivered row is a no-op that returns
 * false.
 */
export async function ackOutbox(
  db: Db,
  options: { owner: string; id: string },
): Promise<boolean> {
  const rows = await asServer(db, (server) =>
    server.query<{ acked: unknown }>(
      `SELECT bob_private.outbox_ack($1::text, $2::uuid) AS acked`,
      [options.owner, options.id],
    ),
  );
  return rows[0]?.acked === true;
}

/** releaseOutbox options. retryInMs pushes available_at out; errorCode is a
 *  short code, never a message. */
type ReleaseOptions = {
  owner: string;
  id: string;
  retryInMs: number;
  errorCode?: string;
  now?: number;
};

/**
 * Releases a leased row back to the queue for a later retry: bumps attempts,
 * clears the lease, pushes available_at out by retryInMs. Only an owner-held
 * row is released; otherwise nothing changes.
 */
export async function releaseOutbox(
  db: Db,
  { owner, id, retryInMs, errorCode, now }: ReleaseOptions,
): Promise<StoredOutboxRow | null> {
  const at = new Date(now ?? Date.now());
  const rows = await asServer(db, (server) =>
    server.query<OutboxRow>(
      `SELECT * FROM bob_private.outbox_release($1::text, $2::uuid, $3::int, $4::text, $5::timestamptz)`,
      [owner, id, retryInMs, errorCode ?? null, at],
    ),
  );
  return rows.length === 0 ? null : rowToOutbox(rows[0]!);
}

/**
 * Clears leases whose lease_expires_at has passed so another worker can claim
 * them (a claimer that died without acking has its work reclaimed). Returns how
 * many leases were cleared. Retries are bounded by the caller's retry policy in
 * the drain worker, not here.
 */
export async function reclaimExpiredOutbox(db: Db, options: { now?: number } = {}): Promise<number> {
  const at = new Date(options.now ?? Date.now());
  const rows = await asServer(db, (server) =>
    server.query<{ reclaimed: unknown }>(
      `SELECT bob_private.outbox_reclaim_expired($1::timestamptz) AS reclaimed`,
      [at],
    ),
  );
  return Number(rows[0]?.reclaimed ?? 0);
}

/** The count of undelivered rows (delivered_at null). */
export async function pendingOutboxCount(db: Db): Promise<number> {
  const rows = await asServer(db, (server) =>
    server.query<{ count: unknown }>(`SELECT bob_private.outbox_pending_count() AS count`),
  );
  return Number(rows[0]?.count ?? 0);
}
/** Releases a deliberate delivery delay without consuming the failure budget. */
export async function deferOutbox(db: Db, options: { owner: string; id: string; retryInMs: number; now: number }): Promise<boolean> {
  const rows = await asServer(db,(server) => server.query<{ deferred: boolean }>(
    'select bob_private.outbox_defer($1,$2,$3,$4) as deferred',
    [options.owner,options.id,options.retryInMs,new Date(options.now)]));
  return rows[0]?.deferred === true;
}
