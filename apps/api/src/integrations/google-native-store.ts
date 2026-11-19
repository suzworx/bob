import { createHash, randomBytes } from 'node:crypto';
import { withUser, type Db } from '../platform/db/db.ts';
import { getGoogleAccount, saveVerifiedGoogleConnection } from './google-store.ts';
import { GoogleNativeAuthorizeSchema, GoogleNativeProofSchema, type GoogleNativeProof } from './google-native-schemas.ts';
import type { z } from 'zod';
import type { GoogleCapability } from './google-credentials.ts';
import type { verifyGoogleGrant } from './google-grant.ts';

export class GoogleNativeUnavailable extends Error {
  readonly code = 'google_authorization_unavailable';
  constructor() { super('google_authorization_unavailable'); }
}
type Account = NonNullable<Awaited<ReturnType<typeof getGoogleAccount>>>;
export type GoogleNativeResult = { status: 'completed'; account: Account }
  | { status: 'processing'; retryAfterMs: number } | { status: 'failed' | 'cancelled' | 'expired' };
interface Attempt {
  id: string; user_id: string; connect_subject: string; capabilities: GoogleCapability[];
  reconnect_account_id: string | null; expires_at: Date | string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired';
  result_account_id: string | null; claim_deadline: Date | string | null;
}
const columns = 'id,user_id,connect_subject,capabilities,reconnect_account_id,expires_at,status,result_account_id,claim_deadline';
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const challenge = (value: string): string => createHash('sha256').update(value).digest('base64url');

async function owned<T>(db: Db, userId: string, sessionId: string, work: (tx: Db) => Promise<T>): Promise<T> {
  return withUser(db, userId, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`google-accounts:${userId}`]);
    const [row] = await tx.query<{ active: boolean }>('select bob_private.google_native_session_active($1::uuid) as active', [sessionId]);
    if (!row?.active) throw new GoogleNativeUnavailable();
    return work(tx);
  });
}

export async function createGoogleNativeAttempt(db: Db, userId: string, sessionId: string, input: z.infer<typeof GoogleNativeAuthorizeSchema>): Promise<Attempt & { state: string }> {
  const body = GoogleNativeAuthorizeSchema.parse(input);
  return owned(db, userId, sessionId, async (tx) => {
    let subject = `gc_${randomBytes(32).toString('base64url')}`;
    if (body.reconnectAccountId) {
      const account = await getGoogleAccount(tx, userId, body.reconnectAccountId);
      if (!account?.connectSubject) throw new GoogleNativeUnavailable();
      subject = account.connectSubject;
      await tx.query('delete from bob.google_consent_attempts where reconnect_account_id=$1', [body.reconnectAccountId]);
      await tx.query('delete from bob.google_native_consent_attempts where reconnect_account_id=$1', [body.reconnectAccountId]);
    }
    await tx.query('delete from bob.google_native_consent_attempts where expires_at<=now()');
    const [count] = await tx.query<{ total: number }>('select count(*)::int as total from bob.google_native_consent_attempts');
    if ((count?.total ?? 20) >= 20) throw new GoogleNativeUnavailable();
    const state = randomBytes(32).toString('base64url');
    const [row] = await tx.query<Attempt>(`insert into bob.google_native_consent_attempts
      (user_id,session_id,state_hash,code_challenge,connect_subject,capabilities,reconnect_account_id)
      values($1,$2,$3,$4,$5,$6,$7) returning ${columns}`,
    [userId,sessionId,digest(state),body.codeChallenge,subject,[...new Set(body.capabilities)],body.reconnectAccountId ?? null]);
    if (!row) throw new GoogleNativeUnavailable();
    return { ...row, state };
  });
}

async function load(tx: Db, sessionId: string, proof: GoogleNativeProof): Promise<Attempt> {
  const p = GoogleNativeProofSchema.parse(proof);
  const [row] = await tx.query<Attempt>(`select ${columns} from bob.google_native_consent_attempts
    where id=$1 and session_id=$2 and state_hash=$3 and code_challenge=$4 for update`,
  [p.attemptId,sessionId,digest(p.state),challenge(p.codeVerifier)]);
  if (!row) throw new GoogleNativeUnavailable();
  if (new Date(row.expires_at).getTime() <= Date.now()) return change(tx,row,'expired');
  if (row.status === 'processing' && row.claim_deadline && new Date(row.claim_deadline).getTime() <= Date.now()) return change(tx,row,'failed');
  return row;
}

async function change(tx: Db, row: Attempt, status: 'failed' | 'cancelled' | 'expired'): Promise<Attempt> {
  await tx.query('update bob.google_native_consent_attempts set status=$2,result_account_id=null where id=$1', [row.id,status]);
  return { ...row, status, result_account_id: null };
}

async function result(tx: Db, row: Attempt): Promise<GoogleNativeResult> {
  if (row.status === 'completed' && row.result_account_id) {
    const account = await getGoogleAccount(tx,row.user_id,row.result_account_id);
    if (!account) throw new GoogleNativeUnavailable();
    return { status: 'completed', account };
  }
  if (row.status === 'pending' || row.status === 'processing') return { status: 'processing', retryAfterMs: 1000 };
  if (row.status === 'completed') throw new GoogleNativeUnavailable();
  return { status: row.status };
}

export async function claimGoogleNativeAttempt(db: Db, userId: string, sessionId: string, proof: GoogleNativeProof): Promise<{ claimed: Attempt } | { result: GoogleNativeResult }> {
  return owned(db,userId,sessionId,async (tx) => {
    const row = await load(tx,sessionId,proof);
    if (row.status !== 'pending') return { result: await result(tx,row) };
    await tx.query(`update bob.google_native_consent_attempts set status='processing',
      claim_deadline=least(expires_at,now()+interval '45 seconds') where id=$1`,[row.id]);
    return { claimed: row };
  });
}

export async function cancelGoogleNativeAttempt(db: Db, userId: string, sessionId: string, proof: GoogleNativeProof): Promise<GoogleNativeResult> {
  return owned(db,userId,sessionId,async (tx) => {
    const row = await load(tx,sessionId,proof);
    return result(tx,row.status === 'pending' || row.status === 'processing' ? await change(tx,row,'cancelled') : row);
  });
}

export async function finishGoogleNativeAttempt(
  db: Db, userId: string, sessionId: string, proof: GoogleNativeProof,
  grant: Awaited<ReturnType<typeof verifyGoogleGrant>> | null,
): Promise<GoogleNativeResult> {
  return owned(db,userId,sessionId,async (tx) => {
    const row = await load(tx,sessionId,proof);
    if (row.status !== 'processing') return result(tx,row);
    if (!grant) return result(tx,await change(tx,row,'failed'));
    const account = await saveVerifiedGoogleConnection(tx,userId,{
      subject: row.connect_subject, reconnectAccountId: row.reconnect_account_id,
      providerAccountId: grant.providerAccountId, email: grant.email, name: grant.name ?? null,
    },row.capabilities);
    // Session revocation can race the provider call; this transaction checks it
    // after acquiring the same owner lock as consent creation and erasure.
    await tx.query(`update bob.google_native_consent_attempts set status='completed',result_account_id=$2 where id=$1`, [row.id,account.id]);
    return { status: 'completed', account };
  });
}

export async function abandonGoogleNativeAttempt(db: Db, userId: string, sessionId: string, attemptId: string): Promise<void> {
  await owned(db,userId,sessionId,(tx) => tx.query(`update bob.google_native_consent_attempts set status='failed'
    where id=$1 and status='pending'`,[attemptId]));
}
