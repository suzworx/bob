// web-timers.ts route tests (#457). A real HTTP server over Postgres with the
// real store, so account scoping is decided by genuine RLS: another account's
// timer is invisible to the list and answers a cancel exactly like a missing one.
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db } from '../../src/platform/db/db.ts';
import { cancelTimers, createAlarm, createTimer, dismissTimer, listPendingTimers, markTimerFired } from '../../src/timers/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createTimersRouter } from '../../src/timers/http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
let changes = 0;
let changedFor: string | null = null;
const NOW = Date.UTC(2026, 8, 25, 12, 0);

async function call(method: string, path: string, tok: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${tok}` } });
}

type TimerBody = { id: string; kind: string; label: string | null; fire_at: number; remaining_ms: number; zone: string };

describe('timers HTTP API', () => {
  let owner: TestAccount;
  let other: TestAccount;
  let ownerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    owner = await addAccount(pg);
    other = await addAccount(pg);
    ownerToken = await signToken({ userId: owner.userId, sessionId: owner.sessionId });
    otherToken = await signToken({ userId: other.userId, sessionId: other.sessionId });

    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api', createTimersRouter({
      getDb: () => Promise.resolve(db),
      onChange: (userId) => { changes += 1; changedFor = userId; },
      now: () => NOW,
    }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await closeTestDb(pg).catch(() => undefined);
  });

  it('lists only the caller\'s pending timers and alarms, soonest first', async () => {
    const pasta = await createTimer(db, owner.userId, { durationMs: 5 * 60_000, label: 'pasta', now: NOW });
    const alarm = await createAlarm(db, owner.userId, { time: '07:00', timeZone: 'UTC', now: NOW });
    const fired = await createTimer(db, owner.userId, { durationMs: 60_000, now: NOW });
    await markTimerFired(db, owner.userId, fired.id, NOW);
    const gone = await createTimer(db, owner.userId, { durationMs: 90_000, now: NOW });
    await cancelTimers(db, owner.userId, { id: gone.id });
    await createTimer(db, other.userId, { durationMs: 120_000, label: 'tea', now: NOW });

    const res = await call('GET', '/api/timers', ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { timers: TimerBody[] };
    expect(body.timers).toEqual([
      { id: pasta.id, kind: 'timer', label: 'pasta', fire_at: NOW + 300_000, remaining_ms: 300_000, zone: 'UTC' },
      { id: alarm.id, kind: 'alarm', label: null, fire_at: alarm.firesAt, remaining_ms: alarm.firesAt - NOW, zone: 'UTC' },
    ]);
  });

  it('cancels one of the caller\'s timers and re-arms the scheduler', async () => {
    const [first] = await listPendingTimers(db, owner.userId, NOW);
    const before = changes;
    const res = await call('DELETE', `/api/timers/${first!.id}`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cancelled: TimerBody; remaining: number };
    expect(body.cancelled).toMatchObject({ id: first!.id, kind: 'timer', label: 'pasta' });
    expect(body.remaining).toBe(1);
    expect(changes).toBe(before + 1);
    // Only the caller's devices are pushed.
    expect(changedFor).toBe(owner.userId);
    const left = await listPendingTimers(db, owner.userId, NOW);
    expect(left.map((t) => t.id)).not.toContain(first!.id);
  });

  it('another account\'s timer answers 404 and stays pending', async () => {
    const [tea] = await listPendingTimers(db, other.userId, NOW);
    const before = changes;
    const res = await call('DELETE', `/api/timers/${tea!.id}`, ownerToken);
    expect(res.status).toBe(404);
    expect(changes).toBe(before);
    expect((await listPendingTimers(db, other.userId, NOW)).map((t) => t.id)).toEqual([tea!.id]);
  });

  it('a timer that is no longer pending answers 404', async () => {
    const [first] = await listPendingTimers(db, other.userId, NOW);
    expect((await call('DELETE', `/api/timers/${first!.id}`, otherToken)).status).toBe(200);
    expect((await call('DELETE', `/api/timers/${first!.id}`, otherToken)).status).toBe(404);
  });

  it('an account with nothing running lists no timers', async () => {
    const res = await call('GET', '/api/timers', otherToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ timers: [] });
  });

  it('rejects a malformed timer id', async () => {
    expect((await call('DELETE', '/api/timers/not-a-uuid', ownerToken)).status).toBe(400);
  });

  it('rejects a request without a token', async () => {
    const res = await fetch(`${baseUrl}/api/timers`);
    expect(res.status).toBe(401);
  });

  it('returns active plus requested terminal states without disclosing another account or untracked history', async () => {
    const account = await addAccount(pg);
    const tok = await signToken({ userId: account.userId, sessionId: account.sessionId });
    const pending = await createTimer(db, account.userId, { durationMs: 1_000, now: NOW });
    const fired = await createTimer(db, account.userId, { durationMs: 2_000, now: NOW });
    const cancelled = await createTimer(db, account.userId, { durationMs: 3_000, now: NOW });
    const dismissed = await createTimer(db, account.userId, { durationMs: 4_000, now: NOW });
    const history = await createTimer(db, account.userId, { durationMs: 5_000, now: NOW });
    const foreign = await createTimer(db, other.userId, { durationMs: 6_000, now: NOW });
    await markTimerFired(db, account.userId, fired.id, NOW + 2_000);
    await cancelTimers(db, account.userId, { id: cancelled.id });
    await markTimerFired(db, account.userId, dismissed.id, NOW + 4_000);
    await dismissTimer(db, account.userId, dismissed.id);
    await markTimerFired(db, account.userId, history.id, NOW + 5_000);
    const ids = [fired.id, cancelled.id, dismissed.id, foreign.id, randomUUID()];
    const res = await call('GET', `/api/timers/notification-state?ids=${ids.join(',')}`, tok);
    expect(res.status).toBe(200);
    const body = await res.json() as { timers: (TimerBody & { status: string })[] };
    expect(body.timers.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: pending.id, status: 'pending' }, { id: fired.id, status: 'fired' },
      { id: cancelled.id, status: 'cancelled' }, { id: dismissed.id, status: 'dismissed' },
    ]);
    expect(body.timers.find((timer) => timer.id === fired.id)?.fire_at).toBe(NOW + 2_000);
  });

  it('bounds tracked ids and active rows, while retaining a requested active row beyond the first60', async () => {
    const account = await addAccount(pg);
    const tok = await signToken({ userId: account.userId, sessionId: account.sessionId });
    const rows = await Promise.all(Array.from({ length: 61 }, (_, i) => createTimer(db, account.userId, { durationMs: (i + 1) * 1_000, now: NOW })));
    const res = await call('GET', '/api/timers/notification-state', tok);
    expect(res.status).toBe(200);
    const body = await res.json() as { timers: TimerBody[] };
    expect(body.timers).toHaveLength(60);
    expect(body.timers[59]?.id).toBe(rows[59]?.id);
    const tracked = await call('GET', `/api/timers/notification-state?ids=${rows[60]?.id}`, tok);
    expect((await tracked.json() as { timers: TimerBody[] }).timers).toHaveLength(61);
    for (const query of ['ids=bad', `ids=${Array.from({ length: 61 }, () => randomUUID()).join(',')}`, `ids=${rows[0]?.id},${rows[0]?.id}`]) {
      expect((await call('GET', `/api/timers/notification-state?${query}`, tok)).status).toBe(400);
    }
    expect((await fetch(`${baseUrl}/api/timers/notification-state`)).status).toBe(401);
  });
});
