/**
 * Conversation-mode metrics (013 R8, FR-031..FR-034): batches metadata-only
 * telemetry events on the client and posts them to POST /api/telemetry. A
 * batch flushes on size or a fixed interval, and on pagehide / hidden so
 * nothing is lost when the page unloads. Events are best-effort: a transport
 * error never throws, and a queue that would exceed 100 held events drops the
 * oldest instead. The payload carries bounded numbers and state names only --
 * never audio, transcripts, or assistant text (FR-034).
 */
import { authHeaders } from '../../../lib/auth/use-session';

type VoiceModeState = 'off' | 'listening' | 'hearing_you' | 'thinking' | 'speaking' | 'muted' | 'paused';

export type TelemetryEvent =
  | {
      event: 'turn_timing';
      eos_to_first_audio_ms: number;
      stt_ms?: number;
      agent_first_token_ms?: number;
      tts_first_audio_ms?: number;
      trace_id?: string;
    }
  | { event: 'reply_feedback'; trace_id: string; positive: boolean }
  | { event: 'barge_in'; reaction_ms: number }
  | { event: 'false_trigger'; count: number }
  | { event: 'mode_state'; from: VoiceModeState; to: VoiceModeState }
  | { event: 'mode_off'; reason: 'idle' | 'user' | 'hidden' | 'lock_denied' | 'error' };

export interface MetricsOptions {
  /** The transport. Defaults to fetch with keepalive and the app's auth header. */
  send?: (events: TelemetryEvent[]) => Promise<void>;
  /** Clock for flush deadlines; defaults to Date.now. Injectable for tests. */
  now?: () => number;
  /** Interval between time-based flushes. Default 10 s. */
  flushMs?: number;
  /** Batch size that triggers an eager flush. Default 20. */
  maxBatch?: number;
  /** Registers the "page is going away / hidden" flush; returns an unsubscribe. */
  onHidden?: (callback: () => void) => () => void;
}

export interface Metrics {
  record(event: TelemetryEvent): void;
  flush(): Promise<void>;
}

/** At most this many events are ever held; beyond it the oldest are dropped. */
const MAX_QUEUED = 100;

/**
 * Default transport: fetch with `keepalive: true` and the app's auth header.
 * Deliberately NOT sendBeacon -- sendBeacon cannot carry the Authorization
 * header the JWT guard requires.
 */
export async function sendTelemetryEvents(events: TelemetryEvent[]): Promise<void> {
  const headers = await authHeaders();
  await fetch('/api/telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ events }),
    keepalive: true,
  });
}

/** Default hidden hook: flush on pagehide and whenever the page becomes hidden. */
function defaultOnHidden(callback: () => void): () => void {
  const onPageHide = (): void => callback();
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') callback();
  };
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

export function createMetrics({
  send = sendTelemetryEvents,
  now = () => Date.now(),
  flushMs = 10000,
  maxBatch = 20,
  onHidden = defaultOnHidden,
}: MetricsOptions = {}): Metrics & { dispose(): void } {
  const intervalMs = flushMs > 0 ? flushMs : 10000;
  const batchSize = maxBatch > 0 ? maxBatch : 20;
  let buffer: TelemetryEvent[] = [];
  let deadline = now() + intervalMs;
  let chain: Promise<void> = Promise.resolve();

  const flushNow = (): Promise<void> => {
    const batch = buffer;
    buffer = [];
    if (batch.length === 0) return Promise.resolve();
    deadline = now() + intervalMs;
    // Single attempt, serialized behind any in-flight send. A transport error
    // is dropped, never thrown -- telemetry is best-effort.
    const attempt = send(batch).catch(() => undefined);
    chain = chain.then(() => attempt);
    return chain;
  };

  const timer = setInterval(() => {
    void flushNow();
  }, intervalMs);
  const unsubscribe = onHidden(() => {
    void flushNow();
  });

  return {
    dispose(): void { clearInterval(timer); unsubscribe(); void flushNow(); },
    record(event: TelemetryEvent): void {
      if (buffer.length >= MAX_QUEUED) buffer.shift();
      buffer.push(event);
      if (buffer.length >= batchSize || now() >= deadline) {
        void flushNow();
      }
    },
    async flush(): Promise<void> {
      await flushNow();
    },
  };
}