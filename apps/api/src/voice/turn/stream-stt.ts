/**
 * Transcribe while the user talks (BOB_STT_STREAMING=1).
 * turn_start opens one stream per session, each accepted audio_up payload is
 * pushed, and the turn takes the final transcript at turn_end. A stream that
 * errors, stays silent past the deadline, never got ready or hears nothing
 * hands the turn back to the batch STT on the buffered audio. Cancel,
 * disconnect, a full uplink, a new turn and every reset abort it.
 */
import { NoTranscriptGeneratedError } from 'ai';
import type { TranscriptStream } from '@bob/ai';
import type { SessionDto } from '../protocol.ts';
import { createEndOfTurnDetector, type EndOfTurnDetector, type EndOfTurnEvidence } from './end-of-turn.ts';

/** How long turn_end waits for the streamed final before the batch STT takes over. */
export const STREAM_STT_FINAL_DEADLINE_MS = 1500;

export type SttStreamOpener = () => TranscriptStream;
type StreamFallbackReason = 'error' | 'deadline' | 'empty' | 'not_ready' | 'disabled';
/** Counts only, never text: transcript parts seen and audio bytes the provider read. */
type StreamCounts = TranscriptStream['stats'];
export type StreamSttOutcome =
  | { text: string; model: string; seconds?: number; setupMs?: number; finalAfterEndMs: number; counts: StreamCounts; fromPartial?: true }
  | { fallback: StreamFallbackReason; setupMs?: number; counts?: StreamCounts; finalAfterEndMs?: number };

/** The session's open stream, or 'failed' when opening it threw. Never more than one per session. */
const streams = new WeakMap<SessionDto, TranscriptStream | 'failed'>();

/** Words the hypothesis needs before it starts the turn's memory recall: a
 *  shorter one is a greeting, a filler or a false wake, and too thin to search on. */
const PARTIAL_RECALL_MIN_WORDS = 4;

/** The turn's one-shot hypothesis listener (watchSttHypothesis); dropped with its stream. */
const watchers = new WeakMap<SessionDto, (hypothesis: string) => void>();

/** 'end' and 'resume' come from the audio; 'drop' when the turn's stream is aborted. */
export type EndOfTurnEvent = 'end' | 'resume' | 'drop';
type EndOfTurnListener = (event: EndOfTurnEvent, hypothesis: string) => void;
interface EndOfTurnWatch { listener: EndOfTurnListener; detector: EndOfTurnDetector; hypothesis: string }

/** The turn's end-of-turn listener and detector; abort drops it with a 'drop', finish drops it silently. */
const endOfTurnWatches = new WeakMap<SessionDto, EndOfTurnWatch>();
/** The last end_of_turn this server sent on the session (turn_ref, when sent, when turn_end came); kept past finish and abort. */
const serverEndOfTurn = new WeakMap<SessionDto, { turnRef: string; sentAt: number; turnEndAt?: number }>();

/** Watches the turn's uplink for a semantic end of turn, with a fresh detector per turn. */
export function watchEndOfTurn(session: SessionDto, listener: EndOfTurnListener): void {
  endOfTurnWatches.set(session, { listener, detector: createEndOfTurnDetector(), hypothesis: '' });
}

/** The watched turn's detector, for its audio_ms and silence_ms in the journal. */
export function endOfTurnState(session: SessionDto): EndOfTurnDetector | undefined {
  return endOfTurnWatches.get(session)?.detector;
}

export function recordServerEndOfTurn(session: SessionDto, turnRef: string, sentAt = Date.now()): void {
  serverEndOfTurn.set(session, { turnRef, sentAt });
}

/** Stamps when turn_end arrived for `turnRef`, only where this server sent it an end_of_turn. */
export function recordTurnEnd(session: SessionDto, turnRef: string, receivedAt = Date.now()): void {
  const sent = serverEndOfTurn.get(session);
  if (sent?.turnRef === turnRef) sent.turnEndAt = receivedAt;
}

/** True when this server sent end_of_turn for `turnRef` (the speculative reply journals eot_source=server from it). */
export function serverEndedTurn(session: SessionDto, turnRef: string): boolean {
  return serverEndOfTurn.get(session)?.turnRef === turnRef;
}

/** When this server sent end_of_turn for `turnRef` and when its turn_end came, each only when known. */
export function endOfTurnEvidence(session: SessionDto, turnRef: string): EndOfTurnEvidence {
  const sent = serverEndOfTurn.get(session);
  if (sent?.turnRef !== turnRef) return {};
  return { sentAt: sent.sentAt, turnEndAt: sent.turnEndAt };
}

/** A listener that throws is ignored: the uplink and the turn must keep going. */
function notifyEndOfTurn(watch: EndOfTurnWatch, event: EndOfTurnEvent): void {
  try {
    watch.listener(event, watch.hypothesis);
  } catch {
    // Best effort by design; the uplink carries on.
  }
}

function feedEndOfTurn(session: SessionDto, pcm: Uint8Array, hypothesis: string): void {
  const watch = endOfTurnWatches.get(session);
  if (watch === undefined) return;
  watch.hypothesis = hypothesis;
  const event = watch.detector.observe(pcm, hypothesis);
  if (event !== null) notifyEndOfTurn(watch, event);
}

/** Calls `onStable` once with the first hypothesis of PARTIAL_RECALL_MIN_WORDS
 *  words or more, checked on each pushed frame. Never at turn_end: a recall
 *  started then is almost never ready by generate (the final lands ~65 ms later).
 *  The next stream, an abort or the finish drops it unfired. */
export function watchSttHypothesis(session: SessionDto, onStable: (hypothesis: string) => void): void {
  watchers.set(session, onStable);
}

function checkHypothesis(session: SessionDto, stream: TranscriptStream): void {
  const onStable = watchers.get(session);
  if (onStable === undefined) return;
  const hypothesis = stream.hypothesis;
  if (hypothesis.split(/\s+/).filter(Boolean).length < PARTIAL_RECALL_MIN_WORDS) return;
  watchers.delete(session);
  onStable(hypothesis);
}

/** Opens the turn's stream, aborting any earlier one. No opener (the flag off) opens nothing. */
export function openSttStream(session: SessionDto, opener: SttStreamOpener | undefined): void {
  abortSttStream(session);
  if (opener === undefined) return;
  try {
    streams.set(session, opener());
  } catch {
    streams.set(session, 'failed');
  }
}

/** Pushes one accepted uplink payload (PCM16 16 kHz mono, the only uplink format). */
export function pushSttStream(session: SessionDto, pcm: Uint8Array): void {
  const stream = streams.get(session);
  if (stream === undefined || stream === 'failed') return;
  stream.push(pcm);
  checkHypothesis(session, stream);
  feedEndOfTurn(session, pcm, stream.hypothesis);
}

export function abortSttStream(session: SessionDto): void {
  const stream = streams.get(session);
  streams.delete(session);
  watchers.delete(session);
  const endOfTurn = endOfTurnWatches.get(session);
  endOfTurnWatches.delete(session);
  if (endOfTurn !== undefined) notifyEndOfTurn(endOfTurn, 'drop');
  if (stream !== undefined && stream !== 'failed') stream.abort();
}

/** No non-blank final, but the partials heard words: the latest hypothesis stands in for the
 *  batch STT (FR-027). Undefined when the partials were blank too. */
function fromPartial(stream: TranscriptStream, seconds: number | undefined, endedAt: number): StreamSttOutcome | undefined {
  const text = stream.hypothesis.trim();
  if (!text) return undefined;
  return {
    text, model: stream.model, ...(seconds !== undefined ? { seconds } : {}), fromPartial: true,
    ...(stream.setupMs === undefined ? {} : { setupMs: stream.setupMs }), counts: stream.stats, finalAfterEndMs: Date.now() - endedAt,
  };
}

/**
 * Ends the stream's input and waits up to STREAM_STT_FINAL_DEADLINE_MS for
 * its final transcript. Takes the stream off the session either way; a
 * deadline, an empty final or an abort of `signal` also closes it.
 */
export async function finishSttStream(session: SessionDto, signal?: AbortSignal): Promise<StreamSttOutcome> {
  const stream = streams.get(session);
  streams.delete(session);
  watchers.delete(session);
  endOfTurnWatches.delete(session);
  if (stream === undefined) return { fallback: 'disabled' };
  if (stream === 'failed') return { fallback: 'error' };
  const endedAt = Date.now();
  const onAbort = (): void => stream.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => { timer = setTimeout(() => resolve('deadline'), STREAM_STT_FINAL_DEADLINE_MS); });
  try {
    const settled = await Promise.race([stream.finish().then(
      (value) => ({ value }),
      // The provider finished with no text at all: the same as an empty final.
      (error: unknown) => (NoTranscriptGeneratedError.isInstance(error) ? 'empty' as const : 'error' as const),
    ), deadline]);
    const setup = stream.setupMs === undefined ? {} : { setupMs: stream.setupMs };
    const counts = stream.stats;
    // Any outcome where a final arrived is timed, so the journal shows how late it came.
    const heard = counts.finals > 0 ? { finalAfterEndMs: Date.now() - endedAt } : {};
    if (settled === 'deadline') {
      stream.abort();
      return { fallback: stream.setupMs === undefined ? 'not_ready' : 'deadline', ...setup, counts, ...heard };
    }
    if (settled === 'error') return { fallback: settled, ...setup, counts, ...heard };
    if (settled === 'empty' || !settled.value.text.trim()) {
      return fromPartial(stream, settled === 'empty' ? undefined : settled.value.seconds, endedAt) ?? { fallback: 'empty', ...setup, counts, ...heard };
    }
    return { ...settled.value, ...setup, counts, finalAfterEndMs: Date.now() - endedAt };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
