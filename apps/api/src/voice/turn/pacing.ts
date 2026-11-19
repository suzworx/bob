import type { WebSocket } from 'ws';
import { debugLog, isFrameDebugEnabled } from '@bob/ai';
import { AUDIO_HEADER_BYTES, PCM16_16K_MONO_RATE_HZ, type SessionDto } from '../protocol.ts';
import { moduleJournal } from '../../platform/logger.ts';
import { delay } from './abort.ts';

const journal = moduleJournal('voice');

/** One downlink frame is 10 ms of audio; pacing at this rate keeps the
 *  burst far below the Cardputer's small network buffers (a 68 KB burst
 *  overflowed them and dropped the connection mid-stream). */
export const DOWNLINK_FRAME_INTERVAL_MS = 20;

/** PCM is streamed through the device's 48 KB ring, so the reply no
 *  longer has to fit on the device. This is a per-reply sanity cap: 60 s at
 *  16 kHz. TTS input is capped at 700 characters (MAX_TTS_INPUT_CHARS), about
 *  45-50 s of speech, so a real reply is never trimmed; a runaway TTS result
 *  cannot hold the socket for minutes. */
export const MAX_DOWNLINK_PCM_BYTES = 60 * PCM16_16K_MONO_RATE_HZ * 2;

/** Both device rings hold 48 KB: kMp3RingBufferBytes and kPcmRingBufferBytes. */
export const DEVICE_RING_BYTES = 48 * 1024;

export const PCM_DRAIN_BYTES_PER_SECOND = PCM16_16K_MONO_RATE_HZ * 2;

/** Once Node's socket buffer holds this many unsent bytes, the device's TCP
 *  window is closed (it is not draining); back off instead of queueing more. */
export const BACKPRESSURE_WATERMARK_BYTES = 32 * 1024;

/** Abort the stream when backpressure persists longer than this. */
export const DOWNLINK_STALL_TIMEOUT_MS = 10_000;

/**
 * The device decodes MP3 through a 48 KB ring (kMp3RingBufferBytes) and
 * streams PCM through another (kPcmRingBufferBytes). Pacing targets 32 KB
 * of either, leaving a third free to absorb network jitter without ever
 * reaching the point where the ring's push() starts discarding bytes.
 */
export const MP3_TARGET_BUFFER_BYTES = 32 * 1024;

/** How one format fills the device ring. Both formats share the ring model and
 *  MP3_TARGET_BUFFER_BYTES (32 KB of 48 KB); only these differ. */
export interface PacingProfile {
  /** Sent without waiting on the model, so playback begins promptly. */
  primeBytes: number;
  /** The device starts draining once this many bytes arrived (its prebuffer
   *  gate); until then the model drains nothing. 0 = from the first frame. */
  drainStartBytes: number;
  /** Per-frame bytes the device ring never stores (the OLX2 header). */
  frameOverheadBytes: number;
  /** Floor between two frames: the device queues at most 24 received frames
   *  (network.cpp kEventQueueDepth) and drops binary ones past that. */
  minFrameGapMs: number;
}

/** A 24-frame (24 KB) burst primes the decoder;
 *  the model counts whole frames, headers included (2% conservative). */
const MP3_PACING: PacingProfile = { primeBytes: 24 * 1024, drainStartBytes: 0, frameOverheadBytes: 0, minFrameGapMs: 0 };

/** Prime the device's 0.5 s prebuffer (kPcmPrebufferBytes, 16 KB), then
 *  hold the ring near 32 KB. 320 B frames are 10 ms each; an 8 ms floor fills
 *  at 1.25x real time, so a 130 ms device loop stall queues ~16 frames, not 24+. */
export const PCM_PACING: PacingProfile = {
  primeBytes: 16 * 1024, drainStartBytes: 16 * 1024, frameOverheadBytes: AUDIO_HEADER_BYTES, minFrameGapMs: 8,
};

/**
 * Delay before sending the next chunk so the device's modeled buffer stays at
 * or below MP3_TARGET_BUFFER_BYTES.
 *
 * The old fixed 20 ms interval sent 1024 B every 20 ms = 50 KB/s regardless of
 * bitrate, while a 64 kbps reply drains at ~7.9 KB/s. The ring therefore
 * saturated after ~57 frames and every later frame was dropped -- inaudible in
 * the logs, because the server counts frames it sent and the device counts
 * frames it decoded, and neither counts the ones lost in between.
 *
 * Exported for tests: pacing is pure arithmetic and must be verifiable without
 * hardware.
 */
export function pacingDelayMs(
  occupancyBytes: number,
  chunkBytes: number,
  drainBytesPerSecond: number,
): number {
  if (drainBytesPerSecond <= 0) return 0;
  const overflowBytes = occupancyBytes + chunkBytes - MP3_TARGET_BUFFER_BYTES;
  if (overflowBytes <= 0) return 0;
  return Math.ceil((overflowBytes / drainBytesPerSecond) * 1000);
}

/** Why a reply's downlink stopped: every frame went out, a cancel, the socket
 *  closing under it, backpressure outlasting DOWNLINK_STALL_TIMEOUT_MS, or a
 *  streamed reply cut at a sentence boundary (size cap or TTS failure). */
type DownlinkOutcome = 'completed' | 'cancelled' | 'socket_closed' | 'stalled' | 'cut';

/** The downlink pacer's model of the device ring for one reply. A streamed
 *  reply carries it from one sentence's frames to the next, so priming
 *  and pacing run exactly as they do for one clip. */
export interface PacerState {
  /** Modeled bytes sitting in the device's decode ring: what has been sent,
   *  less what the decoder has had time to consume. */
  occupancyBytes: number;
  bytesSent: number;
  peakOccupancyBytes: number;
  lastSentAt: number;
  /** Frames handed to the socket across every call for this reply. */
  framesSent: number;
  /** How this reply's format fills the ring (MP3 unless stated). */
  profile: PacingProfile;
  /** Server clock (ms) when the first frame went to the socket; 0 before. */
  firstSentAt: number;
  /** Time spent waiting on the ring model or the fixed interval. */
  pacingWaitMs: number;
  /** Time spent held by socket backpressure. */
  backpressureWaitMs: number;
  outcome: DownlinkOutcome;
}

export function newPacerState(profile: PacingProfile = MP3_PACING): PacerState {
  return {
    occupancyBytes: 0, bytesSent: 0, peakOccupancyBytes: 0, lastSentAt: 0, framesSent: 0, profile,
    firstSentAt: 0, pacingWaitMs: 0, backpressureWaitMs: 0, outcome: 'completed',
  };
}

/** Streams a list of already-serialized OLX2 frames with backpressure handling. */
export async function streamFrames(
  socket: WebSocket,
  session: SessionDto,
  frames: Buffer[],
  frameIntervalMs: number,
  drainBytesPerSecond: number | null = null,
  signal?: AbortSignal,
  /** Called once, right after the first audio_down frame is handed to the socket. */
  onFirstFrame?: () => void,
  pacer: PacerState = newPacerState(),
): Promise<number> {
  let framesSent = 0;
  let stallStartedAt = 0;
  let { occupancyBytes, bytesSent, peakOccupancyBytes, lastSentAt } = pacer;
  const endStall = (): void => {
    if (stallStartedAt !== 0) pacer.backpressureWaitMs += Date.now() - stallStartedAt;
  };
  // An index loop, not for-of: a frame held by backpressure is retried, never
  // skipped, so the reply arrives whole once the device drains.
  for (let index = 0; index < frames.length;) {
    const frame = frames[index];
    if (frame === undefined) break;
    // A cancel stops the stream at the next frame boundary.
    if (signal?.aborted) {
      pacer.outcome = 'cancelled';
      break;
    }
    if (socket.readyState !== 1) {
      pacer.outcome = 'socket_closed';
      // Not an abort: the socket died under us, so no downlink_aborted is
      // journaled and down_frames simply comes up short with no stated cause.
      debugLog('turn.downlink_socket_closed', {
        session: session.id,
        ready_state: socket.readyState,
        frames_sent: framesSent,
        frames_total: frames.length,
        frames_dropped: frames.length - framesSent,
      });
      break;
    }
    if (socket.bufferedAmount > BACKPRESSURE_WATERMARK_BYTES) {
      if (stallStartedAt === 0) {
        stallStartedAt = Date.now();
        // The device stopped draining its TCP window. Journaled only if it
        // persists to an abort, so brief stalls are otherwise invisible.
        debugLog('turn.backpressure_start', {
          session: session.id,
          buffered_bytes: socket.bufferedAmount,
          watermark_bytes: BACKPRESSURE_WATERMARK_BYTES,
          frames_sent: framesSent,
          frames_total: frames.length,
        });
      }
      if (Date.now() - stallStartedAt > DOWNLINK_STALL_TIMEOUT_MS) {
        journal('v2.downlink_aborted', {
          session: session.id,
          buffered_bytes: socket.bufferedAmount,
          frames_sent: framesSent,
          frames_total: frames.length,
        });
        pacer.outcome = 'stalled';
        break;
      }
      await delay(50, signal);
      continue;
    }
    if (stallStartedAt !== 0) {
      debugLog('turn.backpressure_end', {
        session: session.id,
        stalled_ms: Date.now() - stallStartedAt,
        frames_sent: framesSent,
        buffered_bytes: socket.bufferedAmount,
      });
    }
    endStall();
    stallStartedAt = 0;

    let waitMs = frameIntervalMs;
    if (drainBytesPerSecond !== null) {
      const { primeBytes, drainStartBytes, frameOverheadBytes, minFrameGapMs } = pacer.profile;
      const now = Date.now();
      const modelBytes = Math.max(0, frame.length - frameOverheadBytes);
      // What the device ring holds so far; it plays nothing until its gate opens.
      const delivered = bytesSent - (pacer.framesSent + framesSent) * frameOverheadBytes;
      const draining = delivered >= drainStartBytes;
      if (lastSentAt !== 0 && draining) {
        const drained = ((now - lastSentAt) / 1000) * drainBytesPerSecond;
        occupancyBytes = Math.max(0, occupancyBytes - drained);
      }
      // Prime the device before pacing, so playback starts promptly rather
      // than trickling in at the drain rate.
      waitMs = delivered < primeBytes
        ? 0
        : pacingDelayMs(occupancyBytes, modelBytes, drainBytesPerSecond);
      if (minFrameGapMs > 0 && lastSentAt !== 0) waitMs = Math.max(waitMs, lastSentAt + minFrameGapMs - now);
      if (waitMs > 0 && draining) occupancyBytes = Math.max(0, occupancyBytes - (waitMs / 1000) * drainBytesPerSecond);
      occupancyBytes += modelBytes;
      peakOccupancyBytes = Math.max(peakOccupancyBytes, occupancyBytes);
      lastSentAt = now + waitMs;
      if (waitMs > 0) {
        pacer.pacingWaitMs += waitMs;
        await delay(waitMs, signal);
      }
      if (signal?.aborted || socket.readyState !== 1) {
        pacer.outcome = signal?.aborted ? 'cancelled' : 'socket_closed';
        break;
      }
    }

    socket.send(frame);
    index += 1;
    if (pacer.firstSentAt === 0) pacer.firstSentAt = Date.now();
    if (framesSent === 0) onFirstFrame?.();
    framesSent += 1;
    bytesSent += frame.length;
    if (isFrameDebugEnabled()) {
      debugLog('turn.audio_down_frame', {
        session: session.id,
        seq: framesSent - 1,
        frame_bytes: frame.length,
        buffered_bytes: socket.bufferedAmount,
      });
    }
    if (drainBytesPerSecond === null) {
      pacer.pacingWaitMs += frameIntervalMs;
      await delay(frameIntervalMs, signal);
    }
  }
  endStall();
  if (drainBytesPerSecond !== null) {
    debugLog('turn.pacing_summary', {
      session: session.id,
      drain_bytes_per_sec: Math.round(drainBytesPerSecond),
      target_buffer_bytes: MP3_TARGET_BUFFER_BYTES,
      peak_modeled_occupancy_bytes: Math.round(peakOccupancyBytes),
      frames_sent: framesSent,
      bytes_sent: bytesSent,
    });
  }
  Object.assign(pacer, { occupancyBytes, bytesSent, peakOccupancyBytes, lastSentAt });
  pacer.framesSent += framesSent;
  // Best-effort close diagnostics: how far the turn's downlink got before the
  // socket died, so v2.closed can tell backpressure aborts from transport loss.
  session.downFramesSent = pacer.framesSent;
  return framesSent;
}
