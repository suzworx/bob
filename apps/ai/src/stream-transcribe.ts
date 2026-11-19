/**
 * Streaming speech-to-text: PCM16 16 kHz mono is pushed while
 * the user talks, and `finish()` closes the input and resolves with the final
 * transcript. The provider session takes time to open, which can be longer
 * than a short utterance, so frames pushed before it reads are queued and
 * flushed in order the moment it does; `setupMs` is that wait. Never logs
 * audio or text.
 */
import { experimental_streamTranscribe, NoTranscriptGeneratedError } from 'ai';
import { traceSpeechUsage } from './telemetry.ts';
import { BOB_STT_LANGUAGE, BOB_STT_OPTIONS_NAMESPACE, BOB_STT_STREAMING_MODEL } from './config.ts';

export interface StreamTranscript {
  text: string;
  model: string;
  seconds?: number;
}

/** One live transcription session; one per device turn. */
export interface TranscriptStream {
  readonly model: string;
  /** Milliseconds from open until the provider first read audio; undefined while it is not ready. */
  readonly setupMs: number | undefined;
  /** Counts only, never text: transcript parts seen and audio bytes the provider read. */
  readonly stats: { finals: number; partials: number; bytesRead: number };
  /** The words heard so far (the finals, then the latest partial), for an early
   *  memory recall; '' before any. Held in memory, never logged. */
  readonly hypothesis: string;
  /** Queues raw PCM16 16 kHz mono; a no-op once finished or aborted. */
  push(pcm: Uint8Array): void;
  /** Ends the input and resolves with the final transcript (rejects on a provider error or abort). */
  finish(): Promise<StreamTranscript>;
  /** Closes the provider session; any pending finish() rejects. */
  abort(): void;
}

export interface TranscriptStreamOptions {
  model?: string;
  /** Same rule as the batch STT: 'auto' sends no language, anything else is pinned. */
  language?: string;
  /** Injectable for tests; defaults to the AI SDK's experimental_streamTranscribe. */
  streamTranscribe?: typeof experimental_streamTranscribe;
}

/** The device uplink rate; MAI-Transcribe-2-Streaming accepts 16 or 24 kHz, so no resample. */
const UPLINK_RATE_HZ = 16_000;

/** The transcript parts: the finals in order, how many partials came and the latest one's text. Never logged. */
interface Tally { finals: string[]; partials: number; partial: string }

/**
 * Reads the parts as they arrive, then settles the text. A blank finish part errors the stream after
 * its finals, which then stand as the text; any other error still rejects.
 */
async function readParts(result: ReturnType<typeof experimental_streamTranscribe>, tally: Tally): Promise<string> {
  try {
    for await (const part of result.fullStream) {
      if (part.type === 'transcript-final') { tally.finals.push(part.text); tally.partial = ''; }
      else if (part.type === 'transcript-partial') { tally.partials += 1; tally.partial = part.text; }
    }
  } catch (error) {
    if (!NoTranscriptGeneratedError.isInstance(error)) throw error;
  }
  const finished = await Promise.resolve(result.text).catch((error: unknown) => (NoTranscriptGeneratedError.isInstance(error) ? '' : Promise.reject(error)));
  return finished.trim() ? finished : tally.finals.join(' ');
}

export function openTranscriptStream(options: TranscriptStreamOptions = {}): TranscriptStream {
  const model = options.model ?? BOB_STT_STREAMING_MODEL;
  const language = options.language ?? BOB_STT_LANGUAGE;
  const namespace = BOB_STT_OPTIONS_NAMESPACE || (model.split('/')[0] ?? model);
  const streamTranscribe = options.streamTranscribe ?? experimental_streamTranscribe;
  const openedAt = Date.now();
  const abort = new AbortController();
  let queue: Uint8Array[] = [];
  let ended = false;
  let readyAt: number | undefined;
  let bytesRead = 0;
  const tally: Tally = { finals: [], partials: 0, partial: '' };
  let wake: (() => void) | undefined;
  const signal = (): void => { wake?.(); wake = undefined; };

  // highWaterMark 0: pull runs only when the provider reads, which it does once its session is open.
  const audio = new ReadableStream<Uint8Array>({
    async pull(controller) {
      readyAt ??= Date.now();
      while (queue.length === 0 && !ended) await new Promise<void>((resolve) => { wake = resolve; });
      if (queue.length > 0) {
        const chunk = Buffer.concat(queue);
        bytesRead += chunk.byteLength;
        controller.enqueue(chunk);
        queue = [];
      } else controller.close();
    },
    cancel() { ended = true; queue = []; signal(); },
  }, { highWaterMark: 0 });

  const result = streamTranscribe({
    model,
    audio,
    inputAudioFormat: { type: 'audio/pcm', rate: UPLINK_RATE_HZ },
    providerOptions: language === 'auto' ? {} : { [namespace]: { language } },
    abortSignal: abort.signal,
    // No integration: a registered one makes the SDK wrap audio in a byte counter that pulls it at once.
    telemetry: { integrations: [] },
  });
  const final = (async (): Promise<StreamTranscript> => {
    const text = await readParts(result, tally);
    // A blank provider finish also rejects the duration; PCM16 mono length still meters the turn.
    const seconds = await Promise.resolve(result.durationInSeconds).catch(() => (bytesRead > 0 ? bytesRead / (UPLINK_RATE_HZ * 2) : undefined));
    if (seconds !== undefined) traceSpeechUsage({ kind: 'stt', model, inputUnits: seconds });
    return { text, model, ...(seconds !== undefined ? { seconds } : {}) };
  })();
  // An aborted or failed session nobody awaits must not surface as an unhandled rejection.
  final.catch(() => undefined);

  return {
    model,
    get setupMs() { return readyAt === undefined ? undefined : readyAt - openedAt; },
    get stats() { return { finals: tally.finals.length, partials: tally.partials, bytesRead }; },
    get hypothesis() { return [...tally.finals, tally.partial].filter((text) => text.trim() !== '').join(' ').trim(); },
    push(pcm) {
      if (ended) return;
      queue.push(Uint8Array.from(pcm));
      signal();
    },
    finish() {
      ended = true;
      signal();
      return final;
    },
    abort() {
      ended = true;
      queue = [];
      signal();
      abort.abort();
    },
  };
}
