// OBS-N9: one root span per device turn. The real tracer runs with the OTLP
// exporter swapped for an in-memory one; the turn pipeline is a stand-in that
// opens child spans the way the real one does and then resets the session.
import { context, propagation, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { otlpSpans } from '../support/memory-otlp.ts';

vi.mock('@opentelemetry/exporter-trace-otlp-proto', async () => ({
  OTLPTraceExporter: (await import('../support/memory-otlp.ts')).MemoryOtlpTraceExporter,
}));
vi.mock('../../src/platform/logger.ts', async (original) => ({
  ...(await original<object>()), ...(await import('../helpers/journal-mock.ts')).loggerMock(),
}));

import { flushTelemetry, initTelemetry, traceSpan } from '@bob/ai';
import { createAppDeps } from '../../src/app-deps.ts';
import { createSession, resetSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { countUplink } from '../../src/voice/turn/uplink.ts';
import { turnRootOf } from '../../src/voice/turn/turn-root.ts';
import { canonicalId } from '../../src/platform/ids.ts';
import { V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { closeDb, setSharedDb } from '../../src/platform/db/db.ts';
import { journal } from '../../src/platform/logger.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { getActive } from '../../src/conversations/active.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const CONVERSATION = canonicalId('conversation', 'thr_conv0001')!;
const appDeps = createAppDeps();
let pg: TestDb;
let userId: string;
/** Span ends run on microtasks after the root is released; wait for them, then export. */
const settled = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)); await flushTelemetry(); };
const control = (type: string, extra: Record<string, unknown> = {}): ClientControlDto =>
  ({ v: V2_VERSION, type, id: 'test_ctrl_000001', payload: {}, ...extra }) as unknown as ClientControlDto;
const fake = (): WebSocket => ({ readyState: 1, send: vi.fn() }) as unknown as WebSocket;

beforeAll(async () => {
  pg = await createTestDb();
  setSharedDb(Promise.resolve(asDb(pg)));
  ({ userId } = await addAccount(pg));
  initTelemetry();
});
afterAll(async () => {
  await flushTelemetry();
  trace.disable(); context.disable(); propagation.disable();
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});
beforeEach(() => { otlpSpans.reset(); vi.mocked(journal).mockClear(); });

const session = (paired: boolean): DeviceSession => {
  const s = createSession(paired ? { kind: 'device', userId, deviceId: crypto.randomUUID(), name: 'Card' } : undefined);
  Object.assign(s, { stage: 'ready', activeConversationId: 'thr_conv0001' });
  return s;
};

async function runTurn(s: DeviceSession, outcome: 'ok' | 'fail' | 'cancel'): Promise<ReadableSpan[]> {
  const ws = fake();
  const ref = `turn_${outcome}01`;
  await handleControl(appDeps, ws, s, control('turn_start', { turn_ref: ref }), vi.fn());
  s.nextUplinkSeq = 1; countUplink(s, 320);
  await handleControl(appDeps, ws, s, control('device_log', {
    turn_ref: ref, payload: { event: 'x', uptime_ms: 1, heap_free: 2, heap_largest: 3 },
  }), vi.fn());
  if (outcome === 'cancel') {
    await handleControl(appDeps, ws, s, control('cancel'), vi.fn());
  } else {
    await handleControl(appDeps, ws, s, control('turn_end', { turn_ref: ref, seq: 0 }), async () => {
      await traceSpan('ai.transcribe', {}, async () => undefined);
      if (outcome === 'fail') throw new Error('boom');
      resetSession(appDeps, s);
    });
    await s.turnDone;
  }
  await settled();
  return otlpSpans.getFinishedSpans();
}

const names = (spans: ReadableSpan[]): string[] => spans.map((span) => span.name).sort();
const parentOf = (spans: ReadableSpan[], span: ReadableSpan): string | undefined =>
  spans.find((candidate) => candidate.spanContext().spanId === span.parentSpanContext?.spanId)?.name;

describe('one root per device turn', () => {
  it('nests every span of a paired turn under a single device-turn root, all correlated', async () => {
    const s = session(true);
    const spans = await runTurn(s, 'ok');
    const roots = spans.filter((span) => span.parentSpanContext === undefined);
    expect(roots.map((span) => span.name)).toEqual(['device-turn']);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    for (const span of spans) {
      expect(span.attributes).toMatchObject({
        'bob.session.id': s.id, 'gen_ai.conversation.id': CONVERSATION, 'user.id': userId, 'bob.turn.id': 'turn_ok01',
      });
      // AI spans carry the session only as bob.session.id (OpenObserve would overwrite gen_ai.conversation.id with it).
      expect(span.attributes['session.id']).toBe(span.attributes['gen_ai.operation.name'] === undefined ? s.id : undefined);
    }
    expect(roots[0]!.attributes['bob.trace.name']).toBe('device-turn');
    expect(roots[0]!.status.code).not.toBe(2);
    expect(spans.filter((span) => span.name === 'device-turn')).toHaveLength(1);
    expect(parentOf(spans, spans.find((span) => span.name === 'turn-pipeline')!)).toBe('device-turn');
    expect(parentOf(spans, spans.find((span) => span.name === 'ws.uplink')!)).toBe('device-turn');
    expect(names(spans)).toEqual(expect.arrayContaining([
      'ai.transcribe', 'device-log', 'device-turn', 'device-turn-ended', 'device-turn-started', 'turn-pipeline',
      'ws.control.device_log', 'ws.control.turn_end', 'ws.control.turn_start', 'ws.uplink',
    ]));
    expect(turnRootOf(s)).toBeUndefined();
  });

  it('ends the ws.uplink receive window at the accepted turn_end, not after the pipeline (#999)', async () => {
    const s = session(true);
    const ws = fake();
    await handleControl(appDeps, ws, s, control('turn_start', { turn_ref: 'turn_rx01' }), vi.fn());
    s.nextUplinkSeq = 1; countUplink(s, 320);
    await handleControl(appDeps, ws, s, control('turn_end', { turn_ref: 'turn_rx01', seq: 0 }), async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await traceSpan('ai.transcribe', {}, async () => undefined);
      resetSession(appDeps, s);
    });
    await s.turnDone;
    await settled();
    const spans = otlpSpans.getFinishedSpans();
    const uplinks = spans.filter((span) => span.name === 'ws.uplink');
    expect(uplinks).toHaveLength(1);
    const ms = (time: [number, number]): number => time[0] * 1000 + time[1] / 1e6;
    const pipeline = spans.find((span) => span.name === 'turn-pipeline')!;
    expect(ms(uplinks[0]!.endTime)).toBeLessThanOrEqual(ms(pipeline.startTime) + 1);
    expect(parentOf(spans, uplinks[0]!)).toBe('device-turn');
    expect(uplinks[0]!.attributes).toMatchObject({ 'bob.turn.id': 'turn_rx01' });
  });

  it('tags non-turn device messages with session, user and conversation, and follows a conversation switch', async () => {
    const s = session(true);
    const state = { volume: 5, muted: false, mode: 'normal', dnd: false };
    await handleControl(appDeps, fake(), s, control('device_state', { payload: state }), vi.fn());
    s.activeConversationId = 'thr_conv0002';
    await handleControl(appDeps, fake(), s, control('device_state', { payload: state }), vi.fn());
    await settled();
    const controls = otlpSpans.getFinishedSpans().filter((span) => span.name === 'ws.control.device_state');
    expect(controls.map((span) => span.attributes['gen_ai.conversation.id'])).toEqual([CONVERSATION, canonicalId('conversation', 'thr_conv0002')]);
    for (const span of controls) expect(span.attributes).toMatchObject({ 'session.id': s.id, 'user.id': userId });
  });

  it('gives two sessions on one conversation the same conversation id and different session ids', async () => {
    const a = session(true); const b = session(true);
    const first = await runTurn(a, 'ok');
    otlpSpans.reset();
    const second = await runTurn(b, 'ok');
    const rootOf = (spans: ReadableSpan[]): ReadableSpan => spans.find((span) => span.name === 'device-turn')!;
    expect(rootOf(first).attributes['gen_ai.conversation.id']).toBe(rootOf(second).attributes['gen_ai.conversation.id']);
    expect(rootOf(first).attributes['session.id']).not.toBe(rootOf(second).attributes['session.id']);
  });

  it('keeps an unpaired turn to one root with no user.id', async () => {
    const unpaired = session(false);
    Object.assign(unpaired, { auth: undefined });
    const spans = await runTurn(unpaired, 'ok');
    expect(spans.filter((span) => span.parentSpanContext === undefined).map((span) => span.name)).toEqual(['device-turn']);
    for (const span of spans) expect(span.attributes['user.id']).toBeUndefined();
    expect(spans.every((span) => span.attributes['bob.session.id'] === unpaired.id)).toBe(true);
  });

  it('ends the root once with ERROR on a failed pipeline', async () => {
    const s = session(true);
    const spans = await runTurn(s, 'fail');
    const root = spans.filter((span) => span.name === 'device-turn');
    expect(root).toHaveLength(1);
    expect(root[0]!.status.code).toBe(2);
    expect(turnRootOf(s)).toBeUndefined();
  });

  it('ends the root on cancel before turn_end', async () => {
    const s = session(true);
    const spans = await runTurn(s, 'cancel');
    expect(spans.filter((span) => span.name === 'device-turn')).toHaveLength(1);
    expect(spans.filter((span) => span.parentSpanContext === undefined)).toHaveLength(1);
    expect(turnRootOf(s)).toBeUndefined();
  });

  it('ends the root when a turn is torn down mid-capture (disconnect and queue-full reset)', async () => {
    const s = session(true);
    await handleControl(appDeps, fake(), s, control('turn_start', { turn_ref: 'turn_drop01' }), vi.fn());
    expect(turnRootOf(s)).toBeDefined();
    resetSession(appDeps, s);
    await settled();
    expect(turnRootOf(s)).toBeUndefined();
    expect(otlpSpans.getFinishedSpans().filter((span) => span.name === 'device-turn')).toHaveLength(1);
  });
});

describe('turn_start conversation_id (#880)', () => {
  const rootOf = (spans: ReadableSpan[]): ReadableSpan => spans.find((span) => span.name === 'device-turn')!;
  async function startAndEnd(s: DeviceSession, payload: Record<string, unknown>): Promise<ReadableSpan[]> {
    const ws = fake();
    await handleControl(appDeps, ws, s, control('turn_start', { turn_ref: 'turn_conv01', payload }), vi.fn());
    await handleControl(appDeps, ws, s, control('turn_end', { turn_ref: 'turn_conv01', seq: 0 }), async () => { resetSession(appDeps, s); });
    await s.turnDone;
    await settled();
    return otlpSpans.getFinishedSpans();
  }
  const ignored = (): unknown[] => vi.mocked(journal).mock.calls.filter(([event]) => event === 'v2.turn_conversation_ignored');

  it("correlates the turn to the device's conversation when the account can open it", async () => {
    const own = await createConversation(asDb(pg), userId, 'Kitchen');
    const spans = await startAndEnd(session(true), { conversation_id: own.id });
    const expected = canonicalId('conversation', own.id);
    expect(rootOf(spans).attributes).toMatchObject({ 'gen_ai.conversation.id': expected, 'bob.conversation.source': 'device' });
    expect(spans.find((span) => span.name === 'turn-pipeline')!.attributes['gen_ai.conversation.id']).toBe(expected);
    expect(ignored()).toEqual([]);
    // Correlation only: the account's active pointer is not moved by a turn_start.
    expect((await getActive(asDb(pg), userId))?.conversationId ?? null).toBeNull();
  });

  it("ignores another account's conversation and falls back to the server's resolution", async () => {
    const other = await addAccount(pg);
    const foreign = await createConversation(asDb(pg), other.userId, 'Not yours');
    const s = session(true);
    const spans = await startAndEnd(s, { conversation_id: foreign.id });
    const ids = spans.map((span) => span.attributes['gen_ai.conversation.id']);
    expect(ids).not.toContain(canonicalId('conversation', foreign.id));
    expect(rootOf(spans).attributes['gen_ai.conversation.id']).toBe(CONVERSATION);
    expect(ignored()).toEqual([['v2.turn_conversation_ignored', { session: s.id, reason: 'not_found' }]]);
  });

  it('welcome says turn_conversation only to a hello that lists the cap (released firmware never sends the id)', async () => {
    const welcome = async (caps?: string[]): Promise<Record<string, unknown>> => {
      const ws = fake();
      const fresh = createSession({ kind: 'device', userId, deviceId: crypto.randomUUID(), name: 'Card' });
      await handleControl(appDeps, ws, fresh, control('hello', { payload: { format_id: 2, ...(caps ? { caps } : {}) } }), vi.fn());
      const sent = vi.mocked(ws.send).mock.calls.map(([raw]) => JSON.parse(raw as string) as { type: string; payload: Record<string, unknown> });
      return sent.find((message) => message.type === 'welcome')!.payload;
    };
    expect(await welcome(['turn_conversation'])).toHaveProperty('turn_conversation', true);
    expect(await welcome(['device_log'])).not.toHaveProperty('turn_conversation');
    expect(await welcome()).not.toHaveProperty('turn_conversation');
  });

  it('leaves a turn_start without conversation_id exactly as before (no lookup, no event)', async () => {
    const spans = await startAndEnd(session(true), {});
    expect(rootOf(spans).attributes['gen_ai.conversation.id']).toBe(CONVERSATION);
    expect(ignored()).toEqual([]);
  });
});
