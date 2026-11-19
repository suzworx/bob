// Store pairing tests (T016, specs/008-supabase-auth-pairing).
// The test-database path runs always (a per-file copy of the migrated template
// via createTestDb, wrapped by asDb). The getDb() path runs only when BOB_TEST_DB_URL
// points at the local Supabase stack (postgresql://postgres:postgres@127.0.0.1:
// 54322/postgres) — it proves bytea parameters survive the postgres.js adapter.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountDisabled,
  approvePairing,
  claimPairing,
  denyPairing,
  deviceForToken,
  issuePairing,
  lookupPairing,
  PairingCodeCollisionError,
  PairingNotFoundError,
  revokeDevice,
  sha256,
  touchDevice,
} from '../../src/devices/pairing-store.ts';
import { closeDb, getDb, type Db } from '../../src/platform/db/db.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

/** Issues a pending pairing with a unique code (unless overridden) and claim. */
async function issuePairingFor(
  db: Db,
  overrides: { code?: string; ttlSeconds?: number } = {},
): Promise<{ pairingId: string; codeHash: Uint8Array; claimHash: Uint8Array }> {
  const code = overrides.code ?? `pair-${randomUUID()}`;
  const claim = `claim-${randomUUID()}`;
  const codeHash = sha256(code);
  const claimHash = sha256(claim);
  const pairingId = await issuePairing(db, {
    codeHash,
    claimHash,
    model: 'M5Stack Cardputer',
    fwVersion: '0.9.0',
    ipHash: 'ip-hash-1',
    ttlSeconds: overrides.ttlSeconds ?? 600,
  });
  return { pairingId, codeHash, claimHash };
}

describe('store pairing (test database)', () => {
  let pg: TestDb;
  let db: Db;
  let accountA: TestAccount;
  let accountB: TestAccount;
  let bannedAccount: TestAccount;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    accountA = await addAccount(pg);
    accountB = await addAccount(pg);
    bannedAccount = await addAccount(pg, { banned: true });
  });

  afterAll(async () => {
    await closeTestDb(pg);
  });

  it('issue → lookup → approve → claim sets the token → deviceForToken finds it', async () => {
    const { pairingId, codeHash, claimHash } = await issuePairingFor(db);
    const lookup = await lookupPairing(db, accountA.userId, codeHash);
    expect(lookup).not.toBeNull();
    expect(lookup!.pairingId).toBe(pairingId);
    expect(lookup!.deviceModel).toBe('M5Stack Cardputer');
    expect(lookup!.requestedAt).toBeGreaterThan(0);
    expect(lookup!.expiresAt).toBeGreaterThan(lookup!.requestedAt);
    const deviceId = await approvePairing(db, accountA.userId, pairingId, 'Kitchen Card');
    const tokenHash = sha256('olxd_happy');
    expect(await claimPairing(db, pairingId, claimHash, tokenHash)).toEqual({
      deviceId,
      name: 'Kitchen Card',
    });
    expect(await deviceForToken(db, tokenHash)).toEqual({
      deviceId,
      userId: accountA.userId,
      name: 'Kitchen Card',
      revoked: false,
      disabled: false,
    });
  });

  it('claim with a mismatched claim returns null and consumes nothing', async () => {
    const { pairingId, claimHash } = await issuePairingFor(db);
    const deviceId = await approvePairing(db, accountA.userId, pairingId);
    expect(await claimPairing(db, pairingId, sha256('wrong-claim'), sha256('olxd_wrong'))).toBeNull();
    expect((await claimPairing(db, pairingId, claimHash, sha256('olxd_right')))?.deviceId).toBe(
      deviceId,
    );
  });

  it('re-claim before first authentication re-issues with a new token hash', async () => {
    const { pairingId, claimHash } = await issuePairingFor(db);
    await approvePairing(db, accountA.userId, pairingId);
    const first = sha256('olxd_first');
    const second = sha256('olxd_second');
    expect(await claimPairing(db, pairingId, claimHash, first)).not.toBeNull();
    expect(await claimPairing(db, pairingId, claimHash, second)).not.toBeNull();
    expect(await deviceForToken(db, first)).toBeNull();
    expect(await deviceForToken(db, second)).not.toBeNull();
  });

  it('claim after first authentication (touchDevice) returns null', async () => {
    const { pairingId, claimHash } = await issuePairingFor(db);
    const deviceId = await approvePairing(db, accountA.userId, pairingId);
    const tokenHash = sha256('olxd_once');
    await claimPairing(db, pairingId, claimHash, tokenHash);
    await touchDevice(db, deviceId);
    expect(await claimPairing(db, pairingId, claimHash, sha256('olxd_twice'))).toBeNull();
    expect((await deviceForToken(db, tokenHash))?.deviceId).toBe(deviceId);
  });

  it('deny consumes the pairing so lookup returns null', async () => {
    const { pairingId, codeHash } = await issuePairingFor(db);
    await denyPairing(db, accountA.userId, pairingId);
    expect(await lookupPairing(db, accountA.userId, codeHash)).toBeNull();
  });

  it('approving an already-approved pairing raises PairingNotFoundError', async () => {
    const { pairingId } = await issuePairingFor(db);
    await approvePairing(db, accountA.userId, pairingId);
    await expect(approvePairing(db, accountA.userId, pairingId)).rejects.toBeInstanceOf(
      PairingNotFoundError,
    );
  });

  it('approving an already-denied pairing raises PairingNotFoundError', async () => {
    const { pairingId } = await issuePairingFor(db);
    await denyPairing(db, accountA.userId, pairingId);
    await expect(approvePairing(db, accountA.userId, pairingId)).rejects.toBeInstanceOf(
      PairingNotFoundError,
    );
  });

  it("account B cannot approve or revoke A's device (not found)", async () => {
    const { pairingId, claimHash } = await issuePairingFor(db);
    const deviceId = await approvePairing(db, accountA.userId, pairingId);
    await expect(approvePairing(db, accountB.userId, pairingId)).rejects.toBeInstanceOf(
      PairingNotFoundError,
    );
    await expect(revokeDevice(db, accountB.userId, deviceId)).rejects.toBeInstanceOf(
      PairingNotFoundError,
    );
    // deny on a non-pending pairing is a silent no-op: A can still claim it.
    await denyPairing(db, accountB.userId, pairingId);
    expect((await claimPairing(db, pairingId, claimHash, sha256('olxd_after_deny')))?.deviceId).toBe(
      deviceId,
    );
  });

  it('revokeDevice makes deviceForToken report revoked', async () => {
    const { pairingId, claimHash } = await issuePairingFor(db);
    const deviceId = await approvePairing(db, accountA.userId, pairingId);
    const tokenHash = sha256('olxd_revokable');
    await claimPairing(db, pairingId, claimHash, tokenHash);
    await revokeDevice(db, accountA.userId, deviceId);
    const device = await deviceForToken(db, tokenHash);
    expect(device?.deviceId).toBe(deviceId);
    expect(device?.revoked).toBe(true);
    expect(device?.disabled).toBe(false);
  });

  it('accountDisabled reflects a banned account', async () => {
    expect(await accountDisabled(db, accountA.userId)).toBe(false);
    expect(await accountDisabled(db, bannedAccount.userId)).toBe(true);
  });

  it('a second issue with the same pending code hash raises PairingCodeCollisionError', async () => {
    const code = `fixed-${randomUUID()}`;
    await issuePairingFor(db, { code });
    await expect(issuePairingFor(db, { code })).rejects.toBeInstanceOf(PairingCodeCollisionError);
  });
});

const integrationUrl = process.env.BOB_TEST_DB_URL;

describe.skipIf(!integrationUrl)('store pairing (postgres.js, local Supabase)', () => {
  const originalUrl = process.env.BOB_DATABASE_URL;
  let db: Db;
  let accountA: TestAccount;

  beforeAll(async () => {
    // getDb() builds the postgres adapter via createPostgresDb when the URL is
    // set, and closeDb() knows how to release it (db-port.test.ts pattern).
    process.env.BOB_DATABASE_URL = integrationUrl!;
    await closeDb();
    db = await getDb();
    accountA = await createPgAccount(db);
  });

  afterAll(async () => {
    if (db) {
      await db.query('delete from auth.users where id = $1', [accountA.userId]).catch(() => undefined);
    }
    await closeDb();
    if (originalUrl === undefined) {
      delete process.env.BOB_DATABASE_URL;
    } else {
      process.env.BOB_DATABASE_URL = originalUrl;
    }
  });

  it('issue → approve → claim → deviceForToken round-trips bytea on postgres.js', async () => {
    const { pairingId, claimHash } = await issuePairingFor(db);
    const deviceId = await approvePairing(db, accountA.userId, pairingId, 'PG Card');
    const tokenHash = sha256('olxd_pg_integration');
    expect(await claimPairing(db, pairingId, claimHash, tokenHash)).toEqual({
      deviceId,
      name: 'PG Card',
    });
    const device = await deviceForToken(db, tokenHash);
    expect(device?.userId).toBe(accountA.userId);
    expect(device?.revoked).toBe(false);
    expect(device?.disabled).toBe(false);
  });
});

/** Creates an account against the real Supabase auth.users schema through the
 *  sanctioned definer helper (ensure_test_session), never a raw auth insert. */
async function createPgAccount(db: Db): Promise<TestAccount> {
  return addAccount(db as unknown as TestDb);
}
