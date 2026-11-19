/**
 * #457 timers_state: built from the account's pending timers (soonest four,
 * contract key order), sent to a device after welcome, and pushed to every
 * session of an account when its list changes -- an empty list clears the
 * device's countdown. The store is mocked; only the socket bytes matter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

const store = vi.hoisted(() => ({
  listPendingTimers: vi.fn(),
  duePending: vi.fn(),
  markTimerFired: vi.fn(),
  nextPendingFireAt: vi.fn(),
}));
vi.mock('../../src/timers/store.ts', async (original) => ({ ...(await original<object>()), ...store }));

import { DeviceSessions, getDeviceSessions } from '../../src/voice/device-sessions.ts';
import {
  pushTimersState, resetTimersState, sendTimersStateOnWelcome, timersStateSettled, type TimersStateDeps,
} from '../../src/voice/device-tools.ts';
import { startTimerScheduler } from '../../src/timers/scheduler.ts';
import { ServerControlDtoSchema, timersStateDto, type TimersStateDto } from '../../src/voice/protocol.ts';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const timersDeps = { registry: appDeps.deviceSessions, getDb: appDeps.getDb };
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';
const NOW = 1_790_000_000_000;
const db = {} as Db;

type Row = { id: string; userId: string; kind: 'timer' | 'alarm'; label: string | null; firesAt: number; remainingMs: number };
const row = (n: number, remainingMs: number, label: string | null = `t${n}`, userId = A): Row => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, userId, kind: n % 2 === 0 ? 'alarm' : 'timer',
  label, firesAt: NOW + remainingMs, remainingMs,
});

interface FakeSocket { readyState: number; send: ReturnType<typeof vi.fn> }
const makeSocket = (): FakeSocket => ({ readyState: 1, send: vi.fn() });
const sentTimers = (socket: FakeSocket): TimersStateDto[] => socket.send.mock.calls
  .map((call) => JSON.parse(call[0] as string) as TimersStateDto)
  .filter((message) => message.type === 'timers_state');

let registry: DeviceSessions;
let deps: TimersStateDeps;
let rows: Record<string, Row[]>;

function connect(userId: string, deviceId: string | null): FakeSocket {
  const socket = makeSocket();
  registry.register(socket as unknown as WebSocket, { id: `sess_${Math.random().toString(36).slice(2, 12)}`, stage: 'ready' }, userId, deviceId);
  return socket;
}

beforeEach(() => {
  registry = new DeviceSessions({ subscribe: () => () => undefined });
  deps = { registry, getDb: async () => db, now: () => NOW };
  rows = { [A]: [], [B]: [], [C]: [] };
  store.listPendingTimers.mockImplementation(async (_db: Db, userId: string) => rows[userId] ?? []);
});
afterEach(() => {
  resetTimersState();
  appDeps.timerScheduler.reschedule = null;
  registry.clear();
  vi.resetAllMocks();
});

describe('timersStateDto', () => {
  it('keeps the soonest four, soonest first, in contract key order', () => {
    const dto = timersStateDto([row(5, 50_000), row(1, 10_000), row(4, 40_000), row(2, 20_000), row(3, 30_000)]);
    expect(ServerControlDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto.payload.timers.map((timer) => timer.fires_in_ms)).toEqual([10_000, 20_000, 30_000, 40_000]);
    expect(Object.keys(dto.payload.timers[0]!)).toEqual(['id', 'kind', 'label', 'fires_in_ms']);
  });

  it('a null label is empty, a long one is clipped to 24, time is whole ms within bounds', () => {
    const dto = timersStateDto([row(1, 1.4, null), row(2, 5e12, 'x'.repeat(30)), row(3, -5, `${'y'.repeat(23)}😀`)]);
    expect(ServerControlDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto.payload.timers.map((timer) => [timer.label, timer.fires_in_ms])).toEqual([
      ['y'.repeat(23), 0], ['', 1], ['x'.repeat(24), 2_147_483_647],
    ]);
  });
});

describe('sent on welcome', () => {
  it('sends the account list to the welcomed socket', async () => {
    rows[A] = [row(1, 272_000, 'Pasta')];
    const socket = connect(A, 'dev-a');
    await sendTimersStateOnWelcome(socket as unknown as WebSocket, 'sess_x', A, deps);
    const [message] = sentTimers(socket);
    expect(message?.payload.timers).toEqual([{ id: row(1, 0).id, kind: 'timer', label: 'Pasta', fires_in_ms: 272_000 }]);
  });

  it('a change during the welcome read is pushed, not lost (#722)', async () => {
    const socket = connect(A, 'dev-a');
    let release: (value: Row[]) => void = () => undefined;
    store.listPendingTimers.mockImplementationOnce(() => new Promise<Row[]>((resolve) => { release = resolve; }));
    const welcomed = sendTimersStateOnWelcome(socket as unknown as WebSocket, 'sess_x', A, deps);
    await vi.waitFor(() => expect(store.listPendingTimers).toHaveBeenCalledTimes(1));
    // A timer is set while the welcome read is still out, then the read returns the old list.
    rows[A] = [row(1, 60_000)];
    const pushed = pushTimersState(deps, [A]);
    release([]);
    await Promise.all([welcomed, pushed]);
    expect(sentTimers(socket).at(-1)?.payload.timers.map((timer) => timer.id)).toEqual([row(1, 0).id]);
  });

  it('timersStateSettled resolves after a welcome still reading the store', async () => {
    const socket = connect(A, 'dev-a');
    let release: (value: Row[]) => void = () => undefined;
    store.listPendingTimers.mockImplementationOnce(() => new Promise<Row[]>((resolve) => { release = resolve; }));
    void sendTimersStateOnWelcome(socket as unknown as WebSocket, 'sess_x', A, deps);
    await vi.waitFor(() => expect(store.listPendingTimers).toHaveBeenCalledTimes(1));
    let settled = false;
    const done = timersStateSettled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release([row(1, 60_000)]);
    await done;
    expect(sentTimers(socket)).toHaveLength(1);
  });

  it('sends nothing when the store fails', async () => {
    store.listPendingTimers.mockRejectedValue(new Error('down'));
    const socket = connect(A, 'dev-a');
    await sendTimersStateOnWelcome(socket as unknown as WebSocket, 'sess_x', A, deps);
    expect(socket.send).not.toHaveBeenCalled();
  });
});

describe('pushed on change', () => {
  it('reaches every session of the changed account, and only when its list moved', async () => {
    const a1 = connect(A, 'dev-a1');
    const a2 = connect(A, null);
    const b = connect(B, 'dev-b');
    for (const [socket, user] of [[a1, A], [a2, A], [b, B]] as const) {
      await sendTimersStateOnWelcome(socket as unknown as WebSocket, 'sess', user, deps);
    }
    rows[A] = [row(1, 60_000)];
    await pushTimersState(deps);
    expect(sentTimers(a1).at(-1)?.payload.timers).toHaveLength(1);
    expect(sentTimers(a2).at(-1)?.payload.timers).toHaveLength(1);
    expect(sentTimers(b)).toHaveLength(0);
    await pushTimersState(deps);
    expect(sentTimers(a1)).toHaveLength(1);
  });

  it('an empty list is not sent on welcome (the device clears there), but later changes are', async () => {
    const socket = connect(A, 'dev-a');
    await sendTimersStateOnWelcome(socket as unknown as WebSocket, 'sess', A, deps);
    expect(socket.send).not.toHaveBeenCalled();
    rows[A] = [row(1, 1000)];
    await pushTimersState(deps);
    expect(sentTimers(socket)).toHaveLength(1);
  });

  it('caps a long list at four and an emptied list clears the view', async () => {
    const socket = connect(A, 'dev-a');
    await sendTimersStateOnWelcome(socket as unknown as WebSocket, 'sess', A, deps);
    rows[A] = [1, 2, 3, 4, 5, 6].map((n) => row(n, n * 1000));
    await pushTimersState(deps);
    expect(sentTimers(socket).at(-1)?.payload.timers).toHaveLength(4);
    rows[A] = [];
    await pushTimersState(deps);
    expect(sentTimers(socket).at(-1)?.payload.timers).toEqual([]);
  });

  it('forgets an account with no connected session', async () => {
    const socket = connect(A, 'dev-a');
    await sendTimersStateOnWelcome(socket as unknown as WebSocket, 'sess', A, deps);
    registry.clear();
    await pushTimersState(deps);
    const again = connect(A, 'dev-a');
    rows[A] = [row(1, 1000)];
    await pushTimersState(deps);
    expect(again.send).not.toHaveBeenCalled();
  });

  it('timersChanged re-arms the scheduler, then pushes (the process-wide registry and store)', async () => {
    setSharedDb(Promise.resolve(db));
    const order: string[] = [];
    appDeps.timerScheduler.reschedule = async () => { order.push('reschedule'); };
    store.listPendingTimers.mockImplementation(async () => { order.push('read'); return [row(1, 1000)]; });
    const socket = makeSocket();
    getDeviceSessions().register(socket as unknown as WebSocket, { id: 'sess_global', stage: 'ready' }, A, 'dev-a');
    try {
      await sendTimersStateOnWelcome(socket as unknown as WebSocket, 'sess_global', A, timersDeps);
      store.listPendingTimers.mockImplementation(async () => { order.push('read'); return []; });
      order.length = 0;
      await appDeps.timersChanged();
      expect(order).toEqual(['reschedule', 'read']);
      expect(sentTimers(socket).at(-1)?.payload.timers).toEqual([]);
    } finally {
      getDeviceSessions().clear();
    }
  });

  it("with three connected accounts, one account's change reads and pushes only that account", async () => {
    const sockets = [connect(A, 'dev-a'), connect(B, 'dev-b'), connect(C, 'dev-c')];
    for (const [socket, user] of [[sockets[0]!, A], [sockets[1]!, B], [sockets[2]!, C]] as const) {
      await sendTimersStateOnWelcome(socket as unknown as WebSocket, 'sess', user, deps);
    }
    rows[A] = [row(1, 1000)];
    rows[B] = [row(2, 2000, 'b', B)];
    rows[C] = [row(3, 3000, 'c', C)];
    store.listPendingTimers.mockClear();
    await pushTimersState(deps, [B]);
    expect(store.listPendingTimers.mock.calls.map((call) => call[1])).toEqual([B]);
    expect(sentTimers(sockets[1]!)).toHaveLength(1);
    expect(sentTimers(sockets[0]!)).toHaveLength(0);
    expect(sentTimers(sockets[2]!)).toHaveLength(0);
  });

  it('timersChanged(userId) reads only that account', async () => {
    setSharedDb(Promise.resolve(db));
    const reads: string[] = [];
    store.listPendingTimers.mockImplementation(async (_db: Db, userId: string) => { reads.push(userId); return []; });
    const sockets = [A, B, C].map((user) => {
      const socket = makeSocket();
      getDeviceSessions().register(socket as unknown as WebSocket, { id: `sess_${user.slice(0, 8)}`, stage: 'ready' }, user, null);
      return [socket, user] as const;
    });
    try {
      for (const [socket, user] of sockets) await sendTimersStateOnWelcome(socket as unknown as WebSocket, 'sess', user, timersDeps);
      reads.length = 0;
      await appDeps.timersChanged(C);
      expect(reads).toEqual([C]);
    } finally {
      getDeviceSessions().clear();
    }
  });

  it("the scheduler passes the fired timers' account ids to afterFire", async () => {
    const fired = (n: number, userId: string): object => ({ ...row(n, 0, 't', userId), durationMs: 1000, status: 'fired', createdAt: NOW, firedAt: NOW });
    const due = [fired(1, B), fired(2, C), fired(3, B)];
    store.duePending.mockResolvedValueOnce(due).mockResolvedValue([]);
    store.markTimerFired.mockImplementation(async (_db: Db, _user: string, id: string) => due.find((t) => (t as Row).id === id) ?? null);
    store.nextPendingFireAt.mockResolvedValue(null);
    const afterFire = vi.fn();
    const scheduler = startTimerScheduler({ db, onFire: vi.fn(), afterFire, now: () => NOW, setTimer: () => () => undefined });
    await scheduler.reschedule();
    scheduler.stop();
    expect(afterFire).toHaveBeenCalledWith([B, C]);
  });

  it('the scheduler calls afterFire once after a pass that fired', async () => {
    const fired = { ...row(1, 0), durationMs: 1000, status: 'fired', createdAt: NOW, firedAt: NOW };
    store.duePending.mockResolvedValueOnce([fired]).mockResolvedValue([]);
    store.markTimerFired.mockResolvedValue(fired);
    store.nextPendingFireAt.mockResolvedValue(null);
    const afterFire = vi.fn();
    const scheduler = startTimerScheduler({ db, onFire: vi.fn(), afterFire, now: () => NOW, setTimer: () => () => undefined });
    await scheduler.reschedule();
    await scheduler.reschedule();
    scheduler.stop();
    expect(afterFire).toHaveBeenCalledTimes(1);
  });
});
