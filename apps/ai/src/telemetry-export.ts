/**
 * Provider-free span export for telemetry.ts: the backend is chosen only by the
 * standard OTEL_* variables (or a collector in front of it), plus an optional
 * second OTLP traces destination from BOB_OTLP_EXTRA_TRACES_*. One privacy
 * scrub runs once per ended span, then the same span reaches every exporter.
 */
import { OpenTelemetry } from '@ai-sdk/otel';
import { BatchSpanProcessor, type ReadableSpan, type Span, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import {
  AggregationTemporality, MetricReader, PeriodicExportingMetricReader,
  type AggregationTemporalitySelector, type MetricProducer, type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordExporter, type LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Context, Tracer } from '@opentelemetry/api';
import { z } from 'zod';
import { activeTraceAttrs, conversationAttributes, SAFE_METADATA, traceAttributes } from './telemetry-metadata.ts';

/** Deployment environment every backend filters on. */
export function observabilityEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return env.BOB_PRODUCTION === '1' ? 'production' : 'development';
}

const hasValue = (value: string | undefined): boolean => (value ?? '').trim() !== '';

/** True when a standard OTLP traces endpoint is configured and not switched off. */
export function otlpTracesConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const endpoint = hasValue(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) || hasValue(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  return endpoint && (env.OTEL_TRACES_EXPORTER ?? '').trim() !== 'none';
}

/** Metrics export needs an OTLP endpoint and an exporter that is unset or `otlp`; `none` disables it. */
export function otlpMetricsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const exporter = (env.OTEL_METRICS_EXPORTER ?? '').trim();
  const endpoint = hasValue(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) || hasValue(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  return endpoint && (exporter === '' || exporter === 'otlp');
}

function resourceEnvironment(env: NodeJS.ProcessEnv): string {
  for (const pair of (env.OTEL_RESOURCE_ATTRIBUTES ?? '').split(',')) {
    const [key, ...rest] = pair.split('=');
    const value = rest.join('=').trim();
    if (key?.trim() === 'deployment.environment.name' && value !== '') return value;
  }
  return observabilityEnvironment(env);
}

/** Service identity only: no host, user or argv detection. */
export function traceResource(env: NodeJS.ProcessEnv) {
  return resourceFromAttributes({
    'service.name': env.OTEL_SERVICE_NAME || 'bob',
    ...(env.OTEL_SERVICE_VERSION ? { 'service.version': env.OTEL_SERVICE_VERSION } : {}),
    'deployment.environment.name': resourceEnvironment(env),
  });
}

/** Reads the endpoint, protocol and headers from the standard OTEL_EXPORTER_OTLP_* variables. */
export function createOtlpSpanProcessor(): SpanProcessor {
  return new BatchSpanProcessor(new OTLPTraceExporter());
}

/** An optional second OTLP destination (traces or logs), set by configuration only. */
export interface ExtraOtlpConfig {
  url: string;
  headers: Record<string, string>;
}

function decodeHeaderValue(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** `k=v,k2=v2` as in OTEL_EXPORTER_OTLP_HEADERS: split on the first `=`, so a value may contain `=`; values are URL-decoded. */
function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const at = pair.indexOf('=');
    const name = at < 0 ? '' : pair.slice(0, at).trim();
    if (name !== '') headers[name] = decodeHeaderValue(pair.slice(at + 1).trim());
  }
  return headers;
}

function extraOtlpConfig(endpoint: string | undefined, headers: string | undefined): ExtraOtlpConfig | undefined {
  const url = (endpoint ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return undefined;
  return { url, headers: parseHeaders(headers) };
}

/** Undefined unless the endpoint is a full http(s) traces URL. Neither the URL nor the headers are ever logged. */
export function extraOtlpTracesConfig(env: NodeJS.ProcessEnv = process.env): ExtraOtlpConfig | undefined {
  return extraOtlpConfig(env.BOB_OTLP_EXTRA_TRACES_ENDPOINT, env.BOB_OTLP_EXTRA_TRACES_HEADERS);
}

/** Undefined unless the endpoint is a full http(s) logs URL. Neither the URL nor the headers are ever logged. */
export function extraOtlpLogsConfig(env: NodeJS.ProcessEnv = process.env): ExtraOtlpConfig | undefined {
  return extraOtlpConfig(env.BOB_OTLP_EXTRA_LOGS_ENDPOINT, env.BOB_OTLP_EXTRA_LOGS_HEADERS);
}

/** The extra destination's exporter options: gzip, since it is reached over public HTTPS. */
function extraExporterOptions(config: ExtraOtlpConfig) {
  return { url: config.url, headers: config.headers, compression: CompressionAlgorithm.GZIP };
}

export function createExtraOtlpSpanProcessor(config: ExtraOtlpConfig): SpanProcessor {
  return new BatchSpanProcessor(new OTLPTraceExporter(extraExporterOptions(config)));
}

/** Undefined unless the endpoint is a full http(s) metrics URL. Neither the URL nor the headers are ever logged. */
export function extraOtlpMetricsConfig(env: NodeJS.ProcessEnv = process.env): ExtraOtlpConfig | undefined {
  return extraOtlpConfig(env.BOB_OTLP_EXTRA_METRICS_ENDPOINT, env.BOB_OTLP_EXTRA_METRICS_HEADERS);
}

export interface MetricReaderOptions {
  /** Told `otlp_extra_metrics_flush_failed` when the extra destination rejects an export. */
  report?: (kind: string) => void;
  /** Substitute exporters, for tests. */
  exporters?: { primary?: PushMetricExporter; extra?: PushMetricExporter };
}

/** Reports a failed export as it happens: the SDK swallows exporter errors. ExportResultCode.SUCCESS is 0. */
function reportingExporter(exporter: PushMetricExporter, onFailure: () => void): PushMetricExporter {
  return Object.create(exporter, {
    export: {
      value: (metrics: Parameters<PushMetricExporter['export']>[0], done: Parameters<PushMetricExporter['export']>[1]) =>
        exporter.export(metrics, (result) => { if (result.code !== 0) onFailure(); done(result); }),
    },
  }) as PushMetricExporter;
}

/**
 * One MetricReader for the MeterProvider that drives one periodic reader per destination; a failing extra never fails the primary.
 * The readers share this reader's collector, so its temporality is the one every destination receives.
 */
class FanOutMetricReader extends MetricReader {
  constructor(private readonly primary: MetricReader[], private readonly extra: MetricReader[], aggregationTemporalitySelector?: AggregationTemporalitySelector) {
    super(aggregationTemporalitySelector ? { aggregationTemporalitySelector } : undefined);
  }

  override setMetricProducer(producer: MetricProducer): void {
    super.setMetricProducer(producer);
    for (const reader of [...this.primary, ...this.extra]) reader.setMetricProducer(producer);
  }

  protected async onForceFlush(): Promise<void> {
    const [primary] = await Promise.all([
      Promise.allSettled(this.primary.map((reader) => reader.forceFlush())),
      // The extra destination reports its own failures (reportingExporter); they never reach the caller.
      Promise.allSettled(this.extra.map((reader) => reader.forceFlush())),
    ]);
    const failed = primary.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }

  protected async onShutdown(): Promise<void> {
    const settled = await Promise.allSettled([...this.primary, ...this.extra].map((reader) => reader.shutdown()));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }
}

/**
 * Metrics reach each configured destination through its own reader: the primary (standard OTEL_METRICS_EXPORTER=otlp
 * plus an endpoint) and the optional extra from BOB_OTLP_EXTRA_METRICS_*. OTEL_METRIC_EXPORT_INTERVAL applies to both.
 * Undefined when neither is configured.
 */
export function createMetricReader(env: NodeJS.ProcessEnv = process.env, options: MetricReaderOptions = {}): MetricReader | undefined {
  const extra = extraOtlpMetricsConfig(env);
  const primaryOn = otlpMetricsConfigured(env);
  if (!primaryOn && extra === undefined) return undefined;
  const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
  const periodic = (exporter: PushMetricExporter) => new PeriodicExportingMetricReader({
    exporter,
    ...(Number.isFinite(interval) && interval > 0 ? { exportIntervalMillis: interval } : {}),
  });
  const primary = primaryOn ? [periodic(options.exporters?.primary ?? new OTLPMetricExporter())] : [];
  if (extra === undefined) return primary[0];
  const extraExporter = options.exporters?.extra ?? new OTLPMetricExporter(extraExporterOptions(extra));
  const extraReader = periodic(reportingExporter(extraExporter, () => options.report?.('otlp_extra_metrics_flush_failed')));
  // When the extra is the only destination (production), delta: each export carries only the series recorded since the last one.
  return new FanOutMetricReader(primary, [extraReader], primaryOn ? undefined : () => AggregationTemporality.DELTA);
}

/** Log export is explicit: OTEL_LOGS_EXPORTER=otlp plus an OTLP endpoint. Unset or `none` keeps stdout only. */
export function otlpLogsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const endpoint = hasValue(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) || hasValue(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  return endpoint && (env.OTEL_LOGS_EXPORTER ?? '').trim() === 'otlp';
}

/** A flush or shutdown failure labelled with the backend that caused it. */
export class ExportFailure extends Error {
  constructor(readonly kind: string, cause: unknown) {
    super(kind, { cause });
  }
}

/** One batch processor per destination. The SDK swallows exporter errors, so a failed export is remembered and the next flush throws it, labelled with the destination. */
function logProcessor(exporter: LogRecordExporter, kind: string): LogRecordProcessor {
  let failed = false;
  const batch = new BatchLogRecordProcessor({
    exporter: {
      // ExportResultCode.SUCCESS is 0.
      export: (records, done) => exporter.export(records, (result) => { if (result.code !== 0) failed = true; done(result); }),
      forceFlush: () => exporter.forceFlush(),
      shutdown: () => exporter.shutdown(),
    },
  });
  const settle = async (run: () => Promise<void>): Promise<void> => {
    try { await run(); } catch (error) { throw new ExportFailure(kind, error); }
    if (failed) {
      failed = false;
      throw new ExportFailure(kind, new Error('log export failed'));
    }
  };
  return {
    onEmit: (record) => batch.onEmit(record),
    forceFlush: () => settle(() => batch.forceFlush()),
    shutdown: () => settle(() => batch.shutdown()),
  };
}

/**
 * The provider behind journal()'s OTel log bridge: the primary (standard OTEL_* variables) and the optional
 * extra destination each get their own batch processor, so one failing backend never stops the other.
 * Undefined when neither is configured. `exporter` substitutes the primary exporter, for tests.
 */
export function createLogsProvider(env: NodeJS.ProcessEnv = process.env, exporter?: LogRecordExporter): LoggerProvider | undefined {
  const extra = extraOtlpLogsConfig(env);
  const processors: LogRecordProcessor[] = [
    ...(otlpLogsConfigured(env) ? [logProcessor(exporter ?? new OTLPLogExporter(), 'logs_flush_failed')] : []),
    ...(extra !== undefined
      ? [logProcessor(new OTLPLogExporter(extraExporterOptions(extra)), 'otlp_extra_logs_flush_failed')]
      : []),
  ];
  return processors.length === 0 ? undefined : new LoggerProvider({ resource: traceResource(env), processors });
}

export function tagFailures(processor: SpanProcessor, kind: string): SpanProcessor {
  const tag = async (run: () => Promise<void>): Promise<void> => {
    try { await run(); } catch (error) { throw new ExportFailure(kind, error); }
  };
  return {
    onStart: (span: Span, parentContext: Context) => processor.onStart(span, parentContext),
    onEnd: (span: ReadableSpan) => processor.onEnd(span),
    forceFlush: () => tag(() => processor.forceFlush()),
    shutdown: () => tag(() => processor.shutdown()),
  };
}

/**
 * The AI SDK's span integration. Each span also carries its SDK role as `bob.ai.span_type`
 * (`operation` for the whole call, `languageModel`/`embedding` for each provider call, `step`, `tool`)
 * and its `ai.operationId`: an embed is an `operation` span over an `embedding` span with the same
 * name, and only the inner one carries usage, so counting calls needs the role.
 */
export function aiSdkSpans(tracer?: Tracer): OpenTelemetry {
  return new OpenTelemetry({
    ...(tracer ? { tracer } : {}),
    enrichSpan: ({ spanType, operationId }) => ({ 'bob.ai.span_type': spanType, 'ai.operationId': operationId }),
  });
}

/** The AI SDK reports every provider call as `chat`; its operation id says which speech call a span really is. */
const SPEECH_OPERATIONS: Array<[RegExp, string]> = [
  [/^ai\.transcribe(\.|$|\s)/, 'transcription'],
  [/^ai\.generateSpeech(\.|$|\s)/, 'text_to_speech'],
];

/** The label a speech span carries, found by its operation id (or name); only `ai.` ids can be speech. */
function speechOperation(span: ReadableSpan): string | undefined {
  const id = String(span.attributes['ai.operationId'] ?? span.name);
  return id.startsWith('ai.') ? SPEECH_OPERATIONS.find(([pattern]) => pattern.test(id))?.[1] : undefined;
}

/** Any `gen_ai.*` attribute besides the conversation id (which every span carries) makes OpenObserve treat a span as AI. */
function isAiSpan(attributes: ReadableSpan['attributes']): boolean {
  return Object.keys(attributes).some((key) => key.startsWith('gen_ai.') && key !== 'gen_ai.conversation.id');
}

const NO_CONVERSATION_ATTRIBUTES = Object.freeze(conversationAttributes(undefined, undefined));
const COST_KEY = 'gen_ai.usage.cost';
const TOKEN_KEYS = ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.total_tokens'];

/** A zero or -0 cost on a span that used no tokens is noise, not a price. */
function dropEmptyCosts(attributes: ReadableSpan['attributes']): void {
  if (TOKEN_KEYS.some((key) => typeof attributes[key] === 'number' && attributes[key] !== 0)) return;
  for (const key of Object.keys(attributes)) {
    if (key.startsWith(COST_KEY) && attributes[key] === 0) delete attributes[key];
  }
}

const COST_UNITS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'audio_seconds', 'characters'] as const;
type CostUnit = (typeof COST_UNITS)[number];
type CostStatus = 'complete' | 'partial' | 'unknown';
const COST_STATUSES = new Set<unknown>(['complete', 'partial', 'unknown']);
const RATES_VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const PRICING_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return PRICING_DATE.test(value) && !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

const costRatesSchema = z.object({
  version: z.string().regex(RATES_VERSION),
  pricingDate: z.string().refine(isCalendarDate),
  currency: z.string().regex(CURRENCY),
  rates: z.array(z.object({
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
    unit: z.enum(COST_UNITS),
    perUnit: z.number().finite().nonnegative(),
  }).strict()).max(512),
}).strict();

/** One versioned rate snapshot: every estimate names its version, pricing date and currency. */
export interface CostRates {
  version: string;
  pricingDate: string;
  currency: string;
  /** Price per unit, by provider, model and unit. */
  prices: ReadonlyMap<string, number>;
}

const rateKey = (provider: string, model: string, unit: CostUnit): string => JSON.stringify([provider, model, unit]);

/** Parses a configured rate snapshot (JSON). Nothing configured prices nothing; an invalid one throws, and its raw value is never logged. */
export function parseCostRates(raw: string | undefined): CostRates | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const snapshot = costRatesSchema.parse(JSON.parse(raw));
  const prices = new Map<string, number>();
  for (const rate of snapshot.rates) {
    const key = rateKey(rate.provider, rate.model, rate.unit);
    if (prices.has(key)) throw new Error('Duplicate cost rate');
    prices.set(key, rate.perUnit);
  }
  return { version: snapshot.version, pricingDate: snapshot.pricingDate, currency: snapshot.currency, prices };
}

/** The usage one provider call reported, and whether it reported every billable unit. */
interface ProviderUsage {
  provider: string;
  model: string;
  units: Partial<Record<CostUnit, number>>;
  reported: boolean;
}

const quantity = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

/** Speech usage is set on the wrapper after its SDK child ends, so the wrapper is the one billable speech call. */
const SPEECH_CALLS = new Map<string, CostUnit>([['speech-stt-provider', 'audio_seconds'], ['speech-tts-provider', 'characters']]);

/** STT audio seconds come from the provider; TTS characters are counted locally, never reported, so they are never complete. */
function speechUsage(attributes: ReadableSpan['attributes'], unit: CostUnit): Pick<ProviderUsage, 'units' | 'reported'> {
  const units = quantity(attributes['bob.speech.input_units']);
  return { units: units === undefined ? {} : { [unit]: units }, reported: unit === 'audio_seconds' && units !== undefined };
}

/** The SDK's input count includes cache reads and writes; only the rest is uncached input. */
function tokenUsage(attributes: ReadableSpan['attributes'], embedding: boolean): Pick<ProviderUsage, 'units' | 'reported'> {
  const input = quantity(attributes['gen_ai.usage.input_tokens']);
  const read = quantity(attributes['gen_ai.usage.cache_read.input_tokens']) ?? 0;
  const write = quantity(attributes['gen_ai.usage.cache_creation.input_tokens']) ?? 0;
  const output = quantity(attributes['gen_ai.usage.output_tokens']);
  const units: ProviderUsage['units'] = {};
  if (input !== undefined && read + write <= input) units.input_tokens = input - read - write;
  if (read > 0) units.cache_read_tokens = read;
  if (write > 0) units.cache_write_tokens = write;
  if (output !== undefined) units.output_tokens = output;
  return { units, reported: units.input_tokens !== undefined && (embedding || output !== undefined) };
}

/** Only provider calls bill: an SDK `operation` parent repeats its calls' usage, and the SDK speech child carries none. */
function providerUsage(span: ReadableSpan): ProviderUsage | undefined {
  const attributes = span.attributes;
  const speechUnit = SPEECH_CALLS.get(span.name);
  const role = attributes['bob.ai.span_type'];
  if (speechUnit === undefined && role !== 'languageModel' && role !== 'embedding') return undefined;
  const model = String(attributes['gen_ai.request.model'] ?? attributes['ai.model.id'] ?? '');
  // Gateway model ids carry their provider before the '/'.
  const slash = model.indexOf('/');
  const provider = slash > 0 ? model.slice(0, slash) : String(attributes['gen_ai.provider.name'] ?? '');
  const usage = speechUnit === undefined ? tokenUsage(attributes, role === 'embedding') : speechUsage(attributes, speechUnit);
  return { provider, model, ...usage };
}

/** Unknown usage or price stays unknown: no estimate unless a unit is priced, and complete only when every unit is. */
function priceUsage(usage: ProviderUsage, rates: CostRates | undefined): { status: CostStatus; estimate?: number } {
  let estimate = 0;
  let priced = 0;
  let unpriced = 0;
  for (const unit of COST_UNITS) {
    const units = usage.units[unit];
    if (units === undefined) continue;
    const rate = rates?.prices.get(rateKey(usage.provider, usage.model, unit));
    if (rate === undefined) unpriced += 1;
    else { priced += 1; estimate += units * rate; }
  }
  if (priced === 0 || !Number.isFinite(estimate)) return { status: 'unknown' };
  return { status: unpriced === 0 && usage.reported ? 'complete' : 'partial', estimate };
}

function snapshotAttributes(rates: CostRates): Record<string, string> {
  return { 'bob.cost.currency': rates.currency, 'bob.cost.rates_version': rates.version, 'bob.cost.pricing_date': rates.pricingDate };
}

interface TraceCost { calls: number; complete: number; priced: number; estimate: number }
/** Roots not yet ended, and open spans' roots; the oldest is dropped past these, so an unended root cannot grow memory. */
const MAX_OPEN_COST_ROOTS = 256;
const MAX_OPEN_SPANS = 4096;

/** The local root of a trace: no parent, or a parent in another process. */
function isLocalRoot(span: ReadableSpan): boolean {
  return span.parentSpanContext === undefined || span.parentSpanContext.isRemote === true;
}

function boundedSet<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  if (map.size >= max) map.delete(map.keys().next().value ?? '');
  map.set(key, value);
}

/**
 * Prices each provider-call span from the rate snapshot, once, and stamps its local root's
 * total when that root ends. Totals are per local root, not per trace: web voice runs the chat
 * turn and each sentence's synthesis as separate roots in one seeded trace.
 */
class CostLedger {
  private readonly open = new Map<string, TraceCost>();
  /** Span id to its local root's span id, for spans that are not roots. */
  private readonly roots = new Map<string, string>();
  constructor(private readonly rates: CostRates | undefined) {}

  start(span: ReadableSpan): void {
    const parent = span.parentSpanContext;
    if (isLocalRoot(span) || parent === undefined) return;
    boundedSet(this.roots, span.spanContext().spanId, this.roots.get(parent.spanId) ?? parent.spanId, MAX_OPEN_SPANS);
  }

  record(span: ReadableSpan): void {
    const spanId = span.spanContext().spanId;
    const root = this.roots.get(spanId) ?? spanId;
    this.roots.delete(spanId);
    const usage = providerUsage(span);
    if (usage !== undefined) this.price(span, usage, root);
    if (isLocalRoot(span)) this.close(span, spanId);
  }

  private price(span: ReadableSpan, usage: ProviderUsage, root: string): void {
    const { status, estimate } = priceUsage(usage, this.rates);
    span.attributes['bob.cost.status'] = status;
    if (estimate !== undefined && this.rates !== undefined) {
      Object.assign(span.attributes, { 'bob.cost.estimate': estimate, ...snapshotAttributes(this.rates) });
    }
    let total = this.open.get(root);
    if (total === undefined) {
      total = { calls: 0, complete: 0, priced: 0, estimate: 0 };
      boundedSet(this.open, root, total, MAX_OPEN_COST_ROOTS);
    }
    total.calls += 1;
    total.complete += Number(status === 'complete');
    total.priced += Number(estimate !== undefined);
    total.estimate += estimate ?? 0;
  }

  /** A root with no provider call gets no total: absent is not zero. Calls ending after the root are not in it. */
  private close(span: ReadableSpan, root: string): void {
    const total = this.open.get(root);
    if (total === undefined) return;
    this.open.delete(root);
    span.attributes['bob.cost.provider_calls'] = total.calls;
    span.attributes['bob.cost.total_status'] = total.priced === 0 ? 'unknown' : total.complete === total.calls ? 'complete' : 'partial';
    if (total.priced > 0 && this.rates !== undefined) {
      Object.assign(span.attributes, { 'bob.cost.total_estimate': total.estimate, ...snapshotAttributes(this.rates) });
    }
  }
}

/** Stamps user, session, conversation, turn and tags from the active context onto every span started inside it (attributes the span already carries win), normalises speech labels and empty costs, and prices provider calls. */
export class CorrelationSpanProcessor implements SpanProcessor {
  private readonly costs: CostLedger;
  constructor(rates?: CostRates) {
    this.costs = new CostLedger(rates);
  }
  onStart(span: Span, parentContext: Context): void {
    try {
      const stamped = traceAttributes(activeTraceAttrs(parentContext));
      // Every span carries a conversation id: `none` when nothing resolved one (system work, before sign-in).
      if (stamped['bob.conversation.id'] === undefined) Object.assign(stamped, NO_CONVERSATION_ATTRIBUTES);
      for (const key of Object.keys(stamped)) {
        if (span.attributes[key] !== undefined) delete stamped[key];
      }
      // A span's own session.id wins, and its bob.session.id twin follows it.
      const ownSession = span.attributes['session.id'];
      if (ownSession !== undefined && span.attributes['bob.session.id'] === undefined) stamped['bob.session.id'] = ownSession;
      span.setAttributes(stamped);
      this.costs.start(span);
    } catch { /* Correlation is best effort. */ }
  }
  /** Labels are set at the end: the AI SDK writes `chat` after start, and the attributes are still mutable before any exporter sees the span. */
  onEnd(span: ReadableSpan): void {
    try {
      const speech = speechOperation(span);
      if (speech !== undefined) span.attributes['gen_ai.operation.name'] = speech;
      // An AI span keeps the client session only as `bob.session.id`: OpenObserve replaces
      // `gen_ai.conversation.id` with `session.id` on AI spans, which would split a conversation's
      // model calls off by browser tab or device socket.
      if (isAiSpan(span.attributes)) delete span.attributes['session.id'];
      dropEmptyCosts(span.attributes);
      this.costs.record(span);
    } catch { /* best effort */ }
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/** Every delegate has settled: one failure is thrown as is, several as an AggregateError so each destination can be reported. */
async function firstFailure(settled: Array<PromiseSettledResult<void>>): Promise<void> {
  const failed = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  const [only, ...rest] = failed;
  if (only !== undefined && rest.length === 0) throw only.reason;
  if (rest.length > 0) throw new AggregateError(failed.map((result) => result.reason));
}

/** Scrubs each ended span once, then hands the same span to every delegate. */
export class ScrubbingSpanProcessor implements SpanProcessor {
  constructor(
    private readonly scrub: (span: ReadableSpan) => void,
    private readonly delegates: SpanProcessor[],
  ) {}

  onStart(span: Span, parentContext: Context): void {
    for (const delegate of this.delegates) {
      try { delegate.onStart(span, parentContext); } catch { /* one delegate must not stop the others */ }
    }
  }

  onEnd(span: ReadableSpan): void {
    // Fail closed: a span that cannot be scrubbed is dropped, never exported raw.
    try { this.scrub(span); } catch { return; }
    for (const delegate of this.delegates) {
      try { delegate.onEnd(span); } catch { /* one delegate must not stop the others */ }
    }
  }

  async forceFlush(): Promise<void> {
    await firstFailure(await Promise.allSettled(this.delegates.map((delegate) => delegate.forceFlush())));
  }

  async shutdown(): Promise<void> {
    await firstFailure(await Promise.allSettled(this.delegates.map((delegate) => delegate.shutdown())));
  }
}

const SAFE_ATTRIBUTES = new Set([
  'user.id', 'session.id', 'bob.session.id', 'bob.conversation.id', 'gen_ai.conversation.id', 'bob.conversation.source', 'bob.turn.id', 'bob.trace.name', 'bob.tags', 'bob.observation.type', 'bob.ai.span_type',
  'gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.request.model', 'gen_ai.response.model',
  'gen_ai.response.id', 'gen_ai.response.finish_reasons', 'gen_ai.agent.name', 'gen_ai.tool.name',
  'gen_ai.tool.call.id', 'gen_ai.output.type', 'gen_ai.request.stream',
  'ai.operationId', 'ai.telemetry.functionId', 'ai.model.provider', 'ai.model.id',
  'ai.response.finishReason', 'ai.toolCall.name', 'ai.toolCall.id',
]);
const NUMERIC_PREFIXES = ['gen_ai.usage.', 'ai.usage.', 'gen_ai.client.'];
/** Opt-in captures intended content, never headers, provider blobs or errors. */
const PAYLOAD_ATTRIBUTES = new Set([
  'bob.evaluation.input',
  'gen_ai.system_instructions', 'gen_ai.input.messages', 'gen_ai.output.messages',
  'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result',
  'ai.request.text', 'ai.response.text', 'ai.response.reasoning', 'ai.response.object',
  'ai.prompt', 'ai.prompt.messages', 'ai.toolCall.args', 'ai.toolCall.result',
]);

/** Cost attributes are bounded: a status enum, non-negative numbers, and the snapshot's version, date and currency code. */
function isSafeCostAttribute(key: string, value: unknown): boolean {
  switch (key) {
    case 'bob.cost.status':
    case 'bob.cost.total_status': return COST_STATUSES.has(value);
    case 'bob.cost.estimate':
    case 'bob.cost.total_estimate':
    case 'bob.cost.provider_calls': return quantity(value) !== undefined;
    case 'bob.cost.currency': return typeof value === 'string' && CURRENCY.test(value);
    case 'bob.cost.rates_version': return typeof value === 'string' && RATES_VERSION.test(value);
    case 'bob.cost.pricing_date': return typeof value === 'string' && PRICING_DATE.test(value);
    default: return false;
  }
}

function isSafeAttribute(key: string, value: unknown, payload: boolean): boolean {
  if (key.startsWith('bob.cost.')) return isSafeCostAttribute(key, value);
  if (SAFE_ATTRIBUTES.has(key) || (payload && PAYLOAD_ATTRIBUTES.has(key))) return true;
  if (NUMERIC_PREFIXES.some((prefix) => key.startsWith(prefix))) return typeof value === 'number';
  if (key.startsWith('bob.metric.') || key === 'bob.evaluation.score' || key === 'bob.speech.input_units') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return key.startsWith('bob.') && SAFE_METADATA.has(key.slice('bob.'.length))
    && ['string', 'number', 'boolean'].includes(typeof value);
}

function sanitizeAttributes(attributes: ReadableSpan['attributes'], payload: boolean): void {
  for (const key of Object.keys(attributes)) {
    if (!isSafeAttribute(key, attributes[key], payload)) delete attributes[key];
  }
}

/** One scrub for every exporter: allowlisted attributes only; SDKs capture exception messages even with payload capture off. */
export function createSpanScrubber(payload: boolean): (span: ReadableSpan) => void {
  return (span) => {
    delete span.status.message;
    sanitizeAttributes(span.attributes, payload);
    for (const event of span.events) {
      if (event.attributes === undefined) continue;
      if (event.name === 'exception') {
        for (const key of Object.keys(event.attributes)) delete event.attributes[key];
        event.attributes['exception.type'] = 'Error';
      } else {
        sanitizeAttributes(event.attributes, payload);
      }
    }
  };
}
