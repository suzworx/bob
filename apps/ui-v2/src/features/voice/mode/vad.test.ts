import { describe, expect, it, vi } from 'vitest';
import { createVad, VAD_ASSET_PATH, VAD_MODEL, type VadFactory } from './vad';
import { DEFAULT_CONFIG } from './config';
import { toVadOptions, VAD_FRAME_MS } from './endpointing';

const fakeStream = {} as MediaStream;

function fakeFactory(handleSpies: {
  start: ReturnType<typeof vi.fn<() => Promise<void>>>;
  pause: ReturnType<typeof vi.fn<() => Promise<void>>>;
  destroy: ReturnType<typeof vi.fn<() => Promise<void>>>;
}): VadFactory {
  return async () => ({
    start: handleSpies.start,
    pause: handleSpies.pause,
    destroy: handleSpies.destroy,
  });
}

describe('createVad', () => {
  it('hands the existing stream and configured endpointing to the factory', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const handle = {
      start: vi.fn<() => Promise<void>>(async () => {}),
      pause: vi.fn<() => Promise<void>>(async () => {}),
      destroy: vi.fn<() => Promise<void>>(async () => {}),
    };
    const factory: VadFactory = async (options) => {
      seen.push(options as unknown as Record<string, unknown>);
      return handle;
    };

    const vad = await createVad(
      {
        stream: fakeStream,
        config: DEFAULT_CONFIG,
        onSpeechStart: () => {},
        onSpeechEnd: () => {},
        onMisfire: () => {},
      },
      factory,
    );

    expect(seen).toHaveLength(1);
    const options = seen[0] as {
      model: string;
      baseAssetPath: string;
      onnxWASMBasePath: string;
      startOnLoad: boolean;
      getStream: () => Promise<MediaStream>;
      pauseStream: () => Promise<void>;
      resumeStream: () => Promise<MediaStream>;
      positiveSpeechThreshold: number;
      negativeSpeechThreshold: number;
      minSpeechMs: number;
      redemptionMs: number;
    };
    expect(options.model).toBe(VAD_MODEL);
    expect(options.baseAssetPath).toBe(VAD_ASSET_PATH);
    expect(options.onnxWASMBasePath).toBe(VAD_ASSET_PATH);
    expect(options.startOnLoad).toBe(false);
    await expect(options.getStream()).resolves.toBe(fakeStream);
    await expect(options.resumeStream()).resolves.toBe(fakeStream);
    await expect(options.pauseStream()).resolves.toBeUndefined();

    const frames = toVadOptions(DEFAULT_CONFIG);
    expect(options.minSpeechMs).toBe(frames.minSpeechFrames * VAD_FRAME_MS);
    expect(options.redemptionMs).toBe(frames.redemptionFrames * VAD_FRAME_MS);
    expect(options.positiveSpeechThreshold).toBe(frames.positiveSpeechThreshold);
    expect(options.negativeSpeechThreshold).toBe(frames.negativeSpeechThreshold);

    expect(vad).toBe(handle);
  });

  it('wires the speech callbacks onto the vad-web option names', async () => {
    const callbacks = {
      onSpeechStart: vi.fn(),
      onSpeechEnd: vi.fn(),
      onMisfire: vi.fn(),
    };
    let captured: {
      onSpeechStart: () => void;
      onSpeechEnd: (audio: Float32Array) => void;
      onVADMisfire: () => void;
    } | undefined;
    const factory: VadFactory = async (options) => {
      captured = options as unknown as typeof captured;
      return { start: async () => {}, pause: async () => {}, destroy: async () => {} };
    };

    await createVad(
      {
        stream: fakeStream,
        config: DEFAULT_CONFIG,
        ...callbacks,
      },
      factory,
    );

    expect(captured).toBeDefined();
    captured!.onSpeechStart();
    captured!.onSpeechEnd(new Float32Array(0));
    captured!.onVADMisfire();
    expect(callbacks.onSpeechStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onSpeechEnd).toHaveBeenCalledTimes(1);
    expect(callbacks.onMisfire).toHaveBeenCalledTimes(1);
  });

  it('configures onnxruntime-web for single-threaded execution via ortConfig', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const handle = {
      start: vi.fn<() => Promise<void>>(async () => {}),
      pause: vi.fn<() => Promise<void>>(async () => {}),
      destroy: vi.fn<() => Promise<void>>(async () => {}),
    };
    const factory: VadFactory = async (options) => {
      seen.push(options as unknown as Record<string, unknown>);
      return handle;
    };

    await createVad(
      {
        stream: fakeStream,
        config: DEFAULT_CONFIG,
        onSpeechStart: () => {},
        onSpeechEnd: () => {},
        onMisfire: () => {},
      },
      factory,
    );

    const options = seen[0] as { ortConfig: (ort: { env: { wasm: { numThreads?: number } } }) => void };
    expect(typeof options.ortConfig).toBe('function');

    // The app is served without COOP/COEP headers, so pages are never
    // cross-origin isolated and SharedArrayBuffer is unavailable. This is the
    // regression test for that: without ortConfig forcing numThreads to 1, the
    // bundled threaded onnxruntime-web wasm build requests SharedArrayBuffer
    // and fails to load the model (silero_vad_v5.onnx).
    const fakeOrt = { env: { wasm: {} as { numThreads?: number } } };
    options.ortConfig(fakeOrt);
    expect(fakeOrt.env.wasm.numThreads).toBe(1);
  });

  it('exposes start, pause and destroy from the factory handle', async () => {
    const handle = {
      start: vi.fn<() => Promise<void>>(async () => {}),
      pause: vi.fn<() => Promise<void>>(async () => {}),
      destroy: vi.fn<() => Promise<void>>(async () => {}),
    };
    const vad = await createVad(
      {
        stream: fakeStream,
        config: DEFAULT_CONFIG,
        onSpeechStart: () => {},
        onSpeechEnd: () => {},
        onMisfire: () => {},
      },
      fakeFactory(handle),
    );

    await vad.start();
    await vad.pause();
    await vad.destroy();
    expect(handle.start).toHaveBeenCalledTimes(1);
    expect(handle.pause).toHaveBeenCalledTimes(1);
    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });
});