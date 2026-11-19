// Pairing API tests (T019, contracts/pairing-and-devices-api.md D-01..D-10,
// D-12..D-16). A real HTTP server over Postgres exercises the JWT guard,
// requireActiveSession, and the /api/pair router with the real pairing
// service. Each scenario uses a fresh account and a distinct X-Forwarded-For
// IP so the process-wide default lookup rate limiter never leaks between
// tests (FR-015).
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pairing from '../../src/devices/pairing-service.ts';
import type { PairingPush, WaitingSocket } from '../../src/devices/pairing-service.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { issuePairing, sha256 } from '../../src/devices/pairing-store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createPairingRouter } from '../../src/devices/pairing-http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb, withAdminAuth } from '../support/test-db.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PairedPush = Extract<PairingPush, { kind: 'paired' }>;

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

describe('pairing API (contracts/pairing-and-devices-api.md D-01..D-10, D-12..D-16)', () => {
  let pg: TestDb;
  let db: Db;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use(
      '/api/pair',
      createPairingRouter({
        getDb: () => Promise.resolve(db),
        pairing,
        requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.close();
    await closeTestDb(pg);
  });

  async function tokenFor(account: TestAccount): Promise<string> {
    return signToken({ userId: account.userId, sessionId: account.sessionId });
  }

  async function freshAccount(): Promise<{ account: TestAccount; token: string }> {
    const account = await addAccount(pg);
    return { account, token: await tokenFor(account) };
  }

  async function post(path: string, token: string, body: unknown, ip: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-forwarded-for': ip,
      },
      body: JSON.stringify(body),
    });
  }

  async function issue(
    claim = `claim-${randomUUID()}`,
    model = 'M5Stack Cardputer',
  ): Promise<{ pairingId: string; userCode: string; claim: string }> {
    const issued = await pairing.issueCode(db, { model, fwVersion: '0.9.0', claim, ip: '203.0.113.10' });
    return { pairingId: issued.pairingId, userCode: issued.userCode, claim };
  }

  async function issueExpired(): Promise<{ pairingId: string; code: string }> {
    const code = pairing.generateUserCode();
    const pairingId = await issuePairing(db, {
      codeHash: sha256(code.replace(/[-\s]/g, '')),
      claimHash: sha256(`claim-${randomUUID()}`),
      model: 'M5Stack Cardputer',
      fwVersion: '0.9.0',
      ipHash: 'expired-insert',
      ttlSeconds: -10,
    });
    return { pairingId, code };
  }

  it('D-01: lookup of a valid pending code answers 200 with the lookup DTO, no fw_version', async () => {
    const { token } = await freshAccount();
    const { pairingId, userCode } = await issue();
    const res = await post('/api/pair/lookup', token, { user_code: userCode }, '198.51.100.1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      pairing_id: pairingId,
      device_model: 'M5Stack Cardputer',
      requested_at: expect.any(Number),
      expires_at: expect.any(Number),
    });
    expect(typeof body.requested_at).toBe('number');
    expect((body.expires_at as number) > (body.requested_at as number)).toBe(true);
  });

  it('D-02: lookup of a wrong code answers 404 generic and counts a failure', async () => {
    const { token } = await freshAccount();
    const res = await post('/api/pair/lookup', token, { user_code: 'WWWW-WWWW' }, '198.51.100.2');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found' } });
  });

  it('D-03: lookup of an expired code answers 404 generic and counts a failure', async () => {
    const { token } = await freshAccount();
    const { code } = await issueExpired();
    const res = await post('/api/pair/lookup', token, { user_code: code }, '198.51.100.3');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found' } });
  });

  it('D-04: lookup of a used code answers 404 generic and counts a failure', async () => {
    const { account, token } = await freshAccount();
    const { pairingId, userCode } = await issue();
    await pairing.approve(db, account.userId, pairingId);
    const res = await post('/api/pair/lookup', token, { user_code: userCode }, '198.51.100.4');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found' } });
  });

  it('D-05: the 404 body is byte-identical for wrong, expired, and used codes', async () => {
    const { account, token } = await freshAccount();
    const ip = '198.51.100.5';
    const wrong = await post('/api/pair/lookup', token, { user_code: 'WWWW-WWWW' }, ip);
    const { code: expiredCode } = await issueExpired();
    const expired = await post('/api/pair/lookup', token, { user_code: expiredCode }, ip);
    const { pairingId, userCode } = await issue();
    await pairing.approve(db, account.userId, pairingId);
    const used = await post('/api/pair/lookup', token, { user_code: userCode }, ip);
    expect(wrong.status).toBe(404);
    expect(expired.status).toBe(404);
    expect(used.status).toBe(404);
    const wrongBody = await wrong.text();
    expect(await expired.text()).toBe(wrongBody);
    expect(await used.text()).toBe(wrongBody);
    expect(wrongBody).toBe('{"error":{"code":"not_found"}}');
  });

  it('D-06: the 6th lookup failure in 15 min answers 429 with Retry-After', async () => {
    const { token } = await freshAccount();
    const ip = '198.51.100.6';
    for (let index = 0; index < 5; index += 1) {
      const res = await post('/api/pair/lookup', token, { user_code: 'WWWW-WWWW' }, ip);
      expect(res.status).toBe(404);
    }
    const limited = await post('/api/pair/lookup', token, { user_code: 'WWWW-WWWW' }, ip);
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: { code: string; retry_after_seconds: number } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
    expect(limited.headers.get('retry-after')).toBe(String(body.error.retry_after_seconds));
  });

  it('D-07: the rate limit keys per account and per IP independently', async () => {
    const { token: tokenA } = await freshAccount();
    const { token: tokenB } = await freshAccount();
    const ipX = '198.51.100.7';
    for (let index = 0; index < 5; index += 1) {
      await post('/api/pair/lookup', tokenA, { user_code: 'WWWW-WWWW' }, ipX);
    }
    const aFreshIp = await post('/api/pair/lookup', tokenA, { user_code: 'WWWW-WWWW' }, '198.51.100.71');
    expect(aFreshIp.status).toBe(429);
    const bSameIp = await post('/api/pair/lookup', tokenB, { user_code: 'WWWW-WWWW' }, ipX);
    expect(bSameIp.status).toBe(429);
    const bFreshIp = await post('/api/pair/lookup', tokenB, { user_code: 'WWWW-WWWW' }, '198.51.100.72');
    expect(bFreshIp.status).toBe(404);
  });

  it('D-08: user_code normalization accepts lowercase and strips hyphens', async () => {
    const { token } = await freshAccount();
    const { userCode } = await issue();
    const variants = [userCode, userCode.toLowerCase(), userCode.replace('-', ''), userCode.replace('-', '').toLowerCase()];
    for (const [index, variant] of variants.entries()) {
      const res = await post('/api/pair/lookup', token, { user_code: variant }, `198.51.100.8${index}`);
      expect(res.status).toBe(200);
    }
  });

  it('D-09: a non-normalizable code answers 400 and does not count a failure', async () => {
    const { token } = await freshAccount();
    const ip = '198.51.100.9';
    for (let index = 0; index < 6; index += 1) {
      const res = await post('/api/pair/lookup', token, { user_code: 'not-a-code' }, ip);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 'invalid_request' } });
    }
    const wrong = await post('/api/pair/lookup', token, { user_code: 'WWWW-WWWW' }, ip);
    expect(wrong.status).toBe(404);
  });

  it('D-10: approve answers 200 { device_id, name } and defaults name to the model', async () => {
    const { token } = await freshAccount();
    const ip = '198.51.100.10';
    const { pairingId } = await issue();
    const res = await post('/api/pair/approve', token, { pairing_id: pairingId }, ip);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { device_id: string; name: string };
    expect(body.device_id).toMatch(UUID_RE);
    expect(body.name).toBe('M5Stack Cardputer');
    const longModel = 'X'.repeat(50);
    const { pairingId: longId } = await issue(`claim-${randomUUID()}`, longModel);
    const truncated = await post('/api/pair/approve', token, { pairing_id: longId }, ip);
    expect(truncated.status).toBe(200);
    expect(((await truncated.json()) as { name: string }).name).toBe(longModel.slice(0, 40));
  });

  it('D-12: approve with an explicit name returns it and the socket receives paired', async () => {
    const { token } = await freshAccount();
    const claim = `claim-${randomUUID()}`;
    const { pairingId } = await issue(claim);
    const socket = fakeSocket(claim);
    pairing.registerWaiting(pairingId, socket);
    const res = await post('/api/pair/approve', token, { pairing_id: pairingId, name: 'Kitchen' }, '198.51.100.12');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { device_id: string; name: string };
    expect(body.name).toBe('Kitchen');
    expect(socket.sent).toHaveLength(1);
    const paired = socket.sent[0] as PairedPush;
    expect(paired.deviceId).toBe(body.device_id);
    expect(paired.name).toBe('Kitchen');
    expect(paired.deviceToken).toMatch(/^olxd_[A-Za-z0-9_-]{43}$/);
  });

  it('D-13: approve of an already-decided pairing answers 404 identical to unknown', async () => {
    const { token } = await freshAccount();
    const other = await freshAccount();
    const ip = '198.51.100.13';
    const { pairingId } = await issue();
    const first = await post('/api/pair/approve', token, { pairing_id: pairingId }, ip);
    expect(first.status).toBe(200);
    const again = await post('/api/pair/approve', other.token, { pairing_id: pairingId }, '198.51.100.14');
    const { pairingId: deniedId } = await issue();
    await post('/api/pair/deny', token, { pairing_id: deniedId }, ip);
    const denyApprove = await post('/api/pair/approve', token, { pairing_id: deniedId }, ip);
    const unknown = await post('/api/pair/approve', token, { pairing_id: randomUUID() }, ip);
    expect(again.status).toBe(404);
    expect(denyApprove.status).toBe(404);
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    expect(await again.text()).toBe(unknownBody);
    expect(await denyApprove.text()).toBe(unknownBody);
  });

  it('D-14: approve of an expired or used pairing answers 404 generic', async () => {
    const { token } = await freshAccount();
    const ip = '198.51.100.14';
    const { pairingId: expiredId } = await issueExpired();
    const expired = await post('/api/pair/approve', token, { pairing_id: expiredId }, ip);
    expect(expired.status).toBe(404);
    const { pairingId } = await issue();
    const first = await post('/api/pair/approve', token, { pairing_id: pairingId }, ip);
    expect(first.status).toBe(200);
    const second = await post('/api/pair/approve', token, { pairing_id: pairingId }, ip);
    expect(second.status).toBe(404);
  });

  it('D-15: deny answers 204 and the pending code fails lookup afterwards', async () => {
    const { token } = await freshAccount();
    const ip = '198.51.100.15';
    const { pairingId, userCode } = await issue();
    const res = await post('/api/pair/deny', token, { pairing_id: pairingId }, ip);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const lookup = await post('/api/pair/lookup', token, { user_code: userCode }, ip);
    expect(lookup.status).toBe(404);
  });

  it('D-16: deny of an unknown or already-decided pairing answers 204 and changes nothing', async () => {
    const { token } = await freshAccount();
    const ip = '198.51.100.16';
    const unknown = await post('/api/pair/deny', token, { pairing_id: randomUUID() }, ip);
    expect(unknown.status).toBe(204);
    const { pairingId, userCode } = await issue();
    const approved = await post('/api/pair/approve', token, { pairing_id: pairingId }, ip);
    expect(approved.status).toBe(200);
    const denyApproved = await post('/api/pair/deny', token, { pairing_id: pairingId }, ip);
    expect(denyApproved.status).toBe(204);
    const reApprove = await post('/api/pair/approve', token, { pairing_id: pairingId }, ip);
    expect(reApprove.status).toBe(404);
    const lookup = await post('/api/pair/lookup', token, { user_code: userCode }, ip);
    expect(lookup.status).toBe(404);
    const denyAgain = await post('/api/pair/deny', token, { pairing_id: pairingId }, ip);
    expect(denyAgain.status).toBe(204);
  });

  it('requireActiveSession refuses approve/deny for a deleted auth.sessions row', async () => {
    const account = await addAccount(pg);
    const token = await tokenFor(account);
    await withAdminAuth(pg, (admin) => admin.endSession(account.sessionId));
    const { pairingId } = await issue();
    const approve = await post('/api/pair/approve', token, { pairing_id: pairingId }, '198.51.100.17');
    expect(approve.status).toBe(401);
    expect((await approve.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'invalid_token' },
    });
    const deny = await post('/api/pair/deny', token, { pairing_id: pairingId }, '198.51.100.17');
    expect(deny.status).toBe(401);
  });

  it('malformed bodies answer 400 invalid_request', async () => {
    const { token } = await freshAccount();
    const ip = '198.51.100.18';
    const longCode = await post('/api/pair/lookup', token, { user_code: 'x'.repeat(17) }, ip);
    expect(longCode.status).toBe(400);
    const blankName = await post('/api/pair/approve', token, { pairing_id: randomUUID(), name: '   ' }, ip);
    expect(blankName.status).toBe(400);
    const badApproveId = await post('/api/pair/approve', token, { pairing_id: 'not-a-uuid' }, ip);
    expect(badApproveId.status).toBe(400);
    const badDenyId = await post('/api/pair/deny', token, { pairing_id: 'not-a-uuid' }, ip);
    expect(badDenyId.status).toBe(400);
  });
});