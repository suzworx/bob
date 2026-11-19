/**
 * Issue #708: the /v2/cardputer concurrency cap must never leak a slot. A real
 * server on an ephemeral port with BOB_MAX_DEVICE_SESSIONS=2, so one leaked
 * slot shows as a 503 on the second of two fresh concurrent connects.
 */
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setJournalSink } from '../src/platform/logger.ts';
import { closeDb, setSharedDb } from '../src/platform/db/db.ts';
import { resolveDevAccount, DEV_ACCOUNT_ID } from '../src/account/dev-account.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from './support/test-db.ts';

const SECRET = 'slots-secret';
/** A documentation-range client IP sent as X-Forwarded-For (read only when BOB_CLIENT_IP_HEADER names it). */
const FORWARDED_IP = '203.0.113.7';
const MAX = 2;
const journalLines: string[] = [];
let pg: TestDb;
let server: Server | undefined;
let port = 0;

async function startServer(): Promise<void> {
  const { createV2Server } = await import('../src/server.ts');
  const created = await createV2Server();
  server = created.server;
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}

/** Opens a device socket; resolves with the socket or the rejection status. */
function connect(): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v2/cardputer`, { headers: { authorization: `Bearer ${SECRET}` } });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => { resolve({ status: res.statusCode }); ws.terminate(); });
    ws.once('error', () => resolve({ status: -1 }));
  });
}

/** True once MAX concurrent fresh connects all succeed (polled, so a slot freed
 *  late by a close still counts; a leaked slot never frees and times out). */
async function capIsFree(timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const results = await Promise.all(Array.from({ length: MAX }, () => connect()));
    const ok = results.every((result) => result.ws);
    await Promise.all(results.map((result) => result.ws && new Promise<void>((resolve) => {
      result.ws!.once('close', () => resolve());
      result.ws!.close();
    })));
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** A raw TCP upgrade request; `onSent`/`onData` decide when to kill the socket. */
function rawUpgrade(kill: 'after-request' | 'after-101', bearer = SECRET): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        'GET /v2/cardputer HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', `Authorization: Bearer ${bearer}`,
        `X-Forwarded-For: ${FORWARDED_IP}`, '', '',
      ].join('\r\n'));
      if (kill === 'after-request') socket.destroy();
    });
    socket.once('data', () => socket.destroy());
    socket.once('close', () => resolve());
    socket.once('error', () => undefined);
  });
}

describe('device session slots (#708)', () => {
  beforeAll(async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    process.env.DEVICE_SHARED_SECRET = SECRET;
    process.env.BOB_MAX_DEVICE_SESSIONS = String(MAX);
    process.env.BOB_RATE_LIMIT_DEVICE_RPM = '100000';
    setJournalSink((line) => journalLines.push(line));
    pg = await createTestDb();
    const db = asDb(pg);
    await addAccount(pg, { id: DEV_ACCOUNT_ID });
    process.env.BOB_LEGACY_DEVICE_OWNER = await resolveDevAccount(db);
    setSharedDb(Promise.resolve(db));
  }, 30000);

  afterEach(async () => {
    // server.close() also drains the extraction worker before it calls back.
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  afterAll(async () => {
    setJournalSink(null);
    await closeDb().catch(() => undefined);
    await closeTestDb(pg).catch(() => undefined);
    for (const key of ['BOB_SYSTEM_TEST', 'BOB_V2_HOST', 'DEVICE_SHARED_SECRET', 'BOB_MAX_DEVICE_SESSIONS',
      'BOB_RATE_LIMIT_DEVICE_RPM', 'BOB_LEGACY_DEVICE_OWNER']) delete process.env[key];
  });

  it('frees every slot after repeated abrupt client drops (ws.terminate)', async () => {
    await startServer();
    for (let round = 0; round < 5; round += 1) {
      const opened = await Promise.all(Array.from({ length: MAX }, () => connect()));
      expect(opened.every((result) => result.ws)).toBe(true);
      for (const result of opened) result.ws!.terminate();
    }
    expect(await capIsFree()).toBe(true);
  }, 30000);

  it('frees the slot when the raw socket is destroyed mid-upgrade', async () => {
    await startServer();
    for (let attempt = 0; attempt < 10; attempt += 1) await rawUpgrade('after-request');
    expect(await capIsFree()).toBe(true);
  }, 30000);

  /**
   * An olxd_ token awaits the store before auth admits it as unpaired and the
   * concurrency guard takes a slot. This holds that await (a pending shared Db),
   * kills the upgrade socket, then lets auth finish, so every slot-taking step
   * after auth always runs on a dead socket.
   */
  async function killDuringHeldAuth(): Promise<void> {
    const journalStart = journalLines.length;
    const { getDb, setSharedDb: holdDb } = await import('../src/platform/db/db.ts');
    const db = await getDb();
    // A paused upgrade socket does not notice a peer reset on its own, so the
    // test destroys the server side itself: the connection is gone while auth waits.
    type UpgradeSocket = { destroy: () => void; once: (event: 'close', listener: () => void) => void };
    const seen: UpgradeSocket[] = [];
    server!.prependListener('upgrade', (_request, socket: UpgradeSocket) => { seen.push(socket); });
    let releaseDb!: () => void;
    holdDb(new Promise<void>((resolve) => { releaseDb = resolve; }).then(() => db));
    try {
      await rawUpgrade('after-request', `olxd_${'A'.repeat(43)}`);
      const deadline = Date.now() + 5000;
      while (seen.length === 0) {
        if (Date.now() > deadline) throw new Error('the server never received the upgrade');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Wait for the close event itself, as a real (slower) store lookup would:
      // a listener registered after this point never fires.
      const closed = new Promise<void>((resolve) => seen[0]!.once('close', resolve));
      seen[0]!.destroy();
      await closed;
      if (journalLines.slice(journalStart).some((line) => line.includes('"kind":"unpaired"'))) {
        throw new Error('auth finished before the socket closed: the Db hold did not take effect');
      }
    } finally {
      releaseDb();
      holdDb(Promise.resolve(db));
    }
    // Auth journals one of these synchronously at its decision: admitted as
    // unpaired (right before next() runs the concurrency guard), or refused
    // because the socket is already gone. Either way every slot step has run.
    const authed = (): boolean => journalLines.slice(journalStart)
      .some((line) => line.includes('"kind":"unpaired","reason":"unknown"') || line.includes('"error_name":"SocketClosed"'));
    const authDeadline = Date.now() + 5000;
    while (!authed()) {
      if (Date.now() > authDeadline) throw new Error('the held device-token auth never completed');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('frees the slot when the socket dies during async device-token auth (half-done upgrade)', async () => {
    await startServer();
    await killDuringHeldAuth();
    expect(await capIsFree()).toBe(true);
  }, 30000);

  it('frees the per-IP unpaired count when the socket dies during async device-token auth', async () => {
    const { resetUnpairedSockets } = await import('../src/devices/device-auth.ts');
    resetUnpairedSockets();
    // The contract's per-IP unpaired cap; the session cap is raised to match so
    // only the unpaired count can refuse these connects. Behind a proxy the IP
    // comes from a header, so a dead socket still counts against its client (a
    // direct dead socket has no remoteAddress and lands on the '' key instead).
    const unpairedMax = 3;
    process.env.BOB_MAX_DEVICE_SESSIONS = String(unpairedMax);
    process.env.BOB_CLIENT_IP_HEADER = 'x-forwarded-for';
    const opened: WebSocket[] = [];
    try {
      await startServer();
      await killDuringHeldAuth();
      const results = await Promise.all(Array.from({ length: unpairedMax }, () => new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/v2/cardputer`, { headers: { 'x-forwarded-for': FORWARDED_IP } });
        ws.once('open', () => { opened.push(ws); resolve(101); });
        ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? -1); ws.terminate(); });
        ws.once('error', () => resolve(-1));
      })));
      expect(results).toEqual(Array.from({ length: unpairedMax }, () => 101));
    } finally {
      for (const ws of opened) ws.terminate();
      process.env.BOB_MAX_DEVICE_SESSIONS = String(MAX);
      delete process.env.BOB_CLIENT_IP_HEADER;
      resetUnpairedSockets();
    }
  }, 30000);

  it('frees the slot when the socket closes right after the 101 (post-accept setup)', async () => {
    await startServer();
    for (let attempt = 0; attempt < 10; attempt += 1) await rawUpgrade('after-101');
    expect(await capIsFree()).toBe(true);
  }, 30000);
});
