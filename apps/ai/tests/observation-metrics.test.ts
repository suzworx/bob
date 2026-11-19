import { DataPointType, InMemoryMetricExporter, AggregationTemporality, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import { bucketsFor, checkedMetricAttributes, flushObservationMetrics, initObservationMetrics, metricCaps, metricKinds, recordObservationMetrics, registerObservableGauge } from '../src/observation-metrics.ts';

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
initObservationMetrics({ reader }, () => {});
const COUNTERS = Object.entries(metricKinds()).filter(([, kind]) => kind === 'counter').map(([name]) => name);

async function collected() {
  exporter.reset();
  await flushObservationMetrics();
  const metrics = exporter.getMetrics().flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  return new Map(metrics.map((metric) => [metric.descriptor.name, metric]));
}

describe('counters exist at 0 before their first event', () => {
  // A series born at 1 hides its first increment from increase()/rate(); a flag that never fires never appears at all.
  it('exports every 0/1 flag counter at 0 straight after init, and no histogram until it is recorded', async () => {
    const metrics = await collected();
    expect(COUNTERS).toHaveLength(33);
    for (const name of COUNTERS) {
      const metric = metrics.get(`bob.${name}`);
      expect(metric?.dataPointType, name).toBe(DataPointType.SUM);
      expect(metric?.dataPoints[0]?.value, name).toBe(0);
    }
    expect(metrics.has('bob.turn.total_ms')).toBe(false);
  });
});

describe('observation metric instruments', () => {
  it('records 0/1 flags as counters: adds 1 for a 1, nothing for a 0', async () => {
    recordObservationMetrics([{ name: 'turn.failed', value: 1 }, { name: 'turn.failed', value: 1 }, { name: 'turn.cancelled', value: 0 }]);
    const metrics = await collected();
    const failed = metrics.get('bob.turn.failed');
    expect(failed?.dataPointType).toBe(DataPointType.SUM);
    expect(failed?.dataPoints[0]?.value).toBe(2);
    expect(metrics.get('bob.turn.cancelled')?.dataPoints[0]?.value).toBe(0);
  });

  it.each(['http.request.server_error', 'speech.cache_hit', 'rag.timeout', 'tool.handled_failure', 'workflow.rejected', 'turn.completed'] as const)(
    '%s is a counter',
    async (name) => {
      recordObservationMetrics([{ name, value: 1 }]);
      expect((await collected()).get(`bob.${name}`)?.dataPointType).toBe(DataPointType.SUM);
    },
  );

  it('keeps every other metric, and user.feedback, a histogram', async () => {
    recordObservationMetrics([
      { name: 'turn.total_ms', value: 120 }, { name: 'rag.result_count', value: 3 },
      { name: 'user.feedback', value: 1 }, { name: 'ui.error', value: 1 }, { name: 'ui.window.requests_ok', value: 4 },
    ]);
    const metrics = await collected();
    for (const name of ['turn.total_ms', 'rag.result_count', 'user.feedback', 'ui.error', 'ui.window.requests_ok']) {
      expect(metrics.get(`bob.${name}`)?.dataPointType, name).toBe(DataPointType.HISTOGRAM);
    }
  });

  it('leaves the span attributes alone: invalid samples still record nothing', async () => {
    recordObservationMetrics([{ name: 'turn.empty', value: 2 }]);
    expect((await collected()).get('bob.turn.empty')?.dataPoints[0]?.value).toBe(0);
  });
});

describe('registerObservableGauge', () => {
  it('reports every series the callback returns', async () => {
    registerObservableGauge('device.connected', () => [
      { value: 3, attributes: { paired: 'true' } }, { value: 1, attributes: { paired: 'false' } },
    ]);
    const gauge = (await collected()).get('bob.device.connected');
    expect(gauge?.dataPointType).toBe(DataPointType.GAUGE);
    const byPaired = Object.fromEntries((gauge?.dataPoints ?? []).map((point) => [String(point.attributes.paired), point.value]));
    expect(byPaired).toEqual({ true: 3, false: 1 });
  });

  it('survives a throwing callback', async () => {
    registerObservableGauge('device.broken', () => { throw new Error('boom'); });
    await expect(collected()).resolves.toBeDefined();
  });
});

describe('metric kinds are a reviewed contract', () => {
  // A kind change breaks the watch2 metric type: OpenObserve keeps the first type it saw. Update this snapshot only
  // together with re-registering the stream (MCP StreamDelete, see docs/observability.md "Changing a metric's kind").
  it('classifies every metric exactly once, as recorded here', () => {
    expect(metricKinds()).toMatchSnapshot();
  });
});

describe('histogram buckets fit each unit', () => {
  // The SDK default (0..10 000) put bytes, uptime, frame counts and minute-scale durations in +Inf.
  const HISTOGRAMS = Object.entries(metricKinds()).filter(([, kind]) => kind === 'histogram').map(([name]) => name as keyof ReturnType<typeof metricCaps>);
  // Beyond these, a value is off the scale on purpose: a device up more than 7 days, a layout shift above 1.0 (already "poor").
  const OPEN_ENDED = new Set(['device.uptime_ms', 'ui.web_vital.cls']);

  it.each(HISTOGRAMS)('%s has ascending boundaries that reach its cap', (name) => {
    const bounds = bucketsFor(name);
    expect(bounds.length).toBeGreaterThan(3);
    expect([...bounds].sort((a, b) => a - b)).toEqual(bounds);
    if (!OPEN_ENDED.has(name)) expect(bounds.at(-1)).toBeGreaterThanOrEqual(metricCaps()[name]);
  });

  it('records 3 MB of uplink into the 4 MB bucket and a 4-minute turn into the 5-minute bucket', async () => {
    recordObservationMetrics([{ name: 'ws.uplink.bytes', value: 3 * 1024 * 1024 }, { name: 'turn.tts_ms', value: 240_000 }]);
    const metrics = await collected();
    const bucketOf = (metric: string): number | undefined => {
      const point = metrics.get(metric)?.dataPoints.at(-1)?.value as { buckets: { boundaries: number[]; counts: number[] } } | undefined;
      const i = point?.buckets.counts.findIndex((count) => count > 0);
      return i === undefined || i < 0 ? undefined : point!.buckets.boundaries[i] ?? Infinity;
    };
    expect(bucketOf('bob.ws.uplink.bytes')).toBe(4 * 1024 * 1024);
    expect(bucketOf('bob.turn.tts_ms')).toBe(300_000);
  });
});

describe('bounded metric labels', () => {
  it('keeps allow-listed keys and values only', () => {
    expect(checkedMetricAttributes({ route: '/api/tasks/:id', status_class: '4xx', outcome: 'error' })).toEqual({ route: '/api/tasks/:id', status_class: '4xx', outcome: 'error' });
    expect(checkedMetricAttributes({ surface: 'web_voice', stage: 'tts' })).toEqual({ surface: 'web_voice', stage: 'tts' });
    expect(checkedMetricAttributes({ user_id: 'u1', route: '/api/x' } as never)).toEqual({ route: '/api/x' });
  });

  it.each([
    ['a raw id segment', '/api/tasks/123'],
    ['a uuid segment', '/api/tasks/0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['a query string', '/api/search?q=me'],
    ['an email', '/api/users/me@x.com'],
    ['a too-long route', `/api/${'a'.repeat(80)}`],
  ])('drops a route with %s', (_label, route) => {
    expect(checkedMetricAttributes({ route })).toBeUndefined();
  });

  it.each(['unmatched', 'static_asset', 'static_ui'])('keeps the route inventory sentinel %s', (route) => {
    // The server's route inventory names unregistered paths and the web app's files with these fixed words.
    expect(checkedMetricAttributes({ route })).toEqual({ route });
  });

  it('drops values outside each enum', () => {
    expect(checkedMetricAttributes({ status_class: '600' as never, outcome: 'weird' as never, surface: 'phone' as never })).toBeUndefined();
  });

  it('records a labelled histogram series per label set', async () => {
    recordObservationMetrics([
      { name: 'speech.audio_ms', value: 100, attributes: { stage: 'stt' } },
      { name: 'speech.audio_ms', value: 200, attributes: { stage: 'tts' } },
      { name: 'speech.audio_ms', value: 300, attributes: { stage: 'tts' } },
    ]);
    const points = (await collected()).get('bob.speech.audio_ms')?.dataPoints ?? [];
    const count = Object.fromEntries(points.map((p) => [String(p.attributes.stage), (p.value as { count: number }).count]));
    expect(count).toEqual({ stt: 1, tts: 2 });
  });
});
