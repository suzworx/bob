import { EventEmitter } from 'node:events';
import type { Request } from 'express';
import type { WSResponse } from 'websocket-express';
import type { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { recordObservationMetrics, traceSpan } from '@bob/ai';
import { diagnoseUpgrade, rejectInvalidControl, socketSummary } from '../../src/voice/socket-diagnostics.ts';
import { countUplink, flushUplink } from '../../src/voice/turn/uplink.ts';
import { handleBinary, handleControl } from '../../src/voice/session.ts';
import { createSession, type SessionDeps } from '../../src/voice/session-handlers.ts';
import { V2_VERSION } from '../../src/voice/protocol.ts';

vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, fn: () => unknown) => fn()),
  recordObservationMetrics: vi.fn(),
}));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

function upgrade() {
  const socket = new EventEmitter();
  const request = { socket } as Request;
  const accept = vi.fn(async () => ({ readyState: 1 }));
  const reject = vi.fn();
  const response = { accept, reject } as unknown as WSResponse;
  const next = vi.fn();
  diagnoseUpgrade(request, response, next);
  expect(next).toHaveBeenCalledTimes(1);
  return { socket, response, accept, reject };
}

it.each([[401, 'invalid_token'], [503, 'auth_unavailable'], [503, 'too_many_unpaired'], [503, 'too_many_sessions'], [429, 'rate_limited']] as const)(
  'observes upgrade rejection %s/%s once across TCP close', (status, reason) => {
    const state = upgrade();
    state.response.reject(status, reason);
    state.socket.emit('close');
    expect(state.reject).toHaveBeenCalledWith(status, reason);
    expect(traceSpan).toHaveBeenCalledTimes(1);
    expect(traceSpan).toHaveBeenCalledWith('ws.upgrade', expect.objectContaining({ detached: true,
      metadata: { outcome: 'rejected', http_status: String(status), reason } }), expect.any(Function));
  });

it('observes anonymous accepted upgrades and never exports unrecognized rejection text', async () => {
  const state = upgrade();
  await state.response.accept();
  state.socket.emit('close');
  expect(traceSpan).toHaveBeenCalledTimes(1);
  expect(vi.mocked(traceSpan).mock.calls[0]?.[1].metadata).toEqual({ outcome: 'accepted', http_status: '101' });
  const another = upgrade();
  another.response.reject(400, 'private token https://private.invalid');
  expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private');
});

it('preserves failed acceptance and observes abandoned upgrades', async () => {
  const state = upgrade();
  const error = new Error('private upgrade error');
  state.accept.mockRejectedValueOnce(error);
  await expect(state.response.accept()).rejects.toBe(error);
  const another = upgrade();
  another.socket.emit('close');
  expect(vi.mocked(traceSpan).mock.calls.map((call) => call[1].metadata?.outcome)).toEqual(['failed', 'closed']);
});

it('counts every heartbeat in one session summary and marks timeout failure', () => {
  const summary = socketSummary();
  summary.ping(); summary.pong(); summary.pong(); summary.timeout();
  expect(traceSpan).not.toHaveBeenCalled();
  summary.close(1006);
  expect(traceSpan).toHaveBeenCalledWith('ws.session', expect.objectContaining({ detached: true,
    metadata: expect.objectContaining({ outcome: 'failed', reason: 'heartbeat_timeout', frames: '3' }) }), expect.any(Function));
});

it('summarizes audio frames once, including invalid state and binary rejection without bytes', () => {
  const session = createSession();
  const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  const deps = { deviceSessions: { flushPending: vi.fn() } } as unknown as SessionDeps;
  countUplink(session, 320);
  countUplink(session, 320);
  handleBinary(deps, socket, session, Buffer.from('private audio'));
  session.stage = 'capturing';
  handleBinary(deps, socket, session, Buffer.from('private audio'));
  expect(traceSpan).not.toHaveBeenCalled();
  flushUplink(session);
  flushUplink(session);
  expect(traceSpan).toHaveBeenCalledTimes(1);
  expect(recordObservationMetrics).toHaveBeenCalledWith([
    { name: 'ws.uplink.accepted_frames', value: 2 }, { name: 'ws.uplink.rejected_frames', value: 2 }, { name: 'ws.uplink.bytes', value: 640 },
  ]);
  expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private audio');
});

it('ws.uplink.accepted_frames counts 10 ms PCM frames, not messages, when the device batches them', () => {
  const session = createSession();
  countUplink(session, 4 * 320);
  countUplink(session, 8 * 320);
  flushUplink(session);
  expect(recordObservationMetrics).toHaveBeenCalledWith([
    { name: 'ws.uplink.accepted_frames', value: 12 }, { name: 'ws.uplink.rejected_frames', value: 0 }, { name: 'ws.uplink.bytes', value: 3840 },
  ]);
});

it('covers invalid controls and handled authorization/state errors through the real dispatcher', async () => {
  vi.useFakeTimers();
  rejectInvalidControl('BAD_MESSAGE');
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn() }) as unknown as WebSocket;
  const session = createSession({ kind: 'unpaired', reason: 'none' });
  const deps = { getDb: vi.fn(), deviceSessions: { flushPending: vi.fn() } } as unknown as SessionDeps;
  await handleControl(deps, socket, session, { v: V2_VERSION, type: 'turn_start', id: 'message_001', turn_ref: 'turn_000001', payload: {} }, vi.fn());
  expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([{ name: 'ws.control.rejected', value: 1 }]));
  expect(traceSpan).toHaveBeenCalledWith('ws.control.turn_start', expect.objectContaining({ detached: true }), expect.any(Function));
  expect(deps.getDb).not.toHaveBeenCalled();
  socket.emit('close');
});
