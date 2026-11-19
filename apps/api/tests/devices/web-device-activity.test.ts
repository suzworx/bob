// GET /api/devices/:id/activity (#668 "Recent"): the turns one device spoke
// and the account's fired timers, newest first. Real HTTP over Postgres; turns
// are saved through the real device persist paths.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pairing from '../../src/devices/pairing-service.ts';
import { AccountEvents } from '../../src/account/events-bus.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createDevicesRouter } from '../../src/devices/http.ts';
import { DeviceActivityResponseSchema } from '../../src/devices/schemas.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { appendMessage } from '../../src/conversations/store.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { createThread } from '../../src/conversations/thread-store.ts';
import { createTimer, markTimerFired } from '../../src/timers/store.ts';
import { persistDeviceTurn } from '../../src/voice/cardputer-conversation.ts';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, withUserRaw, type TestDb } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';

describe('device activity API (#668 Recent)', () => {
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
      events: new AccountEvents(),
      deviceSessions: getDeviceSessions(),
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setJournalSink(null);
    server.close();
    await closeTestDb(pg);
  });

  async function pair(userId: string, name: string): Promise<string> {
    const issued = await pairing.issueCode(db, {
      model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.92',
    });
    return pairing.approve(db, userId, issued.pairingId, name);
  }

  async function owner(): Promise<{ userId: string; token: string; deviceId: string }> {
    const account = await addAccount(pg);
    const token = await signToken({ userId: account.userId, sessionId: account.sessionId });
    return { userId: account.userId, token, deviceId: await pair(account.userId, 'Desk') };
  }

  const get = (token: string, path: string): Promise<Response> =>
    fetch(`${baseUrl}/api/devices/${path}`, { headers: { authorization: `Bearer ${token}` } });

  /** Pins a thread's messages ahead of the clock, so the ordering is not left
   *  to the database clock. Runs as admin: no app role has a created_at grant
   *  on bob.messages. */
  async function stampThread(threadId: string, at: number): Promise<void> {
    const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
    await withAdmin(url, (sql) => sql.unsafe(
      `UPDATE bob.messages SET created_at = to_timestamp($1 / 1000.0) WHERE conversation_id = $2`, [at, threadId],
    ));
  }

  it('lists this device\'s turns and the account timers, newest first; not web turns or other devices', async () => {
    const me = await owner();
    const other = await pair(me.userId, 'Kitchen');
    const t0 = Date.now() + 60_000;
    const general = await persistDeviceTurn(db, me.userId, undefined, 'what is for dinner', 'Pasta.', me.deviceId);
    await appendMessage(db, me.userId, general.conversationId, { role: 'user', parts: [{ type: 'text', text: 'typed on the web' }], origin: 'web_text' });
    await persistDeviceTurn(db, me.userId, undefined, 'the other device speaks', 'Hi.', other);
    const space = await createSpace(db, me.userId, { kind: 'group', name: 'Family' });
    const thread = await createThread(db, me.userId, { spaceId: space.id, title: 'Groceries' });
    await persistDeviceTurn(db, me.userId, {
      pinnedRef: threadRef(thread.id), sessionId: 'sess_activity', deviceId: me.deviceId, turnRef: 'turn_a1b2c3d4',
      transcriptText: 'add milk', replyText: 'Added milk.',
    }, new AccountEvents());
    await stampThread(thread.id, t0 + 3000);
    const timer = await createTimer(db, me.userId, { durationMs: 60_000, label: 'Eggs' });
    await markTimerFired(db, me.userId, timer.id, t0 + 2000);

    journalLines.length = 0;
    const response = await get(me.token, `${me.deviceId}/activity`);
    expect(response.status).toBe(200);
    const { items } = DeviceActivityResponseSchema.parse(await response.json());
    expect(items).toEqual([
      { kind: 'turn', at: t0 + 3000, title: 'Groceries', heard_excerpt: 'add milk', thread_id: thread.id, space_id: space.id },
      { kind: 'timer', at: t0 + 2000, label: 'Eggs', status: 'fired', scope: 'account' },
      { kind: 'turn', at: expect.any(Number), title: general.title, heard_excerpt: 'what is for dinner', conversation_id: general.conversationId },
    ]);
    const journal = journalLines.join('\n');
    expect(journal).toContain('v2.device_activity_listed');
    expect(journal).toContain('"count":3');
    for (const words of ['add milk', 'what is for dinner', 'Eggs', 'Groceries']) expect(journal).not.toContain(words);
  });

  it('cuts the user\'s words to 80 chars and honours limit (default 5, max 20)', async () => {
    const me = await owner();
    await persistDeviceTurn(db, me.userId, undefined, 'tell me '.repeat(40), 'Sure.', me.deviceId);
    for (let i = 0; i < 6; i += 1) await persistDeviceTurn(db, me.userId, undefined, `turn ${i}`, 'Ok.', me.deviceId);
    const all = DeviceActivityResponseSchema.parse(await (await get(me.token, `${me.deviceId}/activity?limit=20`)).json());
    expect(all.items).toHaveLength(7);
    const long = all.items.find((item) => item.kind === 'turn' && item.heard_excerpt.startsWith('tell me'));
    expect(long?.kind === 'turn' && long.heard_excerpt.length).toBe(80);
    expect(long?.kind === 'turn' && long.heard_excerpt.endsWith('…')).toBe(true);
    const byDefault = DeviceActivityResponseSchema.parse(await (await get(me.token, `${me.deviceId}/activity`)).json());
    expect(byDefault.items).toHaveLength(5);
    expect((await get(me.token, `${me.deviceId}/activity?limit=2`)).status).toBe(200);
    for (const query of ['limit=0', 'limit=21', 'limit=abc', 'limit=2.5', 'since=1']) {
      expect((await get(me.token, `${me.deviceId}/activity?${query}`)).status).toBe(400);
    }
  });

  it('answers one 404 for another account\'s device and for an unknown id', async () => {
    const me = await owner();
    const stranger = await owner();
    await persistDeviceTurn(db, stranger.userId, undefined, 'private words', 'Ok.', stranger.deviceId);
    const foreign = await get(me.token, `${stranger.deviceId}/activity`);
    const unknown = await get(me.token, `${randomUUID()}/activity`);
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
  });

  it('a turn naming a device the account does not own saves unattributed, never failing', async () => {
    const me = await owner();
    const stranger = await owner();
    const saved = await persistDeviceTurn(db, stranger.userId, undefined, 'borrowed id', 'Ok.', me.deviceId);
    await persistDeviceTurn(db, stranger.userId, saved.conversationId, 'gone device', 'Ok.', randomUUID());
    const rows = await withUserRaw(pg, stranger.userId, (tx) => tx.query<{ device_id: string | null }>(
      'SELECT device_id FROM bob.messages WHERE conversation_id = $1', [saved.conversationId],
    ));
    expect(rows.rows.map((row) => row.device_id)).toEqual([null, null, null, null]);
    const mine = DeviceActivityResponseSchema.parse(await (await get(me.token, `${me.deviceId}/activity`)).json());
    expect(mine.items).toEqual([]);
  });
});
