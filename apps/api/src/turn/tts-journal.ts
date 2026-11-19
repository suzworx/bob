/**
 * Device TTS journal: the tts stage lines and downlink debug fields of a device reply (ms, bytes and counts only).
 * Trigger: voice/turn/playback.ts (streamPlayback and createSentencePlayback).
 * Steps: 1. tts started, with the first piece's size. 2. per MP3 clip, its fill-vs-drain debug line. 3. tts completed
 *   for a clause-by-clause reply: summed synthesis time, the first byte and first sentence, the first clause's split.
 * Outcome: journal lines only; nothing is sent to the device here.
 * Journal: v2.turn_stage tts started|completed (cardputer); debug turn.downlink_frames.
 */
import { debugLog } from '@bob/ai';
import type { TtsTiming } from '../voice/speech-port.ts';
import { DOWNLINK_MP3_CHUNK_BYTES, type SessionDto } from '../voice/protocol.ts';
import { sessionBoard } from '../voice/session-board.ts';
import { journalTurnStage } from '../voice/turn-journal.ts';
import { BACKPRESSURE_WATERMARK_BYTES, DOWNLINK_FRAME_INTERVAL_MS, DOWNLINK_STALL_TIMEOUT_MS } from '../voice/turn/pacing.ts';

/** The tts started line, sized by the first piece synthesized. */
export function journalTtsStarted(session: SessionDto, turnRef: string, chars: number): void {
  journalTurnStage({
    interface: 'cardputer', turnId: turnRef, stage: 'tts', outcome: 'started',
    fields: { board: sessionBoard(session), chars, format_id: session.formatId, conversation_id: session.activeConversationId },
  });
}

/**
 * Fill-vs-drain of one MP3 clip: the server paces frames on a fixed interval
 * regardless of the clip's bitrate, so a low-bitrate reply arrives far faster
 * than the device can decode it. Recording both rates makes ring overflow --
 * audio chopped mid-reply with every frame still "delivered" -- visible here
 * rather than only by ear.
 */
export function debugMp3Frames(session: SessionDto, turnRef: string, mp3Bytes: number, frameCount: number, drainBytesPerSecond: number | null): void {
  debugLog('turn.downlink_frames', {
    session: session.id,
    turn_ref: turnRef,
    format: 'mp3',
    mp3_bytes: mp3Bytes,
    frame_count: frameCount,
    chunk_bytes: DOWNLINK_MP3_CHUNK_BYTES,
    frame_interval_ms: DOWNLINK_FRAME_INTERVAL_MS,
    fill_bytes_per_sec: (DOWNLINK_MP3_CHUNK_BYTES * 1000) / DOWNLINK_FRAME_INTERVAL_MS,
    drain_bytes_per_sec: drainBytesPerSecond,
    paced: drainBytesPerSecond !== null,
    send_span_ms: frameCount * DOWNLINK_FRAME_INTERVAL_MS,
    backpressure_watermark_bytes: BACKPRESSURE_WATERMARK_BYTES,
    stall_timeout_ms: DOWNLINK_STALL_TIMEOUT_MS,
  });
}

/** When the first synthesized audio was ready, and the first sentence on its
 *  own when the reply had more than one (ms and counts only). */
function firstByteFields(
  ttsStartedAt: number, firstByteAt: number, ttsMsSlots: ReadonlyArray<number | undefined>, firstSentenceChars: number,
): Record<string, number> {
  const fields: Record<string, number> = {};
  if (firstByteAt !== 0) fields.tts_first_byte_ms = firstByteAt - ttsStartedAt;
  const first = ttsMsSlots[0];
  if (ttsMsSlots.length > 1 && first !== undefined) Object.assign(fields, { first_sentence_ms: first, first_sentence_chars: firstSentenceChars });
  return fields;
}

/** Where the first clause's TTS time went, whole ms, for the tts completed line; each field only when measured. */
function ttsSplitFields(timing: TtsTiming | undefined): Record<string, number> {
  if (timing === undefined) return {};
  const { headers_ms: headers, last_byte_ms: lastByte, done_ms: done } = timing;
  return {
    ...(headers === undefined ? {} : { tts_headers_ms: Math.round(headers) }),
    ...(headers === undefined || lastByte === undefined ? {} : { tts_body_ms: Math.round(lastByte - headers) }),
    // The SDK's JSON parse and base64, after the last byte.
    ...(lastByte === undefined || done === undefined ? {} : { tts_parse_ms: Math.round(done - lastByte) }),
    tts_decode_ms: Math.round(timing.decode_ms),
    tts_encode_ms: Math.round(timing.encode_ms),
    // A progressive encode only.
    ...(timing.encode_tail_ms === undefined ? {} : { tts_encode_tail_ms: Math.round(timing.encode_tail_ms) }),
  };
}

/** What a clause-by-clause reply synthesized, for its tts completed line. */
export interface ClauseTts {
  ttsMs: number[]; ttsStartedAt: number; firstByteAt: number; ttsMsSlots: ReadonlyArray<number | undefined>;
  firstSentenceChars: number; firstTiming: TtsTiming | undefined; mp3Bytes: number; sentences: number; prewarm: Record<string, number>;
}

export function journalClauseTtsCompleted(session: SessionDto, turnRef: string, tts: ClauseTts): void {
  journalTurnStage({
    interface: 'cardputer', turnId: turnRef, stage: 'tts', outcome: 'completed',
    // duration_ms sums each sentence's own synthesis time; with up to
    // TTS_AHEAD of them overlapping, this is total synthesis time, not
    // how long the tts stage took on the clock.
    fields: {
      board: sessionBoard(session),
      duration_ms: tts.ttsMs.reduce((total, ms) => total + ms, 0),
      ...firstByteFields(tts.ttsStartedAt, tts.firstByteAt, tts.ttsMsSlots, tts.firstSentenceChars),
      ...ttsSplitFields(tts.firstTiming),
      mp3_bytes: tts.mp3Bytes,
      sentences: tts.sentences,
      // Only a turn that had a prewarm: how many lines it started, and how many this reply used (counts only).
      ...tts.prewarm,
      conversation_id: session.activeConversationId,
    },
  });
}
