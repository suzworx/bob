import { recordObservationMetrics, toSpanAttrs, traceSpan } from '@bob/ai';
import type { SessionDto } from '../protocol.ts';
import type { PacerState } from './pacing.ts';

/**
 * Exports one `ws.downlink` span for a reply: from the first frame
 * handed to the socket to now, with why it stopped and bounded counters. A
 * socket send is not device receipt or playback. A reply that sent nothing,
 * waited for nothing and was not stopped exports nothing.
 */
export async function flushDownlink(session: SessionDto, pacer: PacerState): Promise<void> {
  const idle = pacer.framesSent === 0 && pacer.pacingWaitMs === 0 && pacer.backpressureWaitMs === 0;
  if (idle && pacer.outcome === 'completed') return;
  await traceSpan('ws.downlink', {
    ...toSpanAttrs({
      surface: 'device', workflowNamespace: session.id,
      ...(session.turnRef !== undefined ? { turnId: session.turnRef } : {}),
      metadata: { outcome: pacer.outcome },
    }),
    ...(pacer.firstSentAt !== 0 ? { startTime: new Date(pacer.firstSentAt) } : {}),
  }, () => recordObservationMetrics([
    { name: 'ws.downlink.frames', value: pacer.framesSent },
    { name: 'ws.downlink.bytes', value: pacer.bytesSent },
    { name: 'ws.downlink.pacing_wait_ms', value: Math.round(pacer.pacingWaitMs) },
    { name: 'ws.downlink.backpressure_wait_ms', value: Math.round(pacer.backpressureWaitMs) },
  ]));
}
