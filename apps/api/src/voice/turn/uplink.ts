import { recordObservationMetrics, traceSpan } from '@bob/ai';
import { DOWNLINK_FRAME_BYTES, type SessionDto, type V2ErrorCode } from '../protocol.ts';
import { deviceCorrelation } from '../socket-diagnostics.ts';
import { runInTurnRoot, turnRootOf } from './turn-root.ts';

/** 10 ms PCM16 frames in `bytes` of uplink: a message may batch several, so frames are counted from bytes, never messages. */
export function pcmFrames(bytes: number): number {
  return Math.floor(bytes / DOWNLINK_FRAME_BYTES);
}

type UplinkSummary = { accepted: number; rejected: number; bytes: number; started: Date; error?: V2ErrorCode };
const uplink = new WeakMap<SessionDto, UplinkSummary>();

/** No span per audio frame: keep bounded counters, exported once when the turn resets/closes. */
export function countUplink(session: SessionDto, bytes: number, error?: V2ErrorCode): void {
  const summary = uplink.get(session) ?? { accepted: 0, rejected: 0, bytes: 0, started: new Date() };
  if (error === undefined) {
    summary.accepted = Math.min(4294967295, summary.accepted + 1);
    summary.bytes = Math.min(4294967295, summary.bytes + bytes);
  } else {
    summary.rejected = Math.min(4294967295, summary.rejected + 1);
    summary.error = error;
  }
  uplink.set(session, summary);
}

/**
 * Exports the session's uplink counters as one `ws.uplink` span, nested under the turn's root when it is open.
 * An accepted turn_end calls it, so the span is the receive window only, not STT, agent or playback.
 * Reset calls it again: frames after turn_end, or a cancelled or disconnected capture, become their own span.
 */
export function flushUplink(session: SessionDto, userId?: string): void {
  const summary = uplink.get(session);
  if (summary === undefined) return;
  uplink.delete(session);
  const inRoot = session.turnRef !== undefined && turnRootOf(session)?.turnRef === session.turnRef;
  void runInTurnRoot(session, session.turnRef, () => traceSpan('ws.uplink', {
    ...(inRoot ? {} : { detached: true }), startTime: summary.started, tags: ['device'],
    ...(session.turnRef ? { workflowNamespace: session.id, turnId: session.turnRef, traceName: 'device-turn' } : {}),
    ...deviceCorrelation(session, userId),
    metadata: { outcome: summary.rejected > 0 ? 'rejected' : 'ok',
      ...(summary.error ? { error_code: summary.error } : {}) },
  }, () => recordObservationMetrics([
    { name: 'ws.uplink.accepted_frames', value: pcmFrames(summary.bytes) },
    { name: 'ws.uplink.rejected_frames', value: summary.rejected },
    { name: 'ws.uplink.bytes', value: summary.bytes },
  ])));
}
