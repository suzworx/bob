/**
 * AI invocation store: one row per explicit ask of Bob, recording the
 * authority at dispatch.
 * Every function runs under withUser() so RLS decides access from ACTIVE
 * membership in the invocation's space; an invocation in a space the caller is
 * not a member of is indistinguishable from one that does not exist (same
 * StoreNotFoundError, no separate code).
 *
 * Claim is the concurrency and idempotency point (both enforced in code AND
 * backstopped by the schema):
 *   - the partial unique index allows at most one `running` row per thread, so
 *     the AI serialises per thread while humans may keep posting;
 *   - the unique (actor_user_id, trigger_message_id) pair makes a retried
 *     request one invocation, not two.
 * A store outage surfaces as a thrown error; claim never guesses an outcome.
 */
import { StoreConflictError, StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { ChatAppBindingSchema, type ChatAppBinding } from './schemas.ts';

type InvocationState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

const INVOCATION_STATES: readonly InvocationState[] = ['queued', 'running', 'completed', 'failed', 'cancelled'];

function toInvocationState(value: unknown): InvocationState {
  return INVOCATION_STATES.includes(value as InvocationState) ? (value as InvocationState) : 'queued';
}

export type StoredInvocation = {
  id: string;
  spaceId: string;
  threadId: string;
  actorUserId: string;
  triggerMessageId: string;
  contextHighWater: number;
  membershipRevision: number;
  state: InvocationState;
  resultMessageId: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
  appBinding?: ChatAppBinding | null;
};

export class InvocationBusyError extends StoreError {
  constructor() {
    super('an invocation is already running in this thread');
    this.name = 'InvocationBusyError';
  }
}

type ClaimInput = {
  spaceId: string;
  threadId: string;
  triggerMessageId: string;
  contextHighWater: number;
  membershipRevision: number;
  appBinding?: ChatAppBinding;
};

/** The columns with timestamptz -> epoch-ms read-back (unqualified, so the same
 *  list works in SELECT and in INSERT/UPDATE ... RETURNING). */
const INVOCATION_COLUMNS = `id, space_id AS "spaceId", conversation_id AS "threadId",
  actor_user_id AS "actorUserId", trigger_message_id AS "triggerMessageId",
  context_high_water AS "contextHighWater", membership_revision AS "membershipRevision",
  state, result_message_id AS "resultMessageId", error_code AS "errorCode", app_binding AS "appBinding",
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt"`;

type InvocationRow = {
  id: unknown;
  spaceId: unknown;
  threadId: unknown;
  actorUserId: unknown;
  triggerMessageId: unknown;
  contextHighWater: unknown;
  membershipRevision: unknown;
  state: unknown;
  resultMessageId: unknown;
  errorCode: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  appBinding: unknown;
};

function normalizeBinding(value: unknown): ChatAppBinding | null {
  return value === null || value === undefined ? null : ChatAppBindingSchema.parse(value);
}

function rowToInvocation(row: InvocationRow): StoredInvocation {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    threadId: String(row.threadId),
    actorUserId: String(row.actorUserId),
    triggerMessageId: String(row.triggerMessageId),
    contextHighWater: Number(row.contextHighWater),
    membershipRevision: Number(row.membershipRevision),
    state: toInvocationState(row.state),
    resultMessageId: row.resultMessageId === null ? null : String(row.resultMessageId),
    errorCode: row.errorCode === null ? null : String(row.errorCode),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    appBinding: normalizeBinding(row.appBinding),
  };
}

async function readInvocationRow(tx: Db, id: string): Promise<InvocationRow | null> {
  const rows = await tx.query<InvocationRow>(
    `SELECT ${INVOCATION_COLUMNS} FROM bob.ai_invocations WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Postgres 23505 unique_violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

/**
 * Claims an invocation as `running`. The outcome tells the caller which case:
 *   - { claimed: true }  a fresh row was inserted as running;
 *   - { claimed: false, reason: 'duplicate' } the same (actor, trigger) already
 *     exists -- idempotent, return the original without re-running;
 *   - throws InvocationBusyError when another invocation is already running in
 *     this thread (the AI serialises; humans may keep posting).
 * Both invariants are checked first then backstopped by the schema's partial
 * unique index and (actor, trigger) pair, so a concurrent race cannot slip
 * through the code-only guard.
 */
export async function claimInvocation(
  db: Db,
  userId: string,
  input: ClaimInput,
  authorize?: (tx: Db) => Promise<void>,
): Promise<{ claimed: boolean; invocation: StoredInvocation }> {
  const binding = normalizeBinding(input.appBinding);
  if (binding && !authorize) throw new StoreError('A bound invocation requires current app authorization');
  return withUser(db, userId, async (tx) => {
    // The workflow's callback rechecks and locks the audience/app in this same
    // transaction. A duplicate must not bypass a pause, removal or revocation.
    if (authorize) await authorize(tx);
    const duplicate = await tx.query<InvocationRow>(
      `SELECT ${INVOCATION_COLUMNS} FROM bob.ai_invocations
       WHERE actor_user_id = $1 AND trigger_message_id = $2`,
      [userId, input.triggerMessageId],
    );
    if (duplicate.length > 0) {
      return duplicateResult(duplicate[0]!, binding);
    }

    const running = await tx.query<InvocationRow>(
      `SELECT ${INVOCATION_COLUMNS} FROM bob.ai_invocations
       WHERE conversation_id = $1 AND state = 'running'`,
      [input.threadId],
    );
    if (running.length > 0) throw new InvocationBusyError();

    // Both unique indexes may win a concurrent race. DO NOTHING keeps this
    // transaction usable for the distinguishing read instead of raising 23505.
    const rows = await tx.query<InvocationRow>(
      `INSERT INTO bob.ai_invocations
         (space_id, conversation_id, actor_user_id, trigger_message_id,
          context_high_water, membership_revision, state, app_binding)
       VALUES ($1, $2, $3, $4, $5, $6, 'running', $7::text::jsonb)
       ON CONFLICT DO NOTHING RETURNING ${INVOCATION_COLUMNS}`,
      [input.spaceId, input.threadId, userId, input.triggerMessageId,
        input.contextHighWater, input.membershipRevision, binding === null ? null : JSON.stringify(binding)],
    );
    if (rows.length > 0) return { claimed: true, invocation: rowToInvocation(rows[0]!) };
    const raced = await tx.query<InvocationRow>(
      `SELECT ${INVOCATION_COLUMNS} FROM bob.ai_invocations
       WHERE actor_user_id = $1 AND trigger_message_id = $2`,
      [userId, input.triggerMessageId],
    );
    if (raced.length > 0) return duplicateResult(raced[0]!, binding);
    throw new InvocationBusyError();
  });
}

function duplicateResult(row: InvocationRow, binding: ChatAppBinding | null): { claimed: false; invocation: StoredInvocation } {
  const invocation = rowToInvocation(row);
  if (JSON.stringify(invocation.appBinding) !== JSON.stringify(binding)) {
    throw new StoreConflictError('This request already targets a different app or campaign.');
  }
  return { claimed: false, invocation };
}

/** Reads one invocation. A caller who is not an active member of its space gets
 *  the identical StoreNotFoundError as a missing id (identity-leak rule). */
export async function getInvocation(
  db: Db,
  userId: string,
  invocationId: string,
): Promise<StoredInvocation> {
  return withUser(db, userId, async (tx) => {
    const row = await readInvocationRow(tx, invocationId);
    if (!row) throw new StoreNotFoundError('invocation not found');
    return rowToInvocation(row);
  });
}

/** Cancels a `running`/`queued` invocation. Only the requesting actor may
 *  cancel their own (the WHERE pins actor_user_id): another member's or a
 *  hidden invocation answers the identical StoreNotFoundError as a missing id.
 *  A completed/failed/cancelled invocation is returned unchanged (no-op). */
export async function cancelInvocation(
  db: Db,
  userId: string,
  invocationId: string,
): Promise<StoredInvocation> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<InvocationRow>(
      `UPDATE bob.ai_invocations
       SET state = 'cancelled', updated_at = now()
       WHERE id = $1 AND actor_user_id = $2 AND state IN ('running', 'queued')
       RETURNING ${INVOCATION_COLUMNS}`,
      [invocationId, userId],
    );
    if (rows.length > 0) return rowToInvocation(rows[0]!);
    const current = await readInvocationRow(tx, invocationId);
    if (!current || String(current.actorUserId) !== userId) {
      throw new StoreNotFoundError('invocation not found');
    }
    return rowToInvocation(current);
  });
}

/** The finalizer's to_jsonb row (snake_case keys, ISO timestamps): the definer
 *  bypasses RLS to return the row even after a revoke, so INVOCATION_COLUMNS
 *  cannot be used. */
function jsonToInvocation(row: Record<string, unknown>): StoredInvocation {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    threadId: String(row.conversation_id),
    actorUserId: String(row.actor_user_id),
    triggerMessageId: String(row.trigger_message_id),
    contextHighWater: Number(row.context_high_water),
    membershipRevision: Number(row.membership_revision),
    state: toInvocationState(row.state),
    resultMessageId: row.result_message_id === null ? null : String(row.result_message_id),
    errorCode: row.error_code === null ? null : String(row.error_code),
    createdAt: Date.parse(String(row.created_at)),
    updatedAt: Date.parse(String(row.updated_at)),
    appBinding: normalizeBinding(row.app_binding),
  };
}

/** Marks an invocation with a terminal state and optional result/error. Runs
 *  through the revocation-safe definer (bob_private.finalize_invocation), so
 *  the write survives the actor losing membership mid-generation -- the very
 *  case cancellation exists for -- while still being pinned to the caller's
 *  own row (actor_user_id = auth.uid()). Returns the updated row, or
 *  StoreNotFoundError when it is not theirs or missing. */
export async function setInvocationState(
  db: Db,
  userId: string,
  invocationId: string,
  state: Exclude<InvocationState, 'queued' | 'running'>,
  fields: { resultMessageId?: string | null; errorCode?: string | null } = {},
): Promise<StoredInvocation> {
  return withUser(db, userId, async (tx) => {
    const finalized = await tx.query<{ finalize_invocation: unknown }>(
      `select bob_private.finalize_invocation($1, $2, $3, $4) as finalize_invocation`,
      [invocationId, state, fields.resultMessageId ?? null, fields.errorCode ?? null],
    );
    const row = finalized[0]?.finalize_invocation;
    if (!row || typeof row !== 'object') throw new StoreNotFoundError('invocation not found');
    return jsonToInvocation(row as Record<string, unknown>);
  });
}
