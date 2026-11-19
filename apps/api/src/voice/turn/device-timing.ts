/**
 * The device's late per-turn timing summary (turn_timing), joined to the
 * server's turn by session + turn_ref and exported as its own detached
 * `device-turn-timing` span in the `device-turn` trace namespace. The server's
 * turn root never waits for it and is never reopened or rewritten.
 *
 * Correlation is bounded: a session remembers at most EXPECTED_CAPACITY turns
 * that negotiated the cap, each for RUNNING_TTL_MS while it runs and
 * SETTLED_TTL_MS after its pipeline unwound or was cancelled. A summary for a
 * turn this session never started (a wrong ref, or one from before a
 * reconnect: a new socket is a new session), an expired one, a duplicate or
 * one whose milestones are out of device-clock order is journaled as ignored
 * and nothing else: no error reply, since a device error mid-turn fails the
 * turn in flight. Device offsets are only compared with each other (one
 * clock), never with server time.
 */
import type { WebSocket } from 'ws';
import { recordObservationMetrics, toSpanAttrs, traceSpan, type ObservationMetricName } from '@bob/ai';
import { moduleJournal } from '../../platform/logger.ts';
import { socketHasCap } from '../device-caps.ts';
import { sessionBoard } from '../session-board.ts';
import type { ClientControlDto, SessionDto } from '../protocol.ts';
import { TURN_TIMING_MILESTONES, type TurnTimingDto, type TurnTimingMilestone, type TurnTimingPayload } from '../protocol-timing.ts';
import { deviceCorrelation } from '../socket-diagnostics.ts';
import { endOfTurnSource } from './end-of-turn.ts';
import { endOfTurnEvidence } from './stream-stt.ts';

const journal = moduleJournal('voice');

export const RUNNING_TTL_MS = 180_000;
export const SETTLED_TTL_MS = 60_000;
export const EXPECTED_CAPACITY = 8;

type Correlation = ReturnType<typeof deviceCorrelation>;
interface ExpectedTurn { expiresAt: number; settled: boolean; consumed: boolean; correlation: Correlation }

const expected = new WeakMap<SessionDto, Map<string, ExpectedTurn>>();

export type TimingVerdict = 'accepted' | 'not_negotiated' | 'unknown_turn' | 'expired' | 'duplicate' | 'out_of_order';

/** Drops expired turns, then the oldest until the map fits its capacity. */
function prune(turns: Map<string, ExpectedTurn>, now: number): void {
  for (const [ref, turn] of turns) if (turn.expiresAt <= now) turns.delete(ref);
  for (const ref of turns.keys()) {
    if (turns.size <= EXPECTED_CAPACITY) break;
    turns.delete(ref);
  }
}

/** An accepted turn_start on a socket that negotiated turn_timing: its summary is now expected. */
export function expectTurnTiming(socket: WebSocket, session: SessionDto, turnRef: string, userId?: string, now = Date.now()): void {
  if (!socketHasCap(socket, 'turn_timing')) return;
  const turns = expected.get(session) ?? new Map<string, ExpectedTurn>();
  expected.set(session, turns);
  turns.delete(turnRef);
  turns.set(turnRef, { expiresAt: now + RUNNING_TTL_MS, settled: false, consumed: false, correlation: deviceCorrelation(session, userId) });
  prune(turns, now);
}

/** The turn's pipeline unwound (or it was cancelled): the summary has SETTLED_TTL_MS from now. */
export function settleTurnTiming(session: SessionDto, turnRef: string, now = Date.now()): void {
  const turn = expected.get(session)?.get(turnRef);
  if (turn === undefined || turn.settled || turn.expiresAt <= now) return;
  turn.settled = true;
  turn.expiresAt = now + SETTLED_TTL_MS;
}

/** Retention follows the control just handled; it never delays the turn itself. */
export function trackTurnTiming(socket: WebSocket, session: SessionDto, dto: ClientControlDto, userId?: string, cancelledRef?: string): void {
  if (dto.type === 'turn_start' && session.stage === 'capturing' && session.turnRef === dto.turn_ref) {
    expectTurnTiming(socket, session, dto.turn_ref, userId);
  } else if (dto.type === 'turn_end' && session.turnRef === dto.turn_ref && session.turnDone !== undefined) {
    const turnRef = dto.turn_ref;
    void session.turnDone.then(() => settleTurnTiming(session, turnRef));
  } else if (dto.type === 'cancel' && cancelledRef !== undefined) {
    settleTurnTiming(session, cancelledRef);
  }
}

/** One device clock: capture before turn_end, and the reply's steps in the order they can happen. */
export function milestonesOrdered(payload: TurnTimingPayload): boolean {
  const at = (key: TurnTimingMilestone): number | undefined => payload[key] ?? undefined;
  const turnEnd = at('turn_end_ms');
  const beforeEnd = [at('capture_end_ms'), at('first_up_ms')];
  if (turnEnd !== undefined && beforeEnd.some((value) => value !== undefined && value > turnEnd)) return false;
  const reply = [turnEnd, at('playback_start_ms'), at('first_down_ms'), at('decoder_ready_ms'), at('speaker_submission_ms'), at('playback_end_ms')]
    .filter((value): value is number => value !== undefined);
  return reply.every((value, index) => index === 0 || value >= (reply[index - 1] ?? 0));
}

function verdictFor(socket: WebSocket, turn: ExpectedTurn | undefined, payload: TurnTimingPayload, now: number): TimingVerdict {
  if (!socketHasCap(socket, 'turn_timing')) return 'not_negotiated';
  if (turn === undefined) return 'unknown_turn';
  if (turn.expiresAt <= now) return 'expired';
  if (turn.consumed) return 'duplicate';
  return milestonesOrdered(payload) ? 'accepted' : 'out_of_order';
}

/** Milestone names in a bounded, fixed vocabulary: which were skipped (null) and which unknown (absent). */
function milestoneStates(payload: TurnTimingPayload): { skipped: string; unknown: string } {
  const skipped = TURN_TIMING_MILESTONES.filter((key) => payload[key] === null);
  const unknown = TURN_TIMING_MILESTONES.filter((key) => payload[key] === undefined);
  return { skipped: skipped.join(',') || 'none', unknown: unknown.join(',') || 'none' };
}

/** `from` to speaker submission on the device clock, when both were measured and in order:
 *  capture end (the user stopping) or the last voiced frame (the user's last word) to Bob speaking. */
function toSpeakerMs(from: number | null | undefined, payload: TurnTimingPayload): number | undefined {
  const submitted = payload.speaker_submission_ms;
  return typeof from === 'number' && typeof submitted === 'number' && submitted >= from ? submitted - from : undefined;
}

/** Measured offsets, frame counts and the one same-clock interval worth charting. */
function timingSamples(payload: TurnTimingPayload): { name: ObservationMetricName; value: number }[] {
  const samples: { name: ObservationMetricName; value: number }[] = [];
  for (const key of TURN_TIMING_MILESTONES) {
    const value = payload[key];
    if (typeof value === 'number') samples.push({ name: `device.turn.${key}`, value });
  }
  samples.push({ name: 'device.turn.up_frames', value: payload.up_frames }, { name: 'device.turn.down_frames', value: payload.down_frames });
  const stopToSpeaker = toSpeakerMs(payload.capture_end_ms, payload);
  if (stopToSpeaker !== undefined) samples.push({ name: 'device.turn.end_to_speaker_ms', value: stopToSpeaker });
  const speechEndToSpeaker = toSpeakerMs(payload.speech_end_ms, payload);
  if (speechEndToSpeaker !== undefined) samples.push({ name: 'device.turn.speech_end_to_speaker_ms', value: speechEndToSpeaker });
  return samples;
}

/** Journal fields: measured offsets as numbers, skipped ones as 'skipped'; unknown ones are left out. */
function journalOffsets(payload: TurnTimingPayload): Record<string, number | string> {
  const fields: Record<string, number | string> = {};
  for (const key of TURN_TIMING_MILESTONES) {
    const value = payload[key];
    if (value !== undefined) fields[key] = value ?? 'skipped';
  }
  // A later firmware's fields; an older one omits them.
  if (payload.speech_end_ms !== undefined) fields.speech_end_ms = payload.speech_end_ms ?? 'skipped';
  const speechEndToSpeaker = toSpeakerMs(payload.speech_end_ms, payload);
  if (speechEndToSpeaker !== undefined) fields.speech_end_to_speaker_ms = speechEndToSpeaker;
  for (const key of ['uplink_backlog', 'mic_fps', 'tx_busy', 'tx_busy_max_ms'] as const) {
    const value = payload[key];
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

/** Who closed the turn's capture: the device's own timing decides it when the summary has the offsets. */
function eotFields(session: SessionDto, dto: TurnTimingDto): { eot_source: string; eot_basis: string } {
  const { payload } = dto;
  return endOfTurnSource({
    ...endOfTurnEvidence(session, dto.turn_ref),
    timing: { source: payload.source, endReason: payload.end_reason, speechEndMs: payload.speech_end_ms, captureEndMs: payload.capture_end_ms },
  });
}

function exportTiming(session: SessionDto, dto: TurnTimingDto, correlation: Correlation): void {
  const { payload } = dto;
  const states = milestoneStates(payload);
  const board = sessionBoard(session);
  const stopToSpeaker = toSpeakerMs(payload.capture_end_ms, payload);
  void traceSpan('device-turn-timing', {
    ...toSpanAttrs({
      surface: 'device', workflowNamespace: session.id, turnId: dto.turn_ref, ...correlation,
      metadata: {
        activation_source: payload.source, board, capture_end_reason: payload.end_reason, outcome: payload.outcome,
        muted: String(payload.muted), format: session.formatId === 2 ? 'mp3' : 'pcm16',
        skipped_milestones: states.skipped, unknown_milestones: states.unknown,
      },
    }),
    traceName: 'device-turn', detached: true, tags: ['device'],
  }, () => {
    recordObservationMetrics(timingSamples(payload));
    journal('v2.device_turn_timing', {
      session: session.id, turn_id: dto.turn_ref, board, activation_source: payload.source, end_reason: payload.end_reason,
      outcome: payload.outcome, muted: payload.muted, ...journalOffsets(payload), ...eotFields(session, dto),
      ...(stopToSpeaker !== undefined ? { stop_to_speaker_ms: stopToSpeaker } : {}),
      up_frames: payload.up_frames, down_frames: payload.down_frames,
    });
  });
}

/** Judges and, when accepted, exports one turn_timing control. Never answers the device. */
export function acceptTurnTiming(
  ctx: { socket: WebSocket; session: SessionDto }, dto: Extract<ClientControlDto, { type: 'turn_timing' }>, now = Date.now(),
): TimingVerdict {
  const { socket, session } = ctx;
  const turns = expected.get(session);
  const turn = turns?.get(dto.turn_ref);
  const verdict = verdictFor(socket, turn, dto.payload, now);
  if (turns !== undefined) prune(turns, now);
  if (verdict !== 'accepted' || turn === undefined) {
    journal('v2.device_turn_timing_ignored', { session: session.id, turn_id: dto.turn_ref, reason: verdict });
    return verdict;
  }
  turn.consumed = true;
  exportTiming(session, dto, turn.correlation);
  return verdict;
}

/** The control handler: the verdict is journaled, never sent. */
export function handleTurnTiming(ctx: { socket: WebSocket; session: SessionDto }, dto: Extract<ClientControlDto, { type: 'turn_timing' }>): void {
  acceptTurnTiming(ctx, dto);
}
