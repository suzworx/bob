// Pairing service tests (T017, specs/008-supabase-auth-pairing). Postgres via
// tests/support/test-db.ts + fake clocks and fake sockets.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccountEvents } from '../../src/account/events-bus.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import {
  approve,
  createPairingRateLimiter,
  deny,
  generateUserCode,
  InvalidCodeError,
  issueCode,
  lookupCode,
  normalizeUserCode,
  PairingRateLimitedError,
  registerWaiting,
  resume,
  type PairingPush,
  type WaitingSocket,
} from '../../src/devices/pairing-service.ts';
import type { Db } from '../../src/platform/db/db.ts';
import {
  deviceForToken,
  issuePairing,
  PairingNotFoundError,
  sha256,
} from '../../src/devices/pairing-store.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Issues a pending pairing through the service with a fresh claim. */
async function issuePairingFor(
  db: Db,
  claim = `claim-${randomUUID()}`,
  ip = '203.0.113.1',
): Promise<{ pairingId: string; userCode: string; expiresIn: 600; claim: string }> {
  const issued = await issueCode(db, {
    model: 'M5Stack Cardputer',
    fwVersion: '0.9.0',
    claim,
    ip,
  });
  return { ...issued, claim };
}

/** A fake device socket recording everything the service pushes to it. */
function fakeSocket(claim: string): WaitingSocket & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    claim,
    sent,
    send: (push: PairingPush): void => {
      sent.push(push);
    },
    close: (): void => {},
  };
}

type PairedPush = Extract<PairingPush, { kind: 'paired' }>;

describe('pairing service', () => {
  let pg: TestDb;
  let db: Db;
  let accountA: TestAccount;
  let accountB: TestAccount;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    accountA = await addAccount(pg);
    accountB = await addAccount(pg);
  });

  afterAll(async () => {
    await closeTestDb(pg);
  });

  afterEach(() => {
    setJournalSink(null);
  });

  it('generates 8-character codes from the alphabet, formatted XXXX-XXXX', () => {
    for (let index = 0; index < 200; index += 1) {
      const code = generateUserCode();
      expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
      expect(normalizeUserCode(code)).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
    }
  });

  it('normalizes case, hyphens, and spaces; rejects anything else', () => {
    expect(normalizeUserCode('kqxc-tzpb')).toBe('KQXCTZPB');
    expect(normalizeUserCode('  KQXC TZPB ')).toBe('KQXCTZPB');
    expect(normalizeUserCode('k q x c t z p b')).toBe('KQXCTZPB');
    expect(normalizeUserCode('KQXCTZP')).toBeNull();
    expect(normalizeUserCode('KQXCTZPBA')).toBeNull();
    expect(normalizeUserCode('KQXCTZP0')).toBeNull();
    expect(normalizeUserCode('KQXCTZPA')).toBeNull();
    expect(normalizeUserCode('')).toBeNull();
  });

  it('retries with a fresh code when the pending code hash collides', async () => {
    // A pending pairing already holds sha256('QQQQQQQQ') (the normalized form).
    await issuePairing(db, {
      codeHash: sha256('QQQQQQQQ'),
      claimHash: sha256(`claim-${randomUUID()}`),
      model: 'M5Stack Cardputer',
      fwVersion: '0.9.0',
      ipHash: 'pre-insert',
      ttlSeconds: 600,
    });
    const codes = ['QQQQ-QQQQ', 'BBBB-BBBB'];
    let calls = 0;
    const issued = await issueCode(
      db,
      { model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: 'claim-retry', ip: '203.0.113.9' },
      {
        generateCode: (): string => {
          const code = codes[calls];
          calls += 1;
          return code!;
        },
      },
    );
    expect(calls).toBe(2);
    expect(issued.userCode).toBe('BBBB-BBBB');
    expect(issued.expiresIn).toBe(600);
    // The surviving code resolves; the collided one was never stored.
    expect(
      (await lookupCode(db, accountA.userId, 'BBBB-BBBB', '203.0.113.9')).pairingId,
    ).toBe(issued.pairingId);
  });

  it('rate-limits 5 lookup failures per account and per IP; malformed never counts', async () => {
    let now = 1_000_000;
    const clock = (): number => now;
    const limiter = createPairingRateLimiter({ now: clock });
    const lookup = (userId: string, code: string, ip: string): Promise<unknown> =>
      lookupCode(db, userId, code, ip, { now: clock, limiter });

    // Five wrong codes fail with the generic 404 error.
    for (let index = 0; index < 5; index += 1) {
      await expect(lookup(accountA.userId, 'ZZZZ-ZZZZ', 'ip-1')).rejects.toBeInstanceOf(
        PairingNotFoundError,
      );
    }
    // The 6th attempt is limited, with retry-after until the window resets.
    let limitedError: unknown;
    try {
      await lookup(accountA.userId, 'ZZZZ-ZZZZ', 'ip-1');
    } catch (error) {
      limitedError = error;
    }
    expect(limitedError).toBeInstanceOf(PairingRateLimitedError);
    expect((limitedError as PairingRateLimitedError).retryAfterSeconds).toBe(900);
    // The IP window blocks a different account from the same IP.
    await expect(lookup(accountB.userId, 'ZZZZ-ZZZZ', 'ip-1')).rejects.toBeInstanceOf(
      PairingRateLimitedError,
    );
    // The account window blocks the same account from a fresh IP.
    await expect(lookup(accountA.userId, 'ZZZZ-ZZZZ', 'ip-2')).rejects.toBeInstanceOf(
      PairingRateLimitedError,
    );
    // A fresh account from a fresh IP is unaffected.
    await expect(lookup(accountB.userId, 'ZZZZ-ZZZZ', 'ip-2')).rejects.toBeInstanceOf(
      PairingNotFoundError,
    );
    // Malformed codes throw InvalidCodeError and never count as failures.
    for (let index = 0; index < 10; index += 1) {
      await expect(lookup(accountB.userId, 'not-a-code', 'ip-3')).rejects.toBeInstanceOf(
        InvalidCodeError,
      );
    }
    await expect(lookup(accountB.userId, 'ZZZZ-ZZZZ', 'ip-3')).rejects.toBeInstanceOf(
      PairingNotFoundError,
    );
    // The window resets after 15 minutes.
    now += 900_001;
    await expect(lookup(accountA.userId, 'ZZZZ-ZZZZ', 'ip-1')).rejects.toBeInstanceOf(
      PairingNotFoundError,
    );
  });

  it('approve delivers paired to a registered socket; the token resolves the device', async () => {
    const claim = `claim-${randomUUID()}`;
    const { pairingId } = await issuePairingFor(db, claim);
    const socket = fakeSocket(claim);
    registerWaiting(pairingId, socket);
    const events = new AccountEvents();
    const deviceId = await approve(db, accountA.userId, pairingId, 'Kitchen', events);
    expect(socket.sent).toHaveLength(1);
    const paired = socket.sent[0] as PairedPush;
    expect(paired.deviceId).toBe(deviceId);
    expect(paired.deviceToken).toMatch(/^olxd_[A-Za-z0-9_-]{43}$/);
    expect(paired.name).toBe('Kitchen');
    const device = await deviceForToken(db, sha256(paired.deviceToken));
    expect(device?.userId).toBe(accountA.userId);
    expect(device?.deviceId).toBe(deviceId);
  });

  it('approve with no socket defers delivery; resume delivers for the right claim only', async () => {
    const claim = `claim-${randomUUID()}`;
    const { pairingId } = await issuePairingFor(db, claim);
    const deviceId = await approve(db, accountA.userId, pairingId);
    // Nothing was pushed: no socket was registered.
    const wrongSocket = fakeSocket('wrong-claim');
    expect(await resume(db, pairingId, 'wrong-claim', wrongSocket)).toBe(false);
    expect(wrongSocket.sent).toHaveLength(0);
    // Reconnecting with the right claim re-delivers the token.
    const rightSocket = fakeSocket(claim);
    expect(await resume(db, pairingId, claim, rightSocket)).toBe(true);
    expect(rightSocket.sent).toHaveLength(1);
    const paired = rightSocket.sent[0] as PairedPush;
    expect((await deviceForToken(db, sha256(paired.deviceToken)))?.deviceId).toBe(deviceId);
  });

  it('re-issues the token before first authentication; the old token stops working', async () => {
    const claim = `claim-${randomUUID()}`;
    const { pairingId } = await issuePairingFor(db, claim);
    const deviceId = await approve(db, accountA.userId, pairingId);
    const socket1 = fakeSocket(claim);
    expect(await resume(db, pairingId, claim, socket1)).toBe(true);
    const token1 = (socket1.sent[0] as PairedPush).deviceToken;
    const socket2 = fakeSocket(claim);
    expect(await resume(db, pairingId, claim, socket2)).toBe(true);
    const token2 = (socket2.sent[0] as PairedPush).deviceToken;
    expect(token1).not.toBe(token2);
    expect(await deviceForToken(db, sha256(token1))).toBeNull();
    expect((await deviceForToken(db, sha256(token2)))?.deviceId).toBe(deviceId);
  });

  it('deny pushes pair_denied to the waiting socket and consumes the code', async () => {
    const claim = `claim-${randomUUID()}`;
    const { pairingId, userCode } = await issuePairingFor(db, claim);
    const socket = fakeSocket(claim);
    registerWaiting(pairingId, socket);
    await deny(db, accountA.userId, pairingId);
    expect(socket.sent).toEqual([{ kind: 'denied', pairingId }]);
    // The denied code no longer resolves (and the lookup failure is isolated).
    await expect(
      lookupCode(db, accountA.userId, userCode, 'ip-1', {
        limiter: createPairingRateLimiter(),
      }),
    ).rejects.toBeInstanceOf(PairingNotFoundError);
    // Denying again with no socket is a silent no-op.
    await expect(deny(db, accountA.userId, pairingId)).resolves.toBeUndefined();
  });

  it('publishes device.changed on approve', async () => {
    const claim = `claim-${randomUUID()}`;
    const { pairingId } = await issuePairingFor(db, claim);
    const events = new AccountEvents();
    const received: unknown[] = [];
    events.subscribe(accountA.userId, (event) => received.push(event));
    const deviceId = await approve(db, accountA.userId, pairingId, undefined, events);
    expect(received).toEqual([{ type: 'device.changed', device_id: deviceId }]);
  });

  it('journal lines never contain a code, an olxd_ token, or a claim', async () => {
    const lines: string[] = [];
    setJournalSink((line: string) => lines.push(line));
    try {
      const claim = `claim-${randomUUID()}`;
      const { pairingId, userCode } = await issuePairingFor(db, claim, '198.51.100.7');
      // A failed lookup journals pair_rejected.
      await expect(
        lookupCode(db, accountA.userId, 'WWWW-WWWW', '198.51.100.7', {
          limiter: createPairingRateLimiter(),
        }),
      ).rejects.toBeInstanceOf(PairingNotFoundError);
      // Approve delivers and journals pair_approved + pair_delivered.
      const socket = fakeSocket(claim);
      registerWaiting(pairingId, socket);
      await approve(db, accountA.userId, pairingId, 'Private');
      // Resume re-issues the token (a second pair_delivered).
      await resume(db, pairingId, claim, fakeSocket(claim));
      // Deny journals pair_denied.
      const denied = await issuePairingFor(db, `claim-${randomUUID()}`);
      const deniedSocket = fakeSocket(denied.claim);
      registerWaiting(denied.pairingId, deniedSocket);
      await deny(db, accountA.userId, denied.pairingId);

      const joined = lines.join('\n');
      expect(joined).not.toContain(userCode);
      expect(joined).not.toContain('WWWW-WWWW');
      expect(joined).not.toContain('olxd_');
      expect(joined).not.toContain(claim);
      expect(joined).not.toContain(denied.claim);
    } finally {
      setJournalSink(null);
    }
  });
});