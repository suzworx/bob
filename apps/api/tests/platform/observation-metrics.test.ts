import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { trace, type Span } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const entry = pathToFileURL(createRequire(import.meta.url).resolve('@bob/ai'));
const moduleUrl = new URL('./observation-metrics.ts', entry).href;
const TRACE_ID = 'a'.repeat(32);

let exporter: InMemoryMetricExporter;
let spans: InMemorySpanExporter;

interface PushStub {
  export: (metrics: unknown, done: (result: unknown) => void) => void;
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
  selectAggregationTemporality: () => AggregationTemporality;
}

function reader(push: InMemoryMetricExporter | PushStub) {
  return new PeriodicExportingMetricReader({ exporter: push as unknown as InMemoryMetricExporter, exportIntervalMillis: 3_600_000 });
}

/** One point per metric name: { count, sum } for a histogram; a counter (0/1 flags) reports its total as both.
 *  Counters still at 0 are left out: every flag counter exists at 0 from init, so only incremented ones were recorded. */
function recorded(): Record<string, { count: number; sum: number }> {
  const out: Record<string, { count: number; sum: number }> = {};
  for (const batch of exporter.getMetrics()) {
    for (const scope of batch.scopeMetrics) {
      for (const metric of scope.metrics) {
        const point = metric.dataPoints.at(-1)?.value as { count: number; sum: number } | number | undefined;
        if (typeof point === 'number') { if (point > 0) out[metric.descriptor.name] = { count: point, sum: point }; }
        else if (point !== undefined) out[metric.descriptor.name] = { count: point.count, sum: point.sum };
      }
    }
  }
  return out;
}

async function load() {
  const metrics = await import(moduleUrl);
  const report = vi.fn();
  metrics.initObservationMetrics({ reader: reader(exporter) }, report);
  return { metrics, report };
}

beforeEach(() => {
  vi.resetModules();
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  spans = new InMemorySpanExporter();
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }));
});
afterEach(() => { vi.restoreAllMocks(); trace.disable(); });

describe('observation metrics', () => {
  it('records an instrument per name and sets bob.metric.* on the active span, without content', async () => {
    const { metrics } = await load();
    const attributes: Record<string, unknown> = {};
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ setAttribute: (key: string, value: unknown) => { attributes[key] = value; } } as unknown as Span);
    metrics.recordObservationMetrics([{ name: 'ui.request.duration_ms', value: 125 }]);
    metrics.recordObservationMetrics([{ name: 'ui.request.duration_ms', value: 130 }, { name: 'user.feedback', value: 1 }]);
    await metrics.flushObservationMetrics();
    expect(recorded()).toEqual({ 'bob.ui.request.duration_ms': { count: 2, sum: 255 }, 'bob.user.feedback': { count: 1, sum: 1 } });
    expect(attributes).toEqual({ 'bob.metric.ui.request.duration_ms': 130, 'bob.metric.user.feedback': 1 });
  });

  it('is silent without initialization or an active span', async () => {
    const metrics = await import(moduleUrl);
    expect(() => metrics.recordObservationMetrics([{ name: 'turn.failed', value: 1 }])).not.toThrow();
    await expect(metrics.flushObservationMetrics()).resolves.toBeUndefined();
    const { metrics: ready } = await load();
    ready.recordObservationMetrics([{ name: 'turn.failed', value: 1 }]);
    await ready.flushObservationMetrics();
    expect(recorded()).toEqual({ 'bob.turn.failed': { count: 1, sum: 1 } });
  });

  it('rejects unknown names, non-finite numbers and values outside each unit range', async () => {
    const { metrics } = await load();
    metrics.recordObservationMetrics([
      { name: 'secret private url', value: 1 }, { name: 'ui.request.failed', value: 2 },
      { name: 'ui.request.duration_ms', value: 120001 }, { name: 'ui.render.duration_ms', value: -1 },
      { name: 'turn.total_ms', value: 600001 }, { name: 'turn.failed', value: 0.5 },
      { name: 'ui.window.requests_ok', value: 1000001 }, { name: 'device.heap_free_bytes', value: 4294967296 },
      { name: 'turn.model_ms', value: NaN }, { name: 'turn.tts_ms', value: Infinity },
      { name: 'user.feedback', value: 2 }, { name: 'voice.eos_to_first_audio_ms', value: 600001 },
    ]);
    await metrics.flushObservationMetrics();
    expect(recorded()).toEqual({});
    metrics.recordObservationMetrics([
      { name: 'turn.failed', value: 0 }, { name: 'turn.total_ms', value: 600000 }, { name: 'device.uptime_ms', value: 4294967295 },
      { name: 'voice.eos_to_first_audio_ms', value: 600000 },
    ]);
    await metrics.flushObservationMetrics();
    expect(Object.keys(recorded()).sort()).toEqual(['bob.device.uptime_ms', 'bob.turn.total_ms', 'bob.voice.eos_to_first_audio_ms']);
  });

  it('bounds each call and never copies arbitrary fields into a metric', async () => {
    const { metrics } = await load();
    metrics.recordObservationMetrics(Array.from({ length: 40 }, () => ({ name: 'ui.request.failed', value: 1, metadata: { token: 'private' }, comment: 'private' })));
    await metrics.flushObservationMetrics();
    expect(recorded()['bob.ui.request.failed']!.count).toBe(32);
    expect(JSON.stringify(exporter.getMetrics())).not.toContain('private');
  });

  it('keeps export failures out of the product and reports only a fixed error kind', async () => {
    const metrics = await import(moduleUrl);
    const report = vi.fn();
    const failing = { export: (_metrics: unknown, done: (result: unknown) => void) => done({ code: 1, error: new Error('private') }),
      forceFlush: async () => { throw new Error('private'); }, shutdown: async () => {}, selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE };
    metrics.initObservationMetrics({ reader: reader(failing) }, report);
    expect(() => metrics.recordObservationMetrics([{ name: 'turn.failed', value: 1 }])).not.toThrow();
    await expect(metrics.flushObservationMetrics()).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith('metrics_flush_failed');
    expect(JSON.stringify(report.mock.calls)).not.toContain('private');
  });
});

describe('recordTraceSignal', () => {
  it('records the metric and emits a trace-signal span inside the given trace', async () => {
    const { metrics } = await load();
    metrics.recordTraceSignal(TRACE_ID, 'user.feedback', 1);
    await metrics.flushObservationMetrics();
    const [signal, ...rest] = spans.getFinishedSpans();
    expect(rest).toEqual([]);
    expect(signal!.name).toBe('trace-signal');
    expect(signal!.spanContext().traceId).toBe(TRACE_ID);
    expect(signal!.spanContext().spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(signal!.spanContext().traceFlags).toBe(1);
    expect(signal!.attributes).toEqual({ 'bob.metric.user.feedback': 1 });
    expect(recorded()).toEqual({ 'bob.user.feedback': { count: 1, sum: 1 } });
  });

  it.each(['', 'nope', '0'.repeat(32), 'A'.repeat(32)])('records the metric only for the invalid trace id %j', async (traceId) => {
    const { metrics } = await load();
    expect(() => metrics.recordTraceSignal(traceId, 'voice.eos_to_first_audio_ms', 900)).not.toThrow();
    await metrics.flushObservationMetrics();
    expect(spans.getFinishedSpans()).toEqual([]);
    expect(recorded()).toEqual({ 'bob.voice.eos_to_first_audio_ms': { count: 1, sum: 900 } });
  });

  it('ignores out-of-range values and never throws without initialization', async () => {
    const metrics = await import(moduleUrl);
    expect(() => metrics.recordTraceSignal(TRACE_ID, 'user.feedback', 5)).not.toThrow();
    expect(() => metrics.recordTraceSignal(TRACE_ID, 'user.feedback', 1)).not.toThrow();
    expect(spans.getFinishedSpans().length).toBe(1);
  });
});
