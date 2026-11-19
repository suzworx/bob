import type { ConversationModeConfig } from './config';

/**
 * Frame duration of the Silero VAD model @ricky0123/vad-web runs. For model
 * "v5"/"v6" the worklet resamples to 16 kHz and delivers 512-sample frames, so
 * each frame is 512 / 16 = 32 ms (real-time-vad.js:366-367). The "legacy"
 * model is 1536 samples = 96 ms; this module is written against v5.
 */
export const VAD_FRAME_MS = 32;

/**
 * vad-web's speech thresholds. The package ships defaults of 0.3 / 0.25
 * (frame-processor.js:11-12) and the config has no overrides, so these are
 * carried through verbatim.
 */
const POSITIVE_SPEECH_THRESHOLD = 0.3;
const NEGATIVE_SPEECH_THRESHOLD = 0.25;

export interface VadFrameOptions {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechFrames: number;
  redemptionFrames: number;
}

/**
 * Rounds a millisecond duration up to a whole number of 32 ms VAD frames, so
 * the configured minimum is always met or exceeded.
 */
export function msToFrames(ms: number): number {
  return Math.ceil(ms / VAD_FRAME_MS);
}

/**
 * R2: maps the config's millisecond endpointing knobs onto vad-web's
 * frame-based options. MIN_SPEECH_MS drives minSpeechFrames (sustained speech
 * below this is a false trigger); SILENCE_MS drives redemptionFrames (silence
 * past this closes the open utterance). vad-web derives these frames internally
 * from minSpeechMs / redemptionMs (frame-processor.js:50-55,69-72); the caller
 * must pass back the frame counts as ms (frames * VAD_FRAME_MS) for the floor()
 * to reproduce them exactly.
 */
export function toVadOptions(config: ConversationModeConfig): VadFrameOptions {
  return {
    positiveSpeechThreshold: POSITIVE_SPEECH_THRESHOLD,
    negativeSpeechThreshold: NEGATIVE_SPEECH_THRESHOLD,
    minSpeechFrames: msToFrames(config.MIN_SPEECH_MS),
    redemptionFrames: msToFrames(config.SILENCE_MS),
  };
}

interface UtteranceGuard {
  /**
   * Reports whether an in-progress utterance that started at startedAtMs must
   * be force-ended at nowMs (FR-006: MAX_UTTERANCE_MS bound).
   */
  forceEnd(startedAtMs: number, nowMs: number): boolean;
}

export function createUtteranceGuard(config: ConversationModeConfig): UtteranceGuard {
  return {
    forceEnd(startedAtMs, nowMs) {
      return nowMs - startedAtMs >= config.MAX_UTTERANCE_MS;
    },
  };
}