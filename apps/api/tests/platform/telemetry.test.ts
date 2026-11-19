/**
 * Provider-free telemetry: a silent no-op without an OTLP endpoint, metadata-only
 * by default (SC-002), payload only with BOB_TRACE_PAYLOAD=1, one privacy
 * scrub before the exporter, and once-per-kind export-failure reporting
 * (FR-004). Runs the real NodeSDK and processors with the OTLP network exporter
 * swapped for an in-memory one. Imports the telemetry module by path rather than
 * through the @bob/ai barrel: agentTelemetry is computed at module load, so
 * each test reloads only telemetry.ts with a fresh environment.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { context, propagation, trace, type Attributes, type Span } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolLoopAgent, registerTelemetry, type TelemetryOptions } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

/** Flags flip per test (a throwing exporter, a failing export) to prove the failure paths report once and degrade to passthrough. */
const ctl = vi.hoisted(() => ({
  constructThrows: false,
  exportFails: false,
  exported: [] as Array<{
    name: string; attributes: Record<string, unknown>; status: { code: number; message?: string };
    events: Array<{ name: string; attributes?: Record<string, unknown> }>;
    resource: { attributes: Record<string, unknown> };
    spanContext(): { traceId: string; spanId: string };
    parentSpanContext?: { spanId: string };
  }>,
}));

/** Stands in for the network exporter: batches reach it only through the real BatchSpanProcessor. */
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: class {
    constructor() { if (ctl.constructThrows) throw new Error('injected exporter failure'); }
    export(spans: typeof ctl.exported, done: (result: { code: number }) => void): void {
      if (ctl.exportFails) { done({ code: 1 }); return; }
      ctl.exported.push(...spans);
      done({ code: 0 });
    }
    async forceFlush(): Promise<void> {}
    async shutdown(): Promise<void> {}
  },
}));

vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());

import { telemetryRoute } from '../../src/platform/observability/telemetry.ts';
import { journal } from '../../src/platform/logger.ts';

/** Every exported span names a conversation: the literal `none` when nothing resolved one. */
const NO_CONVERSATION = { 'bob.conversation.id': 'none', 'gen_ai.conversation.id': 'none', 'bob.conversation.source': 'none' };
const PROMPT_MARKER = 'unmistakable-prompt-9f3c7a';
const REPLY_MARKER = 'unmistakable-reply-7a2e1b';
/** File URL of @bob/ai's entry; telemetry.ts/config.ts load fresh per test through it. */
const AI_ENTRY = pathToFileURL(createRequire(import.meta.url).resolve('@bob/ai'));
const TELEMETRY_MODULE = new URL('./telemetry.ts', AI_ENTRY).href;
const CONFIG_MODULE = new URL('./config.ts', AI_ENTRY).href;
const ENDPOINT = 'https://otlp.example.test';

type Telemetry = typeof import('@bob/ai');

/** Events the fake integration received; proves telemetry events flow. */
let receivedEventCount = 0;
/** Events the fake integration kept; payload-bearing only when flags allow. */
const capturedPayload: unknown[] = [];

/**
 * Fake integration honouring recordInputs/recordOutputs exactly like a real
 * backend integration, which gates every span on `event.recordInputs !==
 * false` / `recordOutputs !== false`: the AI SDK dispatcher stamps those
 * flags onto each event it delivers, so a metadata-only agentTelemetry keeps
 * prompt and reply text out of the captured events.
 */
registerTelemetry({
  onStart(event: unknown): void {
    receivedEventCount += 1;
    if ((event as { recordInputs?: boolean }).recordInputs !== false) capturedPayload.push(event);
  },
  onEnd(event: unknown): void {
    receivedEventCount += 1;
    if ((event as { recordOutputs?: boolean }).recordOutputs !== false) capturedPayload.push(event);
  },
});

/** Runs one agent turn against a mock model with the given telemetry. */
async function runAgentTurn(telemetry: TelemetryOptions): Promise<void> {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: REPLY_MARKER }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0, text: 2, reasoning: 0 },
        totalTokens: 6,
      },
      warnings: [],
    }),
  });
  await new ToolLoopAgent({ model, telemetry }).generate({ prompt: PROMPT_MARKER });
}

/** Loads a fresh telemetry module and starts it; `configured` supplies the OTLP endpoint. */
async function boot(configured = true): Promise<Telemetry> {
  if (configured) vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', ENDPOINT);
  vi.resetModules();
  const telemetry = await import(TELEMETRY_MODULE);
  telemetry.initTelemetry();
  return telemetry;
}

/** Flushes through the production pipeline and returns what the exporter received. */
async function exportedSpans(telemetry: Telemetry): Promise<typeof ctl.exported> {
  await telemetry.flushTelemetry();
  return ctl.exported;
}

/** A real finished span carrying arbitrary attributes, so the production scrub is exercised end to end. */
function emit(name: string, attributes: Attributes, decorate: (span: Span) => void = () => {}): void {
  const span = trace.getTracer('test').startSpan(name, { attributes });
  decorate(span);
  span.end();
}

beforeEach(() => {
  receivedEventCount = 0;
  capturedPayload.length = 0;
  ctl.constructThrows = false;
  ctl.exportFails = false;
  ctl.exported.length = 0;
  // Explicit values win over dotenv, which never overrides existing keys.
  process.env.BOB_TRACE_PAYLOAD = '';
  process.env.BOB_PRODUCTION = '';
  for (const name of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_TRACES_EXPORTER', 'OTEL_SERVICE_NAME', 'OTEL_SERVICE_VERSION']) vi.stubEnv(name, '');
  vi.stubEnv('OTEL_METRICS_EXPORTER', 'none');
});

afterEach(() => {
  vi.unstubAllEnvs();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe('exported span privacy', () => {
  it('detects no host, process or argv resource attributes', async () => {
    const telemetry = await boot();
    emit('probe', { 'gen_ai.request.model': 'speech-model' });
    const [span] = await exportedSpans(telemetry);
    expect(span!.resource.attributes['service.name']).toBe('bob');
    expect(Object.keys(span!.resource.attributes).every((key) => /^(service|deployment)\./.test(key))).toBe(true);
  });

  it.each(['', '1'])('removes credentials and exceptions with payload flag %j', async (payloadFlag) => {
    process.env.BOB_TRACE_PAYLOAD = payloadFlag;
    const telemetry = await boot();
    emit('probe', {
      'ai.request.headers.authorization': 'secret-marker', 'ai.response.providerMetadata': 'secret-marker',
      'vendor.debug.status_message': 'secret-marker', 'url.full': 'secret-marker', 'ai.request.text': PROMPT_MARKER,
    }, (span) => {
      span.setStatus({ code: 2, message: 'secret-marker' });
      span.addEvent('exception', { 'exception.message': 'secret-marker' });
    });
    const exported = await exportedSpans(telemetry);
    expect(exported).toHaveLength(1);
    expect(JSON.stringify(exported[0]!.attributes) + JSON.stringify(exported[0]!.events) + JSON.stringify(exported[0]!.status)).not.toContain('secret-marker');
    expect(JSON.stringify(exported[0]!.attributes).includes(PROMPT_MARKER)).toBe(payloadFlag === '1');
  });

  it('removes SDK exception payloads and keeps safe metadata', async () => {
    const telemetry = await boot();
    emit('probe', {
      'error.message': PROMPT_MARKER, 'ai.request.text': PROMPT_MARKER, 'ai.response.text': PROMPT_MARKER,
      'gen_ai.input.messages': PROMPT_MARKER, 'gen_ai.output.messages': PROMPT_MARKER, 'gen_ai.tool.call.arguments': PROMPT_MARKER,
      'gen_ai.system_instructions': PROMPT_MARKER, 'ai.request.headers.authorization': PROMPT_MARKER,
      'bob.turn.id': 'turn-1', 'bob.device_event': 'playback_completed', 'bob.uptime_ms': 4242, 'bob.attempt': 2,
      'bob.format': 'mp3', 'bob.untrusted': PROMPT_MARKER, 'gen_ai.request.model': 'speech-model',
    }, (span) => {
      span.setStatus({ code: 2, message: PROMPT_MARKER });
      span.addEvent('exception', { 'exception.message': PROMPT_MARKER, 'exception.stacktrace': PROMPT_MARKER, 'exception.type': 'Error' });
    });
    const [span] = await exportedSpans(telemetry);
    expect(JSON.stringify([span!.attributes, span!.events, span!.status])).not.toContain(PROMPT_MARKER);
    expect(span!.attributes).toEqual({
      'bob.turn.id': 'turn-1', 'bob.device_event': 'playback_completed', 'bob.uptime_ms': 4242,
      'bob.attempt': 2, 'bob.format': 'mp3', 'gen_ai.request.model': 'speech-model', ...NO_CONVERSATION,
    });
    expect(span!.events[0]!.attributes).toEqual({ 'exception.type': 'Error' });
  });

  it('preserves bounded UI dimensions while removing private metadata', async () => {
    const telemetry = await boot();
    const dimensions = {
      'bob.event': 'ui_request', 'bob.page': 'chat', 'bob.view_id': '11111111-1111-4111-8111-111111111111',
      'bob.browser_duration_ms': '120', 'bob.timing_source': 'browser', 'bob.target': 'button', 'bob.phase': 'update',
      'bob.area': 'voice', 'bob.method': 'POST', 'bob.status': '200', 'bob.outcome': 'ok',
    };
    emit('probe', { ...dimensions, 'bob.url': PROMPT_MARKER, 'bob.selector': PROMPT_MARKER, 'bob.headers': PROMPT_MARKER });
    const [span] = await exportedSpans(telemetry);
    expect(span!.attributes).toEqual({ ...dimensions, ...NO_CONVERSATION });
  });

  it('keeps evaluator scores numeric and drops a string that merely looks numeric', async () => {
    const telemetry = await boot();
    emit('numeric', { 'bob.evaluation.score': 0.42 });
    emit('text', { 'bob.evaluation.score': '0.42', 'ai.response.text': '0.42' });
    const exported = await exportedSpans(telemetry);
    expect(exported.find((span) => span.name === 'numeric')!.attributes).toEqual({ 'bob.evaluation.score': 0.42, ...NO_CONVERSATION });
    expect(exported.find((span) => span.name === 'text')!.attributes).toEqual(NO_CONVERSATION);
  });
});

describe('OTLP agent telemetry', () => {
  it('is a silent no-op without an OTLP endpoint', async () => {
    const telemetry = await boot(false);
    expect(telemetry.agentTelemetry.isEnabled).toBe(false);
    await runAgentTurn(telemetry.agentTelemetry);
    expect(receivedEventCount).toBe(0);
    expect(capturedPayload).toHaveLength(0);
    await expect(telemetry.flushTelemetry()).resolves.toBeUndefined();
    expect(ctl.exported).toHaveLength(0);
  });

  it('keeps spans metadata-only in default mode (SC-002)', async () => {
    const telemetry = await boot();
    expect(telemetry.agentTelemetry).toMatchObject({ isEnabled: true, recordInputs: false, recordOutputs: false });
    await runAgentTurn(telemetry.agentTelemetry);
    expect(receivedEventCount).toBeGreaterThan(0);
    await telemetry.flushTelemetry();
    const text = JSON.stringify([capturedPayload, ctl.exported.map((span) => [span.attributes, span.events])]);
    expect(text).not.toContain(PROMPT_MARKER);
    expect(text).not.toContain(REPLY_MARKER);
  });

  it('captures payload only with BOB_TRACE_PAYLOAD=1', async () => {
    process.env.BOB_TRACE_PAYLOAD = '1';
    const telemetry = await boot();
    await runAgentTurn(telemetry.agentTelemetry);
    const text = JSON.stringify(capturedPayload);
    expect(text).toContain(PROMPT_MARKER);
    expect(text).toContain(REPLY_MARKER);
  });

  it('allows payload capture in production', async () => {
    process.env.BOB_PRODUCTION = '1';
    process.env.BOB_TRACE_PAYLOAD = '1';
    vi.resetModules();
    const { BOB_TRACE_PAYLOAD } = await import(CONFIG_MODULE);
    expect(BOB_TRACE_PAYLOAD).toBe(true);
  });

  it('names the service from the environment', async () => {
    vi.stubEnv('OTEL_SERVICE_NAME', 'bob-api');
    vi.stubEnv('OTEL_SERVICE_VERSION', '9.9.9');
    const telemetry = await boot();
    emit('probe', {});
    const [span] = await exportedSpans(telemetry);
    expect(span!.resource.attributes).toMatchObject({ 'service.name': 'bob-api', 'service.version': '9.9.9' });
  });

  it('stays off when the traces exporter is none', async () => {
    vi.stubEnv('OTEL_TRACES_EXPORTER', 'none');
    const telemetry = await boot();
    expect(telemetry.agentTelemetry.isEnabled).toBe(false);
    emit('probe', {});
    await telemetry.flushTelemetry();
    expect(ctl.exported).toHaveLength(0);
  });

  it('reports a failed OTLP export as otlp_flush_failed, once, with no payload', async () => {
    ctl.exportFails = true;
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', ENDPOINT);
    vi.resetModules();
    const telemetry = await import(TELEMETRY_MODULE);
    const kinds: string[] = [];
    telemetry.onTelemetryError((kind: string) => { kinds.push(kind); });
    telemetry.initTelemetry();
    emit('probe', { 'ai.request.text': PROMPT_MARKER });
    await telemetry.flushTelemetry();
    emit('probe', { 'ai.request.text': PROMPT_MARKER });
    await telemetry.flushTelemetry();
    expect(kinds).toEqual(['otlp_flush_failed']);
  });

  it('reports an exporter that throws on construction once and degrades to passthrough', async () => {
    ctl.constructThrows = true;
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', ENDPOINT);
    vi.resetModules();
    const telemetry = await import(TELEMETRY_MODULE);
    const kinds: string[] = [];
    telemetry.onTelemetryError((kind: string) => { kinds.push(kind); });
    expect(() => telemetry.initTelemetry()).not.toThrow();
    expect(kinds).toEqual(['telemetry_init_failed']);
    await expect(telemetry.traceSpan('turn', { turnId: 'turn-1' }, async () => 'ok')).resolves.toBe('ok');
    await expect(telemetry.flushTelemetry()).resolves.toBeUndefined();
  });
});

describe('observability context (common placeholder)', () => {
  it('converts a device turn to trace attrs with turn_id stamped', async () => {
    const { toTraceAttrs } = await boot(false);
    expect(toTraceAttrs({ surface: 'device', turnId: 'turn-1', sessionId: 'conv-1', userId: 'user-1' })).toEqual({
      traceName: 'device-turn', tags: ['device'], sessionId: 'conv-1', turnId: 'turn-1', userId: 'user-1',
    });
  });

  it('names traces per turn surface and drops undefined', async () => {
    const { toTraceAttrs } = await boot(false);
    expect(toTraceAttrs({ surface: 'web', turnId: 't-2', sessionId: undefined, userId: undefined })).toEqual({
      traceName: 'web-chat-turn', tags: ['web'], turnId: 't-2',
    });
    expect(toTraceAttrs({ surface: 'invocation', sessionId: 'thread-1', userId: 'u-1' }).traceName).toBe('thread-invocation');
  });

  it('converts any context to span attrs tagged by surface', async () => {
    const { toSpanAttrs } = await boot(false);
    expect(toSpanAttrs({ surface: 'firmware', metadata: { board: 'm5stack-cardputer', result: 'ok' } })).toEqual({
      tags: ['firmware'], metadata: { board: 'm5stack-cardputer', result: 'ok' },
    });
  });

  it('reads the environment from BOB_PRODUCTION', async () => {
    const { observabilityEnvironment } = await boot(false);
    expect(observabilityEnvironment({} as NodeJS.ProcessEnv)).toBe('development');
    expect(observabilityEnvironment({ BOB_PRODUCTION: '1' } as NodeJS.ProcessEnv)).toBe('production');
  });
});

/** The deterministic trace id the workflow seed `seed` must resolve to. */
const idOf = (seed: string): string => (createRequire(import.meta.url)('node:crypto') as typeof import('node:crypto')).createHash('sha256').update(`bob/v1/${seed}`).digest('hex').slice(0, 32);

describe('traceSpan', () => {
  it('preserves a code-owned canonical trace name across auxiliary roots and nested spans', async () => {
    const telemetry = await boot();
    const identity = { workflowNamespace: 'device-session', turnId: 'one', traceName: 'device-turn' };
    await telemetry.traceSpan('ws.control.turn_end', identity, () => telemetry.traceSpan('device-turn', identity, () => undefined));
    await telemetry.traceSpan('ws.uplink', { ...identity, detached: true }, () => undefined);
    const exported = await exportedSpans(telemetry);
    expect(exported.map(({ name }) => name).sort()).toEqual(['device-turn', 'ws.control.turn_end', 'ws.uplink']);
    expect(exported.every((span) => span.attributes['bob.trace.name'] === 'device-turn')).toBe(true);
    expect(new Set(exported.map((span) => span.spanContext().traceId)).size).toBe(1);
  });

  it('retains workflow context for a diagnostic callback after the workflow exits', async () => {
    const telemetry = await boot();
    let finish: () => Promise<void> = async () => {};
    await telemetry.traceSpan('workflow', { workflowNamespace: 'test', workflowId: 'one' }, () => {
      finish = telemetry.bindDiagnosticContext(async () => { await telemetry.traceSpan('completion', {}, () => undefined); });
    });
    await finish();
    const exported = await exportedSpans(telemetry);
    expect(exported).toHaveLength(2);
    expect(exported[1]!.spanContext().traceId).toBe(exported[0]!.spanContext().traceId);
  });

  it('preserves explicit retrospective start time and retriever type', async () => {
    const telemetry = await boot();
    const startTime = new Date('2026-10-06T00:00:00Z');
    await telemetry.traceSpan('memory-retrieval', { observationType: 'retriever', startTime }, () => 'ok');
    const [span] = await exportedSpans(telemetry) as unknown as Array<{ startTime: [number, number]; attributes: Record<string, unknown> }>;
    expect(span!.startTime[0]).toBe(Math.floor(startTime.getTime() / 1000));
    expect(span!.attributes['bob.observation.type']).toBe('retriever');
  });

  it('does not advertise a trace when telemetry is disabled', async () => {
    const telemetry = await boot(false);
    expect(await telemetry.workflowTraceId({ turnId: 'unrecorded' })).toBeNull();
    await expect(telemetry.traceSpan('device-welcome', { sessionId: 'sess-1' }, async () => 'done')).resolves.toBe('done');
  });

  it('separates a background batch from the request that scheduled it', async () => {
    const telemetry = await boot();
    await telemetry.traceSpan('request', { turnId: 'trigger' }, async () => {
      for (const turnId of ['message-b', 'message-c']) {
        await telemetry.traceSpan('memory-extract', { detached: true, workflowNamespace: 'memory/user', turnId }, async () => {});
      }
    });
    const exported = await exportedSpans(telemetry);
    const idsOf = (name: string) => exported.filter((span) => span.name === name).map((span) => span.spanContext().traceId);
    expect(idsOf('request')).toEqual([idOf('turn/trigger')]);
    expect(idsOf('memory-extract')).toEqual([idOf('execution/["memory/user","message-b"]'), idOf('execution/["memory/user","message-c"]')]);
  });

  it('joins separate voice requests by workflow while preserving their journal turn ids', async () => {
    const telemetry = await boot();
    const attrs = telemetry.toSpanAttrs({ surface: 'web', workflowNamespace: 'web-voice/account-a', workflowId: 'voice-1', turnId: 'stt-1' });
    await telemetry.traceSpan('stt', attrs, async () => {});
    await telemetry.traceSpan('chat', { ...attrs, turnId: 'chat-1' }, async () => {});
    const exported = await exportedSpans(telemetry);
    const expected = idOf('execution/["web-voice/account-a","voice-1"]');
    expect(exported.map((span) => span.spanContext().traceId)).toEqual([expected, expected]);
    expect(exported.map((span) => span.attributes['bob.turn.id'])).toEqual(['stt-1', 'chat-1']);
    expect(await telemetry.workflowTraceId(attrs)).toBe(expected);
    expect(await telemetry.workflowTraceId({ ...attrs, workflowNamespace: 'web-voice/account-b' })).not.toBe(expected);
    expect(await telemetry.workflowTraceId({})).toBeNull();
  });

  it('separates repeated device turn refs by server session while preserving correlation', async () => {
    const telemetry = await boot();
    for (const workflowNamespace of ['socket-a', 'socket-b', 'socket-a']) {
      await telemetry.traceSpan('device-turn', telemetry.toSpanAttrs({ surface: 'device', turnId: 'turn_123_v2', workflowNamespace }), async () => {});
    }
    const ids = (await exportedSpans(telemetry)).map((span) => span.spanContext().traceId);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toBe(ids[2]);
    expect(ctl.exported[0]!.attributes['bob.turn.id']).toBe('turn_123_v2');
  });

  it('propagates root name and journal correlation to nested observations', async () => {
    const telemetry = await boot();
    await telemetry.traceSpan('web-chat-turn', { turnId: 'turn-1', sessionId: 'conversation-1' }, async () => {
      await telemetry.traceSpan('stage', { turnId: 'turn-1' }, async () => {
        await telemetry.traceSpeechUsage({ kind: 'tts', model: 'openai/tts-1', inputUnits: 2 });
      });
    });
    const exported = await exportedSpans(telemetry);
    expect(exported.map(({ name }) => name).sort()).toEqual(['stage', 'web-chat-turn']);
    for (const span of exported) {
      expect(span.spanContext().traceId).toBe(idOf('turn/turn-1'));
      // Every span carries the session as bob.session.id; `stage` also carries speech usage (gen_ai.*), so it drops session.id.
      expect(span.attributes).toMatchObject({ 'bob.session.id': 'conversation-1', 'bob.turn.id': 'turn-1', 'bob.trace.name': 'web-chat-turn' });
    }
  });

  it('runs once when tracing fails before entering work', async () => {
    const telemetry = await boot();
    vi.spyOn(trace, 'getTracer').mockImplementationOnce(() => ({ startActiveSpan() { throw new Error('instrumentation'); } }) as never);
    const work = vi.fn(async () => 'reply');
    await expect(telemetry.traceSpan('turn', {}, work)).resolves.toBe('reply');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('keeps the span open through asynchronous work', async () => {
    const telemetry = await boot();
    let resolvePending: (value: string) => void = () => {};
    let resolveEntered: () => void = () => {};
    const pending = new Promise<string>((resolve) => { resolvePending = resolve; });
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    const result = telemetry.traceSpan('turn', {}, () => { resolveEntered(); return pending; });
    await entered;
    expect(await exportedSpans(telemetry)).toHaveLength(0);
    resolvePending('reply');
    await expect(result).resolves.toBe('reply');
    expect(await exportedSpans(telemetry)).toHaveLength(1);
  });

  it('joins one workflow: the same turn ref resolves to the same trace', async () => {
    const telemetry = await boot();
    await telemetry.traceSpan('device-turn-started', { turnId: 'turn-1' }, async () => 'a');
    await telemetry.traceSpan('device-turn-ended', { turnId: 'turn-1' }, async () => 'b');
    const exported = await exportedSpans(telemetry);
    expect(exported.map((span) => span.spanContext().traceId)).toEqual([idOf('turn/turn-1'), idOf('turn/turn-1')]);
    expect(exported.every((span) => span.parentSpanContext === undefined)).toBe(true);
  });

  it('separates workflows: different turn refs resolve to different traces', async () => {
    const telemetry = await boot();
    await telemetry.traceSpan('device-turn-started', { turnId: 'turn-1' }, async () => 'a');
    await telemetry.traceSpan('device-turn-started', { turnId: 'turn-2' }, async () => 'b');
    const ids = (await exportedSpans(telemetry)).map((span) => span.spanContext().traceId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('a session id alone correlates but never seeds the trace', async () => {
    const telemetry = await boot();
    await telemetry.traceSpan('device-presence', { sessionId: 'sess-9', detached: true }, async () => 'done');
    await telemetry.traceSpan('device-presence', { sessionId: 'sess-9', detached: true }, async () => 'done');
    const [first, second] = await exportedSpans(telemetry);
    expect(first!.parentSpanContext).toBeUndefined();
    expect(first!.spanContext().traceId).not.toBe(idOf('session/sess-9'));
    expect(first!.spanContext().traceId).not.toBe(second!.spanContext().traceId);
    expect(first!.attributes['session.id']).toBe('sess-9');
  });

  it('rethrows the original failure exactly once, marks the span failed and leaks no raw text', async () => {
    const telemetry = await boot();
    const failure = new Error(PROMPT_MARKER);
    const work = vi.fn(async () => { throw failure; });
    await expect(telemetry.traceSpan('device-turn', { turnId: 'turn-9' }, work)).rejects.toBe(failure);
    expect(work).toHaveBeenCalledTimes(1);
    const [span] = await exportedSpans(telemetry);
    expect(span!.status.code).toBe(2);
    expect(JSON.stringify([span!.status, span!.attributes, span!.events])).not.toContain(PROMPT_MARKER);
  });
});

describe('traceSpeechUsage', () => {
  it('is a no-op without an OTLP endpoint', async () => {
    const telemetry = await boot(false);
    await expect(Promise.resolve(telemetry.traceSpeechUsage({ kind: 'tts', model: 'openai/tts-1', inputUnits: 42 }))).resolves.toBeUndefined();
    expect(await exportedSpans(telemetry)).toHaveLength(0);
  });

  it('starts no span of its own and skips when none is active', async () => {
    const telemetry = await boot();
    await telemetry.traceSpeechUsage({ kind: 'tts', model: 'speech-model', inputUnits: 3 });
    expect(await exportedSpans(telemetry)).toHaveLength(0);
  });

  it.each([
    ['tts', 'ai.generateSpeech', 'text_to_speech', 42],
    ['stt', 'ai.transcribe', 'transcription', 1.5],
  ] as const)('records %s usage with model and units only on the active span, labelled at its start, no text or cost', async (kind, spanName, operation, inputUnits) => {
    const telemetry = await boot();
    await telemetry.traceSpan(spanName, {}, () => telemetry.traceSpeechUsage({ kind, model: 'speech-model', inputUnits }));
    const spans = await exportedSpans(telemetry);
    expect(spans.map(({ name }) => name)).toEqual([spanName]);
    const span = spans[0]!;
    expect(span!.attributes).toMatchObject({ 'gen_ai.request.model': 'speech-model', 'gen_ai.operation.name': operation, 'bob.speech.input_units': inputUnits });
    expect(Object.keys(span!.attributes).some((key) => /cost/i.test(key))).toBe(false);
  });
});

describe('traceEvaluation', () => {
  it('passes the result through without an OTLP endpoint', async () => {
    const telemetry = await boot(false);
    await expect(telemetry.traceEvaluation('bob-memory-gate', 'typesafe-ai/jev', 'User: hello', async () => 0.7)).resolves.toBe(0.7);
    expect(await exportedSpans(telemetry)).toHaveLength(0);
  });

  it('records the numeric score and model, omitting input by default', async () => {
    const telemetry = await boot();
    await expect(telemetry.traceEvaluation('bob-memory-gate', 'typesafe-ai/jev', 'User: hello', async () => 0.42)).resolves.toBe(0.42);
    const [span] = await exportedSpans(telemetry);
    expect(span!.name).toBe('bob-memory-gate');
    expect(span!.attributes).toMatchObject({ 'bob.observation.type': 'evaluator', 'bob.evaluation.score': 0.42, 'gen_ai.request.model': 'typesafe-ai/jev' });
    expect(JSON.stringify(span!.attributes)).not.toContain('User: hello');
  });

  it('includes the input only with BOB_TRACE_PAYLOAD=1', async () => {
    process.env.BOB_TRACE_PAYLOAD = '1';
    const telemetry = await boot();
    await expect(telemetry.traceEvaluation('bob-memory-gate', 'typesafe-ai/jev', 'User: hello', async () => 0.9)).resolves.toBe(0.9);
    const [span] = await exportedSpans(telemetry);
    expect(span!.attributes['bob.evaluation.input']).toBe('User: hello');
  });
});

// --- 013 R8 web telemetry route (FR-031..FR-034) ----------------------------

const TELEMETRY_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const TELEMETRY_SESSION_ID = '33333333-3333-4333-8333-333333333333';

function telemetryResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
    },
    end() {},
  };
}

function telemetryRequest(body: unknown): unknown {
  return {
    body,
    account: {
      userId: TELEMETRY_ACCOUNT_ID,
      sessionId: TELEMETRY_SESSION_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  };
}

describe('web telemetry route (013 R8)', () => {
  beforeEach(() => {
    vi.mocked(journal).mockClear();
  });

  it('accepts a valid batch and journals one v2.web_telemetry per event (204)', async () => {
    const result = telemetryResponse();
    await telemetryRoute(
      telemetryRequest({
        events: [
          { event: 'turn_timing', eos_to_first_audio_ms: 3200, stt_ms: 900, agent_first_token_ms: 1400, tts_first_audio_ms: 900 },
          { event: 'barge_in', reaction_ms: 240 },
          { event: 'false_trigger', count: 2 },
          { event: 'mode_state', from: 'listening', to: 'hearing_you' },
          { event: 'mode_off', reason: 'idle' },
        ],
      }) as never,
      result as never,
    );
    expect(result.statusCode).toBe(204);
    const calls = vi.mocked(journal).mock.calls;
    expect(calls).toHaveLength(5);
    for (const call of calls) expect(call[0]).toBe('v2.web_telemetry');
  });

  it('journals only the whitelisted fields, with the account in opaque form', async () => {
    const result = telemetryResponse();
    await telemetryRoute(
      telemetryRequest({ events: [{ event: 'turn_timing', eos_to_first_audio_ms: 3000 }] }) as never,
      result as never,
    );
    expect(result.statusCode).toBe(204);
    const call = vi.mocked(journal).mock.calls[0];
    expect(call![0]).toBe('v2.web_telemetry');
    expect(call![1]).toEqual({
      ui_event: 'turn_timing',
      eos_to_first_audio_ms: 3000,
      acct: expect.stringMatching(/^acct=[0-9a-f]{8}$/),
    });
  });

  it('rejects an unknown event kind with 400', async () => {
    const result = telemetryResponse();
    await telemetryRoute(telemetryRequest({ events: [{ event: 'mystery', x: 1 }] }) as never, result as never);
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('rejects any free-text key with 400', async () => {
    for (const body of [
      { events: [{ event: 'turn_timing', eos_to_first_audio_ms: 1000, label: 'free text' }] },
      { events: [{ event: 'barge_in', reaction_ms: 5, transcript: 'free text' }] },
      { events: [{ event: 'mode_off', reason: 'idle', note: 'free text' }] },
    ]) {
      const result = telemetryResponse();
      await telemetryRoute(telemetryRequest(body) as never, result as never);
      expect(result.statusCode).toBe(400);
      expect((result.body as { error: { code: string } }).error.code).toBe('invalid_request');
    }
  });

  it('rejects out-of-range and non-integer numbers with 400', async () => {
    for (const body of [
      { events: [{ event: 'turn_timing', eos_to_first_audio_ms: -1 }] },
      { events: [{ event: 'turn_timing', eos_to_first_audio_ms: 120001 }] },
      { events: [{ event: 'turn_timing', eos_to_first_audio_ms: 1.5 }] },
      { events: [{ event: 'turn_timing', eos_to_first_audio_ms: '3200' }] },
      { events: [{ event: 'barge_in', reaction_ms: 300000 }] },
      { events: [{ event: 'false_trigger', count: -1 }] },
    ]) {
      const result = telemetryResponse();
      await telemetryRoute(telemetryRequest(body) as never, result as never);
      expect(result.statusCode).toBe(400);
      expect((result.body as { error: { code: string } }).error.code).toBe('invalid_request');
    }
  });

  it('rejects an empty batch and a batch of 21 events with 400', async () => {
    const twentyOne = Array.from({ length: 21 }, () => ({ event: 'false_trigger', count: 1 }));
    for (const body of [{ events: [] }, { events: twentyOne }]) {
      const result = telemetryResponse();
      await telemetryRoute(telemetryRequest(body) as never, result as never);
      expect(result.statusCode).toBe(400);
      expect((result.body as { error: { code: string } }).error.code).toBe('invalid_request');
    }
  });

  it('answers 400 for a non-object body or a stray top-level key', async () => {
    for (const body of [null, 'text', { events: 5 }, { events: [{ event: 'mode_off', reason: 'idle' }], extra: 1 }]) {
      const result = telemetryResponse();
      await telemetryRoute(telemetryRequest(body) as never, result as never);
      expect(result.statusCode).toBe(400);
      expect((result.body as { error: { code: string } }).error.code).toBe('invalid_request');
    }
  });
});
