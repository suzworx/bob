/**
 * SpeechPort adapters and the function that picks them.
 *
 *  - provider adapter: the audio pipeline over the @bob/ai Gateway.
 *  - stub adapter: the same audio.ts pipeline over a canned provider, so a
 *    stubbed turn produces the bytes and journal fields it always did.
 *  - selectSpeech(config): the only place stub mode is decided for speech.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTranscriptStream, synthesizeSpeech, transcribeAudio } from '@bob/ai';
import { synthesizeMp3, synthesizePcm, transcribePcm } from './audio/stt-tts.ts';
import type { SpeechPort, SpeechProviderFns } from './speech-port.ts';

/** Which halves of speech are stubbed. Built from env once, at the composition root. */
export interface SpeechConfig {
  stubStt: boolean;
  stubTts: boolean;
  /** BOB_STT_STREAMING=1: transcribe while the user talks. Never with stubbed STT. */
  streamStt?: boolean;
}

/**
 * BOB_AI_STUB / BOB_SYSTEM_TEST stub STT and, unless
 * BOB_SYSTEM_TEST_REAL_TTS=1 keeps synthesis real for an end-to-end harness,
 * TTS. `aiStub` is @bob/ai's AI_STUB_MODE.
 */
export function speechConfigFromEnv(aiStub: boolean, env: NodeJS.ProcessEnv): SpeechConfig {
  const streamStt = !aiStub && env.BOB_STT_STREAMING === '1';
  return { stubStt: aiStub, stubTts: aiStub && env.BOB_SYSTEM_TEST_REAL_TTS !== '1', ...(streamStt ? { streamStt } : {}) };
}

/** The real adapter. `provider` defaults to @bob/ai's Gateway pair; tests inject a fake. */
export function createProviderSpeech(provider?: SpeechProviderFns): SpeechPort {
  // Without an injected provider the pipeline's own default (the Gateway pair) applies, called with the bare argument.
  if (provider === undefined) {
    return {
      transcribe: (pcm) => transcribePcm(pcm),
      openTranscriptStream: () => openTranscriptStream(),
      synthesizePcm: (text, voice) => synthesizePcm(text, undefined, voice),
      synthesizeMp3: (text, voice) => synthesizeMp3(text, undefined, voice),
      transcribeEncoded: (input) => transcribeAudio(input),
      synthesizeEncoded: (input) => synthesizeSpeech(input),
    };
  }
  return {
    transcribe: (pcm) => transcribePcm(pcm, provider),
    synthesizePcm: (text, voice) => synthesizePcm(text, provider, voice),
    synthesizeMp3: (text, voice) => synthesizeMp3(text, provider, voice),
    transcribeEncoded: (input) => provider.transcribeAudio(input),
    synthesizeEncoded: (input) => provider.synthesizeSpeech(input),
  };
}

function parsePositiveSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 16 kHz -> 24 kHz PCM16 by linear interpolation, so the clip keeps its pitch and speed. Whole samples only. */
function resampleTo24k(clip: Buffer): Buffer {
  const inCount = Math.floor(clip.length / 2);
  const outCount = Math.round((inCount * 24_000) / 16_000);
  const out = Buffer.alloc(outCount * 2);
  for (let j = 0; j < outCount; j += 1) {
    const num = j * 16_000;
    const i = Math.floor(num / 24_000);
    const frac = (num % 24_000) / 24_000;
    const a = clip.readInt16LE(i * 2);
    const b = clip.readInt16LE(Math.min(i + 1, inCount - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * frac), j * 2);
  }
  return out;
}

/**
 * Deterministic RIFF/WAVE PCM16 mono 24 kHz: `seconds` of a 440 Hz sine at amplitude 8000,
 * or `clip` (16 kHz) resampled to 24 kHz and looped with 300 ms of silence between loops.
 */
function stubWav(seconds: number, clip: Buffer | null): Buffer {
  const sampleRate = 24_000;
  const dataSize = seconds * sampleRate * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  const data = Buffer.alloc(dataSize);
  if (clip !== null) {
    // The gap is left as the zeros Buffer.alloc gave it.
    const loop = resampleTo24k(clip);
    const period = loop.length + 0.3 * sampleRate * 2;
    for (let at = 0; at < dataSize; at += period) loop.copy(data, at, 0, Math.min(loop.length, dataSize - at));
  } else {
    const step = (2 * Math.PI * 440) / sampleRate;
    for (let i = 0; i < dataSize / 2; i += 1) data.writeInt16LE(Math.round(8000 * Math.sin(step * i)), i * 2);
  }
  return Buffer.concat([header, data]);
}

/** The BOB_SYSTEM_TEST_TTS_WAV clip's PCM16 samples, or null (use the sine) when unset, missing or not 16 kHz mono PCM16. Never throws. */
function stubClip(): Buffer | null {
  const named = process.env.BOB_SYSTEM_TEST_TTS_WAV;
  if (!named) return null;
  try {
    const bytes = readFileSync(join(process.cwd(), named));
    const riff = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
    const pcm16Mono16k = bytes.readUInt16LE(20) === 1 && bytes.readUInt16LE(22) === 1
      && bytes.readUInt32LE(24) === 16_000 && bytes.readUInt16LE(34) === 16;
    return riff && pcm16Mono16k ? bytes.subarray(44) : null;
  } catch {
    return null;
  }
}

/**
 * Canned provider calls: fixed transcript, fixed tone, no network, no keys. Env is read per call.
 * BOB_SYSTEM_TEST_TTS_SECONDS sets a WAV reply's length (default 1 s). BOB_SYSTEM_TEST_TTS_WAV (repo-relative
 * 16 kHz mono PCM16 WAV) voices it with that clip looped instead of the sine; a missing or invalid file falls back to the sine.
 */
const stubProvider: SpeechProviderFns = {
  transcribeAudio: () => Promise.resolve({
    text: process.env.BOB_SYSTEM_TEST_TRANSCRIPT ?? 'system test transcript',
    model: 'system-test-transcriber',
    generationId: 'system-test-transcription',
  }),
  // A WAV request gets the tone (the device pipeline re-encodes it); anything else a silent placeholder.
  synthesizeSpeech: (input) => Promise.resolve(input.format === 'wav'
    ? {
      audio: stubWav(parsePositiveSeconds(process.env.BOB_SYSTEM_TEST_TTS_SECONDS, 1), stubClip()).toString('base64'),
      format: 'wav',
      contentType: 'audio/wav',
      generationId: 'system-test-speech',
    }
    : {
      audio: Buffer.alloc(44_100).toString('base64'),
      format: input.format ?? 'mp3',
      contentType: input.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
      generationId: 'system-test-speech',
    }),
};

/** The stub adapter: the audio pipeline over the canned provider. */
export function createStubSpeech(): SpeechPort {
  return {
    transcribe: (pcm) => transcribePcm(pcm, stubProvider),
    synthesizePcm: (text, voice) => synthesizePcm(text, stubProvider, voice),
    synthesizeMp3: (text, voice) => synthesizeMp3(text, stubProvider, voice),
    transcribeEncoded: (input) => stubProvider.transcribeAudio(input),
    synthesizeEncoded: (input) => stubProvider.synthesizeSpeech(input),
  };
}

/** Picks the speech adapter for a config: the one place speech stubbing is decided. `real` is injectable for tests. */
export function selectSpeech(config: SpeechConfig, real: SpeechPort = createProviderSpeech()): SpeechPort {
  const stub = createStubSpeech();
  const stt = config.stubStt ? stub : real;
  const tts = config.stubTts ? stub : real;
  const openStream = config.streamStt && !config.stubStt ? real.openTranscriptStream?.bind(real) : undefined;
  return {
    transcribe: (pcm) => stt.transcribe(pcm),
    ...(openStream !== undefined ? { openTranscriptStream: openStream } : {}),
    synthesizePcm: (text, voice) => tts.synthesizePcm(text, voice),
    synthesizeMp3: (text, voice) => tts.synthesizeMp3(text, voice),
    transcribeEncoded: (input) => stt.transcribeEncoded(input),
    synthesizeEncoded: (input) => tts.synthesizeEncoded(input),
  };
}

/** The turn pipeline's three speech callables (TurnDeps.stt / ttsPcm / ttsMp3) over one adapter. */
export function speechTurnFns(speech: SpeechPort): {
  stt: (pcm: Buffer) => ReturnType<SpeechPort['transcribe']>;
  sttStream?: () => ReturnType<NonNullable<SpeechPort['openTranscriptStream']>>;
  ttsPcm: (text: string, voice?: string) => ReturnType<SpeechPort['synthesizePcm']>;
  ttsMp3: (text: string, voice?: string) => ReturnType<SpeechPort['synthesizeMp3']>;
} {
  return {
    stt: (pcm) => speech.transcribe(pcm),
    ...(speech.openTranscriptStream !== undefined ? { sttStream: speech.openTranscriptStream.bind(speech) } : {}),
    ttsPcm: (text, voice) => speech.synthesizePcm(text, voice),
    ttsMp3: (text, voice) => speech.synthesizeMp3(text, voice),
  };
}
