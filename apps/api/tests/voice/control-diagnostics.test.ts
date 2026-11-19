import { afterEach, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { WebSocket } from 'ws';
import { recordObservationMetrics, traceSpan } from '@bob/ai';
import { CONTROL_COVERAGE, diagnoseControl, rejectControl } from '../../src/voice/control-diagnostics.ts';
import { ClientControlDtoSchema, V2_VERSION } from '../../src/voice/protocol.ts';
import { handleControl } from '../../src/voice/session.ts';
import { createSession, type SessionDeps } from '../../src/voice/session-handlers.ts';
import { countUplink } from '../../src/voice/turn/uplink.ts';
vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, fn: () => unknown) => fn()),
  recordObservationMetrics: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(traceSpan).mockImplementation(async (_name, _attrs, run) => run());
});
it('assigns every wire control an operation or heartbeat summary', () => {
  expect(Object.keys(CONTROL_COVERAGE).sort()).toEqual(ClientControlDtoSchema.options.map((schema) => schema.shape.type.value).sort());
  expect(Object.entries(CONTROL_COVERAGE).filter(([, mode]) => mode === 'summary')).toEqual([['pong', 'summary']]);
});
it.each(ClientControlDtoSchema.options.map((schema) => schema.shape.type.value).filter((type) => type !== 'pong'))('measures the complete %s dispatch without payload', async (type) => {
  let now = 0;
  await diagnoseControl(type, async () => { now = 12; }, () => now);
  expect(traceSpan).toHaveBeenCalledWith(`ws.control.${type}`, expect.objectContaining({ metadata: { ws_control: type } }), expect.any(Function));
  expect(recordObservationMetrics).toHaveBeenCalledWith([
    { name: 'ws.control.duration_ms', value: 12 }, { name: 'ws.control.failed', value: 0 }, { name: 'ws.control.rejected', value: 0 },
  ]);
});
it('records handled wire rejection without changing dispatch behavior', async () => {
  await diagnoseControl('select_space', () => rejectControl('UNPAIRED'));
  expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([
    { name: 'ws.control.failed', value: 0 }, { name: 'ws.control.rejected', value: 1 },
  ]));
});
it('preserves dispatch errors, records failure once, never exports raw error', async () => {
  const error = new Error('private payload');
  await expect(diagnoseControl('select_space', () => { throw error; })).rejects.toBe(error);
  expect(recordObservationMetrics).toHaveBeenCalledTimes(1);
  expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([{ name: 'ws.control.failed', value: 1 }]));
  expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private payload');
});
it('keeps heartbeat controls in the session summary', async () => {
  const work = vi.fn();
  await diagnoseControl('pong', work);
  expect(work).toHaveBeenCalledTimes(1);
  expect(traceSpan).not.toHaveBeenCalled();
});

function traceId(namespace: string | undefined, turn: string | undefined): string {
  return createHash('sha256').update(JSON.stringify([namespace, turn])).digest('hex').slice(0, 32);
}

function captureTraceContext(): Array<{ name: string; traceId: string; traceName: string }> {
  const scope = new AsyncLocalStorage<{ traceId: string; traceName: string }>();
  const observations: Array<{ name: string; traceId: string; traceName: string }> = [];
  vi.mocked(traceSpan).mockImplementation(async (name, attrs, run) => {
    // Native OTel children retain their active parent's trace even when they supply another seed.
    const parent = attrs.detached ? undefined : scope.getStore();
    const current = {
      traceId: parent?.traceId ?? traceId(attrs.workflowNamespace, attrs.turnId),
      traceName: attrs.traceName ?? parent?.traceName ?? name,
    };
    observations.push({ name, ...current });
    return scope.run(current, run);
  });
  return observations;
}

it.each([undefined, 'turn_other_001', 'turn_active_001'])('joins cancellation to the server-owned turn when the client ref is %s', async (clientRef) => {
  const session = createSession();
  session.stage = 'responding';
  session.turnRef = 'turn_active_001';
  session.turnAbort = new AbortController();
  session.turnDone = Promise.resolve();
  const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  const observations = captureTraceContext();

  await handleControl({} as SessionDeps, socket, session, {
    v: V2_VERSION, type: 'cancel', id: 'message_001', payload: {},
    ...(clientRef === undefined ? {} : { turn_ref: clientRef }),
  }, vi.fn());

  expect(session.turnAbort.signal.aborted).toBe(true);
  expect(observations).toEqual([
    { name: 'ws.control.cancel', traceId: traceId(session.id, 'turn_active_001'), traceName: 'device-turn' },
    { name: 'device-turn-cancelled', traceId: traceId(session.id, 'turn_active_001'), traceName: 'device-turn' },
  ]);
});

it('keeps controls, existing turn milestones, nested agent work and uplink on the canonical device trace', async () => {
  const session = createSession();
  session.stage = 'ready';
  const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  const observations = captureTraceContext();
  const deps = {} as SessionDeps;
  await handleControl(deps, socket, session, {
    v: V2_VERSION, type: 'turn_start', id: 'message_001', payload: {}, turn_ref: 'turn_active_001',
  }, vi.fn());
  countUplink(session, 320);
  await handleControl(deps, socket, session, {
    v: V2_VERSION, type: 'turn_end', id: 'message_002', payload: {}, turn_ref: 'turn_active_001', seq: 0,
  }, () => traceSpan('synthetic-agent', {}, () => undefined));
  await session.turnDone;

  // The root itself is opened by `openSpan`, not `traceSpan`, so it is not an observation here.
  // The accepted turn_end closes the uplink receive window before the pipeline starts (#999).
  expect(observations.map(({ name }) => name)).toEqual([
    'ws.control.turn_start', 'device-turn-started', 'ws.control.turn_end', 'ws.uplink', 'device-turn-ended',
    'turn-pipeline', 'synthetic-agent',
  ]);
  expect(observations.every((observation) => observation.traceName === 'device-turn'
    && observation.traceId === traceId(session.id, 'turn_active_001'))).toBe(true);
});
