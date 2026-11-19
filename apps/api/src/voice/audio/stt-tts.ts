// Uplink assembly, STT/TTS through @bob/ai, and downlink OLX2 framing.
import { Mp3Encoder } from '@breezystack/lamejs';
import { debugLog, synthesizeSpeech, transcribeAudio, BOB_STT_LANGUAGE } from '@bob/ai';
import type { SpeechProviderFns, SttResult, TtsMp3Result, TtsResult } from '../speech-port.ts';
import { MIN_STT_AUDIO_MS } from '../turn-core.ts';
import { createPcm16Wav, readPcm16WavHeader, resamplePcm16Mono } from './wav.ts';
import {
  DOWNLINK_FRAME_BYTES,
  DOWNLINK_MP3_CHUNK_BYTES,
  MAX_DOWNLINK_MP3_BYTES,
  MP3_16K_MONO_FORMAT,
  PCM16_16K_MONO_FORMAT,
  PCM16_16K_MONO_RATE_HZ,
  serializeAudioFrame,
  type AudioFrameDto,
} from '../protocol.ts';

/** CBR bitrate for the MP3 downlink; 32 kbps / 8 = 4000 B/s. */
const MP3_KBPS = 32;

/** Samples encoded before the first frames go out: 16 MPEG-2 granules (1152 samples each), ~1.15 s, so the head holds >= 1 s of audio past the encoder delay. */
const MP3_HEAD_SAMPLES = 16 * 1152;

/** Samples per tail slice (7 granules, ~0.5 s); the event loop runs between slices. */
const MP3_TAIL_SLICE_SAMPLES = 7 * 1152;

export function assemblePcm16(chunks: Buffer[]): Buffer {
  return Buffer.concat(chunks);
}

export function isEmptyTurn(chunks: Buffer[]): boolean {
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0) === 0;
}

/** MIN_STT_AUDIO_MS of PCM16 16 kHz mono: 9,600 bytes for 300 ms. */
export const MIN_STT_PCM_BYTES = (MIN_STT_AUDIO_MS * PCM16_16K_MONO_RATE_HZ * 2) / 1000;

/** True when the turn has audio but too little to be worth transcribing. */
export function isTooShortTurn(chunks: Buffer[]): boolean {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  return total > 0 && total < MIN_STT_PCM_BYTES;
}

export async function transcribePcm(pcm: Buffer, provider: SpeechProviderFns = { transcribeAudio, synthesizeSpeech }): Promise<SttResult> {
  const wav = createPcm16Wav(pcm, { sampleRateHz: PCM16_16K_MONO_RATE_HZ, channels: 1 });
  debugLog('audio.stt_input', {
    pcm_bytes: pcm.length,
    wav_bytes: wav.length,
    sample_rate_hz: PCM16_16K_MONO_RATE_HZ,
    channels: 1,
    duration_ms: Math.round((pcm.length / 2 / PCM16_16K_MONO_RATE_HZ) * 1000),
    language: BOB_STT_LANGUAGE,
    language_pinned: BOB_STT_LANGUAGE !== 'auto',
  });
  const transcript = await provider.transcribeAudio({
    audio: wav.toString('base64'),
    format: 'wav',
    // 'auto' means send no language at all and let the provider detect it.
    ...(BOB_STT_LANGUAGE === 'auto' ? {} : { language: BOB_STT_LANGUAGE }),
  });
  return {
    text: transcript.text,
    model: transcript.model,
    seconds: transcript.usage?.seconds,
  };
}

export async function synthesizePcm(
  text: string,
  provider: SpeechProviderFns = { transcribeAudio, synthesizeSpeech },
  voice?: string,
): Promise<TtsResult> {
  const speech = await provider.synthesizeSpeech({ text, format: 'wav', ...(voice === undefined ? {} : { voice }) });
  const decodeStartedAt = performance.now();
  const wavBytes = Buffer.from(speech.audio, 'base64');
  const header = readPcm16WavHeader(wavBytes);
  // Strip the RIFF header: the downlink frames are raw PCM16, and the header's
  // sample rate is the model's real rate rather than a configured guess.
  const pcmBytes = wavBytes.subarray(header.dataOffset);
  const sourceRateHz = header.sampleRateHz;
  const resampled = resamplePcm16Mono(pcmBytes, sourceRateHz, PCM16_16K_MONO_RATE_HZ);
  const decodeMs = performance.now() - decodeStartedAt;
  debugLog('audio.tts_pcm', {
    provider_bytes: wavBytes.length,
    resampled_bytes: resampled.length,
    // Read from the RIFF header: a wrong source_rate_hz here is heard as
    // chipmunk or slow-motion speech, and only the audio itself knows it.
    source_rate_hz: sourceRateHz,
    target_rate_hz: PCM16_16K_MONO_RATE_HZ,
    duration_ms: Math.round((resampled.length / 2 / PCM16_16K_MONO_RATE_HZ) * 1000),
  });
  const { timing } = speech;
  return {
    pcm: resampled,
    sourceRateHz,
    timing: {
      ...(timing === undefined ? {} : { headers_ms: timing.headers_ms, last_byte_ms: timing.last_byte_ms, done_ms: timing.done_ms }),
      decode_ms: decodeMs,
    },
  };
}

/**
 * MP3 for the downlink: the device decodes 16 kHz mono, so the reply is 16 kHz
 * mono 32 kbps CBR whatever the provider returns (its own 128 kbps 24 kHz MP3
 * overflowed the device ring and chopped the reply's tail). The PCM path
 * resamples once; a pure-JS encoder keeps the deploy free of native binaries.
 */
export async function synthesizeMp3(
  text: string,
  provider: SpeechProviderFns = { transcribeAudio, synthesizeSpeech },
  voice?: string,
): Promise<TtsMp3Result> {
  const { pcm, timing } = await synthesizePcm(text, provider, voice);
  const samples = pcmSamples(pcm);
  if (samples.length <= MP3_HEAD_SAMPLES) {
    const { mp3, encodeMs } = encodePcmMp3Timed(pcm);
    return { mp3, timing: { decode_ms: 0, ...timing, encode_ms: encodeMs } };
  }
  // One encoder for the whole clip: the head goes out now, the tail follows in
  // slices that yield to the event loop, and head ++ tail is the one-shot stream.
  const encoder = new Mp3Encoder(1, PCM16_16K_MONO_RATE_HZ, MP3_KBPS);
  const headStartNs = process.hrtime.bigint();
  const mp3 = Buffer.from(encoder.encodeBuffer(samples.subarray(0, MP3_HEAD_SAMPLES)));
  const encodeMs = elapsedMs(headStartNs);
  const result: TtsMp3Result = { mp3, timing: { decode_ms: 0, ...timing, encode_ms: encodeMs } };
  result.tail = encodeTail(encoder, samples, result);
  // Consumers await the tail; this keeps an abandoned one from an unhandled rejection.
  result.tail.catch(() => undefined);
  return result;
}

/** Encodes the samples after the head in ~0.5 s slices, then flushes; fills in the tail timing and the debug log. */
async function encodeTail(encoder: Mp3Encoder, samples: Int16Array, head: TtsMp3Result): Promise<Buffer> {
  const parts: Buffer[] = [];
  let tailMs = 0;
  for (let at = MP3_HEAD_SAMPLES; at < samples.length; at += MP3_TAIL_SLICE_SAMPLES) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const startNs = process.hrtime.bigint();
    parts.push(Buffer.from(encoder.encodeBuffer(samples.subarray(at, at + MP3_TAIL_SLICE_SAMPLES))));
    tailMs += elapsedMs(startNs);
  }
  const flushStartNs = process.hrtime.bigint();
  parts.push(Buffer.from(encoder.flush()));
  tailMs += elapsedMs(flushStartNs);
  const tail = Buffer.concat(parts);
  if (head.timing !== undefined) head.timing.encode_tail_ms = tailMs;
  logMp3(head.mp3.length + tail.length, (head.timing?.encode_ms ?? 0) + tailMs, samples.length);
  return tail;
}

const elapsedMs = (startNs: bigint): number => Number(process.hrtime.bigint() - startNs) / 1_000_000;

/** resamplePcm16Mono writes little-endian samples, so read them back in LE order rather than aliasing the buffer (platform-endian). */
function pcmSamples(pcm: Buffer): Int16Array {
  const samples = new Int16Array(pcm.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = pcm.readInt16LE(index * 2);
  }
  return samples;
}

/** Encode a complete PCM reply in one stream so concatenated clips remain decodable. */
export function encodePcmMp3(pcm: Buffer): Buffer {
  return encodePcmMp3Timed(pcm).mp3;
}

/** As encodePcmMp3, with the encode time in ms. */
function encodePcmMp3Timed(pcm: Buffer): { mp3: Buffer; encodeMs: number } {
  const startNs = process.hrtime.bigint();
  const encoder = new Mp3Encoder(1, PCM16_16K_MONO_RATE_HZ, MP3_KBPS);
  const encoded = encoder.encodeBuffer(pcmSamples(pcm));
  const flushed = encoder.flush();
  const mp3 = Buffer.concat([Buffer.from(encoded), Buffer.from(flushed)]);
  const encodeMs = elapsedMs(startNs);
  logMp3(mp3.length, encodeMs, pcm.length / 2);
  return { mp3, encodeMs };
}

function logMp3(mp3Bytes: number, encodeMs: number, sampleCount: number): void {
  debugLog('audio.tts_mp3', {
    mp3_bytes: mp3Bytes,
    bitrate_kbps: MP3_KBPS,
    sample_rate_hz: PCM16_16K_MONO_RATE_HZ,
    channels: 1,
    encode_ms: Math.round(encodeMs * 10) / 10,
    duration_ms: Math.round((sampleCount / PCM16_16K_MONO_RATE_HZ) * 1000),
    max_downlink_bytes: MAX_DOWNLINK_MP3_BYTES,
    will_be_capped: mp3Bytes > MAX_DOWNLINK_MP3_BYTES,
    frames_at_chunk_size: Math.ceil(mp3Bytes / DOWNLINK_MP3_CHUNK_BYTES),
  });
}

export function downlinkFrames(pcm: Buffer, turnHandle = 1): Buffer[] {
  const frames: Buffer[] = [];
  let sequence = 0;
  for (let offset = 0; offset < pcm.length; offset += DOWNLINK_FRAME_BYTES) {
    const chunk = pcm.subarray(offset, Math.min(offset + DOWNLINK_FRAME_BYTES, pcm.length));
    const frame: AudioFrameDto = {
      header: { magic: 'OLX2', version: 1, kind: 'audio_down', formatId: PCM16_16K_MONO_FORMAT, channels: 1, turnHandle, sequence, payloadBytes: chunk.length },
      payload: Buffer.from(chunk),
    };
    frames.push(serializeAudioFrame(frame));
    sequence += 1;
  }
  return frames;
}

/** A streamed reply cut into speakable pieces as its text arrives. */
interface ReplySplitter {
  /** Adds a text delta; returns every piece it completed, in order. */
  push(delta: string): string[];
  /** Ends the reply; returns what is left (empty when nothing is). */
  flush(): string[];
}

/** Words whose trailing period does not end a sentence. */
const SENTENCE_ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'approx', 'no']);

/** Closers that may sit between a sentence's punctuation and the space after it. */
const SENTENCE_CLOSERS = '"\')]”’';

/** A piece this long with no sentence end is cut at a clause or word, so one
 *  long opening sentence cannot hold back the first audio. */
export const MAX_REPLY_PIECE_CHARS = 240;

/** End of the sentence that starts at `from`, past its trailing whitespace, or
 *  -1 when the buffer holds no complete sentence yet. The whitespace after the
 *  punctuation must already have arrived: "3." may still become "3.5". */
function sentenceEnd(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]!;
    let end = -1;
    if (char === '\n') end = index + 1;
    else if (char === '.' || char === '!' || char === '?') {
      let next = index + 1;
      while (next < text.length && SENTENCE_CLOSERS.includes(text[next]!)) next += 1;
      if (next < text.length && /\s/.test(text[next]!)) {
        const word = (text.slice(from, index).split(/\s/).pop() ?? '').toLowerCase();
        if (char !== '.' || !SENTENCE_ABBREVIATIONS.has(word)) end = next;
      }
    }
    if (end === -1) continue;
    while (end < text.length && /\s/.test(text[end]!)) end += 1;
    // Trailing whitespace may continue in the next delta; the piece is still
    // complete, and any further whitespace joins the next piece.
    return end;
  }
  return -1;
}

/** Where to cut an over-long piece: after its last clause mark, else its last
 *  space, inside MAX_REPLY_PIECE_CHARS; -1 when neither exists. */
function clauseCut(text: string): number {
  const head = text.slice(0, MAX_REPLY_PIECE_CHARS);
  const clause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '));
  if (clause > MAX_REPLY_PIECE_CHARS / 3) return clause + 2;
  const space = head.lastIndexOf(' ');
  return space > 0 ? space + 1 : -1;
}

/** Clause breaks that may end a splitter's very first piece early. */
const FIRST_PIECE_CLAUSE_BREAKS = [', ', '; ', ': ', ' - '];

/** The first piece must reach this many chars before an early clause break
 *  counts, so a short opening clause is not cut needlessly small. */
const FIRST_PIECE_CLAUSE_MIN_CHARS = 40;

/** End of the earliest clause break at or after FIRST_PIECE_CLAUSE_MIN_CHARS,
 *  or -1 when the buffer has none yet. Only used for a splitter's first piece,
 *  so device time-to-first-audio does not wait for a full sentence. */
function firstPieceClauseCut(text: string): number {
  let bestStart = -1;
  let bestEnd = -1;
  for (const mark of FIRST_PIECE_CLAUSE_BREAKS) {
    const at = text.indexOf(mark, FIRST_PIECE_CLAUSE_MIN_CHARS);
    if (at !== -1 && (bestStart === -1 || at < bestStart)) {
      bestStart = at;
      bestEnd = at + mark.length;
    }
  }
  return bestEnd;
}

/**
 * Splits a streamed reply into sentences for per-sentence TTS. Pieces are raw
 * slices, trailing whitespace included, so joined back together they are
 * exactly the reply text and the server can say how much of it was spoken.
 */
export function createReplySplitter(): ReplySplitter {
  let buffer = '';
  let firstPieceDone = false;
  return {
    push(delta: string): string[] {
      buffer += delta;
      const pieces: string[] = [];
      for (;;) {
        let end = sentenceEnd(buffer, 0);
        if (end === -1 && !firstPieceDone) end = firstPieceClauseCut(buffer);
        if (end === -1 && buffer.length > MAX_REPLY_PIECE_CHARS) end = clauseCut(buffer);
        if (end <= 0) break;
        pieces.push(buffer.slice(0, end));
        buffer = buffer.slice(end);
        firstPieceDone = true;
      }
      return pieces;
    },
    flush(): string[] {
      const rest = buffer;
      buffer = '';
      return rest === '' ? [] : [rest];
    },
  };
}

/** Splits downlink MP3 into serialized OLX2 audio frames. `firstSequence`
 *  continues the numbering when a streamed reply appends another sentence to
 *  the same audio_down stream. */
export function downlinkMp3Frames(mp3: Buffer, turnHandle = 1, firstSequence = 0): Buffer[] {
  const capped = mp3.length > MAX_DOWNLINK_MP3_BYTES ? mp3.subarray(0, MAX_DOWNLINK_MP3_BYTES) : mp3;
  if (capped.length !== mp3.length) {
    debugLog('audio.mp3_capped', {
      original_bytes: mp3.length,
      capped_bytes: capped.length,
      dropped_bytes: mp3.length - capped.length,
    });
  }
  const frames: Buffer[] = [];
  let sequence = firstSequence;
  for (let offset = 0; offset < capped.length; offset += DOWNLINK_MP3_CHUNK_BYTES) {
    const chunk = capped.subarray(offset, Math.min(offset + DOWNLINK_MP3_CHUNK_BYTES, capped.length));
    const frame: AudioFrameDto = {
      header: { magic: 'OLX2', version: 1, kind: 'audio_down', formatId: MP3_16K_MONO_FORMAT, channels: 1, turnHandle, sequence, payloadBytes: chunk.length },
      payload: Buffer.from(chunk),
    };
    frames.push(serializeAudioFrame(frame));
    sequence += 1;
  }
  return frames;
}
