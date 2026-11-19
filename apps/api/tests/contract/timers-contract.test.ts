// #757 contract lock: timers and reminders as they are today, before
// bob.timers folds into bob.reminders. Real routers and stores over the
// test database, a fixed injected clock, volatile ids and times normalised.
// Later #757 units must leave this snapshot byte-identical: no timer may leak
// into a reminder read, and no timer shape may change.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocket } from 'ws';
import express from 'express';
import type { Tool } from 'ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// AI-stub mode as core-invocations-stub.test.ts: no real model call anywhere.
vi.mock('@bob/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  AI_STUB_MODE: true,
}));

import { createTimerTools } from '@bob/ai';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { listDeviceActivity } from '../../src/devices/activity.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { createTimersRouter } from '../../src/timers/http.ts';
import { bindTimerTools } from '../../src/timers/tools.ts';
import {
  cancelTimers, createAlarm, createTimer, dismissTimer, duePending, listPendingTimers, markTimerFired, nextPendingFireAt,
} from '../../src/timers/store.ts';
import { createRemindersRouter } from '../../src/reminders/http.ts';
import { createReminder, getReminder, listReminders } from '../../src/reminders/store.ts';
import { timersStateDto } from '../../src/voice/protocol.ts';
import { sendTimersStateOnWelcome } from '../../src/voice/device-tools.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { readAccountExport } from '../../src/account/export-http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
/** The fixed clock every route, store call and tool runs on. */
const NOW = Date.UTC(2030, 0, 1, 12, 0);
const MIN = 60_000;

let ids = new Map<string, string>();
beforeEach(() => {
  ids = new Map();
});

/** One stable placeholder per distinct id, numbered in order of first sight within a test. */
function stable(raw: string, kind: string): string {
  const key = raw.toLowerCase();
  if (!ids.has(key)) ids.set(key, `<${kind}-${ids.size + 1}>`);
  return ids.get(key)!;
}

function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    if (UUID.test(value)) return stable(value, 'uuid');
    if (ISO.test(value)) return '<iso>';
    // messageId(): a contract prefix over 20 random hex chars (timers_state "tmrs_").
    const message = /^([a-z]+_)[0-9a-f]{20}$/.exec(value);
    if (message) return `${message[1]}${stable(value, 'msg')}`;
    return value;
  }
  if (typeof value === 'number' && value > 1e12) return '<epoch-ms>';
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalize(inner)]));
  }
  return value;
}

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  const getDb = (): Promise<Db> => Promise.resolve(db);
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api', createTimersRouter({ getDb, onChange: () => undefined, now: () => NOW }));
  app.use('/api', createRemindersRouter({ getDb }));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.close();
  await closeTestDb(pg).catch(() => undefined);
});

type Account = { userId: string; token: string };

/** A fresh account per test, so no snapshot depends on another test's rows. */
async function account(): Promise<Account> {
  const { userId, sessionId } = await addAccount(pg);
  return { userId, token: await signToken({ userId, sessionId }) };
}

/** Status plus normalised JSON body. */
async function http(method: string, path: string, who: Account): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${who.token}` } });
  return { status: res.status, body: normalize(await res.json()) };
}

/** The voice tools exactly as the api wires them for one account (UTC), on the fixed clock. */
function voiceTools(who: Account): (name: string, input?: unknown) => Promise<unknown> {
  const tools = createTimerTools(bindTimerTools(db, who.userId, { timeZone: 'UTC', now: () => NOW }));
  return async (name, input = {}) => {
    const execute = (tools[name] as Tool).execute as (input: unknown, options: unknown) => Promise<unknown>;
    return normalize(await execute(input, { toolCallId: 't', messages: [] }));
  };
}

/** One account's timer, alarm, fired, cancelled and dismissed rows on the fixed clock. */
async function seedTimers(who: Account): Promise<Record<'timer' | 'alarm' | 'fired' | 'cancelled' | 'dismissed', string>> {
  const create = (durationMs: number, label: string): Promise<{ id: string }> =>
    createTimer(db, who.userId, { durationMs, label, now: NOW });
  const timer = await create(10 * MIN, 'pasta');
  const alarm = await createAlarm(db, who.userId, { time: '13:00', timeZone: 'UTC', label: 'wake up', now: NOW });
  const fired = await create(MIN, 'tea');
  const cancelled = await create(2 * MIN, 'eggs');
  const dismissed = await create(3 * MIN, 'laundry');
  await markTimerFired(db, who.userId, fired.id, NOW + MIN);
  await markTimerFired(db, who.userId, dismissed.id, NOW + 3 * MIN);
  await dismissTimer(db, who.userId, dismissed.id);
  await cancelTimers(db, who.userId, { id: cancelled.id });
  return { timer: timer.id, alarm: alarm.id, fired: fired.id, cancelled: cancelled.id, dismissed: dismissed.id };
}

describe('timers HTTP', () => {
  it('lists none, then only the pending timer and alarm', async () => {
    const a = await account();
    const none = await http('GET', '/api/timers', a);
    await seedTimers(a);
    expect([none, await http('GET', '/api/timers', a)]).toMatchSnapshot();
  });

  it('cancels one timer, then answers 404 for it, a fired one and a cancelled one', async () => {
    const a = await account();
    const seeded = await seedTimers(a);
    const out = {
      cancelPending: await http('DELETE', `/api/timers/${seeded.timer}`, a),
      cancelAgain: await http('DELETE', `/api/timers/${seeded.timer}`, a),
      cancelFired: await http('DELETE', `/api/timers/${seeded.fired}`, a),
      cancelCancelled: await http('DELETE', `/api/timers/${seeded.cancelled}`, a),
      cancelUnknown: await http('DELETE', `/api/timers/${randomUUID()}`, a),
      cancelMalformed: await http('DELETE', '/api/timers/not-a-uuid', a),
      listAfter: await http('GET', '/api/timers', a),
    };
    expect(out).toMatchSnapshot();
  });

  it('keeps account A timers from account B', async () => {
    const a = await account();
    const b = await account();
    const seeded = await seedTimers(a);
    const out = {
      bList: await http('GET', '/api/timers', b),
      bCancelsA: await http('DELETE', `/api/timers/${seeded.timer}`, b),
      aStillHasIt: await http('GET', '/api/timers', a),
    };
    expect(out).toMatchSnapshot();
  });
});

describe('timers store', () => {
  it('creates timers and alarms with and without a label', async () => {
    const a = await account();
    const rows = [
      await createTimer(db, a.userId, { durationMs: 10 * MIN, label: 'the pasta timer', now: NOW }),
      await createTimer(db, a.userId, { durationMs: 90_000, now: NOW }),
      await createAlarm(db, a.userId, { time: '13:30', timeZone: 'UTC', label: 'my wake up alarm', now: NOW }),
      await createAlarm(db, a.userId, { time: '7am', timeZone: 'America/New_York', now: NOW }),
    ];
    expect(normalize(rows)).toMatchSnapshot();
    expect(normalize(await listPendingTimers(db, a.userId, NOW + MIN))).toMatchSnapshot();
  });

  it('cancels by label, by id, the only one, all, and reports what stays pending', async () => {
    const a = await account();
    const one = await createTimer(db, a.userId, { durationMs: 10 * MIN, label: 'pasta', now: NOW });
    const out: Record<string, unknown> = { byLabel: await cancelTimers(db, a.userId, { label: 'the Pasta timer' }) };
    const two = await createTimer(db, a.userId, { durationMs: 5 * MIN, now: NOW });
    await createAlarm(db, a.userId, { time: '13:00', timeZone: 'UTC', now: NOW });
    out.ambiguous = await cancelTimers(db, a.userId, {});
    out.byId = await cancelTimers(db, a.userId, { id: two.id });
    out.byMalformedId = await cancelTimers(db, a.userId, { id: 'nope' });
    out.onlyOne = await cancelTimers(db, a.userId, {});
    await createTimer(db, a.userId, { durationMs: MIN, now: NOW });
    await createTimer(db, a.userId, { durationMs: 2 * MIN, now: NOW });
    out.all = await cancelTimers(db, a.userId, { all: true });
    out.none = await cancelTimers(db, a.userId, { all: true });
    expect(one.id).toBeTruthy();
    expect(normalize(out)).toMatchSnapshot();
  });

  it('marks fired once, dismisses a fired timer once, ignores malformed ids', async () => {
    const a = await account();
    const t = await createTimer(db, a.userId, { durationMs: MIN, label: 'tea', now: NOW });
    const out = {
      dismissPending: await dismissTimer(db, a.userId, t.id),
      fire: await markTimerFired(db, a.userId, t.id, NOW + MIN),
      fireAgain: await markTimerFired(db, a.userId, t.id, NOW + 2 * MIN),
      dismiss: await dismissTimer(db, a.userId, t.id),
      dismissAgain: await dismissTimer(db, a.userId, t.id),
      fireMalformed: await markTimerFired(db, a.userId, 'nope', NOW),
      dismissMalformed: await dismissTimer(db, a.userId, 'nope'),
      listAfter: await listPendingTimers(db, a.userId, NOW + MIN),
    };
    expect(normalize(out)).toMatchSnapshot();
  });

  it('reads due timers and the next fire time across accounts', async () => {
    const a = await account();
    // Fires in 2020, earlier than every other test's rows, so the global reads are ours.
    const past = Date.UTC(2020, 0, 1);
    const early = await createTimer(db, a.userId, { durationMs: 1000, label: 'early', now: past });
    const later = await createTimer(db, a.userId, { durationMs: 5000, now: past });
    const mine = (rows: { userId: string }[]): unknown[] => normalize(rows.filter((r) => r.userId === a.userId)) as unknown[];
    const out = {
      notDueYet: mine(await duePending(db, past + 500)),
      dueOne: mine(await duePending(db, past + 1000)),
      dueBoth: mine(await duePending(db, past + 6000)),
      nextIsEarly: (await nextPendingFireAt(db)) === early.firesAt,
    };
    await markTimerFired(db, a.userId, early.id, past + 1000);
    const nextAfterFire = await nextPendingFireAt(db);
    await cancelTimers(db, a.userId, { all: true });
    expect({ ...out, nextIsLater: nextAfterFire === later.firesAt, firedNotDue: mine(await duePending(db, past + 6000)) }).toMatchSnapshot();
  });
});

describe('timer voice tools', () => {
  it('returns the set, list and cancel result objects', async () => {
    const a = await account();
    const call = voiceTools(a);
    const out = {
      listEmpty: await call('list_timers'),
      cancelNone: await call('cancel_timer', {}),
      setTimer: await call('set_timer', { duration: 'PT10M', label: 'the pasta timer' }),
      setTimerSeconds: await call('set_timer', { duration: 90 }),
      setTimerUnreadable: await call('set_timer', { duration: 'soon' }),
      setTimerTooLong: await call('set_timer', { duration: 'PT48H' }),
      setAlarm: await call('set_alarm', { time: '13:30', label: 'wake up' }),
      setAlarmPast: await call('set_alarm', { time: '2020-01-01T00:00' }),
      list: await call('list_timers'),
      cancelWhichOne: await call('cancel_timer', {}),
      cancelUnknown: await call('cancel_timer', { label: 'nothing' }),
      cancelByLabel: await call('cancel_timer', { label: 'pasta' }),
      cancelAll: await call('cancel_timer', { all: true }),
      listAfter: await call('list_timers'),
    };
    expect(out).toMatchSnapshot();
  });
});

describe('device activity and timers_state', () => {
  it('lists fired and dismissed timers as account-scope activity, never pending or cancelled ones', async () => {
    const a = await account();
    const b = await account();
    await seedTimers(a);
    const device = { id: randomUUID(), pairedAt: NOW - 60 * MIN };
    const out = {
      owner: await listDeviceActivity(db, a.userId, device, 10),
      ownerLimit1: await listDeviceActivity(db, a.userId, device, 1),
      pairedAfter: await listDeviceActivity(db, a.userId, { ...device, pairedAt: NOW + 2 * MIN }, 10),
      other: await listDeviceActivity(db, b.userId, device, 10),
    };
    expect(normalize(out)).toMatchSnapshot();
  });

  it('builds the timers_state payload: soonest four, null label as empty', async () => {
    const a = await account();
    for (let i = 1; i <= 5; i += 1) await createTimer(db, a.userId, { durationMs: i * MIN, now: NOW });
    await createAlarm(db, a.userId, { time: '12:30', timeZone: 'UTC', label: 'half past', now: NOW });
    await seedTimers(a);
    const pending = await listPendingTimers(db, a.userId, NOW);
    expect(normalize({ all: timersStateDto(pending), none: timersStateDto([]) })).toMatchSnapshot();
  });

  it('pushes timers_state on welcome only to an account that has pending timers', async () => {
    const a = await account();
    const b = await account();
    await seedTimers(a);
    const sent: unknown[] = [];
    const socket = { readyState: 1, send: (text: string): void => void sent.push(JSON.parse(text)) } as unknown as WebSocket;
    const deps = { registry: getDeviceSessions(), getDb: (): Promise<Db> => Promise.resolve(db), now: () => NOW };
    await sendTimersStateOnWelcome(socket, 'sess-a', a.userId, deps);
    await sendTimersStateOnWelcome(socket, 'sess-b', b.userId, deps);
    expect(normalize(sent)).toMatchSnapshot();
  });
});

/** A user with a group space, one reminder and the seeded timers. */
async function accountWithReminderAndTimers(pinCreationOrder = false): Promise<Account & { spaceId: string; reminderId: string }> {
  const who = await account();
  const spaceId = (await createSpace(db, who.userId, { kind: 'group', name: 'Family' })).id;
  const reminder = await createReminder(db, who.userId, spaceId, {
    title: 'water the plants', due: { kind: 'instant', at: NOW + 60 * MIN, zone: 'UTC' },
  });
  const seeded = await seedTimers(who);
  if (pinCreationOrder) {
    // Export orders by database created_at, not the injected timer clock.
    // Distinct fixture timestamps keep the snapshot independent of wall-clock changes.
    await withUser(db, who.userId, async (tx) => {
      for (const [index, id] of Object.values(seeded).entries()) {
        await tx.query('UPDATE bob.reminders SET created_at = $1 WHERE id = $2 AND created_by = $3',
          [new Date(NOW + index * MIN).toISOString(), id, who.userId]);
      }
    });
  }
  return { ...who, spaceId, reminderId: reminder.id };
}

/** What the export route writes: the sections as JSON, volatile values normalised. */
async function exported(who: Account): Promise<Record<string, unknown[]>> {
  return normalize(JSON.parse(JSON.stringify(await readAccountExport(db, who.userId)))) as Record<string, unknown[]>;
}

describe('account export', () => {
  it('puts the timers in timers and the reminder in reminders, never crossed', async () => {
    const a = await accountWithReminderAndTimers(true);
    const raw = JSON.parse(JSON.stringify(await readAccountExport(db, a.userId))) as Record<string, unknown[]>;
    // The reminder's space is numbered first, as in the stored snapshot; no other section shifts the numbers.
    const out = normalize({ space: a.spaceId, sections: Object.keys(raw), reminders: raw.reminders, timers: raw.timers }) as Record<string, unknown>;
    expect({ sections: out.sections, reminders: out.reminders, timers: out.timers }).toMatchSnapshot();
  });
});

describe('reminder reads with timers present', () => {
  it('lists only reminders over HTTP and in the store', async () => {
    const a = await accountWithReminderAndTimers();
    const out = {
      http: await http('GET', `/api/spaces/${a.spaceId}/reminders`, a),
      store: normalize(await listReminders(db, a.userId, a.spaceId)),
      get: normalize(await getReminder(db, a.userId, a.reminderId)),
      timerIdAsReminder: await getReminder(db, a.userId, (await listPendingTimers(db, a.userId, NOW))[0]!.id)
        .then(() => 'found', (error: Error) => `${error.constructor.name}: ${error.message}`),
    };
    expect(out).toMatchSnapshot();
  });
});

describe('two-account isolation', () => {
  it('never shows account A timers or reminders to account B', async () => {
    const a = await accountWithReminderAndTimers();
    const b = await account();
    const bSpace = (await createSpace(db, b.userId, { kind: 'group', name: 'Other' })).id;
    const device = { id: randomUUID(), pairedAt: NOW - 60 * MIN };
    const sent: unknown[] = [];
    const socket = { readyState: 1, send: (text: string): void => void sent.push(JSON.parse(text)) } as unknown as WebSocket;
    await sendTimersStateOnWelcome(socket, 'sess-b', b.userId, {
      registry: getDeviceSessions(), getDb: (): Promise<Db> => Promise.resolve(db), now: () => NOW,
    });
    const bData = await exported(b);
    const out = {
      timersHttp: await http('GET', '/api/timers', b),
      remindersOfASpace: await http('GET', `/api/spaces/${a.spaceId}/reminders`, b),
      remindersOfOwnSpace: await http('GET', `/api/spaces/${bSpace}/reminders`, b),
      storeList: normalize(await listReminders(db, b.userId, a.spaceId)),
      activity: normalize(await listDeviceActivity(db, b.userId, device, 10)),
      voiceList: await voiceTools(b)('list_timers'),
      timersState: normalize(timersStateDto(await listPendingTimers(db, b.userId, NOW))),
      welcomePushes: sent,
      exportTimers: bData.timers,
      exportReminders: bData.reminders,
    };
    expect(out).toMatchSnapshot();
  });
});
