import { describe, expect, it, vi } from 'vitest';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import {
  CorrelationSpanProcessor, ExportFailure, ScrubbingSpanProcessor, createMetricReader, createSpanScrubber,
  extraOtlpLogsConfig, extraOtlpMetricsConfig, extraOtlpTracesConfig, observabilityEnvironment, otlpMetricsConfigured, otlpTracesConfigured, parseCostRates, tagFailures, traceResource,
  type CostRates,
} from '../src/telemetry-export.ts';
import { TRACE_ATTRS_KEY } from '../src/telemetry-metadata.ts';

type Env = NodeJS.ProcessEnv;

function delegate(overrides: Partial<SpanProcessor> = {}): SpanProcessor & { ended: ReadableSpan[]; started: number } {
  const self = {
    ended: [] as ReadableSpan[],
    started: 0,
    onStart() { self.started += 1; },
    onEnd(span: ReadableSpan) { self.ended.push(span); },
    forceFlush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  };
  return self as never;
}

const span = (): ReadableSpan => ({ attributes: { secret: 'x', keep: 'y' } }) as unknown as ReadableSpan;

/** What every span carries when no conversation resolved: the literal `none`, under both names. */
const NO_CONVERSATION = { 'bob.conversation.id': 'none', 'gen_ai.conversation.id': 'none', 'bob.conversation.source': 'none' };

describe('otlpTracesConfigured', () => {
  it.each<[string, Env, boolean]>([
    ['nothing set', {}, false],
    ['empty endpoint', { OTEL_EXPORTER_OTLP_ENDPOINT: '' }, false],
    ['whitespace endpoint', { OTEL_EXPORTER_OTLP_ENDPOINT: '  ' }, false],
    ['general endpoint', { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.test' }, true],
    ['traces endpoint', { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otlp.example.test/v1/traces' }, true],
    ['empty traces endpoint falls back to nothing', { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '' }, false],
    ['exporter none wins over endpoint', { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.test', OTEL_TRACES_EXPORTER: 'none' }, false],
    ['exporter otlp keeps endpoint', { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.test', OTEL_TRACES_EXPORTER: 'otlp' }, true],
  ])('%s', (_name, env, expected) => {
    expect(otlpTracesConfigured(env)).toBe(expected);
  });

  it('reads process.env by default', () => {
    vi.stubEnv('OTEL_TRACES_EXPORTER', '');
    vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', '');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://otlp.example.test');
    expect(otlpTracesConfigured()).toBe(true);
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    expect(otlpTracesConfigured()).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe('extraOtlpTracesConfig', () => {
  const ENDPOINT = 'BOB_OTLP_EXTRA_TRACES_ENDPOINT';
  const HEADERS = 'BOB_OTLP_EXTRA_TRACES_HEADERS';

  it.each<[string, Env]>([
    ['nothing set', {}],
    ['empty endpoint', { [ENDPOINT]: '' }],
    ['blank endpoint', { [ENDPOINT]: '   ' }],
    ['headers without an endpoint', { [HEADERS]: 'a=b' }],
    ['ftp scheme', { [ENDPOINT]: 'ftp://extra.example.test/v1/traces' }],
    ['no scheme', { [ENDPOINT]: 'extra.example.test/v1/traces' }],
    ['scheme only', { [ENDPOINT]: 'https://' }],
    ['embedded whitespace', { [ENDPOINT]: 'https://extra.example.test/ v1' }],
  ])('is undefined for %s', (_name, env) => {
    expect(extraOtlpTracesConfig(env)).toBeUndefined();
  });

  it('reads a full http(s) traces url, trimmed, with no headers by default', () => {
    expect(extraOtlpTracesConfig({ [ENDPOINT]: ' https://extra.example.test/api/otel/v1/traces ' })).toEqual({
      url: 'https://extra.example.test/api/otel/v1/traces', headers: {},
    });
    expect(extraOtlpTracesConfig({ [ENDPOINT]: 'http://127.0.0.1:4318/v1/traces' })?.url).toBe('http://127.0.0.1:4318/v1/traces');
  });

  it.each<[string, string, Record<string, string>]>([
    ['one pair', 'x-key=abc', { 'x-key': 'abc' }],
    ['several pairs with spaces', ' a=1 , b=2 ', { a: '1', b: '2' }],
    ['a base64 value keeps its = padding', 'Authorization=Basic dXNlcjpwYXNz==', { Authorization: 'Basic dXNlcjpwYXNz==' }],
    ['url-encoded values are decoded', 'Authorization=Basic%20dXNlcjpwYXNz%3D%3D,x-tag=a%2Cb', { Authorization: 'Basic dXNlcjpwYXNz==', 'x-tag': 'a,b' }],
    ['a malformed escape is kept verbatim', 'x=100%', { x: '100%' }],
    ['pairs without a name or an = are skipped', '=orphan,novalue,,ok=1', { ok: '1' }],
    ['empty', '', {}],
  ])('parses headers: %s', (_name, raw, expected) => {
    expect(extraOtlpTracesConfig({ [ENDPOINT]: 'https://extra.example.test/v1/traces', [HEADERS]: raw })?.headers).toEqual(expected);
  });
});

describe('extraOtlpLogsConfig', () => {
  const ENDPOINT = 'BOB_OTLP_EXTRA_LOGS_ENDPOINT';
  const HEADERS = 'BOB_OTLP_EXTRA_LOGS_HEADERS';

  it.each<[string, Env]>([
    ['nothing set', {}],
    ['empty endpoint', { [ENDPOINT]: '' }],
    ['blank endpoint', { [ENDPOINT]: '   ' }],
    ['headers without an endpoint', { [HEADERS]: 'a=b' }],
    ['the traces endpoint alone', { BOB_OTLP_EXTRA_TRACES_ENDPOINT: 'https://extra.example.test/v1/traces' }],
    ['ftp scheme', { [ENDPOINT]: 'ftp://extra.example.test/v1/logs' }],
    ['no scheme', { [ENDPOINT]: 'extra.example.test/v1/logs' }],
    ['scheme only', { [ENDPOINT]: 'https://' }],
    ['embedded whitespace', { [ENDPOINT]: 'https://extra.example.test/ v1' }],
  ])('is undefined for %s', (_name, env) => {
    expect(extraOtlpLogsConfig(env)).toBeUndefined();
  });

  it('reads a full http(s) logs url, trimmed, with no headers by default', () => {
    expect(extraOtlpLogsConfig({ [ENDPOINT]: ' https://extra.example.test/api/otel/v1/logs ' })).toEqual({
      url: 'https://extra.example.test/api/otel/v1/logs', headers: {},
    });
    expect(extraOtlpLogsConfig({ [ENDPOINT]: 'http://127.0.0.1:4318/v1/logs' })?.url).toBe('http://127.0.0.1:4318/v1/logs');
  });

  it.each<[string, string, Record<string, string>]>([
    ['one pair', 'x-key=abc', { 'x-key': 'abc' }],
    ['a base64 value keeps its = padding', 'Authorization=Basic dXNlcjpwYXNz==', { Authorization: 'Basic dXNlcjpwYXNz==' }],
    ['url-encoded values are decoded', 'Authorization=Basic%20dXNlcjpwYXNz%3D%3D,x-tag=a%2Cb', { Authorization: 'Basic dXNlcjpwYXNz==', 'x-tag': 'a,b' }],
    ['pairs without a name or an = are skipped', '=orphan,novalue,,ok=1', { ok: '1' }],
    ['empty', '', {}],
  ])('parses headers: %s', (_name, raw, expected) => {
    expect(extraOtlpLogsConfig({ [ENDPOINT]: 'https://extra.example.test/v1/logs', [HEADERS]: raw })?.headers).toEqual(expected);
  });

  it('does not read the traces variables', () => {
    expect(extraOtlpLogsConfig({
      [ENDPOINT]: 'https://extra.example.test/v1/logs',
      BOB_OTLP_EXTRA_TRACES_HEADERS: 'x-traces=1',
    })?.headers).toEqual({});
  });
});

describe('ScrubbingSpanProcessor', () => {
  it('scrubs once and every delegate receives the scrubbed span', () => {
    const first = delegate();
    const second = delegate();
    const scrub = vi.fn((s: ReadableSpan) => { delete (s.attributes as Record<string, unknown>).secret; });
    const processor = new ScrubbingSpanProcessor(scrub, [first, second]);
    const ended = span();
    processor.onEnd(ended);
    expect(scrub).toHaveBeenCalledTimes(1);
    expect(first.ended).toEqual([ended]);
    expect(second.ended).toEqual([ended]);
    expect(ended.attributes).toEqual({ keep: 'y' });
  });

  it('forwards onStart to every delegate', () => {
    const first = delegate();
    const second = delegate();
    new ScrubbingSpanProcessor(() => {}, [first, second]).onStart({} as never, {} as never);
    expect([first.started, second.started]).toEqual([1, 1]);
  });

  it('a throwing delegate does not stop the other', () => {
    const second = delegate();
    const processor = new ScrubbingSpanProcessor(() => {}, [delegate({ onEnd() { throw new Error('boom'); } }), second]);
    expect(() => processor.onEnd(span())).not.toThrow();
    expect(second.ended).toHaveLength(1);
  });

  it('forceFlush rejects when one delegate rejects but still flushes the other', async () => {
    const healthy = delegate();
    const processor = new ScrubbingSpanProcessor(() => {}, [delegate({ forceFlush: async () => { throw new Error('flush down'); } }), healthy]);
    await expect(processor.forceFlush()).rejects.toThrow('flush down');
    expect(healthy.forceFlush).toHaveBeenCalledTimes(1);
  });

  it('forceFlush surfaces every failed delegate so each destination can be reported', async () => {
    const processor = new ScrubbingSpanProcessor(() => {}, [
      tagFailures(delegate({ forceFlush: async () => { throw new Error('a'); } }), 'otlp_flush_failed'),
      tagFailures(delegate({ forceFlush: async () => { throw new Error('b'); } }), 'otlp_extra_flush_failed'),
    ]);
    const failure = await processor.forceFlush().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: ExportFailure) => error.kind)).toEqual(['otlp_flush_failed', 'otlp_extra_flush_failed']);
  });

  it('shutdown rejects with the first failure and still shuts the other down', async () => {
    const healthy = delegate();
    const processor = new ScrubbingSpanProcessor(() => {}, [delegate({ shutdown: async () => { throw new Error('stop down'); } }), healthy]);
    await expect(processor.shutdown()).rejects.toThrow('stop down');
    expect(healthy.shutdown).toHaveBeenCalledTimes(1);
  });

  it('resolves when every delegate flushes', async () => {
    await expect(new ScrubbingSpanProcessor(() => {}, [delegate(), delegate()]).forceFlush()).resolves.toBeUndefined();
  });
});

describe('tagFailures', () => {
  it('labels a rejected flush with the backend kind and keeps the cause', async () => {
    const tagged = tagFailures(delegate({ forceFlush: async () => { throw new Error('flush down'); } }), 'otlp_flush_failed');
    const failure = await tagged.forceFlush().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExportFailure);
    expect((failure as ExportFailure).kind).toBe('otlp_flush_failed');
    expect(((failure as ExportFailure).cause as Error).message).toBe('flush down');
  });

  it('passes spans through untouched', () => {
    const inner = delegate();
    const ended = span();
    tagFailures(inner, 'otlp_flush_failed').onEnd(ended);
    expect(inner.ended).toEqual([ended]);
  });
});

describe('traceResource', () => {
  const attrs = (env: Env): Record<string, unknown> => ({ ...traceResource(env).attributes });

  it('defaults the service name and the environment', () => {
    expect(attrs({})).toEqual({ 'service.name': 'bob', 'deployment.environment.name': 'development' });
    expect(attrs({ BOB_PRODUCTION: '1' })['deployment.environment.name']).toBe('production');
  });

  it('maps only the standard OTEL variables and ignores platform-injected ones', () => {
    expect(attrs({
      OTEL_SERVICE_NAME: 'bob-api', OTEL_SERVICE_VERSION: '1.2.3',
      RAILWAY_GIT_COMMIT_SHA: 'abc123', RAILWAY_ENVIRONMENT_NAME: 'staging', NODE_ENV: 'test',
    })).toEqual({ 'service.name': 'bob-api', 'service.version': '1.2.3', 'deployment.environment.name': 'development' });
  });

  it('takes the environment from OTEL_RESOURCE_ATTRIBUTES when it names one', () => {
    expect(attrs({ OTEL_RESOURCE_ATTRIBUTES: 'a=b,deployment.environment.name=staging' })['deployment.environment.name']).toBe('staging');
  });

  it('treats empty values as unset and never adds host, user or argv', () => {
    const resource = attrs({ OTEL_SERVICE_NAME: '', OTEL_SERVICE_VERSION: '' });
    expect(Object.keys(resource).sort()).toEqual(['deployment.environment.name', 'service.name']);
  });
});

describe('observabilityEnvironment', () => {
  it('is production only for BOB_PRODUCTION=1', () => {
    expect(observabilityEnvironment({ BOB_PRODUCTION: '1' })).toBe('production');
    expect(observabilityEnvironment({})).toBe('development');
  });
});

describe('otlpMetricsConfigured / createMetricReader', () => {
  const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.test' };
  it.each<[string, Env, boolean]>([
    ['nothing set', {}, false],
    ['endpoint, exporter unset', endpoint, true],
    ['endpoint, exporter otlp', { ...endpoint, OTEL_METRICS_EXPORTER: 'otlp' }, true],
    ['endpoint, exporter none', { ...endpoint, OTEL_METRICS_EXPORTER: 'none' }, false],
    ['metrics endpoint only', { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://otlp.example.test/v1/metrics' }, true],
    ['exporter otlp without endpoint', { OTEL_METRICS_EXPORTER: 'otlp' }, false],
  ])('%s', (_name, env, expected) => {
    expect(otlpMetricsConfigured(env)).toBe(expected);
    expect(createMetricReader(env) !== undefined).toBe(expected);
  });
});

describe('extraOtlpMetricsConfig', () => {
  it.each<[string, Env, unknown]>([
    ['nothing set', {}, undefined],
    ['blank endpoint', { BOB_OTLP_EXTRA_METRICS_ENDPOINT: '  ' }, undefined],
    ['not a URL', { BOB_OTLP_EXTRA_METRICS_ENDPOINT: 'watch2' }, undefined],
    ['endpoint only', { BOB_OTLP_EXTRA_METRICS_ENDPOINT: 'https://x.test/v1/metrics' }, { url: 'https://x.test/v1/metrics', headers: {} }],
    [
      'endpoint and headers',
      { BOB_OTLP_EXTRA_METRICS_ENDPOINT: 'https://x.test/v1/metrics', BOB_OTLP_EXTRA_METRICS_HEADERS: 'Authorization=Basic%20abc==,X-A=b' },
      { url: 'https://x.test/v1/metrics', headers: { Authorization: 'Basic abc==', 'X-A': 'b' } },
    ],
    ['traces variables do not leak in', { BOB_OTLP_EXTRA_TRACES_ENDPOINT: 'https://x.test/v1/traces' }, undefined],
  ])('%s', (_name, env, expected) => {
    expect(extraOtlpMetricsConfig(env)).toEqual(expected);
  });
});

describe('createMetricReader destinations', () => {
  const primaryEnv = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.test' };
  const extraEnv = { BOB_OTLP_EXTRA_METRICS_ENDPOINT: 'https://extra.example.test/v1/metrics' };
  const memory = () => new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const names = (exporter: InMemoryMetricExporter) =>
    exporter.getMetrics().flatMap((data) => data.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.descriptor.name)));

  async function run(env: Env, exporters: { primary?: PushMetricExporter; extra?: PushMetricExporter }, report = vi.fn()) {
    const reader = createMetricReader(env, { report, exporters });
    if (reader === undefined) return { report, flushed: undefined };
    const provider = new MeterProvider({ readers: [reader] });
    provider.getMeter('test').createHistogram('bob.sample').record(3);
    await provider.forceFlush();
    await provider.shutdown();
    return { report, flushed: true };
  }

  it('extra only exports to the extra destination', async () => {
    const extra = memory();
    const primary = memory();
    await run(extraEnv, { primary, extra });
    expect(names(extra)).toContain('bob.sample');
    expect(names(primary)).toEqual([]);
  });

  it('primary only exports to the primary destination', async () => {
    const extra = memory();
    const primary = memory();
    await run(primaryEnv, { primary, extra });
    expect(names(primary)).toContain('bob.sample');
    expect(names(extra)).toEqual([]);
  });

  it('both destinations each receive the metric', async () => {
    const extra = memory();
    const primary = memory();
    await run({ ...primaryEnv, ...extraEnv }, { primary, extra });
    expect(names(primary)).toContain('bob.sample');
    expect(names(extra)).toContain('bob.sample');
  });

  it('extra only is delta: a series with no new recordings is not exported again', async () => {
    const extra = memory();
    const reader = createMetricReader(extraEnv, { exporters: { extra } })!;
    const provider = new MeterProvider({ readers: [reader] });
    const meter = provider.getMeter('test');
    meter.createHistogram('bob.quiet').record(3);
    await provider.forceFlush();
    meter.createHistogram('bob.busy').record(5);
    await provider.forceFlush();
    await provider.shutdown();
    const [first, second] = extra.getMetrics().map((data) => data.scopeMetrics.flatMap((scope) => scope.metrics));
    expect(first?.map((metric) => metric.aggregationTemporality)).toEqual([AggregationTemporality.DELTA]);
    expect(second?.filter((metric) => metric.dataPoints.length > 0).map((metric) => metric.descriptor.name)).toEqual(['bob.busy']);
  });

  it('both destinations stay cumulative', async () => {
    const extra = memory();
    const primary = memory();
    await run({ ...primaryEnv, ...extraEnv }, { primary, extra });
    const temporalities = primary.getMetrics().flatMap((data) => data.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.aggregationTemporality)));
    expect(temporalities.length).toBeGreaterThan(0);
    expect(new Set(temporalities)).toEqual(new Set([AggregationTemporality.CUMULATIVE]));
  });

  it('neither configured yields no reader', async () => {
    expect((await run({}, {})).flushed).toBeUndefined();
    expect((await run({ ...primaryEnv, OTEL_METRICS_EXPORTER: 'none' }, {})).flushed).toBeUndefined();
  });

  it('keeps the primary exporting and reports a failing extra once', async () => {
    const primary = memory();
    const failing: PushMetricExporter = {
      export: (_metrics, done) => done({ code: 1 }),
      forceFlush: async () => {},
      shutdown: async () => {},
      selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
    };
    const report = vi.fn();
    const reader = createMetricReader({ ...primaryEnv, ...extraEnv }, { report, exporters: { primary, extra: failing } })!;
    const provider = new MeterProvider({ readers: [reader] });
    provider.getMeter('test').createHistogram('bob.sample').record(3);
    await expect(provider.forceFlush()).resolves.toBeUndefined();
    expect(names(primary)).toContain('bob.sample');
    expect(report.mock.calls).toEqual([['otlp_extra_metrics_flush_failed']]);
  });
});

function pipeline(payload = false, rates?: CostRates) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new ScrubbingSpanProcessor(createSpanScrubber(payload), [new CorrelationSpanProcessor(rates), new SimpleSpanProcessor(exporter)])],
  });
  return { exporter, tracer: provider.getTracer('test') };
}

describe('CorrelationSpanProcessor', () => {
  it('stamps user, session, turn, name, tags and safe metadata on the root and on children', () => {
    const { exporter, tracer } = pipeline();
    const ctx = ROOT_CONTEXT.setValue(TRACE_ATTRS_KEY, {
      traceName: 'device-turn', sessionId: 's1', turnId: 't1', userId: 'u1', tags: ['device'],
      metadata: { interface: 'voice', note: 'dropped-not-safe' },
    });
    const root = tracer.startSpan('root', {}, ctx);
    tracer.startSpan('child', {}, trace.setSpan(ctx, root)).end();
    root.end();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    for (const finished of spans) {
      expect(finished.attributes).toMatchObject({
        'user.id': 'u1', 'session.id': 's1', 'bob.turn.id': 't1', 'bob.trace.name': 'device-turn',
        'bob.tags': ['device'], 'bob.interface': 'voice',
      });
      expect(finished.attributes).not.toHaveProperty('bob.note');
    }
  });

  it('never overwrites correlation attributes the span set itself', () => {
    const { exporter, tracer } = pipeline();
    const ctx = ROOT_CONTEXT.setValue(TRACE_ATTRS_KEY, { sessionId: 'ctx-session', turnId: 'ctx-turn', userId: 'ctx-user', tags: ['device'] });
    tracer.startSpan('own', { attributes: { 'bob.turn.id': 'own-turn', 'session.id': 'own-session', 'user.id': 'own-user' } }, ctx).end();
    expect(exporter.getFinishedSpans()[0]!.attributes).toEqual({
      'bob.turn.id': 'own-turn', 'session.id': 'own-session', 'bob.session.id': 'own-session', 'user.id': 'own-user', 'bob.tags': ['device'], ...NO_CONVERSATION,
    });
  });

  it('exposes the first-class turn id over a stale turn_id metadata value', () => {
    const { exporter, tracer } = pipeline();
    tracer.startSpan('chat', {}, ROOT_CONTEXT.setValue(TRACE_ATTRS_KEY, { turnId: 'chat-1', metadata: { turn_id: 'stt-1' } })).end();
    expect(exporter.getFinishedSpans()[0]!.attributes['bob.turn.id']).toBe('chat-1');
  });

  it('stamps only the `none` conversation when no correlation is active', () => {
    const { exporter, tracer } = pipeline();
    tracer.startSpan('bare').end();
    expect(exporter.getFinishedSpans()[0]!.attributes).toEqual(NO_CONVERSATION);
  });

  it('stamps both conversation names, equal, with the source, on AI and non-AI spans', () => {
    const { exporter, tracer } = pipeline();
    const ctx = ROOT_CONTEXT.setValue(TRACE_ATTRS_KEY, { conversationId: 'conv_abc', conversationSource: 'client' });
    tracer.startSpan('http GET /api/tasks', {}, ctx).end();
    tracer.startSpan('chat', { attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 1 } }, ctx).end();
    for (const span of exporter.getFinishedSpans()) {
      expect(span.attributes).toMatchObject({ 'bob.conversation.id': 'conv_abc', 'gen_ai.conversation.id': 'conv_abc', 'bob.conversation.source': 'client' });
    }
  });
});

describe('createSpanScrubber', () => {
  const emit = (payload: boolean) => {
    const { exporter, tracer } = pipeline(payload);
    const span = tracer.startSpan('gen', { attributes: {
      'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 3, 'bob.metric.turn.total_ms': 9,
      'gen_ai.input.messages': 'PRIVATE-PROMPT', 'ai.prompt': 'PRIVATE-PROMPT', 'http.url': 'https://x.test/?k=secret',
      'bob.unknown': 'x', 'gen_ai.usage.note': 'text-not-number',
    } });
    span.recordException(new Error('PRIVATE-ERROR'));
    span.addEvent('step', { 'gen_ai.input.messages': 'PRIVATE-PROMPT', 'gen_ai.tool.name': 'lookup' });
    span.setStatus({ code: 2, message: 'PRIVATE-STATUS' });
    span.end();
    return exporter.getFinishedSpans()[0]!;
  };

  it('keeps the edge trace id a workflow-route span carries', () => {
    const { exporter, tracer } = pipeline(false);
    const edgeTraceId = 'b'.repeat(32);
    tracer.startSpan('route', { attributes: { 'bob.edge_trace_id': edgeTraceId, 'bob.edge_secret': 'x' } }).end();
    expect(exporter.getFinishedSpans()[0]!.attributes).toEqual({ 'bob.edge_trace_id': edgeTraceId, ...NO_CONVERSATION });
  });

  it('drops non-allowlisted keys, payload keys, exception payloads and status messages by default', () => {
    const finished = emit(false);
    expect(finished.attributes).toEqual({ 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 3, 'bob.metric.turn.total_ms': 9, ...NO_CONVERSATION });
    expect(finished.status.message).toBeUndefined();
    const exception = finished.events.find((event) => event.name === 'exception')!;
    expect(exception.attributes).toEqual({ 'exception.type': 'Error' });
    expect(finished.events.find((event) => event.name === 'step')!.attributes).toEqual({ 'gen_ai.tool.name': 'lookup' });
    expect(JSON.stringify(finished.events) + JSON.stringify(finished.status)).not.toContain('PRIVATE');
  });

  it('labels transcribe and generateSpeech spans by their operation, never chat; a real chat span keeps chat', () => {
    const { exporter, tracer } = pipeline(false);
    const chat = { 'gen_ai.operation.name': 'chat' };
    tracer.startSpan('ai.transcribe whisper-1', { attributes: { ...chat, 'ai.operationId': 'ai.transcribe' } }).end();
    tracer.startSpan('ai.generateSpeech tts-1', { attributes: { ...chat, 'ai.operationId': 'ai.generateSpeech' } }).end();
    tracer.startSpan('ai.generateText gpt', { attributes: { ...chat, 'ai.operationId': 'ai.generateText' } }).end();
    expect(exporter.getFinishedSpans().map((span) => span.attributes['gen_ai.operation.name'])).toEqual(['transcription', 'text_to_speech', 'chat']);
  });

  it('drops a 0 or -0 cost on a span without token usage, and keeps a real one', () => {
    const { exporter, tracer } = pipeline(false);
    const zeros = { 'gen_ai.usage.cost': -0, 'gen_ai.usage.cost.input': 0, 'gen_ai.usage.cost.output': 0 };
    tracer.startSpan('ai.transcribe', { attributes: zeros }).end();
    tracer.startSpan('chat', { attributes: { ...zeros, 'gen_ai.usage.cost': 0.002, 'gen_ai.usage.input_tokens': 5 } }).end();
    const [speech, llm] = exporter.getFinishedSpans();
    expect(Object.keys(speech!.attributes).filter((key) => key.includes('cost'))).toEqual([]);
    expect(llm!.attributes).toMatchObject({ 'gen_ai.usage.cost': 0.002, 'gen_ai.usage.cost.input': 0 });
  });

  it('keeps payload keys only with the payload flag, and still never exceptions or status text', () => {
    const finished = emit(true);
    expect(finished.attributes['gen_ai.input.messages']).toBe('PRIVATE-PROMPT');
    expect(finished.attributes).not.toHaveProperty('http.url');
    expect(JSON.stringify(finished.events) + JSON.stringify(finished.status)).not.toContain('PRIVATE-ERROR');
    expect(finished.status.message).toBeUndefined();
  });

  it('drops a span it cannot scrub instead of exporting it raw', () => {
    const exporter = new InMemorySpanExporter();
    const processor = new ScrubbingSpanProcessor(() => { throw new Error('boom'); }, [new SimpleSpanProcessor(exporter)]);
    new BasicTracerProvider({ spanProcessors: [processor] }).getTracer('t').startSpan('x').end();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});

describe('provider usage cost (#999)', () => {
  const RATES = {
    version: 'test-2026-10', pricingDate: '2026-10-01', currency: 'USD',
    rates: [
      { provider: 'acme', model: 'acme/chat-1', unit: 'input_tokens', perUnit: 0.000001 },
      { provider: 'acme', model: 'acme/chat-1', unit: 'output_tokens', perUnit: 0.000004 },
      { provider: 'acme', model: 'acme/chat-1', unit: 'cache_read_tokens', perUnit: 0.0000001 },
      { provider: 'acme', model: 'acme/chat-1', unit: 'cache_write_tokens', perUnit: 0.000002 },
      { provider: 'ears', model: 'ears/stt-1', unit: 'audio_seconds', perUnit: 0.0001 },
      { provider: 'voice', model: 'voice/tts-1', unit: 'characters', perUnit: 0.00001 },
    ],
  };
  const rates = (snapshot: object = RATES): CostRates => {
    const parsed = parseCostRates(JSON.stringify(snapshot));
    if (parsed === undefined) throw new Error('test snapshot did not parse');
    return parsed;
  };
  const llm = { 'bob.ai.span_type': 'languageModel', 'gen_ai.request.model': 'acme/chat-1' };
  const tokens = {
    'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 50,
    'gen_ai.usage.cache_read.input_tokens': 400, 'gen_ai.usage.cache_creation.input_tokens': 100,
  };
  // 500 uncached + 400 read + 100 write + 50 output, at the rates above.
  const TOKENS_COST = 500 * 0.000001 + 400 * 0.0000001 + 100 * 0.000002 + 50 * 0.000004;
  const attrsOf = (spans: ReadableSpan[], name: string): ReadableSpan['attributes'] => {
    const found = spans.find((span) => span.name === name);
    if (found === undefined) throw new Error(`no span ${name}`);
    return found.attributes;
  };

  it('reads no snapshot from an empty value, and rejects one without a version, a real pricing date, a currency or a valid rate', () => {
    expect(parseCostRates(undefined)).toBeUndefined();
    expect(parseCostRates('  ')).toBeUndefined();
    expect(rates()).toMatchObject({ version: 'test-2026-10', pricingDate: '2026-10-01', currency: 'USD' });
    const [first] = RATES.rates;
    for (const bad of [
      { ...RATES, version: '' }, { ...RATES, pricingDate: '2026-02-30' }, { ...RATES, currency: 'dollars' },
      { ...RATES, rates: [{ ...first, perUnit: -1 }] }, { ...RATES, rates: [{ ...first, unit: 'requests' }] },
      { ...RATES, rates: [first, first] },
    ]) expect(() => parseCostRates(JSON.stringify(bad))).toThrow();
    expect(() => parseCostRates('{not json')).toThrow();
  });

  it('prices a model call from uncached, cache-read, cache-write and output tokens, and names the snapshot', () => {
    const { exporter, tracer } = pipeline(false, rates());
    tracer.startSpan('ai.generateText.doGenerate', { attributes: { ...llm, ...tokens } }).end();
    const call = attrsOf(exporter.getFinishedSpans(), 'ai.generateText.doGenerate');
    expect(call).toMatchObject({
      'bob.cost.status': 'complete', 'bob.cost.currency': 'USD',
      'bob.cost.rates_version': 'test-2026-10', 'bob.cost.pricing_date': '2026-10-01',
    });
    expect(call['bob.cost.estimate']).toBeCloseTo(TOKENS_COST, 12);
  });

  it('leaves the price unknown, never 0, without a snapshot or a rate for the model', () => {
    for (const snapshot of [undefined, rates()]) {
      const { exporter, tracer } = pipeline(false, snapshot);
      tracer.startSpan('call', { attributes: { ...llm, 'gen_ai.request.model': 'other/model', ...tokens } }).end();
      const call = attrsOf(exporter.getFinishedSpans(), 'call');
      expect(call['bob.cost.status']).toBe('unknown');
      expect(call).not.toHaveProperty('bob.cost.estimate');
    }
  });

  it('is partial when a used unit has no rate or the provider did not report all usage', () => {
    const { exporter, tracer } = pipeline(false, rates({ ...RATES, rates: RATES.rates.filter((rate) => rate.unit !== 'output_tokens') }));
    tracer.startSpan('a', { attributes: { ...llm, ...tokens } }).end();
    tracer.startSpan('b', { attributes: { ...llm, 'gen_ai.usage.input_tokens': 10 } }).end();
    const spans = exporter.getFinishedSpans();
    expect(attrsOf(spans, 'a')['bob.cost.status']).toBe('partial');
    expect(attrsOf(spans, 'a')['bob.cost.estimate']).toBeCloseTo(TOKENS_COST - 50 * 0.000004, 12);
    expect(attrsOf(spans, 'b')['bob.cost.status']).toBe('partial');
  });

  it('prices one provider call once: the operation parent and the SDK speech child are not billed again, and the root carries the turn total', () => {
    const { exporter, tracer } = pipeline(false, rates());
    const root = tracer.startSpan('device-turn');
    const inRoot = trace.setSpan(ROOT_CONTEXT, root);
    // The operation span repeats its provider call's usage.
    const operation = tracer.startSpan('ai.generateText', { attributes: { 'bob.ai.span_type': 'operation', 'gen_ai.request.model': 'acme/chat-1', ...tokens } }, inRoot);
    tracer.startSpan('ai.generateText.doGenerate', { attributes: { ...llm, ...tokens } }, trace.setSpan(ROOT_CONTEXT, operation)).end();
    operation.end();
    // Speech units land on the wrapper after the SDK child ends; the child is not a second call.
    const stt = tracer.startSpan('speech-stt-provider', {}, inRoot);
    tracer.startSpan('ai.transcribe', { attributes: { 'ai.operationId': 'ai.transcribe', 'gen_ai.request.model': 'ears/stt-1' } }, trace.setSpan(ROOT_CONTEXT, stt)).end();
    stt.setAttributes({ 'gen_ai.request.model': 'ears/stt-1', 'bob.speech.input_units': 2.5 });
    stt.end();
    root.end();
    const spans = exporter.getFinishedSpans();
    expect(attrsOf(spans, 'ai.generateText')).not.toHaveProperty('bob.cost.status');
    expect(attrsOf(spans, 'ai.transcribe')).not.toHaveProperty('bob.cost.status');
    expect(attrsOf(spans, 'speech-stt-provider')['bob.cost.status']).toBe('complete');
    expect(attrsOf(spans, 'speech-stt-provider')['bob.cost.estimate']).toBeCloseTo(0.00025, 12);
    const total = attrsOf(spans, 'device-turn');
    expect(total).toMatchObject({ 'bob.cost.total_status': 'complete', 'bob.cost.provider_calls': 2, 'bob.cost.currency': 'USD', 'bob.cost.rates_version': 'test-2026-10' });
    expect(total['bob.cost.total_estimate']).toBeCloseTo(TOKENS_COST + 0.00025, 12);
  });

  it('totals each local root by its own calls when several roots share one seeded trace', () => {
    const { exporter, tracer } = pipeline(false, rates());
    // Web voice: the chat turn and each sentence's synthesis are separate roots in one trace.
    const chat = tracer.startSpan('web-chat-turn');
    const shared = chat.spanContext().traceId;
    const tts = tracer.startSpan('web-speech-synthesis', {}, trace.setSpanContext(ROOT_CONTEXT, { ...chat.spanContext(), spanId: 'a'.repeat(16), isRemote: true }));
    expect(tts.spanContext().traceId).toBe(shared);
    tracer.startSpan('ai.generateText.doGenerate', { attributes: { ...llm, ...tokens } }, trace.setSpan(ROOT_CONTEXT, chat)).end();
    tracer.startSpan('speech-tts-provider', { attributes: { 'gen_ai.request.model': 'voice/tts-1', 'bob.speech.input_units': 20 } }, trace.setSpan(ROOT_CONTEXT, tts)).end();
    tts.end();
    chat.end();
    const spans = exporter.getFinishedSpans();
    expect(attrsOf(spans, 'web-speech-synthesis')).toMatchObject({ 'bob.cost.provider_calls': 1, 'bob.cost.total_status': 'partial' });
    expect(attrsOf(spans, 'web-speech-synthesis')['bob.cost.total_estimate']).toBeCloseTo(0.0002, 12);
    expect(attrsOf(spans, 'web-chat-turn')).toMatchObject({ 'bob.cost.provider_calls': 1, 'bob.cost.total_status': 'complete' });
    expect(attrsOf(spans, 'web-chat-turn')['bob.cost.total_estimate']).toBeCloseTo(TOKENS_COST, 12);
  });

  it('labels the total partial when a locally counted synthesis or a failed call without usage is in the turn', () => {
    const { exporter, tracer } = pipeline(false, rates());
    const root = tracer.startSpan('device-turn');
    const inRoot = trace.setSpan(ROOT_CONTEXT, root);
    // TTS characters are counted locally, not reported by the provider.
    tracer.startSpan('speech-tts-provider', { attributes: { 'gen_ai.request.model': 'voice/tts-1', 'bob.speech.input_units': 20 } }, inRoot).end();
    // A failed transcription never reports its audio seconds.
    tracer.startSpan('speech-stt-provider', {}, inRoot).end();
    root.end();
    const spans = exporter.getFinishedSpans();
    expect(attrsOf(spans, 'speech-tts-provider')['bob.cost.status']).toBe('partial');
    expect(attrsOf(spans, 'speech-tts-provider')['bob.cost.estimate']).toBeCloseTo(0.0002, 12);
    expect(attrsOf(spans, 'speech-stt-provider')['bob.cost.status']).toBe('unknown');
    const total = attrsOf(spans, 'device-turn');
    expect(total).toMatchObject({ 'bob.cost.total_status': 'partial', 'bob.cost.provider_calls': 2 });
    expect(total['bob.cost.total_estimate']).toBeCloseTo(0.0002, 12);
  });

  it('gives a turn with no provider call (a speech asset hit and no model) no total, rather than a zero price', () => {
    const { exporter, tracer } = pipeline(false, rates());
    const root = tracer.startSpan('device-turn');
    tracer.startSpan('speech-asset', {}, trace.setSpan(ROOT_CONTEXT, root)).end();
    root.end();
    const keys = Object.keys(attrsOf(exporter.getFinishedSpans(), 'device-turn'));
    expect(keys.filter((key) => key.startsWith('bob.cost.'))).toEqual([]);
  });

  it('the scrub keeps only bounded cost values', () => {
    const { exporter, tracer } = pipeline();
    tracer.startSpan('x', { attributes: {
      'bob.cost.status': 'free', 'bob.cost.estimate': Number.NaN, 'bob.cost.currency': 'dollars', 'bob.cost.rates_version': 'x'.repeat(65),
      'bob.cost.pricing_date': 'yesterday', 'bob.cost.provider_calls': 2, 'bob.cost.total_status': 'complete', 'bob.cost.other': 'x',
    } }).end();
    const keys = Object.keys(attrsOf(exporter.getFinishedSpans(), 'x')).filter((key) => key.startsWith('bob.cost.'));
    expect(keys.sort()).toEqual(['bob.cost.provider_calls', 'bob.cost.total_status']);
  });
});
