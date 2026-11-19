import { randomBytes } from 'node:crypto';
import { ROOT_CONTEXT, SpanKind, TraceFlags, trace, type Counter, type Histogram, type ObservableResult, type Attributes } from '@opentelemetry/api';
import type { Resource } from '@opentelemetry/resources';
import { MeterProvider, type MetricReader } from '@opentelemetry/sdk-metrics';
import { isValidTraceId } from './telemetry-metadata.ts';

const MAXIMUMS = {
  'ws.control.duration_ms': 600000, 'ws.control.failed': 1, 'ws.control.rejected': 1,
  'ws.uplink.accepted_frames': 4294967295, 'ws.uplink.rejected_frames': 4294967295, 'ws.uplink.bytes': 4294967295,
  'ws.downlink.frames': 4294967295, 'ws.downlink.bytes': 4294967295,
  'ws.downlink.pacing_wait_ms': 600000, 'ws.downlink.backpressure_wait_ms': 600000,
  'workflow.duration_ms': 604800000, 'workflow.failed': 1, 'workflow.rejected': 1,
  'workflow.polls.empty': 1000000,
  'http.request.duration_ms': 604800000, 'http.request.stream_ms': 604800000, 'http.request.failed': 1, 'http.request.aborted': 1,
  'http.request.client_error': 1, 'http.request.server_error': 1,
  'rag.duration_ms': 600000, 'rag.result_count': 1000000,
  'rag.failed': 1, 'rag.timeout': 1, 'rag.fallback': 1, 'rag.skipped': 1, 'rag.empty': 1,
  'tool.duration_ms': 600000, 'tool.failed': 1, 'tool.cancelled': 1, 'tool.handled_failure': 1,
  'speech.duration_ms': 600000, 'speech.failed': 1, 'speech.timeout': 1, 'speech.cancelled': 1,
  'speech.input_chars': 1000000, 'speech.audio_ms': 600000,
  'speech.cache_hit': 1, 'speech.cache_miss': 1, 'speech.cache_bypass': 1,
  'ui.request.duration_ms': 120000, 'ui.request.failed': 1, 'ui.request.aborted': 1,
  'ui.action.duration_ms': 604800000, 'ui.action.failed': 1, 'ui.action.aborted': 1,
  'ui.action.invocations': 1000000,
  'ui.auth.duration_ms': 604800000, 'ui.auth.failed': 1, 'ui.auth.aborted': 1,
  'ui.render.duration_ms': 120000,
  // Web Vitals in ms; CLS is unitless, recorded times 1000 as an integer. `ui.error` is one sample per JavaScript error.
  'ui.web_vital.lcp': 120000, 'ui.web_vital.inp': 120000, 'ui.web_vital.cls': 120000,
  'ui.web_vital.fcp': 120000, 'ui.web_vital.ttfb': 120000, 'ui.error': 1,
  'ui.window.requests_ok': 1000000, 'ui.window.requests_error': 1000000,
  'ui.window.requests_aborted': 1000000, 'ui.window.events_observed': 1000000,
  'ui.window.events_accepted': 1000000, 'ui.window.events_dropped': 1000000,
  'ui.window.server_dropped': 1000000,
  'ui.window.batches_failed': 1000000, 'ui.window.timing_overflow': 1000000,
  'turn.failed': 1, 'turn.cancelled': 1, 'turn.empty': 1, 'turn.completed': 1,
  'turn.stt_ms': 600000, 'turn.prep_ms': 600000, 'turn.model_ms': 600000,
  'turn.first_token_ms': 600000, 'turn.tts_ms': 600000,
  'turn.first_audio_ms': 600000, 'turn.total_ms': 600000,
  'device.heap_free_bytes': 4294967295, 'device.heap_largest_bytes': 4294967295,
  'device.uptime_ms': 4294967295,
  // Device-clock offsets from capture start, and same-clock intervals; never mixed with server time.
  'device.turn.capture_end_ms': 600000, 'device.turn.first_up_ms': 600000, 'device.turn.turn_end_ms': 600000,
  'device.turn.playback_start_ms': 600000, 'device.turn.first_down_ms': 600000, 'device.turn.decoder_ready_ms': 600000,
  'device.turn.speaker_submission_ms': 600000, 'device.turn.playback_end_ms': 600000,
  'device.turn.end_to_speaker_ms': 600000, 'device.turn.speech_end_to_speaker_ms': 600000, 'device.turn.up_frames': 100000, 'device.turn.down_frames': 100000,
  'user.feedback': 1, 'voice.eos_to_first_audio_ms': 600000,
  // One per provider call refused for a spent AI Gateway budget (HTTP 402).
  'ai.budget_exhausted': 1,
} as const;

export type ObservationMetricName = keyof typeof MAXIMUMS;

/** Bounded, non-identifying breakdown labels. Anything else is dropped before it reaches an instrument. */
export interface MetricAttributes {
  /** An Express route template (`/api/tasks/:id`), never a raw path. */
  route?: string;
  status_class?: '1xx' | '2xx' | '3xx' | '4xx' | '5xx';
  outcome?: 'ok' | 'error' | 'aborted' | 'closed' | 'returned' | 'resolved';
  surface?: 'device' | 'web_text' | 'web_voice' | 'analytics';
  stage?: 'stt' | 'tts';
}
export interface ObservationMetricSample { name: ObservationMetricName; value: number; attributes?: MetricAttributes }

/** A route template, or one of the route inventory's fixed names (unregistered path, web app file, web app page). */
const ROUTE = /^(\/[A-Za-z0-9_:.\/-]{0,63}|unmatched|static_asset|static_ui)$/;
/** A route segment that looks like an id (digits, a UUID, long hex) means a raw path slipped through. */
const ID_SEGMENT = /^(\d+|[0-9a-f-]{16,})$/i;
const ENUMS: Record<Exclude<keyof MetricAttributes, 'route'>, ReadonlySet<string>> = {
  status_class: new Set(['1xx', '2xx', '3xx', '4xx', '5xx']),
  outcome: new Set(['ok', 'error', 'aborted', 'closed', 'returned', 'resolved']),
  surface: new Set(['device', 'web_text', 'web_voice', 'analytics']),
  stage: new Set(['stt', 'tts']),
};

/** The allow-listed labels of `attributes`, or undefined when none survive. */
export function checkedMetricAttributes(attributes: MetricAttributes | undefined): MetricAttributes | undefined {
  if (attributes === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== 'string') continue;
    if (key === 'route') {
      if (ROUTE.test(value) && !value.split('/').some((segment) => ID_SEGMENT.test(segment))) out.route = value;
    } else if (ENUMS[key as keyof typeof ENUMS]?.has(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out as MetricAttributes : undefined;
}

let provider: MeterProvider | undefined;
let reportFailure: (kind: string) => void = () => {};
const histograms = new Map<string, Histogram>();
const counters = new Map<string, Counter>();
const gauges = new Map<string, () => readonly GaugeSeries[]>();

/** 0/1 outcome flags are counters (one add per occurrence); `user.feedback` is 0/1 but means down/up, so it stays a histogram. */
const FLAG_SUFFIX = /\.(failed|rejected|aborted|cancelled|empty|completed|timeout|fallback|skipped|cache_hit|cache_miss|cache_bypass|client_error|server_error|handled_failure|budget_exhausted)$/;
const isFlag = (name: string): boolean => FLAG_SUFFIX.test(name) && MAXIMUMS[name as ObservationMetricName] === 1;

/** Each metric's largest accepted value. */
export function metricCaps(): Record<ObservationMetricName, number> {
  return { ...MAXIMUMS };
}

const SHORT_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
const LONG_MS = [...SHORT_MS, 3_600_000, 21_600_000, 86_400_000, 604_800_000];
const BYTES = [1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864, 268_435_456, 1_073_741_824, 4_294_967_296];
const COUNTS = [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 10_000, 100_000, 1_000_000, 4_294_967_296];
const CLS_X1000 = [10, 25, 50, 100, 250, 500, 1_000];

/** Bucket boundaries by unit: the SDK default (0..10 000) puts bytes, uptime, counts and minute-scale durations in +Inf. */
export function bucketsFor(name: ObservationMetricName): number[] {
  if (name === 'ui.web_vital.cls') return CLS_X1000;
  if (name.endsWith('_bytes') || name === 'ws.uplink.bytes' || name === 'ws.downlink.bytes') return BYTES;
  if (name.endsWith('_ms') || name.startsWith('ui.web_vital.')) return MAXIMUMS[name] > 600_000 ? LONG_MS : SHORT_MS;
  return COUNTS;
}

/** Every metric's instrument kind. Changing one is a breaking change for the backend's stored metric type. */
export function metricKinds(): Record<ObservationMetricName, 'counter' | 'histogram'> {
  return Object.fromEntries(
    (Object.keys(MAXIMUMS) as ObservationMetricName[]).map((name) => [name, isFlag(name) ? 'counter' : 'histogram']),
  ) as Record<ObservationMetricName, 'counter' | 'histogram'>;
}

export interface GaugeSeries { value: number; attributes?: Attributes }

/** Called with the reader telemetry built from the standard OTEL_* variables; no reader means no instruments. */
export function initObservationMetrics(
  config: { reader: MetricReader; resource?: Resource },
  report: (kind: string) => void,
): void {
  reportFailure = report;
  if (provider !== undefined) return;
  try {
    provider = new MeterProvider({ readers: [config.reader], ...(config.resource !== undefined ? { resource: config.resource } : {}) });
    histograms.clear();
    counters.clear();
    // Every flag counter exists at 0 from the first export: a series born at 1 hides its first event from increase().
    for (const name of Object.keys(MAXIMUMS) as ObservationMetricName[]) if (isFlag(name)) counter(name).add(0);
    for (const [name, callback] of gauges) attachGauge(name, callback);
  } catch { report('telemetry_init_failed'); }
}

function isValidSample(sample: ObservationMetricSample): boolean {
  return Object.hasOwn(MAXIMUMS, sample.name) && Number.isFinite(sample.value)
    && Number.isInteger(sample.value) && sample.value >= 0 && sample.value <= MAXIMUMS[sample.name];
}

function counter(name: ObservationMetricName): Counter {
  let instrument = counters.get(name);
  if (instrument === undefined) {
    instrument = (provider as MeterProvider).getMeter('bob').createCounter(`bob.${name}`, { unit: '1' });
    counters.set(name, instrument);
  }
  return instrument;
}

function recordInstrument({ name, value, attributes }: ObservationMetricSample): void {
  if (provider === undefined) return;
  if (isFlag(name)) {
    if (value === 1) counter(name).add(1);
    return;
  }
  let histogram = histograms.get(name);
  if (histogram === undefined) {
    histogram = provider.getMeter('bob').createHistogram(`bob.${name}`, {
      unit: name.endsWith('_ms') ? 'ms' : name.endsWith('_bytes') ? 'By' : '1',
      advice: { explicitBucketBoundaries: bucketsFor(name) },
    });
    histograms.set(name, histogram);
  }
  histogram.record(value, checkedMetricAttributes(attributes) as Attributes | undefined);
}

function attachGauge(name: string, callback: () => readonly GaugeSeries[]): void {
  if (provider === undefined) return;
  provider.getMeter('bob').createObservableGauge(`bob.${name}`, { unit: '1' }).addCallback((result: ObservableResult) => {
    try { for (const series of callback()) result.observe(series.value, series.attributes); } catch { /* A gauge never breaks the export. */ }
  });
}

/** An observable gauge read at each export (`bob.<name>`); kept so it re-attaches if the provider is rebuilt. No provider means no export, never an error. */
export function registerObservableGauge(name: string, callback: () => readonly GaugeSeries[]): void {
  if (gauges.has(name)) return;
  gauges.set(name, callback);
  attachGauge(name, callback);
}

/** Fixed numeric samples only: an instrument per name plus `bob.metric.<name>` on the active span (backends that drop metrics still search span attributes). */
export function recordObservationMetrics(samples: readonly ObservationMetricSample[]): void {
  try {
    const span = trace.getActiveSpan();
    for (const sample of samples.slice(0, 32)) {
      if (!isValidSample(sample)) continue;
      span?.setAttribute(`bob.metric.${sample.name}`, sample.value);
      recordInstrument(sample);
    }
  } catch { /* Metrics never break the product path. */ }
}

/** A browser-measured operation recorded as a CLIENT span in the trace it joined; the metric instrument is left to the caller. */
interface BrowserSpan { name: string; durationMs: number; attributes?: Record<string, string> }

/** Records the metric and a short `trace-signal` span inside an existing trace (browser feedback, voice timing); with `browser`, a CLIENT span of that name and duration instead (no second instrument sample). */
export function recordTraceSignal(traceId: string, name: ObservationMetricName, value: number, browser?: BrowserSpan): void {
  try {
    const sample = { name, value };
    if (!isValidSample(sample)) return;
    if (browser === undefined) recordInstrument(sample);
    if (!isValidTraceId(traceId)) return;
    const parent = trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext({
      traceId, spanId: randomBytes(8).toString('hex'), traceFlags: TraceFlags.SAMPLED, isRemote: true,
    }));
    const attributes = { ...browser?.attributes, [`bob.metric.${name}`]: value };
    if (browser === undefined) trace.getTracer('bob').startSpan('trace-signal', { attributes }, parent).end();
    else {
      const end = Date.now();
      trace.getTracer('bob').startSpan(browser.name, { kind: SpanKind.CLIENT, startTime: end - browser.durationMs, attributes }, parent).end(end);
    }
  } catch { /* Signals never break the product path. */ }
}

/** Forces one export; a failure is reported once by kind and never thrown. */
export async function flushObservationMetrics(): Promise<void> {
  if (provider === undefined) return;
  try { await provider.forceFlush(); } catch { reportFailure('metrics_flush_failed'); }
}
