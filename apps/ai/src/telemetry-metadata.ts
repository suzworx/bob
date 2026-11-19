import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { context, createContextKey, trace, type Attributes, type Context } from '@opentelemetry/api';

/** How an interaction's conversation id was found: the thing it is about, the browser's open one, the device's, the user's active pointer, or nothing. */
export type ConversationSource = 'explicit' | 'client' | 'device' | 'active' | 'none';

/** The correlation vocabulary: identifiers and short labels only, never user text. */
export interface Correlation {
  traceName?: string;
  /** The CLIENT session (device: the WebSocket session id; web: the per-tab id), `session.id`. */
  sessionId?: string;
  /** The canonical conversation (== thread) id, `bob.conversation.id` and `gen_ai.conversation.id` (equal). */
  conversationId?: string;
  /** How the conversation was resolved, `bob.conversation.source`; `explicit` when omitted. */
  conversationSource?: ConversationSource;
  /** Workflow seed stamped into metadata as turn_id and used to derive the trace ID. */
  turnId?: string;
  /** The acting, authenticated account, `user.id`. */
  userId?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}

/** The keys a context inherits and a span contributes to its descendants (metadata merges separately). */
export const CORRELATION_KEYS = ['traceName', 'sessionId', 'conversationId', 'conversationSource', 'turnId', 'userId', 'tags'] as const;

export type TraceAttrs = Correlation;

/** Span attributes contain identifiers and code-owned labels, never content. */
export interface SpanAttrs extends Correlation {
  observationType?: 'span' | 'retriever' | 'tool' | 'chain';
  /** Trusted server start time for completed operations observed retrospectively. */
  startTime?: Date;
  /** Background work must not inherit the request that scheduled its timer. */
  detached?: boolean;
  /** Server-owned namespace distinguishing executions with the same wire/message id. */
  workflowNamespace?: string;
  workflowId?: string;
  /** W3C header of an upstream caller (the Railway edge): continues its trace when no workflow seed exists. */
  traceparent?: string;
}

/** The listed keys of `from` that are defined; undefined never overwrites (a missing session must not become "undefined"). */
export function pickDefined<T extends object, K extends keyof T>(from: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) if (from[key] !== undefined) out[key] = from[key];
  return out;
}

const contextObservers = new AsyncLocalStorage<{ capture: () => void; captured: boolean }>();

/** Keep a transport completion callback associated with its first business workflow. */
export function withDiagnosticContextObserver<T>(capture: (() => void) | undefined, run: () => T): T {
  return capture === undefined ? contextObservers.exit(run) : contextObservers.run({ capture, captured: false }, run);
}

/** Called inside an active seeded workflow; observer failures never affect work. */
export function captureDiagnosticWorkflowContext(): void {
  const observer = contextObservers.getStore();
  if (observer === undefined || observer.captured) return;
  observer.captured = true;
  try { observer.capture(); } catch { /* Best effort transport correlation. */ }
}

/** Keys carry code-owned labels, numeric measurements or opaque identifiers. */
export const SAFE_METADATA = new Set([
  'ws_control', 'workflow', 'reason', 'error_code',
  'http_method', 'route_template', 'http_status', 'http_status_class', 'duration_ms',
  'turn_id', 'invocation_id', 'interface', 'action', 'board', 'result', 'fw_version', 'model',
  'state', 'fields', 'frames', 'rssi_dbm', 'heap_free', 'heap_largest', 'log_dropped', 'audio_seconds', 'from', 'to',
  'device_event', 'uptime_ms', 'attempt', 'format',
  'event', 'page', 'view_id', 'browser_duration_ms', 'timing_source', 'target', 'phase',
  'area', 'method', 'status', 'outcome',
  'route', 'action_id', 'parent_action_id', 'trigger', 'stage', 'endpoint', 'request_id', 'trace_id', 'edge_trace_id',
  'ui_action_id', 'ui_request_id', 'duration_overflow', 'auth_state', 'server_dropped', 'invocations',
  'operation', 'failed_invocations', 'aborted_invocations',
  'activation_source', 'capture_end_reason', 'muted', 'skipped_milestones', 'unknown_milestones',
]);

/** Deterministic trace id from a stable seed: the first 32 hex chars of sha256. */
export function traceIdFromSeed(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

export function isValidTraceId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id);
}

/** Strict W3C `traceparent` (version 00, non-zero ids); anything else is ignored. */
export function parseTraceparent(header: unknown): { traceId: string; spanId: string; traceFlags: number } | undefined {
  const match = typeof header === 'string' ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header) : null;
  const [, traceId, spanId, flags] = match ?? [];
  if (!isValidTraceId(traceId) || spanId === undefined || flags === undefined || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId, traceFlags: parseInt(flags, 16) };
}

export const TRACE_ATTRS_KEY = createContextKey('bob.trace_attrs');

export function activeTraceAttrs(from: Context = context.active()): TraceAttrs {
  return (from.getValue(TRACE_ATTRS_KEY) as TraceAttrs | undefined) ?? {};
}

/** Inner values win; undefined never overwrites (a missing session must not become "undefined"). */
export function mergeTraceAttrs(base: TraceAttrs, next: TraceAttrs): TraceAttrs {
  const merged: TraceAttrs = { ...base, ...pickDefined(next, CORRELATION_KEYS) };
  if (base.metadata !== undefined || next.metadata !== undefined) merged.metadata = { ...base.metadata, ...next.metadata };
  return merged;
}

/** The literal id of an interaction with no conversation (system work, before sign-in or pairing). */
export const NO_CONVERSATION = 'none';

const LEGACY_CONVERSATION_ID = /^(?:cnv|thr|conv)_([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})$/i;

/**
 * The canonical conversation id (`conv_` + 32 lowercase hex) for a legacy `cnv_`/`thr_` or dashed form, by the same
 * rule as apps/api/src/platform/ids.ts. `none` and anything else pass through unchanged: never invent an id.
 */
export function canonicalConversationId(id: string): string {
  const uuid = LEGACY_CONVERSATION_ID.exec(id)?.[1];
  return uuid === undefined ? id : `conv_${uuid.replaceAll('-', '').toLowerCase()}`;
}

/** The one defaulting rule: no conversation is `none`/`none`; a known one without a source is `explicit`. The id is always canonical. */
function conversationOf(id: string | undefined, source: ConversationSource | undefined): { id: string; source: ConversationSource } {
  return id === undefined ? { id: NO_CONVERSATION, source: 'none' } : { id: canonicalConversationId(id), source: source ?? 'explicit' };
}

/** The ids of the active context as journal keys; the conversation is always present (`none` when nothing resolved it). */
export function currentCorrelation(): { user_id?: string; conversation_id: string; conversation_source: ConversationSource; session_id?: string } {
  const attrs = activeTraceAttrs();
  const conversation = conversationOf(attrs.conversationId, attrs.conversationSource);
  return {
    ...(attrs.userId !== undefined ? { user_id: attrs.userId } : {}),
    conversation_id: conversation.id,
    conversation_source: conversation.source,
    ...(attrs.sessionId !== undefined ? { session_id: attrs.sessionId } : {}),
  };
}

/** The conversation is a first-class id in both namespaces (`bob.*` for every span, `gen_ai.*` for AI tooling), always equal. */
export function conversationAttributes(conversationId: string | undefined, source: ConversationSource | undefined): Attributes {
  const conversation = conversationOf(conversationId, source);
  return {
    'bob.conversation.id': conversation.id,
    'gen_ai.conversation.id': conversation.id,
    'bob.conversation.source': conversation.source,
  };
}

/** The neutral attribute vocabulary; the first-class `turnId` wins over a `turn_id` metadata value. */
export function traceAttributes(attrs: TraceAttrs): Attributes {
  const out: Attributes = metadataAttributes(attrs.metadata ?? {});
  const turnId = attrs.turnId ?? attrs.metadata?.turn_id;
  if (attrs.userId !== undefined) out['user.id'] = attrs.userId;
  // Both names: AI spans drop `session.id` on export (CorrelationSpanProcessor), `bob.session.id` stays on every span.
  if (attrs.sessionId !== undefined) Object.assign(out, { 'session.id': attrs.sessionId, 'bob.session.id': attrs.sessionId });
  if (attrs.conversationId !== undefined) Object.assign(out, conversationAttributes(attrs.conversationId, attrs.conversationSource));
  if (turnId !== undefined) out['bob.turn.id'] = turnId;
  if (attrs.tags !== undefined) out['bob.tags'] = attrs.tags;
  if (attrs.traceName !== undefined) out['bob.trace.name'] = attrs.traceName;
  return out;
}

export function metadataAttributes(metadata: Record<string, string>): Attributes {
  return Object.fromEntries(Object.entries(metadata).filter(([key, value]) =>
    SAFE_METADATA.has(key) && typeof value === 'string' && value.length <= 200
    && !/[\u0000-\u001f]|https?:\/\//i.test(value),
  ).map(([key, value]) => [key === 'turn_id' ? 'bob.turn.id' : `bob.${key}`, value]));
}

/** Best-effort late status updates; arguments are never captured as payloads. */
export function updateActiveSpanMetadata(metadata: Record<string, string>): void {
  try {
    const attributes = metadataAttributes(metadata);
    if (Object.keys(attributes).length > 0) trace.getActiveSpan()?.setAttributes(attributes);
  } catch { /* Observability failures cannot break the product operation. */ }
}

/** Exposes only an opaque identifier, never an SDK error or arbitrary value. */
export function currentDiagnosticTraceId(): string | undefined {
  try {
    const id = trace.getActiveSpan()?.spanContext().traceId;
    return isValidTraceId(id) ? id : undefined;
  } catch { return undefined; }
}
