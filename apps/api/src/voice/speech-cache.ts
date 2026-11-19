/**
 * TTS result cache (a SpeechPort decorator). Short, repeated phrases (the
 * empty-turn reply, a reminder fanned out to several devices, "Done.") skip the
 * provider call, the resample and the MP3 encode. STT is never cached. The
 * text is hashed into the key and never journaled; the voice is part of the
 * key, so a phrase cached in one voice never plays in another.
 */
import { createHash } from 'node:crypto';
import { recordObservationMetrics, traceSpan } from '@bob/ai';
import { moduleJournal } from '../platform/logger.ts';
import { createMemoCache, type MemoCache } from '../platform/cache/memo-cache.ts';
import { wholeMp3, type SpeechPort, type TtsMp3Result } from './speech-port.ts';

const journal = moduleJournal('voice');

export interface SpeechCacheOptions {
  max?: number;
  ttlMs?: number;
  /** Texts longer than this bypass the cache: long replies rarely repeat. */
  maxChars?: number;
  now?: () => number;
}

const hashKey = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex');

export function withTtsCache(port: SpeechPort, options: SpeechCacheOptions = {}): SpeechPort {
  const { max = 128, ttlMs = 60 * 60 * 1000, maxChars = 200, now } = options;
  const make = <V>(): MemoCache<V> => createMemoCache<V>({ max, ttlMs, ...(now ? { now } : {}) });
  const pcm = make<Awaited<ReturnType<SpeechPort['synthesizePcm']>>>();
  const mp3 = make<Awaited<ReturnType<SpeechPort['synthesizeMp3']>>>();
  const encoded = make<Awaited<ReturnType<SpeechPort['synthesizeEncoded']>>>();
  const model = (): string => `${process.env.BOB_TTS_MODEL ?? ''}|${process.env.BOB_TTS_VOICE ?? ''}`;

  async function through<V>(kind: string, cache: MemoCache<V>, text: string, extra: string, call: () => Promise<V>): Promise<{ value: V; hit: boolean }> {
    return traceSpan('speech-tts-cache', { metadata: { format: kind } }, async () => {
      const start = performance.now();
      const bypass = text.length > maxChars;
      let miss = false;
      let failed = true;
      try {
        if (bypass) { const value = await call(); failed = false; return { value, hit: false }; }
        const { value, hit } = await cache.getOrCreate(hashKey(kind, model(), extra, text), () => { miss = true; return call(); });
        if (hit) journal('v2.tts_cache_hit', { kind, chars: text.length });
        failed = false;
        return { value, hit };
      } finally {
        recordObservationMetrics([
          { name: 'speech.duration_ms', value: Math.round(performance.now() - start) },
          { name: 'speech.failed', value: Number(failed) },
          { name: 'speech.cache_bypass', value: Number(bypass) },
          ...(!bypass ? [
            { name: 'speech.cache_hit' as const, value: Number(!miss) },
            { name: 'speech.cache_miss' as const, value: Number(miss) },
          ] : []),
        ]);
      }
    });
  }

  return {
    transcribe: (audio) => port.transcribe(audio),
    ...(port.openTranscriptStream !== undefined ? { openTranscriptStream: port.openTranscriptStream.bind(port) } : {}),
    transcribeEncoded: (input) => port.transcribeEncoded(input),
    // Buffers are copied out so no caller can corrupt the cached bytes.
    // A hit drops `timing`: it describes the original call, not this serve.
    synthesizePcm: async (text, voice) => {
      const { value: { timing, ...r }, hit } = await through('pcm', pcm, text, voice ?? '', () => port.synthesizePcm(text, voice));
      return { ...r, pcm: Buffer.from(r.pcm), ...(timing && !hit ? { timing } : {}) };
    },
    // The cache holds the WHOLE clip: its promise settles once the tail has, so a
    // tail failure evicts the key. A miss hands its caller the progressive result
    // as soon as the head is ready; a hit serves the whole clip, no tail.
    synthesizeMp3: async (text, voice) => {
      let startedHead: (head: Promise<TtsMp3Result>) => void = () => undefined;
      const started = new Promise<TtsMp3Result>((resolve) => { startedHead = resolve; });
      const whole = through('mp3', mp3, text, voice ?? '', () => {
        const head = port.synthesizeMp3(text, voice);
        startedHead(head);
        return head.then(async (r) => (r.tail === undefined ? r : { mp3: await wholeMp3(r), ...(r.timing ? { timing: r.timing } : {}) }));
      });
      const first = await Promise.race([started.then((r) => ({ head: r })), whole.then((done) => ({ done }))]);
      if ('head' in first) return { ...first.head, mp3: Buffer.from(first.head.mp3) };
      const { value: { timing, ...r }, hit } = first.done;
      return { ...r, mp3: Buffer.from(r.mp3), ...(timing && !hit ? { timing } : {}) };
    },
    synthesizeEncoded: async (input) => {
      const { value: { timing, ...r }, hit } = await through('encoded', encoded, input.text, `${input.format ?? ''}|${input.voice ?? ''}|${input.model ?? ''}|${input.speed ?? ''}`, () =>
        port.synthesizeEncoded(input),
      );
      return { ...r, ...(timing && !hit ? { timing } : {}) };
    },
  };
}
