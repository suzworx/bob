import { context, propagation, trace, type Span } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import {
  captureDiagnosticWorkflowContext, currentDiagnosticTraceId, isValidTraceId, parseTraceparent,
  traceIdFromSeed, updateActiveSpanMetadata, withDiagnosticContextObserver,
} from '../src/telemetry-metadata.ts';

const exporter = vi.hoisted(() => ({ spans: undefined as unknown as InMemorySpanExporter, extra: undefined as unknown as InMemorySpanExporter }));
// The extra destination is the only exporter constructed with an explicit url.
vi.mock('@opentelemetry/exporter-trace-otlp-proto', async () => {
  const { InMemorySpanExporter: Memory } = await import('@opentelemetry/sdk-trace-base');
  exporter.spans = new Memory();
  exporter.extra = new Memory();
  return { OTLPTraceExporter: class { constructor(options?: { url?: string }) { return options?.url === undefined ? exporter.spans : exporter.extra; } } };
});

function activeSpan(attributes: Record<string, unknown> = {}, traceId = '0123456789abcdef0123456789abcdef'): Span {
  return {
    setAttributes: vi.fn((next: Record<string, unknown>) => Object.assign(attributes, next)),
    spanContext: () => ({ traceId, spanId: '1234567890abcdef', traceFlags: 1 }),
  } as unknown as Span;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('active operation completion metadata', () => {
  it('records safe completion fields without exporting arbitrary input or URLs', () => {
    const attributes: Record<string, unknown> = {};
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(activeSpan(attributes));
    updateActiveSpanMetadata({
      http_status: '503', outcome: 'failed', error_code: 'QUEUE_FULL',
      prompt: 'private input', authorization: 'secret bearer',
      action: 'https://private.invalid/secret', result: 'x'.repeat(201),
    });
    expect(attributes).toEqual({ 'bob.http_status': '503', 'bob.outcome': 'failed', 'bob.error_code': 'QUEUE_FULL' });
  });

  it('is silent without a current span and for an empty safe selection', () => {
    const span = activeSpan();
    const spy = vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);
    expect(() => updateActiveSpanMetadata({ outcome: 'ok' })).not.toThrow();
    spy.mockReturnValue(span);
    updateActiveSpanMetadata({ prompt: 'private' });
    expect(span.setAttributes).not.toHaveBeenCalled();
  });

  it('contains SDK failures so telemetry cannot change response handling', () => {
    vi.spyOn(trace, 'getActiveSpan').mockImplementation(() => { throw new Error('context unavailable'); });
    expect(() => updateActiveSpanMetadata({ outcome: 'ok' })).not.toThrow();
    expect(currentDiagnosticTraceId()).toBeUndefined();
  });

  it('exposes only valid opaque trace IDs for request correlation', () => {
    const spy = vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);
    expect(currentDiagnosticTraceId()).toBeUndefined();
    spy.mockReturnValue(activeSpan({}, '0123456789abcdef0123456789abcdef'));
    expect(currentDiagnosticTraceId()).toBe('0123456789abcdef0123456789abcdef');
    spy.mockReturnValue(activeSpan({}, 'invalid ID'));
    expect(currentDiagnosticTraceId()).toBeUndefined();
    spy.mockReturnValue(activeSpan({}, '0'.repeat(32)));
    expect(currentDiagnosticTraceId()).toBeUndefined();
  });

  it('captures the first workflow once across async work without leaking between requests', async () => {
    const captured = vi.fn();
    await withDiagnosticContextObserver(captured, async () => {
      await Promise.resolve();
      captureDiagnosticWorkflowContext();
      captureDiagnosticWorkflowContext();
    });
    captureDiagnosticWorkflowContext();
    expect(captured).toHaveBeenCalledOnce();
  });

  it('detached work cannot claim the request observer; callback errors cannot retry work', () => {
    const captured = vi.fn(() => { throw new Error('observer unavailable'); });
    const work = vi.fn(() => {
      withDiagnosticContextObserver(undefined, captureDiagnosticWorkflowContext);
      expect(captured).not.toHaveBeenCalled();
      captureDiagnosticWorkflowContext();
      throw new Error('product error');
    });
    expect(() => withDiagnosticContextObserver(captured, work)).toThrow('product error');
    expect(captured).toHaveBeenCalledOnce();
    expect(work).toHaveBeenCalledOnce();
  });
});

describe('deterministic trace ids', () => {
  it('derives the pinned sha256 vector', () => {
    expect(traceIdFromSeed('bob/v1/turn/abc')).toBe('e067d67cfb8e427720f9ddb75df54f49');
    expect(isValidTraceId(traceIdFromSeed('bob/v1/session/s1'))).toBe(true);
  });
});

describe('parseTraceparent', () => {
  const trace32 = '4bf92f3577b34da6a3ce929d0e0e4736';
  it.each<[string, unknown, ReturnType<typeof parseTraceparent>]>([
    ['sampled', `00-${trace32}-00f067aa0ba902b7-01`, { traceId: trace32, spanId: '00f067aa0ba902b7', traceFlags: 1 }],
    ['unsampled', `00-${trace32}-00f067aa0ba902b7-00`, { traceId: trace32, spanId: '00f067aa0ba902b7', traceFlags: 0 }],
    ['zero trace id', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`, undefined],
    ['zero span id', `00-${trace32}-${'0'.repeat(16)}-01`, undefined],
    ['unknown version', `01-${trace32}-00f067aa0ba902b7-01`, undefined],
    ['uppercase', `00-${trace32.toUpperCase()}-00f067aa0ba902b7-01`, undefined],
    ['short trace id', `00-abc-00f067aa0ba902b7-01`, undefined],
    ['trailing data', `00-${trace32}-00f067aa0ba902b7-01-extra`, undefined],
    ['empty', '', undefined],
    ['not a string', 42, undefined],
    ['undefined', undefined, undefined],
  ])('%s', (_name, header, expected) => {
    expect(parseTraceparent(header)).toEqual(expected);
  });
});

/** Real telemetry.ts and NodeSDK with the OTLP exporter swapped for an in-memory one; global OTel state is reset after each test. */
async function startTelemetry(env: Record<string, string>): Promise<typeof import('../src/telemetry.ts')> {
  for (const [name, value] of Object.entries({
    OTEL_EXPORTER_OTLP_ENDPOINT: '', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '', OTEL_TRACES_EXPORTER: '', OTEL_METRICS_EXPORTER: 'none',
    BOB_OTLP_EXTRA_TRACES_ENDPOINT: '', BOB_OTLP_EXTRA_TRACES_HEADERS: '', BOB_COST_RATES: '', ...env,
  })) vi.stubEnv(name, value);
  vi.resetModules();
  const telemetry = await import('../src/telemetry.ts');
  exporter.spans?.reset();
  exporter.extra?.reset();
  telemetry.initTelemetry();
  return telemetry;
}

afterEach(() => {
  vi.unstubAllEnvs();
  trace.disable();
  context.disable();
  propagation.disable();
});

const ENDPOINT = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' };
const finished = async (telemetry: typeof import('../src/telemetry.ts')) => {
  await telemetry.flushTelemetry();
  return exporter.spans.getFinishedSpans();
};

describe('without OTLP configuration', () => {
  it('starts no SDK, never throws, runs the work and exports nothing', async () => {
    const telemetry = await startTelemetry({});
    expect(trace.getTracerProvider().constructor.name).not.toBe('NodeTracerProvider');
    await expect(telemetry.traceSpan('turn', { turnId: 'abc' }, async () => 7)).resolves.toBe(7);
    await expect(telemetry.workflowTraceId({ turnId: 'abc' })).resolves.toBeNull();
    expect(telemetry.withTraceContext({ userId: 'u' }, () => 'ok')).toBe('ok');
    await expect(telemetry.flushTelemetry()).resolves.toBeUndefined();
    expect(exporter.spans?.getFinishedSpans() ?? []).toEqual([]);
  });
});

describe('with an OTLP endpoint', () => {
  it('puts a seeded workflow in the deterministic trace and stamps correlation on children', async () => {
    const telemetry = await startTelemetry(ENDPOINT);
    await telemetry.traceSpan('device-turn', { turnId: 'abc', sessionId: 's1', userId: 'u1', tags: ['device'] }, async () => {
      await telemetry.traceSpan('child', { observationType: 'tool' }, async () => undefined);
    });
    const spans = await finished(telemetry);
    expect(spans.map((span) => span.name).sort()).toEqual(['child', 'device-turn']);
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe('e067d67cfb8e427720f9ddb75df54f49');
      expect(span.attributes).toMatchObject({ 'user.id': 'u1', 'session.id': 's1', 'bob.turn.id': 'abc', 'bob.tags': ['device'] });
    }
    expect(spans.find((span) => span.name === 'child')!.attributes['bob.observation.type']).toBe('tool');
    await expect(telemetry.workflowTraceId({ turnId: 'abc' })).resolves.toBe('e067d67cfb8e427720f9ddb75df54f49');
  });

  it('continues a valid traceparent only when there is no workflow seed', async () => {
    const telemetry = await startTelemetry(ENDPOINT);
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await telemetry.traceSpan('edge', { traceparent }, async () => undefined);
    await telemetry.traceSpan('seeded', { traceparent, turnId: 'abc' }, async () => undefined);
    await telemetry.traceSpan('bad', { traceparent: 'garbage' }, async () => undefined);
    const spans = await finished(telemetry);
    const byName = (name: string) => spans.find((span) => span.name === name)!;
    expect(byName('edge').spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(byName('edge').parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
    expect(byName('seeded').spanContext().traceId).toBe('e067d67cfb8e427720f9ddb75df54f49');
    expect(byName('bad').spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(byName('bad').spanContext().traceId).not.toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('marks a failed workflow with the fixed message, rethrows the original error and leaks no raw text', async () => {
    const telemetry = await startTelemetry(ENDPOINT);
    await expect(telemetry.traceSpan('turn', { turnId: 'abc' }, async () => { throw new Error('PRIVATE-FAILURE'); })).rejects.toThrow('PRIVATE-FAILURE');
    const [span] = await finished(telemetry);
    expect(span!.status.code).toBe(2);
    expect(JSON.stringify(span)).not.toContain('PRIVATE-FAILURE');
  });
});

describe('with an extra OTLP traces destination', () => {
  const EXTRA = { BOB_OTLP_EXTRA_TRACES_ENDPOINT: 'http://127.0.0.1:2/v1/traces', BOB_OTLP_EXTRA_TRACES_HEADERS: 'x-key=abc' };
  const leaky = { 'gen_ai.request.model': 'speech-model', 'ai.request.text': 'PRIVATE-PROMPT', 'url.full': 'PRIVATE-URL' };

  it('sends exactly the same scrubbed span to both destinations', async () => {
    const telemetry = await startTelemetry({ ...ENDPOINT, ...EXTRA });
    trace.getTracer('test').startSpan('probe', { attributes: leaky }).end();
    await telemetry.flushTelemetry();
    const [primary, ...morePrimary] = exporter.spans.getFinishedSpans();
    const [extra, ...moreExtra] = exporter.extra.getFinishedSpans();
    expect([morePrimary.length, moreExtra.length]).toEqual([0, 0]);
    expect(extra).toBe(primary);
    expect(primary!.attributes).toEqual({
      'gen_ai.request.model': 'speech-model',
      'bob.conversation.id': 'none', 'gen_ai.conversation.id': 'none', 'bob.conversation.source': 'none',
    });
  });

  it('starts tracing with the extra destination alone', async () => {
    const telemetry = await startTelemetry(EXTRA);
    expect(telemetry.agentTelemetry.isEnabled).toBe(true);
    await telemetry.traceSpan('turn', { turnId: 'abc' }, async () => undefined);
    await telemetry.flushTelemetry();
    expect(exporter.spans.getFinishedSpans()).toEqual([]);
    expect(exporter.extra.getFinishedSpans().map((span) => span.spanContext().traceId)).toEqual(['e067d67cfb8e427720f9ddb75df54f49']);
  });

  it('ignores an extra endpoint that is not http(s)', async () => {
    const telemetry = await startTelemetry({ BOB_OTLP_EXTRA_TRACES_ENDPOINT: 'ftp://extra.example.test' });
    expect(telemetry.agentTelemetry.isEnabled).toBe(false);
    await expect(telemetry.traceSpan('turn', {}, async () => 7)).resolves.toBe(7);
    expect(exporter.extra?.getFinishedSpans() ?? []).toEqual([]);
  });

  it('keeps the primary exporting when the extra flush fails, and reports otlp_extra_flush_failed once', async () => {
    const telemetry = await startTelemetry({ ...ENDPOINT, ...EXTRA });
    const kinds: string[] = [];
    telemetry.onTelemetryError((kind) => { kinds.push(kind); });
    vi.spyOn(exporter.extra, 'export').mockImplementation((_spans, done) => done({ code: 1 }));
    await telemetry.traceSpan('one', {}, async () => undefined);
    await telemetry.flushTelemetry();
    await telemetry.traceSpan('two', {}, async () => undefined);
    await telemetry.flushTelemetry();
    expect(exporter.spans.getFinishedSpans().map((span) => span.name)).toEqual(['one', 'two']);
    expect(kinds).toEqual(['otlp_extra_flush_failed']);
  });
});

describe('user, conversation and session are independent correlation ids', () => {
  it('stamps gen_ai.conversation.id on children and survives the export scrub', async () => {
    const telemetry = await startTelemetry(ENDPOINT);
    await telemetry.traceSpan('root', { turnId: 't1', sessionId: 'session_a', conversationId: 'conv_1', userId: 'u1' }, async () => {
      await telemetry.traceSpan('child', {}, async () => undefined);
    });
    for (const span of await finished(telemetry)) {
      expect(span.attributes).toMatchObject({ 'session.id': 'session_a', 'gen_ai.conversation.id': 'conv_1', 'user.id': 'u1' });
    }
  });

  it('a session id correlates without deriving the trace id', async () => {
    const telemetry = await startTelemetry(ENDPOINT);
    await telemetry.traceSpan('a', { sessionId: 's', detached: true }, async () => undefined);
    await telemetry.traceSpan('b', { sessionId: 's', detached: true }, async () => undefined);
    const [a, b] = await finished(telemetry);
    expect(a!.spanContext().traceId).not.toBe(b!.spanContext().traceId);
    expect(a!.attributes['session.id']).toBe('s');
  });

  it('a span with a user and no conversation joins the user\'s active one, once, source active', async () => {
    const telemetry = await startTelemetry(ENDPOINT);
    const resolve = vi.fn(async (userId: string) => (userId === 'u1' ? 'conv_active' : undefined));
    telemetry.setActiveConversationResolver(resolve);
    await telemetry.traceSpan('with-user', { userId: 'u1', detached: true }, async () => telemetry.traceSpan('child', {}, async () => undefined));
    await telemetry.traceSpan('explicit', { userId: 'u1', conversationId: 'conv_x', conversationSource: 'explicit', detached: true }, async () => undefined);
    await telemetry.traceSpan('unknown-user', { userId: 'u2', detached: true }, async () => undefined);
    const byName = Object.fromEntries((await finished(telemetry)).map((span) => [span.name, span.attributes]));
    expect(byName['with-user']).toMatchObject({ 'user.id': 'u1', 'bob.conversation.id': 'conv_active', 'bob.conversation.source': 'active' });
    expect(byName.child).toMatchObject({ 'bob.conversation.id': 'conv_active', 'gen_ai.conversation.id': 'conv_active' });
    expect(byName.explicit).toMatchObject({ 'bob.conversation.id': 'conv_x', 'bob.conversation.source': 'explicit' });
    expect(byName['unknown-user']).toMatchObject({ 'bob.conversation.id': 'none', 'bob.conversation.source': 'none' });
    expect(resolve.mock.calls.map(([userId]) => userId)).toEqual(['u1', 'u2']);
  });

  it('openSpan keeps one root open across calls and ends it once, with ERROR when failed', async () => {
    const telemetry = await startTelemetry(ENDPOINT);
    const root = telemetry.openSpan('device-turn', { workflowNamespace: 'sess', turnId: 't1', userId: 'u1' });
    await root.run(() => telemetry.traceSpan('first', {}, async () => undefined));
    await root.run(() => telemetry.traceSpan('second', {}, async () => undefined));
    root.end(true);
    root.end();
    const spans = await finished(telemetry);
    const rootSpan = spans.find((span) => span.name === 'device-turn')!;
    expect(spans.filter((span) => span.name === 'device-turn')).toHaveLength(1);
    expect(rootSpan.status).toMatchObject({ code: 2 });
    for (const child of spans.filter((span) => span.name !== 'device-turn')) {
      expect(child.parentSpanContext?.spanId).toBe(rootSpan.spanContext().spanId);
      expect(child.spanContext().traceId).toBe(rootSpan.spanContext().traceId);
    }
  });
});

describe('configured cost rates (#999)', () => {
  const RATES = JSON.stringify({
    version: 'test-1', pricingDate: '2026-10-01', currency: 'USD',
    rates: [{ provider: 'ears', model: 'ears/stt-1', unit: 'audio_seconds', perUnit: 0.0001 }],
  });

  it('prices speech usage on the provider wrapper once and totals it on the turn root', async () => {
    const telemetry = await startTelemetry({ ...ENDPOINT, BOB_COST_RATES: RATES });
    await telemetry.traceSpan('device-turn', { turnId: 'cost-1' }, async () => {
      await telemetry.traceSpan('speech-stt-provider', {}, async () => {
        await telemetry.traceSpeechUsage({ kind: 'stt', model: 'ears/stt-1', inputUnits: 2 });
      });
    });
    const spans = await finished(telemetry);
    const wrapper = spans.find((span) => span.name === 'speech-stt-provider');
    const root = spans.find((span) => span.name === 'device-turn');
    expect(wrapper?.attributes).toMatchObject({ 'bob.cost.status': 'complete', 'bob.cost.rates_version': 'test-1', 'bob.cost.pricing_date': '2026-10-01' });
    expect(wrapper?.attributes['bob.cost.estimate']).toBeCloseTo(0.0002, 12);
    expect(root?.attributes).toMatchObject({ 'bob.cost.total_status': 'complete', 'bob.cost.provider_calls': 1, 'bob.cost.currency': 'USD' });
    expect(root?.attributes['bob.cost.total_estimate']).toBeCloseTo(0.0002, 12);
  });

  it('reports an invalid snapshot once by kind, never its value, and keeps tracing with the price unknown', async () => {
    for (const [name, value] of Object.entries({
      ...ENDPOINT, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '', OTEL_TRACES_EXPORTER: '', OTEL_METRICS_EXPORTER: 'none',
      BOB_OTLP_EXTRA_TRACES_ENDPOINT: '', BOB_OTLP_EXTRA_TRACES_HEADERS: '', BOB_COST_RATES: '{"version":"secret-value"',
    })) vi.stubEnv(name, value);
    vi.resetModules();
    const telemetry = await import('../src/telemetry.ts');
    exporter.spans?.reset();
    const kinds: string[] = [];
    telemetry.onTelemetryError((kind) => { kinds.push(kind); });
    telemetry.initTelemetry();
    await telemetry.traceSpan('speech-stt-provider', {}, async () => {
      await telemetry.traceSpeechUsage({ kind: 'stt', model: 'ears/stt-1', inputUnits: 2 });
    });
    const [wrapper] = await finished(telemetry);
    expect(kinds).toEqual(['cost_rates_invalid']);
    expect(wrapper?.attributes['bob.cost.status']).toBe('unknown');
    expect(wrapper?.attributes).not.toHaveProperty('bob.cost.estimate');
  });
});
