import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import type { GoogleCapability } from './google-credentials.ts';

const capabilitiesSchema = z.array(z.enum(['calendar.read', 'calendar.write', 'gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'])).min(1).max(6);
const uuidSchema = z.uuid();

interface ConsentIntent {
  subject: string;
  capabilities: GoogleCapability[];
  reconnectAccountId: string | null;
  expiresAt: number;
}

interface ConsentRow {
  connect_subject: string;
  capabilities: GoogleCapability[];
  reconnect_account_id: string | null;
  expires_at: Date | string;
}

function map(row: ConsentRow): ConsentIntent {
  return { subject: row.connect_subject, capabilities: row.capabilities,
    reconnectAccountId: row.reconnect_account_id, expiresAt: new Date(row.expires_at).getTime() };
}

function hash(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

/** Persist before starting provider authorization. Raw state is returned once. */
export async function createGoogleConsentAttempt(
  db: Db, userId: string,
  input: { capabilities: readonly GoogleCapability[]; reconnectAccountId?: string },
): Promise<ConsentIntent & { state: string }> {
  const capabilities = [...new Set(capabilitiesSchema.parse(input.capabilities))];
  const reconnectId = input.reconnectAccountId === undefined ? null : uuidSchema.parse(input.reconnectAccountId);
  const state = randomBytes(32).toString('base64url');
  return withUser(db, userId, async (tx) => {
    // Share the finalization/purge lock so an uncommitted attempt cannot
    // become visible only after an overlapping account purge has finished.
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`google-accounts:${userId}`]);
    const subject = await connectionSubject(tx, reconnectId);
    // A newer reconnect supersedes even a consumed attempt whose token
    // exchange is still running. Its finalization must not roll back selection.
    if (reconnectId !== null) await tx.query(
      'delete from bob.google_consent_attempts where reconnect_account_id = $1', [reconnectId],
    );
    // Opportunistically remove this owner's expired attempts.
    await tx.query('delete from bob.google_consent_attempts where expires_at <= now()');
    const rows = await tx.query<ConsentRow>(
      `insert into bob.google_consent_attempts
       (user_id, state_hash, connect_subject, capabilities, reconnect_account_id)
       values ($1, $2, $3, $4, $5) returning *`,
      [userId, hash(state), subject, capabilities, reconnectId],
    );
    const row = rows[0];
    if (!row) throw new Error('google_consent_insert_failed');
    return { ...map(row), state };
  });
}

async function connectionSubject(tx: Db, reconnectId: string | null): Promise<string> {
  if (reconnectId === null) return `gc_${randomBytes(32).toString('base64url')}`;
  const rows = await tx.query<{ connect_subject: string | null }>(
    'select connect_subject from bob.google_accounts where id = $1 for key share', [reconnectId],
  );
  const subject = rows[0]?.connect_subject;
  if (!subject) throw new StoreNotFoundError('google_reconnect_unavailable');
  return subject;
}

/** A callback consumes its owner-bound intent once, before any token exchange. */
export async function consumeGoogleConsentAttempt(db: Db, userId: string, state: string): Promise<(ConsentIntent & { completionHash: string }) | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<ConsentRow>(
      `update bob.google_consent_attempts set consumed_at = now()
       where state_hash = $1 and expires_at > now() and consumed_at is null
       returning connect_subject, capabilities, reconnect_account_id, expires_at`, [hash(state)],
    );
    return rows[0] ? { ...map(rows[0]), completionHash: hash(state) } : null;
  });
}
