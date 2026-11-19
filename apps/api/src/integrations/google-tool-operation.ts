import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StoreConflictError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { claimGoogleOperation, getGoogleOperation } from './google-operation-store.ts';

const brand = Symbol('server mutation slot');
export interface GoogleMutationSlot {
  readonly [brand]: true;
  readonly conversationId: string;
  readonly messageId: string;
  readonly ordinal: number;
  readonly allowNewOperations: boolean;
}
const issued = new WeakSet<GoogleMutationSlot>();
/** Construct only from a trusted persisted user turn, never model input. Replays
 * and regenerations MUST set allowNewOperations:false. Ordinals are server-owned. */
export function createGoogleMutationSlots(anchor: { conversationId: string; messageId: string; allowNewOperations: boolean }): { next(): GoogleMutationSlot } {
  let ordinal = 0;
  return { next() {
    if (ordinal >= 100) throw new Error('google_operation_limit');
    const slot: GoogleMutationSlot = Object.freeze({ ...anchor, ordinal: ordinal++, [brand]: true as const });
    issued.add(slot);
    return slot;
  } };
}
const intentSchema = z.object({
  kind: z.enum(['calendar_create', 'calendar_update', 'gmail_draft', 'gmail_compose', 'gmail_update_draft', 'gmail_send', 'gmail_trash', 'gmail_restore']),
  intentHash: z.string().regex(/^[a-f0-9]{64}$/), targetHash: z.string().regex(/^[a-f0-9]{64}$/),
  targetMessageId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
  updateEventId: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/).optional(),
}).strict().refine((v) => (v.kind === 'calendar_update') === (v.updateEventId !== undefined)).refine((v) => ['gmail_trash', 'gmail_restore'].includes(v.kind) === (v.targetMessageId !== undefined));
type Intent = z.infer<typeof intentSchema>;
type Claim = Awaited<ReturnType<typeof claimGoogleOperation>>;
interface Mapping { google_account_id: string; kind: string; intent_hash: string; target_hash: string; operation_id: string }

async function validateAnchor(tx: Db, owner: string, accountId: string, slot: GoogleMutationSlot): Promise<void> {
  const account = await tx.query('select id from bob.google_accounts where id=$1 for update', [accountId]);
  if (!account.length) throw new StoreNotFoundError('google_account_not_found');
  const anchors = await tx.query(`select m.id from bob.messages m
    join bob.conversations c on c.id=m.conversation_id
    join bob.spaces s on s.id=c.space_id
    where m.id=$1 and c.id=$2 and m.user_id=$3 and c.user_id=$3
      and m.role='user' and c.archived_at is null and s.kind='private' and s.archived_at is null`,
  [slot.messageId, slot.conversationId, owner]);
  if (!anchors.length) throw new StoreNotFoundError('google_operation_anchor_unavailable');
}
async function receipt(tx: Db, owner: string, accountId: string, row: Mapping, intent: Intent): Promise<Claim> {
  if (row.google_account_id !== accountId || row.kind !== intent.kind || row.intent_hash !== intent.intentHash || row.target_hash !== intent.targetHash) throw new StoreConflictError('google_operation_needs_review');
  const found = await getGoogleOperation(tx, owner, accountId, row.operation_id);
  if (!found) throw new Error('google_operation_unavailable');
  return { execute: false, receipt: found };
}
async function bind(tx: Db, owner: string, accountId: string, slot: GoogleMutationSlot, intent: Intent, operationId: string): Promise<void> {
  await tx.query(`insert into bob.google_operation_slots
    (user_id,google_account_id,anchor_message_id,ordinal,kind,intent_hash,target_hash,operation_id)
    values($1,$2,$3,$4,$5,$6,$7,$8)`,
  [owner, accountId, slot.messageId, slot.ordinal, intent.kind, intent.intentHash, intent.targetHash, operationId]);
}

function targetKinds(kind: Intent['kind']): Intent['kind'][] {
  if (kind === 'gmail_update_draft' || kind === 'gmail_send') return ['gmail_update_draft', 'gmail_send'];
  if (kind === 'gmail_trash' || kind === 'gmail_restore') return ['gmail_trash', 'gmail_restore'];
  return [kind];
}

/** Root Db only, outside an outer transaction: commit reservation BEFORE HTTP.
 * Services supply their own canonical intent and resolved provider target hashes.
 * No provider payload or credentials are stored. Existing claims never execute. */
export async function claimGoogleToolOperation(db: Db, owner: string, accountId: string, slot: GoogleMutationSlot, input: Intent): Promise<Claim> {
  if (!issued.has(slot)) throw new Error('google_operation_invalid_slot');
  const intent = intentSchema.parse(input);
  z.string().uuid().parse(accountId);
  return withUser(db, owner, async (tx) => {
    await validateAnchor(tx, owner, accountId, slot);
    const mappings = await tx.query<Mapping>(`select * from bob.google_operation_slots
      where anchor_message_id=$1 and (ordinal=$2 or (google_account_id=$3 and kind=$4 and intent_hash=$5))
      order by (ordinal=$2) desc`, [slot.messageId, slot.ordinal, accountId, intent.kind, intent.intentHash]);
    const existing = mappings[0];
    if (existing) return receipt(tx, owner, accountId, existing, intent);
    if (!slot.allowNewOperations) throw new StoreConflictError('google_operation_replay_missing');
    const unresolved = await tx.query<Mapping>(`select s.* from bob.google_operation_slots s
      join bob.google_operations o using(user_id,google_account_id,operation_id)
      where s.google_account_id=$1 and s.kind=any($2::text[]) and s.target_hash=$3
        and o.state in ('pending','unknown') limit 1`, [accountId, targetKinds(intent.kind), intent.targetHash]);
    const prior = unresolved[0];
    if (prior) {
      const claim = await receipt(tx, owner, accountId, prior, intent);
      await bind(tx, owner, accountId, slot, intent, prior.operation_id);
      return claim;
    }
    const operationId = randomUUID();
    const stableKey = intent.updateEventId ?? intent.targetMessageId ?? (['gmail_draft', 'gmail_compose', 'gmail_update_draft', 'gmail_send'].includes(intent.kind) ? `<bob-${operationId}@heybob.xyz>` : operationId.replaceAll('-', ''));
    const claim = await claimGoogleOperation(tx, owner, accountId, { operationId, kind: intent.kind, intentHash: intent.intentHash, stableKey, ...(intent.kind.startsWith('gmail_') && intent.kind !== 'gmail_draft' ? { targetHash: intent.targetHash } : {}) });
    await bind(tx, owner, accountId, slot, intent, operationId);
    return claim;
  });
}
