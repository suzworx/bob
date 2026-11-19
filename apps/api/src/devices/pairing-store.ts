/**
 * Typed wrappers over the bob_private pairing/device functions: server-only
 * ones under asServer, user-context ones under withUser. Callers pass SHA-256
 * hashes for codes, claims and device tokens -- raw secrets never enter SQL.
 *
 * deny_pairing silently no-ops on a non-pending pairing, so a cross-account
 * deny leaves the owner's pairing untouched and raises nothing.
 */
import { createHash } from 'node:crypto';
import { asServer, StoreError, withUser, type Db } from '../platform/db/db.ts';

/** The generic 404: pairing absent, not approvable, not owned, or unauthenticated. */
export class PairingNotFoundError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = 'PairingNotFoundError';
  }
}

/** A pending pairing already holds this code hash; retry with a fresh code. */
export class PairingCodeCollisionError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = 'PairingCodeCollisionError';
  }
}

export function sha256(value: string): Uint8Array {
  return createHash('sha256').update(value, 'utf8').digest();
}

function mapPairingError(error: unknown): unknown {
  if (error instanceof PairingNotFoundError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes('pairing request not approvable') ||
    message.includes('device not found or not owned') ||
    message.includes('not authenticated')
  ) {
    return new PairingNotFoundError(message);
  }
  return error;
}

function isCodeCollision(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  return (
    err?.code === '23505' ||
    (typeof err?.message === 'string' &&
      err.message.includes('duplicate key value violates unique constraint') &&
      err.message.includes('pairing_requests_pending_code_idx'))
  );
}

interface IssuePairingInput {
  codeHash: Uint8Array;
  claimHash: Uint8Array;
  model: string;
  fwVersion: string;
  ipHash: string;
  ttlSeconds: number;
}

export async function issuePairing(db: Db, input: IssuePairingInput): Promise<string> {
  return asServer(db, async (sdb) => {
    try {
      const rows = await sdb.query<{ issue_pairing: string }>(
        'select bob_private.issue_pairing($1, $2, $3, $4, $5, $6) as issue_pairing',
        [
          input.codeHash,
          input.claimHash,
          input.model,
          input.fwVersion,
          input.ipHash,
          input.ttlSeconds,
        ],
      );
      const row = rows[0];
      if (!row) throw new StoreError('issuePairing: no row');
      return row.issue_pairing;
    } catch (error) {
      if (isCodeCollision(error)) {
        throw new PairingCodeCollisionError('pairing code already pending');
      }
      throw error;
    }
  });
}

/** Null when the claim does not match or the device has already authenticated. */
export async function claimPairing(
  db: Db,
  pairingId: string,
  claimHash: Uint8Array,
  tokenHash: Uint8Array,
): Promise<{ deviceId: string; name: string } | null> {
  return asServer(db, async (sdb) => {
    const rows = await sdb.query<{ device_id: string; name: string }>(
      'select * from bob_private.claim_pairing($1, $2, $3)',
      [pairingId, claimHash, tokenHash],
    );
    const row = rows[0];
    return row ? { deviceId: row.device_id, name: row.name } : null;
  });
}

export async function deviceForToken(
  db: Db,
  tokenHash: Uint8Array,
): Promise<{
  deviceId: string;
  userId: string;
  name: string;
  revoked: boolean;
  disabled: boolean;
} | null> {
  return asServer(db, async (sdb) => {
    const rows = await sdb.query<{
      device_id: string;
      user_id: string;
      name: string;
      revoked: boolean;
      disabled: boolean;
    }>('select * from bob_private.device_for_token($1)', [tokenHash]);
    const row = rows[0];
    if (!row) return null;
    return {
      deviceId: row.device_id,
      userId: row.user_id,
      name: row.name,
      revoked: row.revoked,
      disabled: row.disabled,
    };
  });
}

export async function touchDevice(db: Db, deviceId: string): Promise<void> {
  return asServer(db, async (sdb) => {
    await sdb.query('select bob_private.touch_device($1)', [deviceId]);
  });
}

/** Whether the account is disabled by a future banned_until. */
export async function accountDisabled(db: Db, userId: string): Promise<boolean> {
  return asServer(db, async (sdb) => {
    const rows = await sdb.query<{ account_disabled: boolean }>(
      'select bob_private.account_disabled($1) as account_disabled',
      [userId],
    );
    const row = rows[0];
    if (!row) throw new StoreError('accountDisabled: no row');
    return row.account_disabled;
  });
}

export async function lookupPairing(
  db: Db,
  userId: string,
  codeHash: Uint8Array,
): Promise<{
  pairingId: string;
  deviceModel: string;
  requestedAt: number;
  expiresAt: number;
} | null> {
  return withUser(db, userId, async (tx) => {
    try {
      const rows = await tx.query<{
        id: string;
        status: string;
        device_model: string;
        created_at: Date | string;
        expires_at: Date | string;
      }>('select * from bob_private.lookup_pairing($1)', [codeHash]);
      const row = rows[0];
      if (!row) return null;
      return {
        pairingId: row.id,
        deviceModel: row.device_model,
        requestedAt: new Date(row.created_at).getTime(),
        expiresAt: new Date(row.expires_at).getTime(),
      };
    } catch (error) {
      throw mapPairingError(error);
    }
  });
}

/** Creates the device row with a NULL token hash; returns the device id. */
export async function approvePairing(
  db: Db,
  userId: string,
  pairingId: string,
  name?: string,
): Promise<string> {
  return withUser(db, userId, async (tx) => {
    try {
      const rows = await tx.query<{ approve_pairing: string }>(
        'select bob_private.approve_pairing($1, $2) as approve_pairing',
        [pairingId, name ?? null],
      );
      const row = rows[0];
      if (!row) throw new StoreError('approvePairing: no row');
      return row.approve_pairing;
    } catch (error) {
      throw mapPairingError(error);
    }
  });
}

export async function denyPairing(db: Db, userId: string, pairingId: string): Promise<void> {
  return withUser(db, userId, async (tx) => {
    await tx.query('select bob_private.deny_pairing($1)', [pairingId]);
  });
}

export async function revokeDevice(db: Db, userId: string, deviceId: string): Promise<void> {
  return withUser(db, userId, async (tx) => {
    try {
      await tx.query('select bob_private.revoke_device($1)', [deviceId]);
    } catch (error) {
      throw mapPairingError(error);
    }
  });
}
