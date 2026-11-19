import { deriveIntent } from '@bob/ai';
import { agentUsageFields, classifyFailure, type AgentUsageStep } from '../voice/turn-core.ts';
import { toTurnMetricRow, type TurnMetricInput, type TurnMetricRow } from '../platform/observability/turn-metrics.ts';
import { userBucket } from '../platform/observability/user-bucket.ts';
import { attachmentBytes } from './schemas.ts';
import type { RecentMessage } from './store.ts';
import type { WebChatDeps } from './chat-tools.ts';
import { journalTurnStage } from '../voice/turn-journal.ts';
import type { PrepTimings } from '../turn/prep-kit.ts';

// Helpers of one web chat turn (workflows/workflow-web-chat-turn.ts): attachment counts, partial-reply
// recovery, the prep step timings and their journal events, and the privacy-safe metrics row and failure
// fields. No I/O except the injected metric sink and the metadata-only journal.

/** Attachment count and decoded bytes on a message -- counts only, never names or content. */
function attachmentSummary(parts: unknown[]): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const part of parts) {
    const size = attachmentBytes(part);
    if (size === 0) continue;
    count += 1;
    bytes += size;
  }
  return { count, bytes };
}

export function storedToUiMessages(messages: RecentMessage[]): Array<{ id: string; role: string; parts: unknown[] }> {
  return messages.map((message) => ({ id: message.id, role: message.role, parts: message.parts }));
}

/**
 * Best-effort reconstruction of an aborted reply from the raw SSE bytes the
 * route already pumped. Only text deltas are recovered; reasoning and tool
 * parts lost mid-stream are gone, which is honest about what the reader saw.
 */
export function recoverPartialReply(rawChunks: string[]): Array<Record<string, unknown>> | null {
  const text = rawChunks.join('');
  let accumulated = '';
  for (const line of text.split('\n')) {
    const payload = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { type?: string; delta?: string };
      if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
        accumulated += chunk.delta;
      }
    } catch {
      // A split JSON line across chunk boundaries; skip rather than guess.
    }
  }
  if (!accumulated.trim()) return null;
  return [{ type: 'text', text: accumulated }];
}

/** The web turn's one privacy-safe metrics row: numbers, enums and usage steps only, never text. */
export interface WebTurnMetricInput {
  surface: 'web_text' | 'web_voice';
  outcome: 'completed' | 'failed' | 'cancelled';
  failedStage?: 'input' | 'agent';
  failure?: { kind: NonNullable<TurnMetricInput['failure_kind']>; upstreamStatus?: number };
  /** When chat-http's handler received the request (arrival_ms); absent for callers that pass none. */
  receivedAt?: number;
  startedAt: number;
  modelStartedAt?: number;
  firstTokenAt?: number | null;
  endedAt: number;
  steps: readonly AgentUsageStep[];
  interrupted: boolean;
  accountId: string;
}

/** Each prep step's own ms (`timings`, overlapping) and the critical-path waits (`waits`, from `startedAt`, the prep
 *  start after the conversation is found, to the model call). */
export interface WebPrepClock { turnId: string; conversationId: string; receivedAt: number | undefined; startedAt: number; modelStartedAt: number; timings: PrepTimings; waits: PrepTimings }

/** One web `v2.turn_stage_prep_completed`: ms only, never text, message ids beyond the turn's, or URLs. The waits
 *  and other_ms sum to prep_ms. */
export function journalWebPrep(clock: WebPrepClock): void {
  const prepMs = clock.modelStartedAt - clock.startedAt;
  const waited = Object.values(clock.waits).reduce((total, ms) => total + ms, 0);
  journalTurnStage({
    interface: 'web',
    turnId: clock.turnId,
    stage: 'prep',
    outcome: 'completed',
    fields: {
      conversation_id: clock.conversationId,
      ...(clock.receivedAt !== undefined ? { arrival_ms: clock.modelStartedAt - clock.receivedAt } : {}),
      prep_ms: prepMs,
      prep_source: 'inline',
      ...clock.timings,
      ...clock.waits,
      other_ms: Math.max(0, prepMs - waited),
    },
  });
}

/** Journals the web agent stage start (attachment counts and byte totals only, never names or bytes) and
 *  returns the replayed history's attachment bytes. */
export function journalWebAgentStarted(turnId: string, conversationId: string, incomingParts: unknown[], uiMessages: ReadonlyArray<{ parts?: unknown[] }>): number {
  const incoming = attachmentSummary(incomingParts);
  let replayed = 0;
  let replayedCount = 0;
  for (const entry of uiMessages) {
    const summary = attachmentSummary(entry.parts ?? []);
    replayed += summary.bytes;
    replayedCount += summary.count;
  }
  journalTurnStage({
    interface: 'web',
    turnId,
    stage: 'agent',
    outcome: 'started',
    fields: {
      messages: uiMessages.length,
      conversation_id: conversationId,
      attachments: incoming.count,
      attachment_bytes: incoming.bytes,
      history_attachments: replayedCount,
      history_attachment_bytes: replayed,
    },
  });
  return replayed;
}

function buildWebTurnMetric(input: WebTurnMetricInput): TurnMetricRow {
  const usage = agentUsageFields({ steps: input.steps });
  const tools = usage.called_tools.split(',').filter((name) => name !== '');
  const { modelStartedAt, firstTokenAt, receivedAt } = input;
  return toTurnMetricRow({
    surface: input.surface,
    outcome: input.outcome,
    ...(input.outcome === 'failed' ? { failed_stage: input.failedStage ?? 'agent', failure_kind: input.failure?.kind, upstream_status: input.failure?.upstreamStatus } : {}),
    ...(modelStartedAt !== undefined ? { prep_ms: modelStartedAt - input.startedAt, model_ms: input.endedAt - modelStartedAt } : {}),
    ...(modelStartedAt !== undefined && receivedAt !== undefined ? { arrival_ms: modelStartedAt - receivedAt } : {}),
    ...(firstTokenAt != null ? { first_token_ms: firstTokenAt - input.startedAt } : {}),
    total_ms: input.endedAt - input.startedAt,
    usage,
    called_tools: tools,
    intent: deriveIntent(tools),
    user_bucket: userBucket(input.accountId) ?? undefined,
    streamed: true,
    interrupted: input.interrupted,
  });
}

/** How the turn ended: a Stop or the timeout is a cancel; a reader leaving mid-reply is a completed turn marked interrupted. */
export interface WebTurnEnd extends Omit<WebTurnMetricInput, 'outcome' | 'interrupted'> {
  failed: boolean;
  stopped: boolean;
  timedOut: boolean;
  clientGone: boolean;
}

/** Never throws: a metrics problem must not reach the reader. */
export function recordWebTurnMetric(deps: Pick<WebChatDeps, 'recordTurnMetric'>, end: WebTurnEnd): void {
  try {
    const cancelled = end.stopped || end.timedOut;
    const interrupted = cancelled || (end.clientGone && !end.failed);
    deps.recordTurnMetric?.(buildWebTurnMetric({ ...end, outcome: cancelled ? 'cancelled' : end.failed ? 'failed' : 'completed', interrupted }));
  } catch {
    // Dropping one row is the whole cost of a failed metric.
  }
}

type ClassifiedFailure = ReturnType<typeof classifyFailure>;

export function failureNoteOf(failure: ClassifiedFailure, invalid: boolean): Pick<WebTurnMetricInput, 'failedStage' | 'failure'> {
  return {
    failedStage: invalid ? 'input' : 'agent',
    failure: { kind: failure.kind, ...(failure.upstreamStatus !== undefined ? { upstreamStatus: failure.upstreamStatus } : {}) },
  };
}

/** The journalled fields of a failed web turn: enum values and flags only, never content. */
export function failureFields(failure: ClassifiedFailure, reason: string): Record<string, string | boolean | number> {
  return {
    kind: failure.kind,
    error_name: failure.errorName,
    ...(failure.upstreamStatus !== undefined ? { upstream_status: failure.upstreamStatus } : {}),
    ...(failure.timedOut ? { timed_out: true } : {}),
    reason,
  };
}
