/**
 * The seam between the turn pipeline and speech: PCM16 16 kHz mono in, PCM16
 * 16 kHz mono (or 32 kbps MP3) out, already at the downlink rate so callers
 * never resample. Adapters never log audio, transcripts or the text they speak.
 */
import type { synthesizeSpeech, transcribeAudio, TranscriptStream } from '@bob/ai';

/** A transcription: the text plus what the provider reports about it. */
export interface SttResult {
  text: string;
  model?: string;
  seconds?: number;
}

/** Synthesized speech as PCM16 16 kHz mono; `sourceRateHz` is what the provider produced. */
export interface TtsResult {
  pcm: Buffer;
  sourceRateHz: number;
  /** As TtsMp3Result.timing, without the encode. */
  timing?: Omit<TtsTiming, 'encode_ms'>;
}

/** Where one synthesis spent its time. Milliseconds only; never content. */
export interface TtsTiming {
  /** Gateway response headers in, from the start of the HTTP call. */
  headers_ms?: number;
  /** Gateway response body complete, from the start of the HTTP call. */
  last_byte_ms?: number;
  /** The SDK's speech call resolved (its JSON parse and base64 are done), from the start of the HTTP call; last_byte_ms to here is the parse. */
  done_ms?: number;
  /** Base64 decode, WAV header and resample. */
  decode_ms: number;
  /** MP3 encode of the head (what first sound waits on); the whole clip when there is no tail. */
  encode_ms: number;
  /** MP3 encode of the tail. Filled in when `tail` resolves, so read it after. */
  encode_tail_ms?: number;
}

/** Synthesized speech as 16 kHz mono 32 kbps CBR MP3. */
export interface TtsMp3Result {
  /** The whole clip, or the HEAD of one encoder stream when `tail` is set. */
  mp3: Buffer;
  /**
   * Set by a progressive encode only: `mp3` is then at least ~1.0 s of
   * audio and this resolves to the remaining bytes, so `mp3 ++ await tail` is
   * the complete clip. Absent when the clip is short enough to come whole.
   */
  tail?: Promise<Buffer>;
  /** Set by a real synthesis only: a cache hit or a template asset carries none. */
  timing?: TtsTiming;
}

/** The complete clip: head and tail joined, or `mp3` when there is no tail. */
export async function wholeMp3(result: TtsMp3Result): Promise<Buffer> {
  return result.tail === undefined ? result.mp3 : Buffer.concat([result.mp3, await result.tail]);
}

export interface SpeechPort {
  /** Transcribes PCM16 16 kHz mono audio. */
  transcribe(pcm: Buffer): Promise<SttResult>;
  /** Opens a streaming transcription of PCM16 16 kHz mono; absent when streaming is off (BOB_STT_STREAMING). */
  openTranscriptStream?(): TranscriptStream;
  /** Speaks `text` as PCM16 16 kHz mono. */
  synthesizePcm(text: string, voice?: string): Promise<TtsResult>;
  /** Speaks `text` as 16 kHz mono MP3. `voice` omitted is the provider default (BOB_TTS_VOICE). */
  synthesizeMp3(text: string, voice?: string): Promise<TtsMp3Result>;
  /** Browser STT (/api/voice): base64 audio in any accepted container, provider output as is. */
  transcribeEncoded(input: Parameters<typeof transcribeAudio>[0]): ReturnType<typeof transcribeAudio>;
  /** Browser TTS (/api/speech): the provider's encoded audio (MP3), not resampled. */
  synthesizeEncoded(input: Parameters<typeof synthesizeSpeech>[0]): ReturnType<typeof synthesizeSpeech>;
}

/** The two provider calls the audio pipeline is built on: the Gateway pair or
 *  the canned stub pair. Same shapes, so the pipeline is identical for both. */
export interface SpeechProviderFns {
  transcribeAudio: typeof transcribeAudio;
  synthesizeSpeech: typeof synthesizeSpeech;
}
