import { sessionBoard } from '../session-board.ts';
import { NoTranscriptGeneratedError } from 'ai';
import { debugLog, traceSpan, toSpanAttrs } from '@bob/ai';
import { type SessionDto } from '../protocol.ts';
import { journalTurnStage } from '../turn-journal.ts';
import { abortable } from './abort.ts';
import type { TurnDeps } from './deps.ts';
import { finishSttStream, type StreamSttOutcome } from './stream-stt.ts';

/** The stream metadata on v2.turn_stage_stt_completed: never text. */
function streamFields(outcome: StreamSttOutcome): Record<string, string | number | boolean> {
  const streamed = 'text' in outcome;
  return {
    streamed,
    fallback_reason: streamed ? 'none' : outcome.fallback,
    ...('fromPartial' in outcome && outcome.fromPartial ? { from_partial: true } : {}),
    ...(outcome.setupMs !== undefined ? { stream_setup_ms: outcome.setupMs } : {}),
    ...(outcome.counts ? { stream_finals: outcome.counts.finals, stream_partials: outcome.counts.partials, stream_bytes_read: outcome.counts.bytesRead } : {}),
    ...(outcome.finalAfterEndMs !== undefined ? { final_after_end_ms: outcome.finalAfterEndMs } : {}),
  };
}

/** Transcribes the uplink PCM and returns the transcript text.
 *  Returns null when the transcript is empty, so the turn can end the same
 *  visible way an empty recording does instead of sending a blank message. */
export async function transcribeTurn(deps: TurnDeps, session: SessionDto, pcm: Buffer, turnRef: string, signal?: AbortSignal): Promise<string | null> {
  const startedAt = Date.now();
  journalTurnStage({
    interface: 'cardputer', turnId: turnRef, stage: 'stt', outcome: 'started',
    fields: { board: sessionBoard(session), pcm_bytes: pcm.length, conversation_id: session.activeConversationId },
  });
  let transcript: Awaited<ReturnType<TurnDeps['stt']>>;
  // The streamed final when BOB_STT_STREAMING opened one at turn_start; otherwise, or when it
  // fails, the batch STT on the buffered audio.
  let stream = { fallback: 'disabled' } as StreamSttOutcome;
  try {
    transcript = await traceSpan('device-stt', toSpanAttrs({
      surface: 'device', workflowNamespace: session.id, turnId: turnRef,
    }), async () => {
      stream = await abortable(finishSttStream(session, signal), signal);
      if ('text' in stream) return { text: stream.text, model: stream.model, ...(stream.seconds !== undefined ? { seconds: stream.seconds } : {}) };
      return abortable(deps.stt(pcm), signal);
    });
  } catch (error) {
    // The provider returned no transcript at all (AI_NoTranscriptGeneratedError).
    // Ends the same way an empty transcript does; every other error still throws.
    if (!NoTranscriptGeneratedError.isInstance(error)) throw error;
    // No SttResult, so the model comes from the error's response metadata
    // (the configured one only when there was no response) and seconds from the clip.
    const model = error.responses[0]?.modelId ?? process.env.BOB_STT_MODEL ?? 'fish-audio/transcribe-1';
    const seconds = pcm.length / 2 / 16_000;
    journalTurnStage({
      interface: 'cardputer', turnId: turnRef, stage: 'stt', outcome: 'completed',
      fields: { board: sessionBoard(session), duration_ms: Date.now() - startedAt, model, seconds, ...streamFields(stream), conversation_id: session.activeConversationId },
    });
    return null;
  }
  journalTurnStage({
    interface: 'cardputer', turnId: turnRef, stage: 'stt', outcome: 'completed',
    fields: {
      board: sessionBoard(session),
      duration_ms: Date.now() - startedAt,
      model: transcript.model,
      seconds: transcript.seconds,
      ...streamFields(stream),
      conversation_id: session.activeConversationId,
    },
  });
  debugLog('turn.transcript', {
    session: session.id,
    text: transcript.text,
    text_chars: transcript.text.length,
    model: transcript.model,
    streamed: 'text' in stream,
    pcm_bytes: pcm.length,
    pcm_duration_ms: Math.round((pcm.length / 2 / 16_000) * 1000),
    seconds: transcript.seconds,
    duration_ms: Date.now() - startedAt,
  });
  if (!transcript.text.trim()) return null;
  return transcript.text;
}
