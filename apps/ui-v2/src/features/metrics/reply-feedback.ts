import { sendTelemetryEvents } from '@/features/voice/mode/metrics';

const TRACE_ID = /^[0-9a-f]{32}$/;

/** Only the server's actual trace id may receive reply feedback. */
export function messageTraceId(message: { metadata?: unknown }): string | undefined {
  const metadata = message.metadata;
  if (typeof metadata !== 'object' || metadata === null || !('traceId' in metadata)) return undefined;
  return typeof metadata.traceId === 'string' && TRACE_ID.test(metadata.traceId)
    ? metadata.traceId : undefined;
}

/** Thumbs up/down on a finished reply, sent through /api/telemetry. Best effort, never throws. */
export async function sendReplyFeedback(traceId: string, positive: boolean): Promise<void> {
  if (!TRACE_ID.test(traceId)) return;
  try {
    await sendTelemetryEvents([{ event: 'reply_feedback', trace_id: traceId, positive }]);
  } catch {
    // Telemetry is best-effort.
  }
}
