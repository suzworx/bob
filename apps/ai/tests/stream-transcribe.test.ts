/**
 * #1331 item 2: the streaming STT adapter over an injected fake
 * experimental_streamTranscribe (no network). Frames pushed before the
 * provider session is ready are queued and reach it in order once it reads.
 * The readiness, empty-final and stats tests run the real SDK over a fake model.
 */
import { describe, expect, it } from 'vitest';
import { experimental_streamTranscribe, registerTelemetry, type TranscriptionModel } from 'ai';
import { openTranscriptStream } from '../src/stream-transcribe.ts';

type StreamArgs = Parameters<typeof experimental_streamTranscribe>[0];
type Part = { type: string } & Record<string, unknown>;

/** A fake provider: records its args, reads no audio until `ready()`, then answers `text` when input ends. */
function fakeProvider(text = 'hello there') {
  let args: StreamArgs | undefined;
  const received: number[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fn = ((input: StreamArgs) => {
    args = input;
    const textPromise = (async () => {
      await gate;
      const reader = input.audio.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received.push(...(value as Uint8Array));
      }
      return text;
    })();
    return {
      get text() { return textPromise; },
      get durationInSeconds() { return Promise.resolve(1.5); },
      get fullStream() { return (async function* () { /* no parts: the text alone is the final */ })(); },
    };
  }) as unknown as typeof experimental_streamTranscribe;
  return { fn, ready: () => release(), received, args: () => args };
}

/** The real experimental_streamTranscribe over a fake model: it waits on `gate`, reads the audio to its end, then streams `parts`. */
function sdkOver(parts: Part[], gate: Promise<void> = Promise.resolve()): typeof experimental_streamTranscribe {
  const model = {
    specificationVersion: 'v4', provider: 'test', modelId: 'stream-1',
    async doStream({ audio }: { audio: ReadableStream<Uint8Array | string> }) {
      await gate;
      const reader = audio.getReader();
      while (!(await reader.read()).done) { /* drain the audio */ }
      return { stream: new ReadableStream<Part>({ start(controller) { parts.forEach((part) => controller.enqueue(part)); controller.close(); } }) };
    },
  };
  return ((args: StreamArgs) => experimental_streamTranscribe({ ...args, model: model as unknown as TranscriptionModel })) as typeof experimental_streamTranscribe;
}

describe('openTranscriptStream', () => {
  it('queues frames pushed before the provider is ready and flushes them in order', async () => {
    const provider = fakeProvider();
    const stream = openTranscriptStream({ model: 'test/stream-1', language: 'en', streamTranscribe: provider.fn });
    stream.push(Uint8Array.from([1, 2]));
    stream.push(Uint8Array.from([3, 4]));
    expect(stream.setupMs).toBeUndefined();
    provider.ready();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stream.setupMs).toBeGreaterThanOrEqual(0);
    stream.push(Uint8Array.from([5, 6]));
    await expect(stream.finish()).resolves.toEqual({ text: 'hello there', model: 'test/stream-1', seconds: 1.5 });
    expect(provider.received).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('sends raw PCM16 16 kHz and the batch language pin under the model namespace', () => {
    const provider = fakeProvider();
    openTranscriptStream({ model: 'microsoft/mai-transcribe-2-streaming', language: 'en', streamTranscribe: provider.fn }).abort();
    expect(provider.args()).toMatchObject({
      model: 'microsoft/mai-transcribe-2-streaming',
      inputAudioFormat: { type: 'audio/pcm', rate: 16000 },
      providerOptions: { microsoft: { language: 'en' } },
    });
  });

  it('sends no language when it is auto, and abort aborts the provider call', () => {
    const provider = fakeProvider();
    const stream = openTranscriptStream({ model: 'test/stream-1', language: 'auto', streamTranscribe: provider.fn });
    expect(provider.args()?.providerOptions).toEqual({});
    stream.abort();
    expect(provider.args()?.abortSignal?.aborted).toBe(true);
  });

  it('reads setupMs from the provider read, not from the SDK byte counter', async () => {
    // A registered integration makes the SDK wrap the audio in its byte counter, which pulls eagerly.
    const integration = { experimental_onStreamTranscriptionEnd: () => undefined };
    registerTelemetry(integration);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const parts: Part[] = [{ type: 'stream-start', warnings: [] }, { type: 'finish', text: 'hello', segments: [] }];
      const stream = openTranscriptStream({ model: 'test/stream-1', language: 'en', streamTranscribe: sdkOver(parts, gate) });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(stream.setupMs).toBeUndefined();
      release();
      await expect(stream.finish()).resolves.toMatchObject({ text: 'hello' });
      expect(stream.setupMs).toBeGreaterThanOrEqual(0);
    } finally {
      const registry = (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS;
      registry?.splice(registry.indexOf(integration), 1);
    }
  });

  it('finish resolves with the finalised text when the finish part is blank', async () => {
    const parts: Part[] = [{ type: 'stream-start', warnings: [] }, { type: 'transcript-final', text: 'hello' }, { type: 'finish', text: '', segments: [] }];
    const stream = openTranscriptStream({ model: 'test/stream-1', language: 'en', streamTranscribe: sdkOver(parts) });
    stream.push(Uint8Array.from([1, 2]));
    await expect(stream.finish()).resolves.toMatchObject({ text: 'hello', model: 'test/stream-1' });
  });

  it('counts the finals, partials and bytes the provider read', async () => {
    const parts: Part[] = [{ type: 'stream-start', warnings: [] }, { type: 'transcript-partial', text: 'hel' }, { type: 'transcript-final', text: 'hello' }, { type: 'finish', text: 'hello', segments: [] }];
    const stream = openTranscriptStream({ model: 'test/stream-1', language: 'en', streamTranscribe: sdkOver(parts) });
    stream.push(Uint8Array.from([1, 2, 3]));
    await stream.finish();
    expect(stream.stats).toEqual({ finals: 1, partials: 1, bytesRead: 3 });
  });

  it('holds the hypothesis so far: the finals in order, then the latest partial (in memory only)', async () => {
    const parts: Part[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'transcript-partial', text: 'hel' }, { type: 'transcript-final', text: 'hello' },
      { type: 'transcript-partial', text: 'there' }, { type: 'transcript-partial', text: 'there friend' },
      { type: 'finish', text: 'hello there friend', segments: [] },
    ];
    const stream = openTranscriptStream({ model: 'test/stream-1', language: 'en', streamTranscribe: sdkOver(parts) });
    expect(stream.hypothesis).toBe('');
    stream.push(Uint8Array.from([1, 2]));
    await stream.finish();
    expect(stream.hypothesis).toBe('hello there friend');
  });
});
