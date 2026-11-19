/**
 * Provider-free telemetry for the Bob agent. Spans use the OpenTelemetry API
 * only and leave over standard OTLP; the backend (Railway, a collector, any
 * OTLP receiver) is chosen solely by the OTEL_* variables, with an optional
 * second traces and logs destination from BOB_OTLP_EXTRA_TRACES_* and
 * BOB_OTLP_EXTRA_LOGS_*. Spans are
 * metadata-only by default: model, latency, usage, tool names, finish reason,
 * error class. Prompts, replies, and tool payloads leave the machine only when
 * BOB_TRACE_PAYLOAD=1 is set. The flag governs the one shared
 * `agentTelemetry` object (`recordInputs`/`recordOutputs`), which the AI SDK
 * dispatcher stamps onto every telemetry event, and the export scrub allowlist.
 *
 * `@ai-sdk/otel` turns the AI SDK 7 telemetry events into GenAI spans. Per-turn
 * context (trace name, session, turn id, user, tags) rides an OTel context key
 * set by `withTraceContext`/`traceSpan`; `CorrelationSpanProcessor` stamps it on
 * every span started inside.
 */
import { registerTelemetry, type TelemetryOptions } from 'ai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { context, ROOT_CONTEXT, SpanStatusCode, trace, type Context, type Span, type SpanOptions } from '@opentelemetry/api';
import { BOB_TRACE_PAYLOAD } from './config.ts';
import { flushObservationMetrics, initObservationMetrics } from './observation-metrics.ts';
import {
  activeTraceAttrs, captureDiagnosticWorkflowContext, CORRELATION_KEYS, mergeTraceAttrs, metadataAttributes, parseTraceparent, pickDefined,
  TRACE_ATTRS_KEY, traceAttributes, traceIdFromSeed, withDiagnosticContextObserver, type Correlation, type SpanAttrs, type TraceAttrs,
} from './telemetry-metadata.ts';
import { logs } from '@opentelemetry/api-logs';
import type { LoggerProvider } from '@opentelemetry/sdk-logs';
import { moduleJournal } from './journal.ts';
import {
  aiSdkSpans, CorrelationSpanProcessor, createExtraOtlpSpanProcessor, createLogsProvider, createMetricReader, createOtlpSpanProcessor, createSpanScrubber,
  ExportFailure, extraOtlpTracesConfig, otlpTracesConfigured, parseCostRates, ScrubbingSpanProcessor, tagFailures, traceResource,
  type CostRates,
} from './telemetry-export.ts';
export type { ConversationSource, SpanAttrs, TraceAttrs } from './telemetry-metadata.ts';
export { observabilityEnvironment } from './telemetry-export.ts';

/**
 * The one observability context every surface injects. Server turn paths
 * build it from domain values and convert it to trace attrs; the browser
 * mirrors the shape for session signals (its own copy lives in
 * `apps/ui-v2/src/features/metrics/` because ui-v2 takes zero workspace
 * imports); the Cardputer speaks it as `session_id` + `turn_ref` on the wire
 * (`voice/protocol.ts`).
 *
 * Values are identifiers and short labels only -- never user text, prompts,
 * replies, audio, credentials, or URLs.
 */
export type BobSurface = 'device' | 'web' | 'invocation' | 'firmware' | 'pairing' | 'delivery';

/**
 * The common placeholder: what a turn, milestone, or signal joins on.
 * `sessionId` is the CLIENT session (device: the WebSocket session id; web: the
 * per-tab id) and `conversationId` the canonical conversation id; the three of
 * user, conversation and session are independent. `turnId` is the journal `turn_id`
 * (the device's `turn_ref`); `metadata` carries short dimensions only
 * (`interface`, `action`, `board`, `result`, `fw_version`).
 */
export interface ObservabilityContext extends Pick<Correlation, 'turnId' | 'sessionId' | 'conversationId' | 'conversationSource' | 'userId' | 'metadata'> {
  surface: BobSurface;
  /** Server-owned execution namespace; wire turn refs need not be globally unique. */
  workflowNamespace?: string;
  /** One validated execution shared by separate voice requests. */
  workflowId?: string;
}

const CONTEXT_IDS = ['sessionId', 'conversationId', 'conversationSource', 'turnId', 'userId'] as const;

/** Trace name per turn surface: one trace per turn, named by its surface. */
const SURFACE_TRACE_NAME: Record<'device' | 'web' | 'invocation', string> = {
  device: 'device-turn',
  web: 'web-chat-turn',
  invocation: 'thread-invocation',
};

/**
 * Converts a turn context to trace attrs. `turnId` stays first-class and is
 * exported as `bob.turn.id` (the journal key). Only turn surfaces convert:
 * milestones use `toSpanAttrs`.
 */
export function toTraceAttrs(context: ObservabilityContext & { surface: 'device' | 'web' | 'invocation' }): TraceAttrs {
  return {
    traceName: SURFACE_TRACE_NAME[context.surface],
    tags: [context.surface],
    ...pickDefined(context, CONTEXT_IDS),
    ...pickDefined(context, ['metadata']),
  };
}

/** Converts any context to milestone span attrs. Stamps `turnId` into metadata
 *  as `turn_id` (the journal key) so milestones join traces; an explicit
 *  caller `turn_id` wins. */
export function toSpanAttrs(context: ObservabilityContext): SpanAttrs {
  const attrs: SpanAttrs = {
    ...pickDefined(context, CONTEXT_IDS),
    ...pickDefined(context, ['workflowNamespace', 'workflowId']),
    tags: [context.surface],
  };
  if (context.turnId !== undefined || context.metadata !== undefined) {
    attrs.metadata = {
      ...(context.turnId !== undefined ? { turn_id: context.turnId } : {}),
      ...context.metadata,
    };
  }
  return attrs;
}

const hasPrimaryTraces = otlpTracesConfigured();
const extraTraces = extraOtlpTracesConfig();
const hasOtlpTraces = hasPrimaryTraces || extraTraces !== undefined;

/** Telemetry settings applied to the ToolLoopAgent. Metadata-only unless BOB_TRACE_PAYLOAD=1 enables prompt and reply capture. */
export const agentTelemetry: TelemetryOptions = {
  isEnabled: hasOtlpTraces,
  functionId: 'bob-agent',
  recordInputs: BOB_TRACE_PAYLOAD,
  recordOutputs: BOB_TRACE_PAYLOAD,
};

let initialized = false;
let exporters: ScrubbingSpanProcessor | undefined;
let logsProvider: LoggerProvider | undefined;
let tracingReady = false;
const workflowIds = new AsyncLocalStorage<string>();
const tracer = () => trace.getTracer('bob');

/** Retain a workflow for transport completion callbacks without opening a span. */
export function bindDiagnosticContext<T>(fn: () => T): () => T {
  if (!tracingReady) return fn;
  try {
    const captured = context.active();
    const workflow = workflowIds.getStore();
    return () => {
      let invoked = false;
      const run = (): T => { invoked = true; return fn(); };
      try {
        return context.with(captured, () => workflow === undefined ? workflowIds.exit(run) : workflowIds.run(workflow, run));
      } catch (error) {
        if (invoked) throw error;
        return fn();
      }
    };
  } catch {
    return fn;
  }
}

/** Registers the OTLP log bridge: `OTEL_LOGS_EXPORTER=otlp` plus an endpoint, and/or the extra BOB_OTLP_EXTRA_LOGS_* destination. */
function startLogs(): void {
  try {
    logsProvider = createLogsProvider();
    if (logsProvider !== undefined) logs.setGlobalLoggerProvider(logsProvider);
  } catch {
    logsProvider = undefined;
    reportTelemetryError('logs_init_failed');
  }
}

/** The versioned rate snapshot in BOB_COST_RATES (JSON). An invalid one is reported by kind only and prices nothing. */
function configuredCostRates(): CostRates | undefined {
  try {
    return parseCostRates(process.env.BOB_COST_RATES);
  } catch {
    reportTelemetryError('cost_rates_invalid');
    return undefined;
  }
}

/** Starts tracing once when a standard OTLP endpoint is configured; otherwise a silent no-op. Call before any agent. */
export function initTelemetry(): void {
  if (initialized) return;
  initialized = true;
  startLogs();
  const reader = createMetricReader(process.env, { report: reportTelemetryError });
  if (!hasOtlpTraces && reader === undefined) return;
  try {
    const resource = traceResource(process.env);
    if (reader !== undefined) initObservationMetrics({ reader, resource }, reportTelemetryError);
    if (!hasOtlpTraces) return;
    // Primary first, then the optional extra destination: both receive the same scrubbed span.
    const processor = new ScrubbingSpanProcessor(createSpanScrubber(BOB_TRACE_PAYLOAD), [
      new CorrelationSpanProcessor(configuredCostRates()),
      ...(hasPrimaryTraces ? [tagFailures(createOtlpSpanProcessor(), 'otlp_flush_failed')] : []),
      ...(extraTraces !== undefined ? [tagFailures(createExtraOtlpSpanProcessor(extraTraces), 'otlp_extra_flush_failed')] : []),
    ]);
    new NodeSDK({
      // Default detectors include OS username, host identifiers and argv; metric and log
      // readers come only from our own wiring, never from NodeSDK's env defaults.
      autoDetectResources: false, resource, metricReaders: [], logRecordProcessors: [],
      spanProcessors: [processor],
      idGenerator: {
        generateTraceId: () => workflowIds.getStore() ?? randomBytes(16).toString('hex'),
        generateSpanId: () => randomBytes(8).toString('hex'),
      },
    }).start();
    registerTelemetry(aiSdkSpans());
    exporters = processor;
    tracingReady = true;
  } catch {
    tracingReady = false;
    reportTelemetryError('telemetry_init_failed');
  }
}

/**
 * Runs `fn` with per-turn trace attributes attached to every span started
 * inside it (stamped by `CorrelationSpanProcessor`). A passthrough when
 * tracing is not initialized, so call sites need no config checks. Undefined
 * values never overwrite: an unpaired device turn has no user, and a missing
 * session must not arrive as the string "undefined".
 */
export function withTraceContext<T>(attrs: TraceAttrs, fn: () => T): T {
  if (!tracingReady) return fn();
  return context.with(context.active().setValue(TRACE_ATTRS_KEY, mergeTraceAttrs(activeTraceAttrs(), attrs)), fn);
}

/**
 * Attributes the work after identity is known: stamps the active span (the request root opened
 * before auth) and every span started inside `fn`. A passthrough when tracing is not initialized.
 */
export function withCorrelation<T>(attrs: TraceAttrs, fn: () => T): T {
  if (!tracingReady) return fn();
  try { trace.getActiveSpan()?.setAttributes(traceAttributes(attrs)); } catch { /* Correlation is best effort. */ }
  return withTraceContext(attrs, fn);
}

/**
 * Deterministic workflow trace id from a stable seed. Same seed, same
 * trace: the device turn_ref, the web turn id, or the session id all
 * resolve to the one trace that carries the whole workflow, and the id
 * can be regenerated later for signals given only the external id.
 */
export async function workflowTraceId(attrs: SpanAttrs): Promise<string | null> {
  if (!tracingReady) return null;
  const seed = workflowSeed(attrs);
  return seed === null ? null : traceIdFromSeed(`bob/v1/${seed}`);
}

/** Seed real roots without inventing a parent span. OTel nests active children. */
function inWorkflow<T>(attrs: SpanAttrs, run: () => T): T {
  if (workflowIds.getStore() !== undefined || workflowSeed(attrs) === null) return run();
  return workflowIds.run(traceIdFromSeed(`bob/v1/${workflowSeed(attrs)}`), run);
}

/** Seed priority: the execution namespace, else the turn ref, else null (random trace). The session only correlates. */
function workflowSeed(attrs: SpanAttrs): string | null {
  if (attrs.workflowNamespace !== undefined) return `execution/${JSON.stringify([attrs.workflowNamespace, attrs.workflowId ?? attrs.turnId ?? null])}`;
  if (attrs.turnId !== undefined) return `turn/${attrs.turnId}`;
  return null;
}

export function withDetachedTelemetryContext<T>(fn: () => T): T {
  return withDiagnosticContextObserver(undefined, () => workflowIds.exit(() => context.with(ROOT_CONTEXT, fn)));
}

function captureSeededContext(attrs: SpanAttrs): void {
  if (workflowSeed(attrs) !== null) captureDiagnosticWorkflowContext();
}

/** The correlation a span contributes to its descendants. */
function ownTraceAttrs(attrs: SpanAttrs, traceName: string | undefined): TraceAttrs {
  const own: TraceAttrs = { ...pickDefined(attrs, CORRELATION_KEYS), ...(traceName !== undefined ? { traceName } : {}) };
  if (attrs.turnId !== undefined || attrs.metadata !== undefined) {
    own.metadata = { ...attrs.metadata, ...(attrs.turnId !== undefined ? { turn_id: attrs.turnId } : {}) };
  }
  return own;
}

/** The context a span starts in: a valid upstream `traceparent` only when no workflow seed or active workflow decides the trace. */
function startContext(spanName: string, attrs: SpanAttrs): Context {
  const active = activeTraceAttrs();
  let base = context.active();
  const parent = workflowSeed(attrs) === null && workflowIds.getStore() === undefined ? parseTraceparent(attrs.traceparent) : undefined;
  if (parent !== undefined) base = trace.setSpanContext(ROOT_CONTEXT, { ...parent, isRemote: true });
  const traceName = attrs.traceName ?? (workflowIds.getStore() === undefined && spanName !== '' ? spanName : undefined);
  const own = ownTraceAttrs(attrs, traceName);
  return base.setValue(TRACE_ATTRS_KEY, mergeTraceAttrs(active, own));
}

function observeSpan<T>(name: string, attrs: SpanAttrs, ctx: Context, run: () => Promise<T>): Promise<T> {
  const options: SpanOptions = {
    attributes: { 'bob.observation.type': attrs.observationType ?? 'span' },
    ...(attrs.startTime ? { startTime: attrs.startTime } : {}),
  };
  return tracer().startActiveSpan(name, options, ctx, async (span: Span) => {
    captureSeededContext(attrs);
    try {
      return await run();
    } catch (error) {
      // Never let the SDK capture raw exception messages or payloads.
      try { span.setStatus({ code: SpanStatusCode.ERROR, message: 'workflow_failed' }); } catch { /* best effort */ }
      throw error;
    } finally {
      try { span.end(); } catch { /* best effort */ }
    }
  });
}

/** Resolves a user's active conversation (canonical id), for work done on their behalf with no conversation of its own. */
export type ActiveConversationResolver = (userId: string) => Promise<string | undefined>;
let activeConversation: ActiveConversationResolver | undefined;

/** Installs the one background-correlation mechanism: a span with a user and no conversation joins the user's active one (source `active`). */
export function setActiveConversationResolver(resolve: ActiveConversationResolver | undefined): void {
  activeConversation = resolve;
}

/**
 * The attrs, or a promise of them carrying the user's active conversation when the user is known and the conversation is not.
 * A caller that already knows there is none says so with `conversationSource: 'none'` and skips the lookup.
 */
function withActiveConversation(attrs: SpanAttrs): SpanAttrs | Promise<SpanAttrs> {
  const inherited = activeTraceAttrs();
  const userId = attrs.userId ?? inherited.userId;
  if (activeConversation === undefined || userId === undefined) return attrs;
  if ((attrs.conversationId ?? inherited.conversationId) !== undefined || (attrs.conversationSource ?? inherited.conversationSource) !== undefined) return attrs;
  return activeConversation(userId).then(
    (conversationId) => (conversationId === undefined ? attrs : { ...attrs, conversationId, conversationSource: 'active' as const }),
    () => attrs,
  );
}

export async function traceSpan<T>(spanName: string, attrs: SpanAttrs, fn: () => T | Promise<T>): Promise<T> {
  if (!tracingReady) return fn();
  if (attrs.detached) return withDetachedTelemetryContext(() => traceSpan(spanName, { ...attrs, detached: false }, fn));
  // A span-infrastructure failure runs the work bare; a failure inside fn
  // propagates exactly as without the span (never retried, never swallowed).
  let work: Promise<T> | undefined;
  try {
    const resolved = withActiveConversation(attrs);
    if (resolved !== attrs) attrs = await resolved;
    const ctx = startContext(spanName, attrs);
    await inWorkflow(attrs, () => observeSpan(spanName, attrs, ctx, async () => {
      work = Promise.resolve().then(fn);
      await work;
    })).catch(() => undefined);
  } catch {
    // Infrastructure may fail before or after starting work; never retry it.
  }
  return work === undefined ? fn() : work;
}

/** A span opened now and ended later: `run` executes work inside it, `end` closes it once (ERROR / workflow_failed when `failed`). */
export interface OpenSpan {
  run<T>(fn: () => T): T;
  end(failed?: boolean): void;
}

const NO_SPAN: OpenSpan = { run: (fn) => fn(), end: () => undefined };

/**
 * A long-lived, detached root span with the same attrs and workflow seed as `traceSpan`, for work that
 * spans several requests (a device turn). A no-op handle when tracing is off or the span cannot start.
 */
export function openSpan(spanName: string, attrs: SpanAttrs): OpenSpan {
  if (!tracingReady) return NO_SPAN;
  try {
    return withDetachedTelemetryContext(() => inWorkflow(attrs, () => {
      const ctx = startContext(spanName, attrs);
      const span = tracer().startSpan(spanName, {
        attributes: { 'bob.observation.type': attrs.observationType ?? 'span' },
        ...(attrs.startTime ? { startTime: attrs.startTime } : {}),
      }, ctx);
      const spanContext = trace.setSpan(ctx, span);
      const workflow = workflowIds.getStore();
      let ended = false;
      return {
        run: (fn) => context.with(spanContext, () => (workflow === undefined ? workflowIds.exit(fn) : workflowIds.run(workflow, fn))),
        end(failed = false): void {
          if (ended) return;
          ended = true;
          try {
            if (failed) span.setStatus({ code: SpanStatusCode.ERROR, message: 'workflow_failed' });
            span.end();
          } catch { /* best effort */ }
        },
      };
    }));
  } catch {
    return NO_SPAN;
  }
}

/**
 * Billable usage the AI SDK never reports: TTS input characters and STT audio
 * seconds, as attributes on the active speech wrapper span (`speech-*-provider`;
 * the SDK child has already ended), units only -- never input or output text; no
 * span of its own, and nothing when none is active. A no-op without OTLP config,
 * and never throws into synthesis. The exporter prices them from BOB_COST_RATES.
 */
export interface SpeechUsage {
  kind: 'tts' | 'stt';
  model: string;
  /** Characters for TTS, seconds for STT. */
  inputUnits: number;
  /** Joins the workflow trace when the caller knows it. */
  turnId?: string;
  sessionId?: string;
}

export async function traceSpeechUsage(usage: SpeechUsage): Promise<void> {
  if (!tracingReady) return;
  try {
    // No span of its own: the active span is the speech wrapper, since the SDK's ai.transcribe / ai.generateSpeech child has ended.
    trace.getActiveSpan()?.setAttributes({
      'gen_ai.request.model': usage.model,
      'bob.speech.input_units': usage.inputUnits,
    });
  } catch {
    // Usage telemetry must never fail synthesis.
  }
}

/** Traces one evaluation-model call (the memory gate) as an `evaluator` span; the score is always recorded, the input only with BOB_TRACE_PAYLOAD=1. */
export function traceEvaluation(name: string, model: string, input: string, run: () => Promise<number>, userId?: string): Promise<number> {
  if (!tracingReady) return run();
  const observe = (): Promise<number> => tracer().startActiveSpan(name, {
    attributes: { 'bob.observation.type': 'evaluator', 'gen_ai.request.model': model, ...metadataAttributes({ model }) },
  }, async (span: Span): Promise<number> => {
    try {
      const score = await run();
      span.setAttribute('bob.evaluation.score', score);
      if (BOB_TRACE_PAYLOAD) span.setAttribute('bob.evaluation.input', input);
      return score;
    } catch (error) {
      try { span.setStatus({ code: SpanStatusCode.ERROR, message: 'workflow_failed' }); } catch { /* best effort */ }
      throw error;
    } finally {
      span.end();
    }
  });
  return userId === undefined ? observe() : withTraceContext({ userId }, observe);
}

/** Flushes buffered spans and metrics; a failure is reported once per kind and never thrown, so export never delays or fails a reply. */
export async function flushTelemetry(): Promise<void> {
  if (exporters !== undefined) {
    try {
      await exporters.forceFlush();
    } catch (error) {
      for (const failure of error instanceof AggregateError ? error.errors : [error]) {
        reportTelemetryError(failure instanceof ExportFailure ? failure.kind : 'otlp_flush_failed');
      }
    }
  }
  await flushLogs();
  await flushObservationMetrics();
}

async function flushLogs(): Promise<void> {
  try {
    await logsProvider?.forceFlush();
  } catch (error) {
    for (const failure of error instanceof AggregateError ? error.errors : [error]) {
      reportTelemetryError(failure instanceof ExportFailure ? failure.kind : 'logs_flush_failed');
    }
  }
}

type TelemetryErrorListener = (kind: string) => void;

const listeners = new Set<TelemetryErrorListener>();
const reportedKinds = new Set<string>();

function defaultTelemetryErrorListener(kind: string): void {
  moduleJournal('ai', 'ai')('v2.telemetry_export_failed', { kind });
}

/** Subscribes to export failures so the API can journal them; each kind is reported once per process. Returns an unsubscribe function. */
export function onTelemetryError(listener: TelemetryErrorListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function reportTelemetryError(kind: string): void {
  if (reportedKinds.has(kind)) return;
  reportedKinds.add(kind);
  for (const listener of listeners.size > 0 ? [...listeners] : [defaultTelemetryErrorListener]) {
    try { listener(kind); } catch { /* A listener must never break the agent call. */ }
  }
}
