import { describe, expect, it } from 'vitest';
import {
  createUtteranceGuard,
  msToFrames,
  toVadOptions,
  VAD_FRAME_MS,
} from './endpointing';
import { DEFAULT_CONFIG } from './config';

describe('msToFrames', () => {
  it('converts exact multiples without rounding up', () => {
    expect(msToFrames(VAD_FRAME_MS)).toBe(1);
    expect(msToFrames(VAD_FRAME_MS * 10)).toBe(10);
  });

  it('rounds up a partial frame so the configured minimum is always met', () => {
    expect(msToFrames(1)).toBe(1);
    expect(msToFrames(VAD_FRAME_MS - 1)).toBe(1);
    expect(msToFrames(VAD_FRAME_MS + 1)).toBe(2);
  });

  it('maps the config defaults onto whole frames', () => {
    expect(msToFrames(DEFAULT_CONFIG.MIN_SPEECH_MS)).toBe(
      Math.ceil(DEFAULT_CONFIG.MIN_SPEECH_MS / VAD_FRAME_MS),
    );
    expect(msToFrames(DEFAULT_CONFIG.SILENCE_MS)).toBe(
      Math.ceil(DEFAULT_CONFIG.SILENCE_MS / VAD_FRAME_MS),
    );
  });
});

describe('toVadOptions', () => {
  it('maps MIN_SPEECH_MS to minSpeechFrames and SILENCE_MS to redemptionFrames', () => {
    const options = toVadOptions(DEFAULT_CONFIG);
    expect(options.minSpeechFrames).toBe(
      Math.ceil(DEFAULT_CONFIG.MIN_SPEECH_MS / VAD_FRAME_MS),
    );
    expect(options.redemptionFrames).toBe(
      Math.ceil(DEFAULT_CONFIG.SILENCE_MS / VAD_FRAME_MS),
    );
  });

  it('carries the vad-web default speech thresholds through', () => {
    const options = toVadOptions(DEFAULT_CONFIG);
    expect(options.positiveSpeechThreshold).toBe(0.3);
    expect(options.negativeSpeechThreshold).toBe(0.25);
  });
});

describe('createUtteranceGuard', () => {
  it('does not force-end before MAX_UTTERANCE_MS elapses', () => {
    const guard = createUtteranceGuard(DEFAULT_CONFIG);
    expect(guard.forceEnd(0, DEFAULT_CONFIG.MAX_UTTERANCE_MS - 1)).toBe(false);
  });

  it('force-ends at exactly MAX_UTTERANCE_MS', () => {
    const guard = createUtteranceGuard(DEFAULT_CONFIG);
    expect(guard.forceEnd(0, DEFAULT_CONFIG.MAX_UTTERANCE_MS)).toBe(true);
  });

  it('force-ends past the limit', () => {
    const guard = createUtteranceGuard(DEFAULT_CONFIG);
    expect(guard.forceEnd(0, DEFAULT_CONFIG.MAX_UTTERANCE_MS + 1)).toBe(true);
  });

  it('respects the utterance start time, not an absolute clock', () => {
    const guard = createUtteranceGuard(DEFAULT_CONFIG);
    expect(guard.forceEnd(5000, 6000)).toBe(false);
    expect(guard.forceEnd(5000, 5000 + DEFAULT_CONFIG.MAX_UTTERANCE_MS)).toBe(true);
  });
});