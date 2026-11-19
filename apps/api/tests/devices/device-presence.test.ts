// Device presence: a paired device connecting (welcome) or closing its socket
// publishes device.changed, so an open Devices page re-reads "Connected now".
// Real HTTP over Postgres: the /api/events stream and GET /api/devices, fed by
// the real session.ts hello path and the real registry. A quick reconnect
// (inside the close debounce) reads as one continuous connection, and a bus
// that throws never costs the welcome or crashes the offline timer.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocket } from 'ws';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pairing from '../../src/devices/pairing-service.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createDevicesRouter } from '../../src/devices/http.ts';
import { createWebEventsRouter } from '../../src/account/events-http.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { MP3_16K_MONO_FORMAT, V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { collectEvents, openSse, type SseEvent } from '../support/sse.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
const journal: string[] = [];
const streams: Array<{ abort: () => void }> = [];

type FakeSocket = EventEmitter & { readyState: number; sent: string[]; send: (data: string) => void };
const hello = { v: V2_VERSION, type: 'hello', id: 'test_hello_0001', payload: { format_id: MP3_16K_MONO_FORMAT } } as unknown as ClientControlDto;

/** Connects a device session through the real hello path; close() drops it.
 *  `sent` keeps the type of every control message the server sent it. */
async function connect(userId: string, deviceId: string): Promise<FakeSocket> {
  const sent: string[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent,
    send: (data: string): void => { sent.push((JSON.parse(data) as { type: string }).type); },
  });
  const session = createSession({ kind: 'device', userId, deviceId, name: 'Kitchen' });
  await handleControl(appDeps, socket as unknown as WebSocket, session, hello, () => undefined);
  return socket;
}
const close = (socket: FakeSocket): void => { socket.readyState = 3; socket.emit('close', 1006, Buffer.alloc(0)); };

/** Opens /api/events; `changed()` counts the device.changed frames so far. */
async function openEvents(token: string, deviceId: string): Promise<{ changed: () => number }> {
  const { events, abort } = await openSse(baseUrl, token);
  streams.push({ abort });
  const { frames } = collectEvents(events);
  const isChanged = (frame: SseEvent): boolean =>
    frame.type === 'device.changed' && (frame.data as { device_id?: unknown }).device_id === deviceId;
  return { changed: () => frames.filter(isChanged).length };
}

async function connected(token: string, deviceId: string): Promise<boolean | undefined> {
  const response = await fetch(`${baseUrl}/api/devices`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await response.json()) as { devices: Array<{ id: string; connected: boolean }> };
  return body.devices.find((device) => device.id === deviceId)?.connected;
}

/** A fresh account with one approved device and an open events stream. */
async function paired(): Promise<{ userId: string; deviceId: string; token: string; changed: () => number }> {
  const account = await addAccount(pg);
  const issued = await pairing.issueCode(db, { model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.9' });
  const deviceId = await pairing.approve(db, account.userId, issued.pairingId, 'Kitchen');
  const token = await signToken({ userId: account.userId, sessionId: account.sessionId });
  const { changed } = await openEvents(token, deviceId);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { userId: account.userId, deviceId, token, changed };
}

beforeAll(async () => {
  setJournalSink((line) => journal.push(line));
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api/devices', createDevicesRouter({
    getDb: () => Promise.resolve(db),
    requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
    events: getAccountEvents(),
    deviceSessions: getDeviceSessions(),
  }));
  app.use('/api/events', createWebEventsRouter({ getDb: () => Promise.resolve(db), events: getAccountEvents() }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30000);

afterAll(async () => {
  for (const stream of streams) stream.abort();
  setJournalSink(null);
  getDeviceSessions().clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('device presence', () => {
  it('connect and close each publish device.changed; GET /api/devices then reads connected false', async () => {
    const { userId, deviceId, token, changed } = await paired();
    const socket = await connect(userId, deviceId);
    await expect.poll(changed, { timeout: 2000 }).toBe(1);
    expect(await connected(token, deviceId)).toBe(true);
    close(socket);
    await expect.poll(changed, { timeout: 1500 }).toBe(2);
    expect(await connected(token, deviceId)).toBe(false);
    expect(journal.join('\n')).toContain('"event":"v2.device_presence"');
    expect(journal.join('\n')).not.toContain('Kitchen');
  });

  it('a reconnect inside the debounce publishes no offline in between', async () => {
    const { userId, deviceId, token, changed } = await paired();
    const first = await connect(userId, deviceId);
    await expect.poll(changed, { timeout: 2000 }).toBe(1);
    close(first);
    await connect(userId, deviceId);
    await expect.poll(changed, { timeout: 2000 }).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(changed()).toBe(2);
    expect(await connected(token, deviceId)).toBe(true);
  });

  it('a publish that throws never stops the welcome nor escapes the offline timer', async () => {
    const { userId, deviceId } = await paired();
    const publish = vi.spyOn(getAccountEvents(), 'publish').mockImplementation(() => { throw new Error('bad event'); });
    try {
      const before = journal.filter((line) => line.includes('"event":"v2.device_presence_failed"')).length;
      const socket = await connect(userId, deviceId);
      expect(socket.sent).toContain('welcome');
      close(socket);
      // Past the close debounce: the offline publish throws inside the timer too.
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(journal.filter((line) => line.includes('"event":"v2.device_presence_failed"')).length).toBe(before + 2);
      expect(getDeviceSessions().forDevice(deviceId)).toBeUndefined();
    } finally {
      publish.mockRestore();
    }
  });
});
