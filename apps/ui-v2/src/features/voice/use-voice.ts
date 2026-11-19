import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '../../lib/auth/use-session';

export type VoiceError =
  | 'permission'
  | 'no_device'
  | 'unsupported'
  | 'too_long'
  | 'upload'
  | 'playback'
  | 'out_of_credit';

/** #1041: the server's 503 code when the AI budget is spent (web chat sends it too). */
export const OUT_OF_CREDIT = 'out_of_credit' as const;

/** What a failed response means: the server's 503 out_of_credit, else `fallback`. */
async function failedAs<T extends string>(result: Response, fallback: T): Promise<T | typeof OUT_OF_CREDIT> {
  if (result.status !== 503) return fallback;
  const body = (await result.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  return body?.error?.code === OUT_OF_CREDIT ? OUT_OF_CREDIT : fallback;
}

const MAX_AUDIO_BYTES = 2097152;

/**
 * Uplink sample rate. Speech models work at 16 kHz mono, the Cardputer uplink
 * already sends exactly that, and it keeps a re-encoded capture roughly 65
 * seconds under MAX_AUDIO_BYTES -- a 44.1 kHz stereo WAV would blow that in
 * twelve.
 */
const TRANSCRIBE_SAMPLE_RATE = 16000;

type OfflineAudioContextCtor = typeof OfflineAudioContext;
type AudioHost = {
  OfflineAudioContext?: OfflineAudioContextCtor;
  webkitOfflineAudioContext?: OfflineAudioContextCtor;
};

function offlineAudioContext(): OfflineAudioContextCtor | null {
  const host = window as unknown as AudioHost;
  return host.OfflineAudioContext ?? host.webkitOfflineAudioContext ?? null;
}

/** Wraps PCM samples in a 16-bit mono RIFF/WAVE container. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // uncompressed PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Re-encodes a MediaRecorder capture as 16 kHz mono WAV.
 *
 * MediaRecorder emits whatever container the browser prefers -- WebM/Opus on
 * Chrome, MP4/AAC on Safari, Ogg/Opus on Firefox -- and the configured STT
 * model decodes some of those and not others. Chrome's WebM is the one it
 * rejects, which is the whole of the browser voice path on the most common
 * browser. Normalising here rather than widening a provider's container list
 * keeps that failure from returning the next time the model changes, and
 * lands the web uplink on the same representation the device already sends.
 *
 * The browser's own decoders do the work, so no codec ships in the bundle.
 * Returns null when the browser has no OfflineAudioContext or cannot decode
 * the capture; the caller then uploads the original bytes unchanged.
 */
async function toWav(blob: Blob): Promise<Blob | null> {
  const Ctor = offlineAudioContext();
  if (!Ctor) return null;
  try {
    // decodeAudioData resamples to the context rate, so decoding in a 16 kHz
    // context does the downsampling; the render pass downmixes to mono.
    const decoded = await new Ctor(1, 1, TRANSCRIBE_SAMPLE_RATE).decodeAudioData(await blob.arrayBuffer());
    const frames = Math.ceil(decoded.duration * TRANSCRIBE_SAMPLE_RATE);
    if (frames <= 0) return null;
    const offline = new Ctor(1, frames, TRANSCRIBE_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), TRANSCRIBE_SAMPLE_RATE);
  } catch {
    return null;
  }
}

/**
 * Base64 for an upload that is now PCM rather than Opus, so an order of
 * magnitude larger. Chunked because building the binary string one character
 * at a time costs seconds on a megabyte, and spreading a whole megabyte
 * through one apply() overflows the argument stack.
 */
function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** The wire format name for a capture uploaded without re-encoding. */
function originalFormat(blob: Blob): 'm4a' | 'ogg' | 'webm' {
  if (blob.type.startsWith('audio/mp4')) return 'm4a';
  if (blob.type.startsWith('audio/ogg')) return 'ogg';
  return 'webm';
}

export interface VoiceWorkflow { workflowId: string; onTrace?: (traceId: string) => void }

export function useVoice(): {
  error: VoiceError | null;
  setError: (error: VoiceError) => void;
  clearError: () => void;
  transcribe: (blob: Blob, workflow?: VoiceWorkflow) => Promise<string | null>;
  speak: (text: string, workflowId?: string) => Promise<void>;
  audioUrl: string | null;
  truncated: boolean;
  synthesize: (text: string, signal: AbortSignal, workflowId?: string) => Promise<string>;
  play: (url: string) => Promise<void>;
  stopPlayback: () => void;
  revoke: (url: string) => void;
} {
  const [error, setError] = useState<VoiceError | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const audioUrlRef = useRef<string | null>(null);
  audioUrlRef.current = audioUrl;

  useEffect(
    () => () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    },
    [],
  );

  // Uploads a recorded blob to Bob Core for transcription (FR-020). The
  // browser's own recogniser is never used; capture reaches this hook through
  // CoreSpeechInput's forced recorded-audio path.
  const transcribe = useCallback(async (blob: Blob, workflow?: VoiceWorkflow): Promise<string | null> => {
    setError(null);
    if (blob.size > MAX_AUDIO_BYTES) {
      setError('too_long');
      return null;
    }
    try {
      const wav = await toWav(blob);
      const upload = wav ?? blob;
      // Checked again after re-encoding: PCM is ~8x the recorded Opus, so a
      // capture that cleared the guard above can still exceed the server's
      // cap, and that must read as too_long rather than a failed upload.
      if (upload.size > MAX_AUDIO_BYTES) {
        setError('too_long');
        return null;
      }
      const format = wav ? 'wav' : originalFormat(blob);
      const bytes = new Uint8Array(await upload.arrayBuffer());
      const result = await fetchWithAuth('/api/voice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: toBase64(bytes), format, workflowId: workflow?.workflowId }),
      });
      if (!result.ok) {
        setError(await failedAs(result, 'upload'));
        return null;
      }
      const traceId = result.headers.get('X-Bob-Trace-Id');
      if (traceId && /^[a-f0-9]{32}$/.test(traceId)) workflow?.onTrace?.(traceId);
      const body = (await result.json()) as { text: string };
      return body.text;
    } catch {
      setError('upload');
      return null;
    }
  }, []);

  const speak = useCallback(async (text: string, workflowId?: string): Promise<void> => {
    try {
      const result = await fetchWithAuth('/api/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, workflowId }),
      });
      if (!result.ok) {
        setError(await failedAs(result, 'playback'));
        return;
      }
      setTruncated(result.headers.get('X-Bob-Speech-Truncated') === 'true');
      const url = URL.createObjectURL(await result.blob());
      setAudioUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
    } catch {
      setError('playback');
    }
  }, []);

  // Hands-free sentence playback (013 / S13): the conversation-mode playback
  // queue synthesizes one sentence at a time through these primitives. They
  // sit alongside (never replace) `speak`/`transcribe`/`audioUrl`, which keep
  // the push-to-talk and #102 auto-play path exactly as it is today (FR-037).

  // The single active sentence audio element. `play` resolves on playback
  // end, rejects on error, and is unblocked early by `stopPlayback` so a
  // barge-in never leaves the queue awaiting an element that can no longer
  // play.
  const sentenceAudioRef = useRef<HTMLAudioElement | null>(null);
  const sentenceSettleRef = useRef<{
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);

  const synthesize = useCallback(
    async (text: string, signal: AbortSignal, workflowId?: string): Promise<string> => {
      const result = await fetchWithAuth('/api/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, workflowId }),
        signal,
      });
      if (!result.ok) throw new Error(await failedAs(result, 'speech'));
      return URL.createObjectURL(await result.blob());
    },
    [],
  );

  const playSentence = useCallback(
    (url: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const el = new Audio(url);
        sentenceAudioRef.current = el;
        sentenceSettleRef.current = { resolve, reject };
        const settle = (error?: Error): void => {
          if (sentenceAudioRef.current !== el) return;
          sentenceAudioRef.current = null;
          sentenceSettleRef.current = null;
          if (error) reject(error);
          else resolve();
        };
        el.onended = (): void => settle();
        el.onerror = (): void => settle(new Error('playback'));
        void el.play().catch((error: unknown) => settle(error as Error));
      }),
    [],
  );

  const stopSentencePlayback = useCallback((): void => {
    const el = sentenceAudioRef.current;
    const settle = sentenceSettleRef.current;
    sentenceAudioRef.current = null;
    sentenceSettleRef.current = null;
    if (el) {
      el.pause();
      el.remove();
    }
    settle?.resolve();
  }, []);

  const revokeUrl = useCallback((url: string): void => {
    URL.revokeObjectURL(url);
  }, []);

  return {
    error,
    setError,
    clearError: () => setError(null),
    transcribe,
    speak,
    audioUrl,
    truncated,
    synthesize,
    play: playSentence,
    stopPlayback: stopSentencePlayback,
    revoke: revokeUrl,
  };
}
