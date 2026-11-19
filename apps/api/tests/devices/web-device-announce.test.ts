// POST /api/devices/:id/announce (#668 U4): a notice card on one device, on the
// registry's announcement outbox. Real HTTP over Postgres; the registry is the
// real one with fake sockets.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocket } from 'ws';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pairing from '../../src/devices/pairing-service.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createDevicesRouter } from '../../src/devices/http.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { ServerControlDtoSchema } from '../../src/voice/protocol.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

describe('device announce API (#668 U4)', () => {
  let pg: TestDb;
  let db: Db;
  let server: Server;
  let baseUrl: string;
  const journalLines: string[] = [];

  beforeAll(async () => {
    setJournalSink((line: string) => journalLines.push(line));
    pg = await createTestDb();
    db = asDb(pg);
    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api/devices', createDevicesRouter({
      getDb: () => Promise.resolve(db),
      requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
      events: getAccountEvents(),
      deviceSessions: getDeviceSessions(),
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => getDeviceSessions().clear());

  afterAll(async () => {
    setJournalSink(null);
    server.close();
    await closeTestDb(pg);
  });

  async function owner(): Promise<{ userId: string; token: string; deviceId: string }> {
    const account = await addAccount(pg);
    const issued = await pairing.issueCode(db, {
      model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.91',
    });
    const deviceId = await pairing.approve(db, account.userId, issued.pairingId, 'Desk');
    return { userId: account.userId, token: await signToken({ userId: account.userId, sessionId: account.sessionId }), deviceId };
  }

  function post(token: string, deviceId: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/devices/${deviceId}/announce`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function connect(userId: string, deviceId: string, dnd = false): ReturnType<typeof vi.fn> {
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const session = {
      id: `sess-${deviceId}`, stage: 'ready' as const,
      deviceState: { volume: 6, muted: false, mode: 'ptt' as const, dnd, battery_pct: 81, charging: true, fw_version: '1.4.0' },
    };
    getDeviceSessions().register(socket as unknown as WebSocket, session, userId, deviceId);
    return socket.send;
  }

  function announces(send: ReturnType<typeof vi.fn>): unknown[] {
    return send.mock.calls
      .map(([raw]) => ServerControlDtoSchema.parse(JSON.parse(String(raw))))
      .filter((dto) => dto.type === 'announce');
  }

  const speakerTest = { kind: 'notice', title: 'Speaker test', ring: true };

  it('sends a schema-valid announce to the connected device only (202 sent)', async () => {
    const { userId, token, deviceId } = await owner();
    const send = connect(userId, deviceId);
    const other = await owner();
    const otherSend = connect(other.userId, other.deviceId);
    const start = journalLines.length;
    const res = await post(token, deviceId, { kind: 'notice', title: 'Dinner', body: 'Come downstairs', ring: false });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'sent' });
    expect(announces(send)).toEqual([expect.objectContaining({
      type: 'announce',
      payload: expect.objectContaining({ kind: 'notice', title: 'Dinner', body: 'Come downstairs', ring: false }),
    })]);
    expect(announces(otherSend)).toEqual([]);
    const lines = journalLines.slice(start).join('\n');
    expect(lines).toMatch(/"event":"v2\.device_announce"[^\n]*"outcome":"sent"/);
    expect(lines).not.toContain('Dinner');
    expect(lines).not.toContain('downstairs');
  });

  it('holds it while the device is in DND (202 held) and sends nothing', async () => {
    const { userId, token, deviceId } = await owner();
    const send = connect(userId, deviceId, true);
    const res = await post(token, deviceId, speakerTest);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'held' });
    expect(announces(send)).toEqual([]);
  });

  it('answers 409 no_device when the device is not connected, and queues nothing', async () => {
    const { userId, token, deviceId } = await owner();
    const res = await post(token, deviceId, speakerTest);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'no_device' } });
    expect(getDeviceSessions().pendingAnnouncements(userId)).toEqual([]);
  });

  it('answers the one 404 body for another account\'s and unknown devices', async () => {
    const mine = await owner();
    const theirs = await owner();
    connect(theirs.userId, theirs.deviceId);
    for (const id of [theirs.deviceId, randomUUID()]) {
      const res = await post(mine.token, id, speakerTest);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'not_found' } });
    }
    expect(getDeviceSessions().pendingAnnouncements(theirs.userId)).toEqual([]);
  });

  it('rejects a body outside the strict schema with 400', async () => {
    const { userId, token, deviceId } = await owner();
    connect(userId, deviceId);
    for (const body of [
      { ...speakerTest, kind: 'timer' },
      { ...speakerTest, title: '' },
      { ...speakerTest, title: 'x'.repeat(29) },
      { ...speakerTest, body: 'x'.repeat(201) },
      { ...speakerTest, extra: 1 },
      { kind: 'notice', title: 'Hi' },
    ]) {
      expect((await post(token, deviceId, body)).status).toBe(400);
    }
  });
});
