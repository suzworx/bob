/**
 * Device auth + session pairing contract tests (T018, specs/008-supabase-auth
 * -pairing, contracts/cardputer-pairing-protocol.md). Covers P-01, P-05…P-11,
 * P-13, P-20 through the real guard (request.deviceAuth) and the session
 * handleControl, over one shared Postgres store. Runs with BOB_TEST_GUARD_ROLE
 * the connection first switches to bob_server (production role), exactly as
 * tests/store-conversations-pg.test.ts does.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  createDeviceAuthGuard,
  resetUnpairedSockets,
  type DeviceAuth,
} from '../../src/devices/device-auth.ts';
import { createSession, resetPairRequestBucket, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { deny } from '../../src/devices/pairing-service.ts';
import { V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import {
  approvePairing,
  claimPairing,
  issuePairing,
  revokeDevice,
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

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  _socket: { remoteAddress: string };
}

function makeSocket(ip = '203.0.113.1', readyState = 1): FakeSocket {
  return { readyState, send: vi.fn(), close: vi.fn(), once: vi.fn(), _socket: { remoteAddress: ip } };
}

/** A fake express request for the guard; socket.once records the close handler
 *  the guard installs so tests can release unpaired slots. */
interface GuardRequest {
  get: (name: string) => string | undefined;
  socket: { remoteAddress: string; once: (event: string, handler: () => void) => void };
  deviceAuth?: DeviceAuth;
}

function guardRequest(auth: string | undefined, ip: string, closeHandlers: Array<() => void>): GuardRequest {
  return {
    get: (name: string) => (name.toLowerCase() === 'authorization' ? auth : undefined),
    socket: {
      remoteAddress: ip,
      once: (event: string, handler: () => void): void => {
        if (event === 'close') closeHandlers.push(handler);
      },
    },
    deviceAuth: undefined,
  };
}

function wsResponse() {
  let rejected: { code?: number; message?: string } | null = null;
  return {
    reject(code?: number, message?: string) { rejected = { code, message }; },
    rejected: () => rejected,
  } as never;
}

function control(type: string, extra: Record<string, unknown> = {}): ClientControlDto {
  return { v: V2_VERSION, type, id: 'test_ctrl_000001', payload: {}, ...extra } as unknown as ClientControlDto;
}

/** Parses the most recently sent JSON DTO from the fake socket. */
function lastSent(socket: FakeSocket): unknown {
  const calls = socket.send.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(calls[calls.length - 1]![0] as string);
}

async function unpairedReadySession(
  reason: 'none' | 'unknown' | 'revoked' = 'none',
  ip = '203.0.113.1',
): Promise<{ socket: FakeSocket; session: DeviceSession }> {
  const socket = makeSocket(ip);
  const session = createSession({ kind: 'unpaired', reason });
  await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
  socket.send.mockClear();
  return { socket, session };
}

let pg: TestDb;
let db: Db;
let account: TestAccount;
let bannedAccount: TestAccount;

const guardRole = process.env.BOB_TEST_GUARD_ROLE === '1';

/** Pairs a device under `owner` and returns its id plus the raw token. */
async function seedDevice(name: string, owner: TestAccount = account): Promise<{ deviceId: string; token: string }> {
  const claim = randomBytes(16).toString('hex');
  const pairingId = await issuePairing(db, {
    codeHash: sha256(`code-${randomUUID()}`),
    claimHash: sha256(claim),
    model: 'M5Stack Cardputer',
    fwVersion: '0.9.0',
    ipHash: 'seed',
    ttlSeconds: 600,
  });
  const deviceId = await approvePairing(db, owner.userId, pairingId, name);
  const token = `olxd_${randomBytes(32).toString('base64url')}`;
  await claimPairing(db, pairingId, sha256(claim), sha256(token));
  return { deviceId, token };
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  account = await addAccount(pg);
  bannedAccount = await addAccount(pg, { banned: true });
  if (guardRole) await pg.exec('set role bob_server');
  setSharedDb(Promise.resolve(db));
});

afterEach(() => {
  resetUnpairedSockets();
  resetPairRequestBucket();
  setJournalSink(null);
  delete process.env.BOB_PAIR_REQUEST_RPM;
  delete process.env.BOB_UNPAIRED_IDLE_MS;
});

afterAll(async () => {
  setJournalSink(null);
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('unpaired session behaviour', () => {
  it('P-01: upgrade with no header → unpaired; hello answers pairing_required {none}, never welcome', async () => {
    const closeHandlers: Array<() => void> = [];
    const request = guardRequest(undefined, '203.0.113.1', closeHandlers);
    const next = vi.fn();
    await createDeviceAuthGuard('secret', appDeps.getDb)(request as never, wsResponse(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(request.deviceAuth).toEqual({ kind: 'unpaired', reason: 'none' });

    const socket = makeSocket();
    const session = createSession(request.deviceAuth);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(session.stage).toBe('ready');
    expect(lastSent(socket)).toMatchObject({ type: 'pairing_required', payload: { reason: 'none' } });
    expect(String(socket.send.mock.calls.join())).not.toContain('welcome');
    closeHandlers.forEach((handler) => handler());
  });

  it('P-05: unpaired turn_start → error UNPAIRED', async () => {
    const { socket, session } = await unpairedReadySession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_test_000001' }), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'UNPAIRED' } });
    expect(session.stage).toBe('ready');
  });

  it('P-06: unpaired list_conversations → error UNPAIRED', async () => {
    const { socket, session } = await unpairedReadySession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('list_conversations'), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'UNPAIRED' } });
  });

  it('P-07: unpaired select_conversation → error UNPAIRED', async () => {
    const { socket, session } = await unpairedReadySession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('select_conversation', { payload: { conversation_id: 'cnv_00000000000000000000' } }), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'UNPAIRED' } });
  });

  it('unpaired new_conversation → error UNPAIRED', async () => {
    const { socket, session } = await unpairedReadySession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('new_conversation', { payload: { request_id: 'newc_req_000001' } }), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'UNPAIRED' } });
  });

  it('P-08: unpaired pong (the device keep-alive) is accepted with no error', async () => {
    const { socket, session } = await unpairedReadySession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('pong'), vi.fn());
    expect(socket.send).not.toHaveBeenCalled();
    expect(session.stage).toBe('ready');
  });

  it('P-09: the 4th concurrent unpaired socket from one IP is rejected with 503', async () => {
    const ip = '198.51.100.7';
    const guard = createDeviceAuthGuard('secret', appDeps.getDb);
    for (let index = 0; index < 3; index += 1) {
      const next = vi.fn();
      await guard(guardRequest(undefined, ip, []) as never, wsResponse(), next);
      expect(next).toHaveBeenCalledOnce();
    }
    const res = wsResponse();
    await guard(guardRequest(undefined, ip, []) as never, res, vi.fn());
    expect((res as unknown as { rejected: () => { code?: number; message?: string } | null }).rejected()).toMatchObject({
      code: 503,
      message: 'too_many_unpaired',
    });
  });

  it('P-10: an unpaired socket idle for 11 minutes (env-shortened) is closed by the server', async () => {
    process.env.BOB_UNPAIRED_IDLE_MS = '40';
    const socket = makeSocket();
    const session = createSession({ kind: 'unpaired', reason: 'none' });
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(socket.close).not.toHaveBeenCalled();
    await sleep(120);
    expect(socket.close).toHaveBeenCalled();
  });

  it('P-11: pair_request beyond the per-IP limit → error PAIRING_RATE_LIMITED', async () => {
    process.env.BOB_PAIR_REQUEST_RPM = '2';
    resetPairRequestBucket();
    const request = async (): Promise<unknown> => {
      const { socket, session } = await unpairedReadySession('none', '203.0.113.9');
      await handleControl(appDeps, 
        socket as unknown as WebSocket,
        session,
        control('pair_request', {
          payload: {
            model: 'M5Stack Cardputer',
            fw_version: '0.9.0',
            claim: randomBytes(16).toString('hex'),
          },
        }),
        vi.fn(),
      );
      return lastSent(socket);
    };
    expect(await request()).toMatchObject({ type: 'pair_code' });
    expect(await request()).toMatchObject({ type: 'pair_code' });
    expect(await request()).toMatchObject({ type: 'error', payload: { code: 'PAIRING_RATE_LIMITED' } });
  });

  it('P-29: web Deny pushes pair_denied {pairing_id} to the waiting socket, never pair_expired', async () => {
    const { socket, session } = await unpairedReadySession();
    const claim = randomBytes(16).toString('hex');
    await handleControl(appDeps, 
      socket as unknown as WebSocket,
      session,
      control('pair_request', { payload: { model: 'M5Stack Cardputer', fw_version: '0.9.0', claim } }),
      vi.fn(),
    );
    const code = lastSent(socket) as { type: string; payload: { pairing_id: string } };
    expect(code.type).toBe('pair_code');
    socket.send.mockClear();

    await deny(db, account.userId, code.payload.pairing_id);
    const sent = socket.send.mock.calls.map((call) => JSON.parse(call[0] as string) as { type: string; id: string; payload: { pairing_id: string } });
    expect(sent).toEqual([
      { v: 1, type: 'pair_denied', id: sent[0]!.id, payload: { pairing_id: code.payload.pairing_id } },
    ]);
    expect(sent[0]!.id).toMatch(/^pdnd_/);
    expect(sent.some((entry) => entry.type === 'pair_expired')).toBe(false);
  });

});

describe('device credential upgrade paths', () => {
  it('P-13: a paired device reconnects with its token → welcome with device {id,name} and active_conversation', async () => {
    const { deviceId, token } = await seedDevice('Kitchen');
    const closeHandlers: Array<() => void> = [];
    const request = guardRequest(`Bearer ${token}`, '203.0.113.5', closeHandlers);
    const next = vi.fn();
    await createDeviceAuthGuard('secret', appDeps.getDb)(request as never, wsResponse(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(request.deviceAuth).toEqual({ kind: 'device', userId: account.userId, deviceId, name: 'Kitchen' });

    const socket = makeSocket();
    const session = createSession(request.deviceAuth);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    const welcome = lastSent(socket) as { type: string; payload: Record<string, unknown> };
    expect(welcome.type).toBe('welcome');
    expect(welcome.payload.device).toEqual({ id: deviceId, name: 'Kitchen' });
    expect(welcome.payload.active_conversation).toBeNull();
    closeHandlers.forEach((handler) => handler());
  });

  it('P-20: an unknown olxd_ token → unpaired {unknown}; hello answers pairing_required {unknown}', async () => {
    const closeHandlers: Array<() => void> = [];
    const request = guardRequest(`Bearer olxd_${randomBytes(32).toString('base64url')}`, '203.0.113.6', closeHandlers);
    const next = vi.fn();
    await createDeviceAuthGuard('secret', appDeps.getDb)(request as never, wsResponse(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(request.deviceAuth).toEqual({ kind: 'unpaired', reason: 'unknown' });

    const socket = makeSocket();
    const session = createSession(request.deviceAuth);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'pairing_required', payload: { reason: 'unknown' } });
    closeHandlers.forEach((handler) => handler());
  });

  it('P-20 (revoked): a revoked token → unpaired {revoked}; a disabled account counts as revoked', async () => {
    const { deviceId, token } = await seedDevice('Doomed');
    await revokeDevice(db, account.userId, deviceId);
    const closeHandlers: Array<() => void> = [];
    const request = guardRequest(`Bearer ${token}`, '203.0.113.7', closeHandlers);
    await createDeviceAuthGuard('secret', appDeps.getDb)(request as never, wsResponse(), vi.fn());
    expect(request.deviceAuth).toEqual({ kind: 'unpaired', reason: 'revoked' });

    const banned = await seedDevice('Banned', bannedAccount);
    const bannedHandlers: Array<() => void> = [];
    const bannedRequest = guardRequest(`Bearer ${banned.token}`, '203.0.113.8', bannedHandlers);
    await createDeviceAuthGuard('secret', appDeps.getDb)(bannedRequest as never, wsResponse(), vi.fn());
    expect(bannedRequest.deviceAuth).toEqual({ kind: 'unpaired', reason: 'revoked' });
    closeHandlers.forEach((handler) => handler());
    bannedHandlers.forEach((handler) => handler());
  });
});