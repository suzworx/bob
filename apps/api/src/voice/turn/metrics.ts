// Per-turn metrics: timings, usage and outcome only. No method takes text.
import { deriveIntent } from '@bob/ai';
import { toTurnMetricRow, type TurnMetricInput, type TurnMetricRow } from '../../platform/observability/turn-metrics.ts';
import { userBucket } from '../../platform/observability/user-bucket.ts';
import { sessionUserId, type DeviceSession } from '../session-handlers.ts';
import type { SessionDto } from '../protocol.ts';
import type { TurnFailure, TurnStage } from '../turn-core.ts';
import type { TurnDeps } from './deps.ts';
import type { ReplyMetrics } from './generate.ts';

/** The hello's fw_version placeholders; they say nothing about the firmware. */
const NO_FIRMWARE: ReadonlySet<string> = new Set(['unknown', 'invalid']);

export interface TurnMetrics {
  stt(ms: number): void;
  agent(reply: { streamed: boolean; metrics?: ReplyMetrics }): void;
  firstToken(ms: number): void;
  playback(result: { firstAudioAt: number | null; ttsTotalMs?: number }, turnStartedAt: number): void;
  empty(): void;
  /** Completes the turn; an empty turn stays empty. */
  complete(interrupted?: boolean): void;
  cancel(interrupted?: boolean): void;
  fail(stage: TurnStage, failure: TurnFailure): void;
  build(args: { totalMs: number; accountId?: string; fwVersion?: string }): TurnMetricRow;
}

export function createTurnMetrics(surface: 'device'): TurnMetrics {
  // An exit that sets no outcome is an unexpected throw, so the default is a failure.
  const row: TurnMetricInput = { surface, outcome: 'failed' };
  return {
    stt(ms) { row.stt_ms = ms; },
    agent(reply) {
      row.streamed = reply.streamed;
      if (reply.metrics === undefined) return;
      row.prep_ms = reply.metrics.prepMs;
      row.model_ms = reply.metrics.modelMs;
      row.usage = reply.metrics.usage;
    },
    firstToken(ms) { row.first_token_ms ??= ms; },
    playback({ firstAudioAt, ttsTotalMs }, turnStartedAt) {
      if (ttsTotalMs !== undefined) row.tts_ms = ttsTotalMs;
      if (firstAudioAt !== null) row.first_audio_ms = firstAudioAt - turnStartedAt;
      // tts_cache_hit stays unset: the speech cache does not report hits to the pipeline.
    },
    empty() { row.outcome = 'empty'; },
    complete(interrupted = false) {
      if (row.outcome !== 'empty') row.outcome = 'completed';
      if (interrupted) row.interrupted = true;
    },
    cancel(interrupted = false) {
      row.outcome = 'cancelled';
      if (interrupted) row.interrupted = true;
    },
    fail(stage, failure) {
      row.outcome = 'failed';
      row.failed_stage = stage;
      row.failure_kind = failure.kind;
      row.upstream_status = failure.upstreamStatus;
    },
    build({ totalMs, accountId, fwVersion }) {
      const tools = (row.usage?.called_tools ?? '').split(',').filter((name) => name !== '');
      return toTurnMetricRow({
        ...row,
        total_ms: totalMs,
        called_tools: tools,
        ...(row.usage !== undefined ? { intent: deriveIntent(tools) } : {}),
        user_bucket: userBucket(accountId) ?? undefined,
        fw_version: fwVersion !== undefined && !NO_FIRMWARE.has(fwVersion) ? fwVersion : undefined,
      });
    },
  };
}

/** Records the turn's one row. Never throws: a metrics problem must not reach the device. */
export function recordTurnMetrics(deps: Pick<TurnDeps, 'recordTurnMetric'>, metrics: TurnMetrics, session: SessionDto, turnStartedAt: number): void {
  try {
    const device = session as DeviceSession;
    deps.recordTurnMetric?.(metrics.build({ totalMs: Date.now() - turnStartedAt, accountId: sessionUserId(device), fwVersion: device.fwVersion }));
  } catch {
    // Dropping one row is the whole cost of a failed metric.
  }
}
