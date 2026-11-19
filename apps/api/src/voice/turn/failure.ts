import type { WebSocket } from 'ws';
import { debugLog } from '@bob/ai';
import { replyTextDto, type SessionDto } from '../protocol.ts';
import { moduleJournal } from '../../platform/logger.ts';
import { noteBudgetExhausted } from '../../platform/observability/budget-alarm.ts';
import { socketHasCap } from '../device-caps.ts';
import { sendDto, sendError, sendStatus } from '../session-handlers.ts';
import { sessionBoard } from '../session-board.ts';
import {
  classifyFailure,
  type TurnFailure,
  type TurnStage,
} from '../turn-core.ts';
import { journalTurnStage } from '../turn-journal.ts';
import { markTurnFailed } from './turn-root.ts';

const journal = moduleJournal('voice');

/** What the device shows when the AI budget is spent. Plain, and it
 *  claims nothing was done. */
export const OUT_OF_CREDIT_REPLY = "Sorry, I can't think right now. The service is out of credit.";

/** The note before the agent's real reply when only speech (TTS) is out
 *  of credit. The reply stays: it may report what a tool really did. */
export const SPEECH_OUT_OF_CREDIT_REPLY = "Sorry, I can't speak right now. The service is out of credit.";

/** The card's reply for a 402 at `stage`: at stt or agent nothing was done, at
 *  tts the agent's reply (when there is one) follows the speech note. */
function outOfCreditReply(stage: TurnStage, agentReply: string | undefined): string {
  if (stage !== 'tts') return OUT_OF_CREDIT_REPLY;
  return agentReply ? `${SPEECH_OUT_OF_CREDIT_REPLY} ${agentReply}` : SPEECH_OUT_OF_CREDIT_REPLY;
}

/** The out-of-credit card as reply_text. heard is empty: on a follow-up turn
 *  that ends the device's follow-up chain (follow_up.h), so a spent budget
 *  does not keep listening. False when the firmware lacks the reply_text cap. */
function sendOutOfCreditCard(socket: WebSocket, turnRef: string, stage: TurnStage, agentReply: string | undefined): boolean {
  if (!socketHasCap(socket, 'reply_text')) return false;
  sendDto(socket, replyTextDto(turnRef, '', outOfCreditReply(stage, agentReply)));
  return true;
}

/**
 * A spent budget (402) ends the turn on the reply card instead of the
 * generic "Something went wrong": reply_text then status idle, the way an
 * empty hands-free turn ends, so the device shows the card and is READY.
 * Speech is billed to the same budget, so nothing is spoken. A first
 * wake-word turn may still open one follow-up window (the firmware ends the
 * chain only on a follow-up turn heard as nothing), whose turn meets the same
 * card and ends the chain. False (send INTERNAL instead) for firmware without
 * the reply_text cap, which would end the turn silently.
 */
function endOnOutOfCreditCard(socket: WebSocket, session: SessionDto, turnRef: string, stage: TurnStage, agentReply: string | undefined): boolean {
  if (!sendOutOfCreditCard(socket, turnRef, stage, agentReply)) return false;
  sendStatus(socket, session, 'idle', turnRef);
  return true;
}

/** A streamed reply's TTS failed after some of it played (cut tts_failed):
 *  the audio sent still plays and playback_end follows, so no error.
 *  Journals the stage; a 402 is also alarmed and replaces the card with the
 *  speech note. Called before playback_end, while the device holds the turn. */
export function journalSpeechCut(
  socket: WebSocket,
  session: SessionDto,
  turnRef: string,
  error: unknown,
  turnStartedAt: number,
  agentReply: string,
): void {
  const failure = classifyFailure('tts', error);
  journalStageFailed(session, turnRef, failure, turnStartedAt);
  if (noteBudgetExhausted(failure, 'device')) sendOutOfCreditCard(socket, turnRef, 'tts', agentReply);
}

/** Journals a failed stage with its classified fields (names only, never
 *  messages). Shared by failTurn and the STT-rejected-audio path. */
export function journalStageFailed(session: SessionDto, turnRef: string, failure: TurnFailure, turnStartedAt: number): void {
  journalTurnStage({
    interface: 'cardputer', turnId: turnRef, stage: failure.stage, outcome: 'failed',
    fields: {
      board: sessionBoard(session),
      duration_ms: Date.now() - turnStartedAt,
      conversation_id: session.activeConversationId,
      kind: failure.kind,
      error_name: failure.errorName,
      upstream_status: failure.upstreamStatus,
      timed_out: failure.timedOut,
    },
  });
}

/** The STT provider refused the clip itself, so the turn ends
 *  as "I did not hear anything" instead of INTERNAL. Journals the mapping. */
export function journalSttRejectedAudio(session: SessionDto, turnRef: string, failure: TurnFailure, turnStartedAt: number): void {
  journalStageFailed(session, turnRef, failure, turnStartedAt);
  journal('v2.turn_stt_rejected', {
    session: session.id,
    turn_id: turnRef,
    kind: failure.kind,
    error_name: failure.errorName,
    upstream_status: failure.upstreamStatus,
  });
}

/** Journals a failed stage and the turn-level failure, then sends the device
 *  INTERNAL, or the out-of-credit card for a spent budget (402, also alarmed).
 *  `notifyDevice` false journals only: streamed audio already playing
 *  ended cleanly, and an error would make the device abort it. `agentReply`
 *  (tts only) is the reply already on the card, kept after the speech note. */
export function failTurn(
  socket: WebSocket,
  session: SessionDto,
  turnRef: string,
  stage: TurnStage,
  error: unknown,
  turnStartedAt: number,
  notifyDevice = true,
  agentReply?: string,
): TurnFailure {
  const failure = classifyFailure(stage, error);
  const outOfCredit = noteBudgetExhausted(failure, 'device');
  markTurnFailed(session);
  journalStageFailed(session, turnRef, failure, turnStartedAt);
  journal('v2.turn_failed', {
    session: session.id,
    conversation_id: session.activeConversationId,
    stage,
    kind: failure.kind,
    error_name: failure.errorName,
    upstream_status: failure.upstreamStatus,
    timed_out: failure.timedOut,
  });
  debugLog('turn.failed', {
    session: session.id,
    turn_ref: turnRef,
    stage,
    kind: failure.kind,
    error_name: failure.errorName,
    // Name and stack only -- never error.message or cause text, which can
    // carry provider response bodies.
    stack: error instanceof Error ? error.stack : undefined,
    total_ms: Date.now() - turnStartedAt,
  });
  if (!notifyDevice) return failure;
  if (!outOfCredit || !endOnOutOfCreditCard(socket, session, turnRef, stage, agentReply)) sendError(socket, session, 'INTERNAL');
  return failure;
}
