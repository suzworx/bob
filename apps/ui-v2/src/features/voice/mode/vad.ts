import { MicVAD } from '@ricky0123/vad-web';
import type { RealTimeVADOptions } from '@ricky0123/vad-web';
import type { ConversationModeConfig } from './config';
import { toVadOptions, VAD_FRAME_MS } from './endpointing';

/** Same-origin asset root served by apps/ui-v2/public/vad (see scripts/copy-vad-assets.mjs). */
export const VAD_ASSET_PATH = '/vad/';

/** Research R1 pins Silero VAD v5, which runs at 32 ms/frame (endpointing.ts). */
export const VAD_MODEL = 'v5';

interface VadCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  onMisfire: () => void;
}

interface CreateVadInput extends VadCallbacks {
  readonly stream: MediaStream;
  readonly config: ConversationModeConfig;
}

export interface VadHandle {
  start(): Promise<void>;
  pause(): Promise<void>;
  destroy(): Promise<void>;
}

export type VadFactory = (options: Partial<RealTimeVADOptions>) => Promise<VadHandle>;

/**
 * Thin adapter over @ricky0123/vad-web's MicVAD. The mode opens the
 * MediaStream itself with the R3 getUserMedia constraints (echoCancellation,
 * noiseSuppression, autoGainControl) and hands it in here — vad-web never
 * calls getUserMedia. start/pause/destroy map onto the handle the factory
 * returns; the factory defaults to MicVAD.new and is injectable so the adapter
 * is testable without the WASM model.
 */
export function createVad(
  { stream, config, onSpeechStart, onSpeechEnd, onMisfire }: CreateVadInput,
  factory: VadFactory = MicVAD.new,
): Promise<VadHandle> {
  const frames = toVadOptions(config);
  return factory({
    model: VAD_MODEL,
    baseAssetPath: VAD_ASSET_PATH,
    onnxWASMBasePath: VAD_ASSET_PATH,
    startOnLoad: false,
    // The app is served without COOP/COEP, so the page is never cross-origin
    // isolated and `SharedArrayBuffer` is unavailable. The bundled onnxruntime-web
    // wasm build defaults to its threaded backend, which requires
    // SharedArrayBuffer to spin up worker threads and fails to load the model
    // without it. Force single-threaded (still SIMD) execution so it never
    // requests threads.
    ortConfig: (ort) => {
      ort.env.wasm.numThreads = 1;
    },
    getStream: async () => stream,
    pauseStream: async () => {},
    resumeStream: async () => stream,
    positiveSpeechThreshold: frames.positiveSpeechThreshold,
    negativeSpeechThreshold: frames.negativeSpeechThreshold,
    minSpeechMs: frames.minSpeechFrames * VAD_FRAME_MS,
    redemptionMs: frames.redemptionFrames * VAD_FRAME_MS,
    onSpeechStart,
    onSpeechEnd,
    onVADMisfire: onMisfire,
  });
}