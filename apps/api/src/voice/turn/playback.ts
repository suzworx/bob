import type { TtsMp3Result, TtsTiming } from '../speech-port.ts';
import type { WebSocket } from 'ws';
import { MAX_TTS_INPUT_CHARS, traceSpan, toSpanAttrs, ttsVoiceFor } from '@bob/ai';
import {
  createReplySplitter,
  downlinkFrames,
  downlinkMp3Frames,
} from '../audio/stt-tts.ts';
import { ONLY_A_LINK, speakable } from '../audio/speakable.ts';
import {
  MAX_DOWNLINK_MP3_BYTES,
  MP3_16K_MONO_FORMAT,
  V2_VERSION,
  messageId,
  type SessionDto,
} from '../protocol.ts';
import { moduleJournal } from '../../platform/logger.ts';
import { mp3DrainBytesPerSecond } from '../audio/mp3.ts';
import { sendDto, sendStatus } from '../session-handlers.ts';
import { sessionBoard } from '../session-board.ts';
import { journalTurnStage } from '../turn-journal.ts';
import { prewarmFields, turnPrewarm, ttsSlots } from '../../turn/speech-prewarm.ts';
import { debugMp3Frames, journalClauseTtsCompleted, journalTtsStarted } from '../../turn/tts-journal.ts';
import { TurnCancelledError, abortable } from './abort.ts';
import type { TurnDeps } from './deps.ts';
import { flushDownlink } from './downlink.ts';
import { journalSpeechCut } from './failure.ts';
import {
  DOWNLINK_FRAME_INTERVAL_MS, MAX_DOWNLINK_PCM_BYTES,
  PCM_DRAIN_BYTES_PER_SECOND, PCM_PACING, newPacerState, streamFrames,
} from './pacing.ts';

export { prewarmSpeech } from '../../turn/speech-prewarm.ts';

const journal = moduleJournal('voice');

export interface PlaybackResult {
  downFrames: number;
  replyBytes: number;
  totalFrames: number;
  firstAudioAt: number | null;
  /** Total TTS time of the reply (the one call, or the sum over a streamed reply's sentences). */
  ttsTotalMs?: number;
}

/** A finished MP3 reply through createSentencePlayback; a reply with nothing
 *  speakable speaks its raw text once (the player's fallback). Rejects when
 *  nothing played because TTS failed or the turn was cancelled. */
async function speakByClause(
  deps: TurnDeps, socket: WebSocket, session: SessionDto, text: string, turnRef: string, turnStartedAt: number, signal?: AbortSignal,
): Promise<SentencePlaybackResult> {
  const player = createSentencePlayback(deps, socket, session, turnRef, turnStartedAt, signal);
  player.push(text);
  player.fallback(text);
  const played = await player.finish((partial) => {
    if (partial.cut === 'tts_failed') journalSpeechCut(socket, session, turnRef, partial.ttsError, turnStartedAt, text);
  });
  if (played.started) return played;
  if (signal?.aborted) throw new TurnCancelledError();
  if (played.ttsError !== undefined) throw played.ttsError;
  return played;
}

/**
 * Speaks a finished reply (a guarded game reply, a generate-only agent, a PCM
 * session) and streams playback_start / audio_down frames / playback_end.
 * MP3 goes clause by clause through createSentencePlayback, so the first
 * clause plays while the rest synthesizes; PCM keeps one whole-reply call.
 * Rejects when nothing was played (TTS failed or the turn was cancelled).
 */
export async function streamPlayback(
  deps: TurnDeps,
  socket: WebSocket,
  session: SessionDto,
  text: string,
  turnRef: string,
  turnStartedAt: number,
  signal?: AbortSignal,
): Promise<PlaybackResult> {
  if (session.formatId === MP3_16K_MONO_FORMAT) return speakByClause(deps, socket, session, text, turnRef, turnStartedAt, signal);
  const voice = ttsVoiceFor(session.assistantName);
  // When the first audio_down frame went to the socket (null if none did).
  let firstAudioAt: number | null = null;
  const markFirstAudio = (): void => { firstAudioAt = Date.now(); };
  const ttsStartedAt = Date.now();
  journalTtsStarted(session, turnRef, text.length);

  const speech = await traceSpan('device-tts', toSpanAttrs({
    surface: 'device', workflowNamespace: session.id, turnId: turnRef, metadata: { format: 'pcm16' },
  }), () => abortable(deps.ttsPcm(speakable(text) || text, voice), signal));
  const ttsTotalMs = Date.now() - ttsStartedAt;
  journalTurnStage({
    interface: 'cardputer', turnId: turnRef, stage: 'tts', outcome: 'completed',
    fields: {
      board: sessionBoard(session),
      duration_ms: ttsTotalMs,
      // A whole-clip TTS hands over its first byte with its last.
      tts_first_byte_ms: ttsTotalMs,
      pcm_bytes: speech.pcm.length,
      source_rate: speech.sourceRateHz,
      conversation_id: session.activeConversationId,
    },
  });
  const pcm =
    speech.pcm.length > MAX_DOWNLINK_PCM_BYTES ? speech.pcm.subarray(0, MAX_DOWNLINK_PCM_BYTES) : speech.pcm;
  if (pcm.length !== speech.pcm.length) {
    journal('v2.downlink_trimmed', {
      session: session.id,
      original_bytes: speech.pcm.length,
      trimmed_bytes: pcm.length,
    });
  }
  journal('v2.downlink_started', {
    session: session.id,
    turn_id: turnRef,
    pcm_bytes: pcm.length,
    total_ms: Date.now() - turnStartedAt,
  });

  sendStatus(socket, session, 'speaking', turnRef);
  sendDto(socket, { v: V2_VERSION, type: 'playback_start', id: messageId('playback_start'), turn_ref: turnRef, payload: {} });
  const frames = downlinkFrames(pcm);
  // The device streams PCM through a 48 KB ring, so it is paced at real
  // time with the MP3 ring model.
  const pacer = newPacerState(PCM_PACING);
  const framesSent = await streamFrames(
    socket, session, frames, DOWNLINK_FRAME_INTERVAL_MS, PCM_DRAIN_BYTES_PER_SECOND, signal, markFirstAudio, pacer,
  );
  void flushDownlink(session, pacer);
  sendDto(socket, { v: V2_VERSION, type: 'playback_end', id: messageId('playback_end'), turn_ref: turnRef, payload: {} });
  sendStatus(socket, session, 'idle', turnRef);
  return { downFrames: framesSent, replyBytes: pcm.length, totalFrames: frames.length, firstAudioAt, ttsTotalMs };
}

/** What a streamed reply did: counts and durations only. */
export interface SentencePlaybackResult extends PlaybackResult {
  /** playback_start went out: at least one sentence reached the device. */
  started: boolean;
  /** Sentences whose audio went to the socket. */
  sentences: number;
  /** TTS + MP3 encode time of each synthesized sentence, in order. */
  ttsMs: number[];
  /** Characters of the reply whose audio went out (the heard share). */
  heardChars: number;
  /** The 700-character cap left later sentences unspoken, as batch TTS would. */
  charCapped: boolean;
  /** Why the audio stopped short of the reply's end, if it did. */
  cut: 'tts_failed' | 'size_cap' | null;
  /** The TTS error behind cut 'tts_failed'; processTurn classifies it. */
  ttsError?: unknown;
}

export interface SentencePlayback {
  /** Feeds an agent text delta; each completed sentence goes to TTS at once. */
  push(delta: string): void;
  /** Speaks the reply's raw text as one sentence when no sentence was queued (a fence or table alone): the normal fallback, on this playback. */
  fallback(text: string): void;
  /** Speaks nothing more: queued sentences are dropped (the agent failed). */
  stop(): void;
  /** Queues the last piece, waits for every queued sentence to stream, then
   *  sends playback_end and status idle if playback_start went out.
   *  `beforeEnd` runs just before playback_end, while the device still
   *  holds the turn (the last messages it accepts for it). */
  finish(beforeEnd?: (played: SentencePlaybackResult) => void): Promise<SentencePlaybackResult>;
}

/** Sentences whose TTS may be synthesizing at once. */
const TTS_AHEAD = 2;

/**
 * Speaks a reply while the agent is still writing it. Each sentence is
 * synthesized and appended to ONE
 * audio_down stream: one playback_start, frame sequence numbers continuing
 * across sentences, one pacer model of the device ring; playback itself stays
 * strictly in enqueue order regardless of synthesis order. The 700-character
 * cap and the 3 MB MP3 cap stop the stream at a sentence boundary. A cancel
 * abandons pending TTS calls and ends the stream at the next frame; a
 * TTS failure keeps the audio already sent.
 */
export function createSentencePlayback(
  deps: TurnDeps,
  socket: WebSocket,
  session: SessionDto,
  turnRef: string,
  turnStartedAt: number,
  signal?: AbortSignal,
): SentencePlayback {
  const splitter = createReplySplitter();
  const voice = ttsVoiceFor(session.assistantName);
  const pacer = newPacerState();
  const out: SentencePlaybackResult = {
    downFrames: 0, replyBytes: 0, totalFrames: 0, firstAudioAt: null,
    started: false, sentences: 0, ttsMs: [], heardChars: 0, charCapped: false, cut: null,
  };
  let playTail: Promise<void> = Promise.resolve();
  let accepting = true;
  let stopped = false;
  let queuedChars = 0;
  // The reply's raw text, when the workflow hands it over; spoken at finish() only if no sentence was queued.
  let fallbackText: string | undefined;
  let ttsStartedAt = 0;
  // When the first synthesized audio was ready (0 until then), and the first sentence's size.
  let firstByteAt = 0;
  let firstSentenceChars = 0;
  // The first clause's TTS split; later clauses never set it.
  let firstTiming: TtsTiming | undefined;
  let drainBytesPerSecond: number | null = null;
  const halted = (): boolean => stopped || signal?.aborted === true;
  // This turn's prewarmed clauses, when it had any: how many it started, and how many this reply used.
  const prewarm = turnPrewarm(deps, session, turnRef, voice, signal, halted);
  const markFirstAudio = (): void => { out.firstAudioAt ??= Date.now(); };

  // Up to TTS_AHEAD sentences synthesize at once, so sentence N+1 is
  // ready by the time sentence N finishes playing instead of starting cold.
  // Playback order still follows enqueue order via playTail below.
  const slots = ttsSlots(TTS_AHEAD);

  const play = async (tts: Promise<TtsMp3Result | null>, piece: string): Promise<void> => {
    let speech: TtsMp3Result | null;
    try {
      speech = await tts;
    } catch (error) {
      if (!halted()) Object.assign(out, { cut: 'tts_failed', ttsError: error });
      stopped = true;
      return;
    }
    if (speech === null || halted()) return;
    let sent = 0;
    let total = 0;
    // One MP3 segment of the clip (its head, then its tail): false when the clip must stop here.
    const segment = async (mp3: Buffer): Promise<boolean> => {
      if (out.replyBytes + mp3.length > MAX_DOWNLINK_MP3_BYTES) {
        journal('v2.downlink_trimmed', { session: session.id, original_bytes: out.replyBytes + mp3.length, trimmed_bytes: out.replyBytes });
        out.cut = 'size_cap';
        return false;
      }
      if (!out.started) {
        out.started = true;
        drainBytesPerSecond = mp3DrainBytesPerSecond(mp3);
        journal('v2.downlink_started', {
          session: session.id, turn_id: turnRef, mp3_bytes: mp3.length, total_ms: Date.now() - turnStartedAt,
        });
        sendStatus(socket, session, 'speaking', turnRef);
        sendDto(socket, { v: V2_VERSION, type: 'playback_start', id: messageId('playback_start'), turn_ref: turnRef, payload: {} });
      }
      const frames = downlinkMp3Frames(mp3, 1, out.totalFrames);
      debugMp3Frames(session, turnRef, mp3.length, frames.length, drainBytesPerSecond);
      out.replyBytes += mp3.length;
      out.totalFrames += frames.length;
      const count = await streamFrames(socket, session, frames, DOWNLINK_FRAME_INTERVAL_MS, drainBytesPerSecond, signal, markFirstAudio, pacer);
      out.downFrames += count;
      sent += count;
      total += frames.length;
      // A short count: cancel, a dead socket or a stalled device.
      return count === frames.length;
    };
    let complete = await segment(speech.mp3);
    // The tail of a progressive clip follows the head on the same stream; a failure keeps what was sent.
    // Its text counts as heard only when the whole clip played: a tail that never played leaves the clip's length unknown.
    let heardAll = speech.tail === undefined;
    if (complete && speech.tail !== undefined) {
      try {
        const rest = await abortable(speech.tail, signal);
        complete = !halted() && await segment(rest);
        heardAll = complete;
      } catch (error) {
        if (!halted()) Object.assign(out, { cut: 'tts_failed', ttsError: error });
        complete = false;
      }
    }
    if (sent > 0) out.sentences += 1;
    // A clip whose tail never played has no known length, so none of its text counts as heard.
    out.heardChars += total === 0 || !heardAll ? 0 : Math.floor((piece.length * sent) / total);
    if (!complete) stopped = true;
  };

  // Each sentence's synthesis time, indexed by start order (so a later
  // sentence that finishes first still lands at the right slot). A sentence
  // that fails or is aborted before completing leaves its slot unset -- it is
  // dropped, not recorded as a 0, when finish() reads this out.
  const ttsMsSlots: Array<number | undefined> = [];

  // A sentence's slot is held from the moment it is granted until its TTS
  // call settles, so the next sentence can start before this one finishes.
  const synthesize = async (text: string): Promise<TtsMp3Result | null> => {
    await slots.acquire();
    try {
      if (halted()) return null;
      const startedAt = Date.now();
      if (ttsStartedAt === 0) {
        ttsStartedAt = startedAt;
        firstSentenceChars = text.length;
        journalTtsStarted(session, turnRef, text.length);
      }
      const msIndex = ttsMsSlots.push(undefined) - 1;
      // Re-checked here, not just above: traceSpan can take a few hops of its
      // own before it actually calls the provider, and a cancel landing in
      // that gap must still stop the call from going out, not just its result
      // from being used.
      const speech = await traceSpan('device-tts', toSpanAttrs({
        surface: 'device', workflowNamespace: session.id, turnId: turnRef, metadata: { format: 'mp3' },
      }), () => (halted() ? null : prewarm.speechFor(text)));
      if (speech !== null) {
        const doneAt = Date.now();
        ttsMsSlots[msIndex] = doneAt - startedAt;
        if (firstByteAt === 0) firstByteAt = doneAt;
        if (msIndex === 0) firstTiming = speech.timing;
      }
      return speech;
    } finally {
      slots.release();
    }
  };

  // No sentence was queued (a fence or table alone): the raw text speaks once, as the whole-reply call does (speakable(text) || text).
  const speakFallback = (): void => {
    if (fallbackText === undefined || queuedChars > 0) return;
    // Consumed before synthesis, so a second finish() cannot queue the same text again.
    const text = fallbackText;
    fallbackText = undefined;
    const tts = synthesize(speakable(text) || text);
    tts.catch(() => undefined);
    playTail = playTail.then(() => play(tts, text));
  };

  let saidOnlyALink = false;
  const enqueue = (piece: string): void => {
    if (!accepting || halted()) return;
    const text = speakable(piece);
    if (text === '' || (text === ONLY_A_LINK && saidOnlyALink)) return;
    saidOnlyALink ||= text === ONLY_A_LINK;
    if (queuedChars > 0 && queuedChars + piece.length > MAX_TTS_INPUT_CHARS) {
      accepting = false;
      out.charCapped = true;
      return;
    }
    queuedChars += piece.length;
    const tts = synthesize(text);
    tts.catch(() => undefined);
    playTail = playTail.then(() => play(tts, piece));
  };

  return {
    push(delta: string): void {
      for (const piece of splitter.push(delta)) enqueue(piece);
    },
    fallback(text: string): void {
      if (text !== '') fallbackText = text;
    },
    stop(): void {
      stopped = true;
    },
    async finish(beforeEnd?: (played: SentencePlaybackResult) => void): Promise<SentencePlaybackResult> {
      for (const piece of splitter.flush()) enqueue(piece);
      speakFallback();
      await playTail;
      // Stops between sentences never reach streamFrames, so they are settled here.
      if (pacer.outcome === 'completed' && signal?.aborted) pacer.outcome = 'cancelled';
      else if (pacer.outcome === 'completed' && out.cut !== null) pacer.outcome = 'cut';
      void flushDownlink(session, pacer);
      if (out.started) {
        try {
          beforeEnd?.(out);
        } finally {
          sendDto(socket, { v: V2_VERSION, type: 'playback_end', id: messageId('playback_end'), turn_ref: turnRef, payload: {} });
          sendStatus(socket, session, 'idle', turnRef);
        }
      }
      // Only sentences whose synthesis actually completed; a failed or
      // aborted one leaves no entry (never a 0).
      out.ttsMs = ttsMsSlots.filter((ms): ms is number => ms !== undefined);
      if (ttsStartedAt !== 0 && out.cut !== 'tts_failed') {
        journalClauseTtsCompleted(session, turnRef, {
          ttsMs: out.ttsMs, ttsStartedAt, firstByteAt, ttsMsSlots, firstSentenceChars, firstTiming,
          mp3Bytes: out.replyBytes, sentences: out.sentences, prewarm: prewarmFields(prewarm.lines, prewarm.hits),
        });
      }
      out.ttsTotalMs = out.ttsMs.reduce((total, ms) => total + ms, 0);
      return out;
    },
  };
}
