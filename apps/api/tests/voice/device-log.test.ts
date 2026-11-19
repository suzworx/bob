import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

const spans = vi.hoisted(() => {
  // Real tracing for the trace-join test only; the exporter below never touches the network.
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otlp.example.test';
  process.env.OTEL_METRICS_EXPORTER = 'none';
  return { calls: [] as Array<{ name: string; attrs: unknown }>, metrics: vi.fn(), real: false };
});
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: class {
    export(_spans: unknown, done: (result: { code: number }) => void): void { done({ code: 0 }); }
    async forceFlush(): Promise<void> {}
    async shutdown(): Promise<void> {}
  },
}));
vi.mock('@bob/ai', async (original) => {
  const actual = await original<typeof import('@bob/ai')>();
  return {
    ...actual,
    recordObservationMetrics: spans.metrics,
    traceSpan: (name: string, attrs: Parameters<typeof actual.traceSpan>[1], action: () => unknown): unknown => {
      spans.calls.push({ name, attrs });
      return spans.real ? actual.traceSpan(name, attrs, action) : action();
    },
  };
});
import { createAppDeps } from '../../src/app-deps.ts';
import { ClientControlDtoSchema } from '../../src/voice/protocol.ts';
import { handleControl } from '../../src/voice/session.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import { setJournalSink } from '../../src/platform/logger.ts';

const diagnostic = {
  v: 1, type: 'device_log', id: 'log_123456_v2', turn_ref: 'turn_123456_v2',
  payload: { event: 'playback_started', uptime_ms: 123456, heap_free: 100000, heap_largest: 80000 },
};

afterEach(() => { vi.useRealTimers(); setJournalSink(null); spans.real = false; spans.calls.length = 0; spans.metrics.mockClear(); });

describe('metadata-only device diagnostics', () => {
  it('accepts bounded diagnostics and rejects arbitrary text, unknown fields and non-finite counters', () => {
    expect(ClientControlDtoSchema.safeParse(diagnostic).success).toBe(true);
    for (const payload of [
      { ...diagnostic.payload, event: 'https://private.example' },
      { ...diagnostic.payload, transcript: 'private' },
      { ...diagnostic.payload, heap_free: -1 },
      { ...diagnostic.payload, heap_largest: 4294967296 },
      { ...diagnostic.payload, uptime_ms: 1.5 },
      { ...diagnostic.payload, uptime_ms: Infinity },
    ]) expect(ClientControlDtoSchema.safeParse({ ...diagnostic, payload }).success).toBe(false);
  });

  it('correlates authenticated device events and bounds export to one per second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const session = createSession({ kind: 'device', userId: crypto.randomUUID(), deviceId: crypto.randomUUID(), name: 'Card' });
    session.stage = 'ready';
    const socket = { readyState: 1, send: vi.fn() };
    const journal: string[] = [];
    setJournalSink((line) => journal.push(line));
    const dto = ClientControlDtoSchema.parse(diagnostic);
    const send = (): Promise<void> => handleControl(createAppDeps(), socket as unknown as WebSocket, session, dto, vi.fn());
    await send();
    await send();
    expect(spans.calls.filter((call) => call.name === 'device-log')).toHaveLength(1);
    expect(spans.calls.filter((call) => call.name === 'ws.control.device_log')).toHaveLength(2);
    const deviceMetrics = (): unknown[] => spans.metrics.mock.calls
      .filter(([samples]) => (samples as Array<{ name: string }>).some((sample) => sample.name.startsWith('device.')))
      .map(([samples]) => samples);
    expect(deviceMetrics()).toEqual([[
      { name: 'device.heap_free_bytes', value: 100000 },
      { name: 'device.heap_largest_bytes', value: 80000 },
      { name: 'device.uptime_ms', value: 123456 },
    ]]);
    expect(spans.calls.find((call) => call.name === 'device-log')).toMatchObject({ name: 'device-log', attrs: {
      workflowNamespace: session.id, turnId: diagnostic.turn_ref, tags: ['device'],
      metadata: { device_event: 'playback_started', uptime_ms: '123456', heap_free: '100000' },
    } });
    expect(JSON.parse(journal.find((line) => line.includes('"event":"v2.device_log"')) ?? '{}')).toMatchObject({
      source: 'device', module: 'devices', turn_id: diagnostic.turn_ref,
    });
    vi.advanceTimersByTime(1000);
    await send();
    expect(spans.calls.filter((call) => call.name === 'device-log')).toHaveLength(2);
    expect(deviceMetrics()).toHaveLength(2);
    expect(journal.filter((line) => line.includes('"event":"v2.device_log"'))).toHaveLength(2);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('journals a turn-referenced device event inside the turn\'s workflow trace', async () => {
    const ai = await vi.importActual<typeof import('@bob/ai')>('@bob/ai');
    ai.initTelemetry();
    spans.real = true;
    const session = createSession({ kind: 'device', userId: crypto.randomUUID(), deviceId: crypto.randomUUID(), name: 'Card' });
    session.stage = 'ready';
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    const socket = { readyState: 1, send: vi.fn() };
    await handleControl(createAppDeps(), socket as unknown as WebSocket, session, ClientControlDtoSchema.parse(diagnostic), vi.fn());
    const entry = JSON.parse(lines.find((line) => line.includes('"event":"v2.device_log"')) ?? '{}') as Record<string, unknown>;
    // Every span of a device turn is seeded by (session, turn_ref); the device event shares that trace.
    const turnTrace = await ai.workflowTraceId({ workflowNamespace: session.id, turnId: diagnostic.turn_ref });
    expect(turnTrace).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.trace_id).toBe(turnTrace);
    expect(entry).toMatchObject({ source: 'device', module: 'devices', turn_id: diagnostic.turn_ref });
  });

  it('refuses unpaired and pre-hello diagnostics without exporting them', async () => {
    const dto = ClientControlDtoSchema.parse(diagnostic);
    const socket = { readyState: 1, send: vi.fn(), once: vi.fn(), close: vi.fn() };
    for (const session of [createSession({ kind: 'unpaired', reason: 'none' }), createSession()]) {
      await handleControl(createAppDeps(), socket as unknown as WebSocket, session, dto, vi.fn());
    }
    expect(spans.calls.filter((call) => call.name === 'device-log')).toHaveLength(0);
    expect(spans.calls.map((call) => call.name)).toEqual(['ws.control.device_log', 'ws.control.device_log']);
    const recorded = spans.metrics.mock.calls.flatMap(([samples]) => samples as Array<{ name: string; value: number }>);
    expect(recorded.filter((sample) => sample.name.startsWith('device.'))).toHaveLength(0);
    expect(recorded.filter((sample) => sample.name === 'ws.control.rejected')).toEqual([
      { name: 'ws.control.rejected', value: 1 }, { name: 'ws.control.rejected', value: 1 },
    ]);
    expect(JSON.stringify(spans.calls)).not.toMatch(/playback_started|uptime_ms|heap_free|heap_largest/);
    expect(socket.send).toHaveBeenCalledTimes(2);
  });
});
