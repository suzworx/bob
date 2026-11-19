/**
 * Shared log core: one JSON line shape for api, ai, web and device events.
 * No server or vendor code here -- the api adds a file sink on top, and the
 * OTLP bridge is a plain OpenTelemetry Logs API call that does nothing until
 * telemetry-export.ts registers a provider (OTEL_LOGS_EXPORTER=otlp).
 */
import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { canonicalConversationId, currentCorrelation } from './telemetry-metadata.ts';

export type JournalFields = Record<string, string | number | boolean | undefined>;
export type JournalSource = 'api' | 'ai' | 'web' | 'device';
export type Journal = (event: string, fields?: JournalFields) => void;

/** Railway reads `level` as the severity: a failed or errored event is `error`. */
export function journalLevel(event: string): 'info' | 'error' {
  return ['_failed', '_error', '.error'].some((suffix) => event.endsWith(suffix)) ? 'error' : 'info';
}

/** Envelope keys only the logger writes; a caller's own value is dropped. */
const RESERVED_KEYS = new Set(['level', 'message', 'source', 'module', 'trace_id', 'span_id', 'conversation_source']);

export function isReservedJournalKey(key: string): boolean {
  return RESERVED_KEYS.has(key);
}

/** The active span's ids, or none: logging must never throw. */
function activeTrace(): { trace_id?: string; span_id?: string } {
  try {
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (spanContext && isSpanContextValid(spanContext)) {
      return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
    }
  } catch {
    // No span ids beats no log line.
  }
  return {};
}

export interface JournalOrigin {
  source: JournalSource;
  module?: string;
}

/** The caller's own conversation id in its canonical spelling, or undefined when it gave none. */
function callerConversationId(fields: JournalFields): string | undefined {
  return typeof fields.conversation_id === 'string' ? canonicalConversationId(fields.conversation_id) : undefined;
}

/**
 * user_id, conversation_id, conversation_source, session_id from the correlation context; a caller's own id wins
 * (canonical), and names its own source unless it is the very conversation the context resolved.
 */
function correlationFields(fields: JournalFields): Record<string, string> {
  try {
    const { user_id, conversation_id, conversation_source, session_id } = currentCorrelation();
    const own = callerConversationId(fields);
    return {
      ...(user_id !== undefined ? { user_id } : {}),
      conversation_id,
      conversation_source: own !== undefined && own !== conversation_id ? 'explicit' : conversation_source,
      ...(session_id !== undefined ? { session_id } : {}),
    };
  } catch {
    return {};
  }
}

/** The one line shape: ts, level, event, message, source, module, the correlation ids, caller fields, then the active span's ids. */
export function journalEntry(event: string, fields: JournalFields, origin: JournalOrigin): Record<string, unknown> {
  // Values are deliberately limited to local IDs, state names, counts, and error classes.
  const callerFields = Object.fromEntries(Object.entries(fields).filter(([key]) => !RESERVED_KEYS.has(key)));
  const conversationId = callerConversationId(fields);
  if (conversationId !== undefined) callerFields.conversation_id = conversationId;
  return {
    ts: new Date().toISOString(),
    level: journalLevel(event),
    event,
    message: event,
    source: origin.source,
    ...(origin.module !== undefined ? { module: origin.module } : {}),
    ...correlationFields(fields),
    ...callerFields,
    ...activeTrace(),
  };
}

/** The only console writer: stdout JSON lines are what Railway reads. */
export function writeConsoleLine(line: string): void {
  console.log(line);
}

let journalSink: ((line: string) => void) | null = null;

/** Sets the journal sink (the api's file); pass null to disable it. */
export function setJournalSink(sink: ((line: string) => void) | null): void {
  journalSink = sink;
}

const SEVERITY = { info: SeverityNumber.INFO, error: SeverityNumber.ERROR } as const;
const NOT_ATTRIBUTES = new Set(['ts', 'level', 'message', 'trace_id', 'span_id']);

/** Mirrors one entry as an OTel LogRecord with the same attribute names as the stdout line; a no-op while no logger provider is registered. */
function emitLogRecord(entry: Record<string, unknown>): void {
  try {
    const level = entry.level === 'error' ? 'error' : 'info';
    const attributes: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(entry)) {
      const value = entry[key];
      if (value !== undefined && !NOT_ATTRIBUTES.has(key)) attributes[key] = value as string | number | boolean;
    }
    logs.getLogger(`bob.${String(entry.module ?? entry.source)}`).emit({
      severityNumber: SEVERITY[level],
      severityText: level,
      body: String(entry.message),
      attributes,
      context: context.active(),
    });
  } catch {
    // Export is best effort: the console line is already written.
  }
}

/** Writes one entry to the console and the sink, and mirrors it to OTLP when configured. */
function writeJournalEntry(event: string, fields: JournalFields, origin: JournalOrigin): void {
  const entry = journalEntry(event, fields, origin);
  const line = JSON.stringify(entry);
  writeConsoleLine(line);
  journalSink?.(line);
  emitLogRecord(entry);
}

/** Emits a timestamped JSON journal entry with no module tag. */
export function journal(event: string, fields: JournalFields = {}): void {
  writeJournalEntry(event, fields, { source: 'api' });
}

/** A `journal`-compatible function that stamps every line with its module and source. */
export function moduleJournal(module: string, source: JournalSource = 'api'): Journal {
  return (event, fields = {}) => writeJournalEntry(event, fields, { source, module });
}
