import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_CONFIG, withOverrides, type ConversationModeConfig } from './config';
import {
  DISPLAY_LABELS,
  micLive as isMicLive,
  transition,
  type Effect,
  type Event,
  type State,
} from './conversation-mode';
import { createUtteranceGuard, toVadOptions, type VadFrameOptions } from './endpointing';
import { shouldInterrupt } from './echo-guard';
import type { SentenceSplitter } from './sentence-split';
import type { PlaybackQueue, PlaybackState } from './playback-queue';
import type { VadHandle } from './vad';
import type { Metrics } from './metrics';

export interface ConversationModeDeps {
  getUserMedia: typeof navigator.mediaDevices.getUserMedia;
  acquireLock: () => Promise<boolean>;
  createVadFn: (input: VadInput) => Promise<VadHandle>;
  createQueue: (onState?: (state: PlaybackState) => void) => PlaybackQueue;
  createSplitter: () => SentenceSplitter;
  metrics: Metrics;
  patchHeardPortion: (heardChars: number) => void;
  onUtterance: (blob: Blob) => void;
  config?: Partial<ConversationModeConfig>;
}

export interface VadInput {
  stream: MediaStream;
  config: ConversationModeConfig;
  vadFrames: VadFrameOptions;
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  onMisfire: () => void;
}

export interface ConversationModeHandle {
  state: State;
  label: string;
  micLive: boolean;
  // Why the mode is paused (another tab holds voice), for the bar to say; null otherwise.
  reason: string | null;
  start: () => Promise<void>;
  stop: () => void;
  mute: () => void;
  unmute: () => void;
  resume: () => void;
  feedReplyChunk: (text: string) => void;
  endReply: () => void;
}

const PCM16_WAV_SAMPLE_RATE = 16000;

function pcmToWavBlob(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, PCM16_WAV_SAMPLE_RATE, true);
  view.setUint32(28, PCM16_WAV_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function useConversationMode(deps: ConversationModeDeps): ConversationModeHandle {
  const cfg = useMemo(
    () => (deps.config ? withOverrides(deps.config) : DEFAULT_CONFIG),
    [deps.config],
  );
  const [state, setState] = useState<State>('off');
  const [reason, setReason] = useState<string | null>(null);
  const stateRef = useRef<State>('off');
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const streamRef = useRef<MediaStream | null>(null);
  const vadRef = useRef<VadHandle | null>(null);
  const queueRef = useRef<PlaybackQueue | null>(null);
  const splitterRef = useRef<SentenceSplitter | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const utteranceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechStartMsRef = useRef(0);
  const endOfSpeechRef = useRef<number | null>(null);
  const metricsRef = useRef(deps.metrics);
  metricsRef.current = deps.metrics;
  const utteranceBlobRef = useRef<Blob | null>(null);
  const pendingHeardRef = useRef(0);

  const guardRef = useRef(createUtteranceGuard(cfg));
  guardRef.current = createUtteranceGuard(cfg);

  const setStateBoth = useCallback((next: State): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const clearIdleTimer = useCallback((): void => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const startIdleTimer = useCallback((): void => {
    clearIdleTimer();
    idleTimerRef.current = setTimeout(() => {
      dispatchRef.current({ type: 'IDLE_TIMEOUT' });
    }, cfgRef.current.IDLE_TIMEOUT_MS);
  }, [clearIdleTimer]);

  const releaseMic = useCallback((): void => {
    if (utteranceTimerRef.current !== null) {
      clearTimeout(utteranceTimerRef.current);
      utteranceTimerRef.current = null;
    }
    if (vadRef.current) {
      void vadRef.current.destroy();
      vadRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const openMic = useCallback(async (): Promise<void> => {
    try {
      const stream = await deps.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const handle = await deps.createVadFn({
        stream,
        config: cfgRef.current,
        vadFrames: toVadOptions(cfgRef.current),
        onSpeechStart: () => {
          speechStartMsRef.current = Date.now();
          dispatchRef.current({ type: 'SPEECH_START' });
          if (utteranceTimerRef.current !== null) clearTimeout(utteranceTimerRef.current);
          utteranceTimerRef.current = setTimeout(() => {
            const now = Date.now();
            if (
              stateRef.current === 'hearing' &&
              guardRef.current.forceEnd(speechStartMsRef.current, now)
            ) {
              dispatchRef.current({
                type: 'SPEECH_END',
                durationMs: now - speechStartMsRef.current,
              });
            }
          }, cfgRef.current.MAX_UTTERANCE_MS);
        },
        onSpeechEnd: (audio: Float32Array) => {
          utteranceBlobRef.current = pcmToWavBlob(audio);
          const speechMs = Date.now() - speechStartMsRef.current;
          if (
            stateRef.current === 'speaking' &&
            !shouldInterrupt({ state: 'speaking', speechMs, config: cfgRef.current })
          ) {
            return;
          }
          dispatchRef.current({ type: 'SPEECH_END', durationMs: speechMs });
        },
        onMisfire: () => {
          dispatchRef.current({ type: 'ERROR', code: 'misfire' });
        },
      });
      vadRef.current = handle;
      await handle.start();
    } catch {
      dispatchRef.current({ type: 'ERROR', code: 'mic' });
    }
  }, [deps]);

  const teardownPlayback = useCallback((): void => {
    if (!queueRef.current) return;
    const { heardChars } = queueRef.current.stop();
    pendingHeardRef.current += heardChars;
  }, []);

  const runEffect = useCallback(
    (effect: Effect): void => {
      switch (effect.type) {
        case 'openMic':
          void openMic();
          break;
        case 'releaseMic':
          releaseMic();
          break;
        case 'stopPlayback':
          teardownPlayback();
          break;
        case 'abortReply':
          teardownPlayback();
          break;
        case 'recordHeardPortion':
          deps.patchHeardPortion(pendingHeardRef.current);
          pendingHeardRef.current = 0;
          break;
        case 'startIdleTimer':
          startIdleTimer();
          break;
        case 'clearIdleTimer':
          clearIdleTimer();
          break;
        case 'submitUtterance': {
          const blob = utteranceBlobRef.current;
          utteranceBlobRef.current = null;
          if (blob) deps.onUtterance(blob);
          break;
        }
        case 'discardUtterance':
          utteranceBlobRef.current = null;
          break;
        case 'setModeReason':
          setReason(effect.reason);
          break;
      }
    },
    [deps, openMic, releaseMic, teardownPlayback, startIdleTimer, clearIdleTimer],
  );

  const runEffectRef = useRef(runEffect);
  runEffectRef.current = runEffect;

  const dispatchRef = useRef<(event: Event) => void>(() => {});
  const dispatch = useCallback((event: Event): void => {
    const previous = stateRef.current;
    const result = transition(previous, event, {
      now: Date.now(),
      config: cfgRef.current,
    });
    if (result.effects.some((effect) => effect.type === 'submitUtterance')) endOfSpeechRef.current = Date.now();
    if (event.type === 'FIRST_AUDIO' && previous === 'thinking' && endOfSpeechRef.current !== null) {
      metricsRef.current.record({ event: 'turn_timing', eos_to_first_audio_ms: Math.min(600000, Math.max(0, Date.now() - endOfSpeechRef.current)) });
      endOfSpeechRef.current = null;
    }
    if (event.type === 'STOP' || event.type === 'ERROR' || event.type === 'HIDDEN' || result.effects.some((effect) => effect.type === 'abortReply')) endOfSpeechRef.current = null;
    if (result.state !== stateRef.current) {
      // A reason belongs to the transition that set it; any other move clears it.
      setReason(null);
      setStateBoth(result.state);
    }
    result.effects.forEach((effect) => runEffectRef.current(effect));
  }, [setStateBoth]);
  dispatchRef.current = dispatch;

  const start = useCallback(async (): Promise<void> => {
    if (!queueRef.current) {
      queueRef.current = deps.createQueue((s) => {
        if (s === 'speaking') dispatchRef.current({ type: 'FIRST_AUDIO' });
        else dispatchRef.current({ type: 'PLAYBACK_DONE' });
      });
    }
    if (!splitterRef.current) splitterRef.current = deps.createSplitter();
    const held = await deps.acquireLock();
    if (!held) {
      dispatchRef.current({ type: 'LOCK_DENIED' });
      return;
    }
    dispatchRef.current({ type: 'START' });
  }, [deps]);

  const feedReplyChunk = useCallback((text: string): void => {
    const splitter = splitterRef.current;
    const queue = queueRef.current;
    if (!splitter || !queue) return;
    dispatchRef.current({ type: 'REPLY_STARTED' });
    for (const sentence of splitter.push(text)) queue.enqueue(sentence);
  }, []);

  const endReply = useCallback((): void => {
    const splitter = splitterRef.current;
    const queue = queueRef.current;
    if (!splitter || !queue) return;
    for (const sentence of splitter.flush()) queue.enqueue(sentence);
  }, []);

  const stop = useCallback((): void => {
    dispatchRef.current({ type: 'STOP' });
  }, []);
  const mute = useCallback((): void => {
    dispatchRef.current({ type: 'MUTE' });
  }, []);
  const unmute = useCallback((): void => {
    dispatchRef.current({ type: 'UNMUTE' });
  }, []);
  const resume = useCallback((): void => {
    dispatchRef.current({ type: 'RESUME' });
  }, []);

  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') dispatchRef.current({ type: 'HIDDEN' });
    };
    const onPageHide = (): void => {
      dispatchRef.current({ type: 'HIDDEN' });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (utteranceTimerRef.current !== null) clearTimeout(utteranceTimerRef.current);
      clearIdleTimer();
      releaseMic();
      teardownPlayback();
    };
  }, [clearIdleTimer, releaseMic, teardownPlayback]);

  return {
    state,
    label: DISPLAY_LABELS[state],
    micLive: isMicLive(state),
    reason: state === 'paused' ? reason : null,
    start,
    stop,
    mute,
    unmute,
    resume,
    feedReplyChunk,
    endReply,
  };
}