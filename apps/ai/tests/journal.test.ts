import { context, ROOT_CONTEXT, trace, TraceFlags, type Context, type ContextManager } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { journal, journalLevel, moduleJournal, setJournalSink } from '../src/journal.ts';
import { createLogsProvider, otlpLogsConfigured } from '../src/telemetry-export.ts';
import { TRACE_ATTRS_KEY, type TraceAttrs } from '../src/telemetry-metadata.ts';

const logExporters = vi.hoisted(() => ({ primary: undefined as unknown as InMemoryLogRecordExporter, extra: undefined as unknown as InMemoryLogRecordExporter }));
// The extra destination is the only log exporter constructed with an explicit url.
vi.mock('@opentelemetry/exporter-logs-otlp-proto', async () => {
  const { InMemoryLogRecordExporter: Memory } = await import('@opentelemetry/sdk-logs');
  logExporters.primary = new Memory();
  logExporters.extra = new Memory();
  return { OTLPLogExporter: class { constructor(options?: { url?: string }) { return options?.url === undefined ? logExporters.primary : logExporters.extra; } } };
});

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const OTLP_ENV = { OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' };

// Synchronous stand-in for the SDK's context manager: journal calls are synchronous.
class StackContextManager implements ContextManager {
  private stack: Context[] = [ROOT_CONTEXT];
  active(): Context { return this.stack.at(-1) ?? ROOT_CONTEXT; }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(ctx: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A): ReturnType<F> {
    this.stack.push(ctx);
    try { return fn.call(thisArg, ...args); } finally { this.stack.pop(); }
  }
  bind<T>(_ctx: Context, target: T): T { return target; }
  enable(): this { return this; }
  disable(): this { this.stack = [ROOT_CONTEXT]; return this; }
}

let logSpy: ReturnType<typeof vi.spyOn>;
const lastEntry = (): Record<string, unknown> => JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as Record<string, unknown>;
const inSpan = (run: () => void): void => {
  const span = trace.wrapSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED });
  context.with(trace.setSpan(context.active(), span), run);
};

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  context.setGlobalContextManager(new StackContextManager());
  setJournalSink(null);
});

afterEach(() => {
  setJournalSink(null);
  logs.disable();
  context.disable();
  vi.restoreAllMocks();
});

describe('journal envelope', () => {
  it('orders ts, level, event, message, source, module, caller fields, trace ids', () => {
    inSpan(() => moduleJournal('voice')('v2.hello', { seq: 1 }));
    expect(Object.keys(lastEntry())).toEqual(['ts', 'level', 'event', 'message', 'source', 'module', 'conversation_id', 'conversation_source', 'seq', 'trace_id', 'span_id']);
    expect(lastEntry()).toMatchObject({ source: 'api', module: 'voice', message: 'v2.hello', trace_id: TRACE_ID, span_id: SPAN_ID });
  });

  it('stamps source api and no module on the bare journal', () => {
    journal('v2.hello');
    expect(Object.keys(lastEntry())).toEqual(['ts', 'level', 'event', 'message', 'source', 'conversation_id', 'conversation_source']);
  });

  it('keeps level, message, source, module and trace ids logger-owned', () => {
    const spoof = { level: 'debug', message: 'x', source: 'web', module: 'spoof', trace_id: 't', span_id: 's' };
    moduleJournal('voice')('v2.turn_failed', spoof);
    expect(lastEntry()).toMatchObject({ level: 'error', message: 'v2.turn_failed', source: 'api', module: 'voice' });
    expect(lastEntry()).not.toHaveProperty('trace_id');
  });

  it('applies the failed/error level rule', () => {
    expect(journalLevel('v2.turn_failed')).toBe('error');
    expect(journalLevel('v2.ota.error')).toBe('error');
    expect(journalLevel('v2.failed_over')).toBe('info');
  });

  it('stamps the given source and sends the same line to console and sink', () => {
    const sink = vi.fn();
    setJournalSink(sink);
    moduleJournal('ai', 'ai')('v2.ping');
    expect(lastEntry()).toMatchObject({ source: 'ai', module: 'ai' });
    expect(sink.mock.calls[0]?.[0]).toBe(logSpy.mock.calls[0]?.[0]);
  });
});

const inCorrelation = (attrs: TraceAttrs, run: () => void): void => {
  context.with(context.active().setValue(TRACE_ATTRS_KEY, attrs), run);
};

describe('journal correlation ids', () => {
  const ids: TraceAttrs = { userId: 'user-1', sessionId: 'session-1', conversationId: 'conv_aaaa', conversationSource: 'client' };

  it('adds user_id, conversation_id, conversation_source and session_id from the correlation context', () => {
    inCorrelation(ids, () => journal('v2.hello'));
    expect(lastEntry()).toMatchObject({ user_id: 'user-1', conversation_id: 'conv_aaaa', conversation_source: 'client', session_id: 'session-1' });
  });

  it('is `none` outside any context and omits the user and session it does not know', () => {
    journal('v2.hello');
    const entry = lastEntry();
    expect(entry).toMatchObject({ conversation_id: 'none', conversation_source: 'none' });
    expect(entry).not.toHaveProperty('user_id');
    expect(entry).not.toHaveProperty('session_id');
  });

  it('lets a caller keep its own ids without duplicating a key, and names the source explicit', () => {
    inCorrelation(ids, () => journal('v2.hello', { user_id: 'caller-user', conversation_id: 'conv_bbbb' }));
    const line = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(line.match(/"user_id"/g)).toHaveLength(1);
    expect(line.match(/"conversation_id"/g)).toHaveLength(1);
    expect(lastEntry()).toMatchObject({ user_id: 'caller-user', conversation_id: 'conv_bbbb', conversation_source: 'explicit', session_id: 'session-1' });
  });

  it('writes a caller-provided legacy conversation id in the canonical form, keeping the context source when it is the same conversation', () => {
    const hex = '71fbd2912e96448d9647a07e16a6ce16';
    inCorrelation({ ...ids, conversationId: `conv_${hex}` }, () => journal('v2.hello', { conversation_id: `cnv_${hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}` }));
    expect(lastEntry()).toMatchObject({ conversation_id: `conv_${hex}`, conversation_source: 'client' });
    journal('v2.hello', { conversation_id: `thr_${hex}` });
    expect(lastEntry()).toMatchObject({ conversation_id: `conv_${hex}`, conversation_source: 'explicit' });
  });

  it('keeps conversation_source logger-owned', () => {
    inCorrelation(ids, () => journal('v2.hello', { conversation_source: 'spoof' }));
    expect(lastEntry()).toMatchObject({ conversation_source: 'client' });
  });

  it('reaches the OTLP log bridge under the same names as the stdout line', async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = createLogsProvider(OTLP_ENV, exporter)!;
    logs.setGlobalLoggerProvider(provider);
    inCorrelation(ids, () => journal('v2.hello'));
    await provider.forceFlush();
    const attributes = exporter.getFinishedLogRecords()[0]?.attributes;
    expect(attributes).toMatchObject({
      user_id: 'user-1', session_id: 'session-1', conversation_id: 'conv_aaaa', conversation_source: 'client',
    });
    expect(Object.keys(attributes ?? {})).not.toContain('user.id');
  });
});

describe('OTLP log bridge', () => {
  it('is off unless OTEL_LOGS_EXPORTER is explicitly otlp with an endpoint', () => {
    expect(otlpLogsConfigured({})).toBe(false);
    expect(otlpLogsConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x' })).toBe(false);
    expect(otlpLogsConfigured({ ...OTLP_ENV, OTEL_LOGS_EXPORTER: 'none' })).toBe(false);
    expect(otlpLogsConfigured({ OTEL_LOGS_EXPORTER: 'otlp' })).toBe(false);
    expect(createLogsProvider({})).toBeUndefined();
    expect(otlpLogsConfigured(OTLP_ENV)).toBe(true);
  });

  it('exports each line as a LogRecord when a provider is registered', async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = createLogsProvider(OTLP_ENV, exporter);
    expect(provider).toBeDefined();
    logs.setGlobalLoggerProvider(provider!);
    inSpan(() => moduleJournal('voice')('v2.turn_failed', { stage: 'stt', seq: 2 }));
    moduleJournal('ai', 'ai')('v2.ping');
    await provider!.forceFlush();
    const [first, second] = exporter.getFinishedLogRecords();
    expect(first).toMatchObject({ body: 'v2.turn_failed', severityText: 'error', severityNumber: SeverityNumber.ERROR });
    expect(first?.instrumentationScope.name).toBe('bob.voice');
    expect(first?.attributes).toEqual({
      event: 'v2.turn_failed', source: 'api', module: 'voice', stage: 'stt', seq: 2,
      conversation_id: 'none', conversation_source: 'none',
    });
    expect(first?.spanContext).toMatchObject({ traceId: TRACE_ID, spanId: SPAN_ID });
    expect(second).toMatchObject({ body: 'v2.ping', severityNumber: SeverityNumber.INFO });
    expect(second?.instrumentationScope.name).toBe('bob.ai');
  });

  it('exports nothing while no provider is registered', () => {
    expect(() => moduleJournal('voice')('v2.ping')).not.toThrow();
    expect(lastEntry()).toMatchObject({ event: 'v2.ping' });
  });
});

describe('extra OTLP logs destination', () => {
  const EXTRA = { BOB_OTLP_EXTRA_LOGS_ENDPOINT: 'http://127.0.0.1:2/v1/logs', BOB_OTLP_EXTRA_LOGS_HEADERS: 'x-key=abc' };
  const emit = async (env: Record<string, string>): Promise<void> => {
    const provider = createLogsProvider(env);
    logs.setGlobalLoggerProvider(provider!);
    inSpan(() => moduleJournal('voice')('v2.turn_failed', { stage: 'stt' }));
    await provider!.forceFlush();
  };

  beforeEach(() => {
    logExporters.primary.reset();
    logExporters.extra.reset();
  });

  it('exports to the extra destination alone, without the standard log variables', async () => {
    await emit(EXTRA);
    expect(logExporters.primary.getFinishedLogRecords()).toEqual([]);
    expect(logExporters.extra.getFinishedLogRecords().map((record) => record.body)).toEqual(['v2.turn_failed']);
  });

  it('exports to the primary alone as before', async () => {
    await emit(OTLP_ENV);
    expect(logExporters.primary.getFinishedLogRecords().map((record) => record.body)).toEqual(['v2.turn_failed']);
    expect(logExporters.extra.getFinishedLogRecords()).toEqual([]);
  });

  it('sends the identical record to both destinations', async () => {
    await emit({ ...OTLP_ENV, ...EXTRA });
    const [primary, ...morePrimary] = logExporters.primary.getFinishedLogRecords();
    const [extra, ...moreExtra] = logExporters.extra.getFinishedLogRecords();
    expect([morePrimary.length, moreExtra.length]).toEqual([0, 0]);
    expect(extra?.body).toBe(primary?.body);
    expect(extra?.attributes).toEqual(primary?.attributes);
    expect(extra?.attributes).toEqual({
      event: 'v2.turn_failed', source: 'api', module: 'voice', stage: 'stt',
      conversation_id: 'none', conversation_source: 'none',
    });
    expect(extra?.spanContext).toMatchObject({ traceId: TRACE_ID, spanId: SPAN_ID });
    expect(primary?.spanContext).toMatchObject({ traceId: TRACE_ID, spanId: SPAN_ID });
  });

  it('is off when neither destination is usable', () => {
    expect(createLogsProvider({})).toBeUndefined();
    expect(createLogsProvider({ BOB_OTLP_EXTRA_LOGS_ENDPOINT: 'ftp://extra.example.test' })).toBeUndefined();
    expect(createLogsProvider({ BOB_OTLP_EXTRA_LOGS_HEADERS: 'x-key=abc' })).toBeUndefined();
  });

  it('reports a failing extra flush once as otlp_extra_logs_flush_failed while the primary keeps exporting', async () => {
    for (const [name, value] of Object.entries({
      OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:1/v1/logs', OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '', OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none',
      BOB_OTLP_EXTRA_TRACES_ENDPOINT: '', ...EXTRA,
    })) vi.stubEnv(name, value);
    vi.resetModules();
    const telemetry = await import('../src/telemetry.ts');
    const fresh = await import('../src/journal.ts');
    telemetry.initTelemetry();
    const kinds: string[] = [];
    telemetry.onTelemetryError((kind) => { kinds.push(kind); });
    vi.spyOn(logExporters.extra, 'export').mockImplementation((_records, done) => done({ code: 1 }));
    fresh.moduleJournal('voice')('v2.one');
    await telemetry.flushTelemetry();
    fresh.moduleJournal('voice')('v2.two');
    await telemetry.flushTelemetry();
    vi.unstubAllEnvs();
    expect(logExporters.primary.getFinishedLogRecords().map((record) => record.body)).toEqual(['v2.one', 'v2.two']);
    expect(kinds).toEqual(['otlp_extra_logs_flush_failed']);
  });
});
