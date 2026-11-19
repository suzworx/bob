import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { DeviceSessions } from '../../src/voice/device-sessions.ts';
import { setJournalSink } from '../../src/platform/logger.ts';

const events = { subscribe: () => () => undefined };
const socket = (): WebSocket => ({ readyState: 1, send: vi.fn(), close: vi.fn() }) as unknown as WebSocket;
const session = (id: string) => ({ id, stage: 'ready' as const });

afterEach(() => { setJournalSink(null); vi.useRealTimers(); });

describe('DeviceSessions.connectedCounts', () => {
  it('follows sockets opening, pairing and closing', () => {
    const sessions = new DeviceSessions(events);
    const a = session('a'); const b = session('b'); const legacy = session('l');
    expect(sessions.connectedCounts()).toEqual({ paired: 0, unpaired: 0 });
    sessions.trackSocket(a); sessions.trackSocket(b); sessions.trackSocket(legacy);
    expect(sessions.connectedCounts()).toEqual({ paired: 0, unpaired: 3 });
    sessions.register(socket(), a, 'user-1', 'dev-1');
    sessions.register(socket(), legacy, 'user-2', null);
    expect(sessions.connectedCounts()).toEqual({ paired: 2, unpaired: 1 });
    sessions.unregister(a); sessions.untrackSocket(a);
    sessions.untrackSocket(b);
    expect(sessions.connectedCounts()).toEqual({ paired: 1, unpaired: 0 });
    sessions.clear();
  });

  it('never goes negative on a repeated or unknown close', () => {
    const sessions = new DeviceSessions(events);
    sessions.untrackSocket(session('ghost'));
    sessions.unregister(session('ghost'));
    sessions.trackSocket(session('x'));
    sessions.untrackSocket(session('x')); sessions.untrackSocket(session('x'));
    expect(sessions.connectedCounts()).toEqual({ paired: 0, unpaired: 0 });
  });
});

describe('v2.devices_connected journal line', () => {
  it('is written on change, at most once a minute, with the last count', () => {
    vi.useFakeTimers();
    const lines: Array<{ event: string; paired?: unknown; unpaired?: unknown }> = [];
    setJournalSink((raw) => { const line = JSON.parse(raw) as { event: string }; if (line.event === 'v2.devices_connected') lines.push(line); });
    let now = 1_000_000;
    const sessions = new DeviceSessions(events, { now: () => now });
    sessions.trackSocket(session('a'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ paired: 0, unpaired: 1 });
    sessions.trackSocket(session('b'));
    sessions.trackSocket(session('c'));
    expect(lines).toHaveLength(1);
    sessions.untrackSocket(session('c'));
    vi.advanceTimersByTime(59_000);
    expect(lines).toHaveLength(1);
    now += 60_000;
    vi.advanceTimersByTime(1_000);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ paired: 0, unpaired: 2 });
    vi.advanceTimersByTime(120_000);
    expect(lines).toHaveLength(2);
    sessions.clear();
  });
});

describe('device.connected gauge', () => {
  it('reports the paired and unpaired series from the registry', async () => {
    const registered: { callback: null | (() => Array<{ value: number; attributes: Record<string, string> }>) } = { callback: null };
    vi.resetModules();
    vi.doMock('@bob/ai', async (original) => ({
      ...(await original<Record<string, unknown>>()),
      registerObservableGauge: (_name: string, callback: typeof registered.callback) => { registered.callback = callback; },
    }));
    const { registerDeviceConnectedGauge } = await import('../../src/app-deps.ts');
    const { DeviceSessions: Sessions } = await import('../../src/voice/device-sessions.ts');
    const sessions = new Sessions(events);
    sessions.trackSocket(session('a')); sessions.trackSocket(session('b'));
    sessions.register(socket(), session('a'), 'user-1', 'dev-1');
    registerDeviceConnectedGauge(sessions);
    expect(registered.callback?.()).toEqual([
      { value: 1, attributes: { paired: 'true' } }, { value: 1, attributes: { paired: 'false' } },
    ]);
    sessions.clear();
    vi.doUnmock('@bob/ai');
  });
});
