import { z } from 'zod';
import { StoreError, StoreConflictError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';

const inputSchema = z.object({
  operationId: z.string().uuid(), kind: z.enum(['calendar_create', 'calendar_update', 'gmail_draft', 'gmail_compose', 'gmail_update_draft', 'gmail_send', 'gmail_trash', 'gmail_restore']),
  targetHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  intentHash: z.string().regex(/^[a-f0-9]{64}$/), stableKey: z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/),
}).strict().refine((value) => {
  if (['gmail_compose', 'gmail_update_draft', 'gmail_send', 'gmail_trash', 'gmail_restore'].includes(value.kind) && !value.targetHash) return false;
  if (value.kind === 'calendar_create') return /^[a-v0-9]{5,1024}$/.test(value.stableKey);
  if (['gmail_draft', 'gmail_compose', 'gmail_update_draft', 'gmail_send'].includes(value.kind)) return /^<[A-Za-z0-9._-]+@[A-Za-z0-9.-]+>$/.test(value.stableKey);
  return /^[A-Za-z0-9_-]+$/.test(value.stableKey);
});
type OperationInput = z.infer<typeof inputSchema>;
type State = 'pending' | 'succeeded' | 'unknown' | 'failed';
interface Receipt extends OperationInput { state: State; resultId: string | null; createdAt: number; updatedAt: number }
interface Row {
  operation_id: string; target_hash: string | null; kind: OperationInput['kind']; intent_hash: string; stable_key: string;
  state: State; result_id: string | null; created_at: Date | string; updated_at: Date | string;
}
const columns = 'operation_id, target_hash, kind, intent_hash, stable_key, state, result_id, created_at, updated_at';
function map(row: Row): Receipt {
  return { ...(row.target_hash ? { targetHash: row.target_hash } : {}), operationId: row.operation_id, kind: row.kind, intentHash: row.intent_hash, stableKey: row.stable_key,
    state: row.state, resultId: row.result_id, createdAt: new Date(row.created_at).getTime(), updatedAt: new Date(row.updated_at).getTime() };
}
function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new StoreError('google_operation_invalid_input');
  return result.data;
}

function conflictingKinds(kind: OperationInput['kind']): OperationInput['kind'][] {
  if (kind === 'gmail_update_draft' || kind === 'gmail_send') return ['gmail_update_draft', 'gmail_send'];
  if (kind === 'gmail_trash' || kind === 'gmail_restore') return ['gmail_trash', 'gmail_restore'];
  return [kind];
}
async function checkUnresolvedTarget(tx: Db, accountId: string, value: OperationInput): Promise<void> {
  const unresolved = await tx.query(`select operation_id from bob.google_operations
    where google_account_id=$1 and target_hash=$2 and kind=any($3::text[])
      and state in ('pending','unknown') limit 1`, [accountId, value.targetHash, conflictingKinds(value.kind)]);
  if (unresolved.length) throw new StoreConflictError('google_operation_needs_review');
}

/** Only a newly inserted receipt authorizes an execution. Existing pending means reconcile, never takeover. */
export async function claimGoogleOperation(db: Db, owner: string, accountId: string, input: OperationInput): Promise<{ execute: boolean; receipt: Receipt }> {
  const value = validate(inputSchema, input);
  validate(z.string().uuid(), accountId);
  return withUser(db, owner, async (tx) => {
    const accounts = await tx.query<{ id: string }>('select id from bob.google_accounts where id = $1 for update', [accountId]);
    if (!accounts[0]) throw new StoreNotFoundError('google_account_not_found');
    const previous = (await tx.query<Row>(`select ${columns} from bob.google_operations where google_account_id = $1 and operation_id = $2`, [accountId, value.operationId]))[0];
    if (!previous && value.targetHash) await checkUnresolvedTarget(tx, accountId, value);
    const inserted = previous ? [] : await tx.query<Row>(`insert into bob.google_operations
      (user_id, google_account_id, operation_id, kind, intent_hash, stable_key, target_hash)
      values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing returning ${columns}`,
    [owner, accountId, value.operationId, value.kind, value.intentHash, value.stableKey, value.targetHash ?? null]);
    const existing = previous ?? inserted[0];
    if (!existing) throw new StoreError('google_operation_unavailable');
    if (existing.kind !== value.kind || existing.intent_hash !== value.intentHash || existing.stable_key !== value.stableKey || (existing.target_hash ?? undefined) !== value.targetHash) throw new StoreConflictError('google_operation_intent_mismatch');
    return { execute: inserted.length === 1, receipt: map(existing) };
  });
}

export async function getGoogleOperation(db: Db, owner: string, accountId: string, operationId: string): Promise<Receipt | null> {
  validate(z.string().uuid(), accountId);
  validate(z.string().uuid(), operationId);
  return withUser(db, owner, async (tx) => {
    const rows = await tx.query<Row>(`select ${columns} from bob.google_operations where google_account_id = $1 and operation_id = $2`, [accountId, operationId]);
    return rows[0] ? map(rows[0]) : null;
  });
}

/** Failed means definitive non-execution; unknown means outcome unproven. Neither grants a retry. */
export async function finishGoogleOperation(db: Db, owner: string, accountId: string, operationId: string, expected: 'pending' | 'unknown', state: 'succeeded' | 'unknown' | 'failed', resultId: string | null = null): Promise<Receipt | null> {
  validate(z.string().uuid(), accountId);
  validate(z.string().uuid(), operationId);
  validate(z.enum(['pending', 'unknown']), expected);
  validate(z.enum(['succeeded', 'unknown', 'failed']), state);
  if (expected === 'unknown' && state === 'unknown') throw new StoreError('google_operation_invalid_transition');
  if (state === 'succeeded') validate(z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/), resultId);
  else if (resultId !== null) throw new StoreError('google_operation_invalid_input');
  return withUser(db, owner, async (tx) => {
    const rows = await tx.query<Row>(`update bob.google_operations set state = $1, result_id = $2
      where google_account_id = $3 and operation_id = $4 and state = $5 returning ${columns}`,
    [state, resultId, accountId, operationId, expected]);
    return rows[0] ? map(rows[0]) : null;
  });
}
