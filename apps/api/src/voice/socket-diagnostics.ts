import type { NextFunction, Request } from 'express';
import type { WSResponse } from 'websocket-express';
import { recordObservationMetrics, traceSpan } from '@bob/ai';
import type { SessionDto, V2ErrorCode } from './protocol.ts';
import { canonicalId } from '../platform/ids.ts';

const UPGRADE_REASONS = new Set(['invalid_token', 'auth_unavailable', 'too_many_unpaired', 'too_many_sessions', 'rate_limited']);

/** Installed before auth/rate guards: every upgrade attempt reaches one terminal outcome. */
export function diagnoseUpgrade(request: Request, response: WSResponse, next: NextFunction): void {
  const startTime = new Date();
  const started = performance.now();
  let finished = false;
  const finish = (outcome: 'accepted' | 'rejected' | 'failed' | 'closed', status: number, reason?: string | null): void => {
    if (finished) return;
    finished = true;
    request.socket.off('close', closed);
    void traceSpan('ws.upgrade', { detached: true, startTime, tags: ['device'], metadata: {
      outcome, http_status: String(status), ...(reason && UPGRADE_REASONS.has(reason) ? { reason } : {}),
    } }, () => recordObservationMetrics([
      { name: 'workflow.duration_ms', value: Math.max(0, Math.round(performance.now() - started)) },
      { name: 'workflow.failed', value: Number(outcome === 'failed' || status >= 500) },
      { name: 'workflow.rejected', value: Number(outcome === 'rejected') },
    ]));
  };
  const closed = (): void => finish('closed', 0);
  const accept = response.accept.bind(response);
  const reject = response.reject.bind(response);
  response.accept = async () => {
    try {
      const socket = await accept();
      finish('accepted', 101);
      return socket;
    } catch (error) {
      finish('failed', 0);
      throw error;
    }
  };
  response.reject = (status, reason): void => {
    finish('rejected', status ?? 400, reason);
    reject(status, reason);
  };
  request.socket.once('close', closed);
  next();
}

/** The three independent ids of a device session's spans: client session (the WebSocket session id),
 *  the acting account when paired, and the active conversation (canonical) when known. */
export interface DeviceCorrelation { sessionId: string; userId?: string; conversationId?: string; conversationSource?: 'device' }

/** The correlation of the session's next spans, derived from the session each time (switching conversation changes it). The one place a device ref becomes a canonical conversation id. */
export function deviceCorrelation(session: SessionDto, userId?: string): DeviceCorrelation {
  const conversationId = session.activeConversationId === undefined ? null : canonicalId('conversation', session.activeConversationId);
  return {
    sessionId: session.id,
    ...(userId !== undefined ? { userId } : {}),
    ...(conversationId !== null ? { conversationId, conversationSource: 'device' as const } : {}),
  };
}

/** Invalid controls never contribute their unvalidated type or content. */
export function rejectInvalidControl(code: V2ErrorCode): void {
  void traceSpan('ws.control.invalid', { detached: true, tags: ['device'], metadata: { outcome: 'rejected', error_code: code } },
    () => recordObservationMetrics([{ name: 'ws.control.rejected', value: 1 }]));
}

export function socketSummary(): { ping(): void; pong(): void; timeout(): void; error(): void; close(code: number): void } {
  const started = new Date();
  let heartbeats = 0;
  let failed = false;
  let reason: 'closed' | 'heartbeat_timeout' | 'socket_error' = 'closed';
  return {
    ping(): void { heartbeats = Math.min(4294967295, heartbeats + 1); },
    pong(): void { heartbeats = Math.min(4294967295, heartbeats + 1); },
    timeout(): void { failed = true; reason = 'heartbeat_timeout'; },
    error(): void { failed = true; reason = 'socket_error'; },
    close(code): void {
      void traceSpan('ws.session', { detached: true, startTime: started, tags: ['device'], metadata: {
        outcome: failed || code === 1006 ? 'failed' : 'ok', reason, action: 'heartbeat_summary', frames: String(heartbeats),
        status: String(code),
      } }, () => recordObservationMetrics([
        { name: 'workflow.duration_ms', value: Math.min(604800000, Math.max(0, Date.now() - started.getTime())) },
        { name: 'workflow.failed', value: Number(failed || code === 1006) },
      ]));
    },
  };
}
