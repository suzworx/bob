/**
 * Bounded-label metrics registry (issue #145, plan.md "Metrics"): command
 * rates, outbox due lag, retries, provider sync lag and worker saturation as
 * an in-process counter/duration registry. No prom-client, no scrape endpoint
 * — snapshot() is the JSON summary the health path can serve later.
 *
 * Design rules:
 * - A label only takes a value from the fixed allowlist declared with the
 *   metric. An off-list value throws in tests (strict) and is dropped to the
 *   reserved `unknown` label in production, so cardinality cannot grow with
 *   data.
 * - No identifier is ever a label value: a uuid, an email, a token prefix
 *   (olxd_, sk-, sb_) or a URL is rejected exactly like an off-list value.
 * - snapshot() is numbers only — counters, and duration aggregates
 *   { count, total_ms }. Never a sample, never a last-value string.
 *
 * Metric set (every metric is documented in docs/log-reference.md):
 * - bob_commands_total: device command rate by operation and status.
 * - bob_outbox_retries_total / bob_outbox_due_lag_ms: outbox retries and
 *   due lag by event_type (the family's declared delivery effects below).
 * - bob_outbox_worker_in_flight / bob_outbox_worker_parked: saturation
 *   readings from the drain loop's own health() (core/outbox-worker.ts).
 * - bob_provider_sync_lag_ms: provider sync lag by provider and status,
 *   defined now although no provider adapter exists yet.
 *
 * No producer is wired to these metrics yet — the wiring is a later task; the
 * registry and its enforcement are the deliverable here. The outbox event_type
 * allowlist is the declared delivery effects; extend it deliberately as
 * producers land, never by letting data choose a label value.
 */

/** Reserved label value every allowlist implicitly admits: the drop target for
 *  off-list or identifier-like values in production. */
const UNKNOWN_LABEL = 'unknown';

type MetricKind = 'counter' | 'duration';

/** A declared metric and its bounded label allowlists. */
type MetricDefinition = {
  name: string;
  kind: MetricKind;
  labels?: Readonly<Record<string, readonly string[]>>;
};

type LabelValues = Readonly<Record<string, string>>;

type DurationAggregate = { count: number; total_ms: number };

type MetricsSnapshot = {
  counters: Record<string, number>;
  durations: Record<string, DurationAggregate>;
};

type MetricsRegistry = {
  counter(name: string, labels?: LabelValues): void;
  observe(name: string, ms: number, labels?: LabelValues): void;
  snapshot(): MetricsSnapshot;
};

/** The outbox delivery effects the family produces; extend deliberately. */
const OUTBOX_EVENT_TYPES = [
  'reminder.due',
  'notification.pushed',
  'invitation.delivered',
  'publication.sent',
  'task.completed',
] as const;

/** Device command operations from the v2 wire contract (schemas.ts). */
const COMMAND_OPERATIONS = [
  'hello',
  'turn_start',
  'audio',
  'turn_end',
  'cancel',
  'pong',
  'list_conversations',
  'select_conversation',
  'new_conversation',
  'list_spaces',
  'select_space',
  'pair_request',
] as const;

const DEFAULT_METRICS: readonly MetricDefinition[] = [
  {
    name: 'bob_commands_total',
    kind: 'counter',
    labels: { operation: COMMAND_OPERATIONS, status: ['ok', 'refused', 'failed'] },
  },
  {
    name: 'bob_outbox_retries_total',
    kind: 'counter',
    labels: { event_type: OUTBOX_EVENT_TYPES },
  },
  {
    name: 'bob_outbox_due_lag_ms',
    kind: 'duration',
    labels: { event_type: OUTBOX_EVENT_TYPES },
  },
  { name: 'bob_outbox_worker_in_flight', kind: 'counter' },
  { name: 'bob_outbox_worker_parked', kind: 'counter' },
  {
    name: 'bob_provider_sync_lag_ms',
    kind: 'duration',
    labels: { provider: ['google', 'apple', 'native'], status: ['ok', 'failed', 'empty'] },
  },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PREFIXES = ['olxd_', 'sk-', 'sb_'] as const;

/** True when a value looks like an identifier that must never be a label. */
function isIdentifierLike(value: string): boolean {
  if (UUID_RE.test(value)) return true;
  if (value.includes('@') || value.includes('://')) return true;
  for (const prefix of TOKEN_PREFIXES) {
    if (value.startsWith(prefix)) return true;
  }
  return false;
}

/** The series key for a metric and its labels, Prometheus-style. */
function seriesKey(name: string, labels: LabelValues): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}="${value}"`);
  if (parts.length === 0) return name;
  return `${name}{${parts.join(',')}}`;
}

/**
 * Resolves label values against the metric's allowlist. Returns an empty
 * object for no labels, null when the whole call must be dropped (an
 * undeclared label name cannot be represented safely), and the resolved
 * labels otherwise. Off-list or identifier-like values throw in strict mode
 * and become `unknown` in production.
 */
function resolveLabels(
  def: MetricDefinition,
  labels: LabelValues | undefined,
  strict: boolean,
): LabelValues | null {
  if (labels === undefined) return {};
  const resolved: Record<string, string> = {};
  for (const [label, value] of Object.entries(labels)) {
    const allow = def.labels?.[label];
    if (allow === undefined) {
      if (strict) throw new Error(`metrics: ${def.name} label ${label} is not declared`);
      return null;
    }
    if (value === UNKNOWN_LABEL) {
      resolved[label] = value;
      continue;
    }
    if (isIdentifierLike(value) || !allow.includes(value)) {
      if (strict) {
        throw new Error(`metrics: ${def.name} label ${label} value not allowlisted: ${value}`);
      }
      resolved[label] = UNKNOWN_LABEL;
    } else {
      resolved[label] = value;
    }
  }
  // Every DECLARED label must appear, not just the supplied ones. Resolving
  // only `Object.entries(labels)` let one metric carry several series of
  // different shapes -- `bob_commands_total`, `{operation=...}` and
  // `{operation=...,status=...}` could coexist, so the totals could not be
  // aggregated on either dimension. A missing name is a producer bug, so it
  // throws in strict mode and degrades to `unknown` in production rather than
  // dropping the observation entirely.
  for (const label of Object.keys(def.labels ?? {})) {
    if (resolved[label] !== undefined) continue;
    if (strict) throw new Error(`metrics: ${def.name} label ${label} was not supplied`);
    resolved[label] = UNKNOWN_LABEL;
  }
  return resolved;
}

type MetricsOptions = {
  /** Throw on off-list or identifier-like label values. Defaults to true
   *  under vitest; false reproduces the production drop-to-unknown path. */
  strict?: boolean;
};

export function createMetrics(options: MetricsOptions = {}): MetricsRegistry {
  const strict = options.strict ?? process.env.VITEST === 'true';
  const byName = new Map<string, MetricDefinition>(DEFAULT_METRICS.map((d) => [d.name, d]));
  const counters = new Map<string, number>();
  const durations = new Map<string, DurationAggregate>();

  return {
    counter(name: string, labels?: LabelValues): void {
      const def = byName.get(name);
      if (def === undefined) throw new Error(`metrics: unknown metric ${name}`);
      if (def.kind !== 'counter') throw new Error(`metrics: ${name} is not a counter`);
      const resolved = resolveLabels(def, labels, strict);
      if (resolved === null) return;
      const key = seriesKey(name, resolved);
      counters.set(key, (counters.get(key) ?? 0) + 1);
    },
    observe(name: string, ms: number, labels?: LabelValues): void {
      const def = byName.get(name);
      if (def === undefined) throw new Error(`metrics: unknown metric ${name}`);
      if (def.kind !== 'duration') throw new Error(`metrics: ${name} is not a duration`);
      // A single NaN or Infinity poisons `total_ms` for the lifetime of the
      // process: every later average reads back NaN, and a negative duration
      // silently drags the total down. Neither is recoverable once summed, so
      // an impossible reading is refused rather than recorded.
      if (!Number.isFinite(ms) || ms < 0) {
        if (strict) throw new Error(`metrics: ${name} duration must be a finite, non-negative number: ${ms}`);
        return;
      }
      const resolved = resolveLabels(def, labels, strict);
      if (resolved === null) return;
      const key = seriesKey(name, resolved);
      const current = durations.get(key) ?? { count: 0, total_ms: 0 };
      durations.set(key, { count: current.count + 1, total_ms: current.total_ms + ms });
    },
    snapshot(): MetricsSnapshot {
      const counterSnapshot: Record<string, number> = {};
      for (const [key, value] of counters) counterSnapshot[key] = value;
      const durationSnapshot: Record<string, DurationAggregate> = {};
      for (const [key, value] of durations) durationSnapshot[key] = value;
      return { counters: counterSnapshot, durations: durationSnapshot };
    },
  };
}