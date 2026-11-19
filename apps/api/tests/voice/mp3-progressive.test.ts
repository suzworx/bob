/**
 * #1391: the MP3 encode hands back its head (>= 1 s of audio) at once and the
 * rest of one encoder stream as `tail`, so the first audio_down frames do not
 * wait for the whole clip to be encoded.
 */
import { describe, expect, it } from 'vitest';
import { encodePcmMp3, synthesizeMp3 } from '../../src/voice/audio/stt-tts.ts';
import { wholeMp3 } from '../../src/voice/speech-port.ts';
import type { SpeechProviderFns } from '../../src/voice/speech-port.ts';
import { audioStartOffset, parseMp3Frame } from '../../src/voice/audio/mp3.ts';
import { createPcm16Wav } from '../../src/voice/audio/wav.ts';

const RATE = 16_000;

function sinePcm(seconds: number): Buffer {
  const samples = new Int16Array(Math.round(seconds * RATE));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / RATE) * 10_000);
  }
  return Buffer.from(samples.buffer);
}

function providerFor(pcm: Buffer): SpeechProviderFns {
  const wav = createPcm16Wav(pcm, { sampleRateHz: RATE, channels: 1 });
  return {
    transcribeAudio: () => { throw new Error('unexpected stt'); },
    synthesizeSpeech: () => Promise.resolve({ audio: wav.toString('base64'), format: 'wav', contentType: 'audio/wav' }),
  } as unknown as SpeechProviderFns;
}

function durationSeconds(buffer: Buffer): number {
  let offset = audioStartOffset(buffer);
  let duration = 0;
  while (offset + 4 <= buffer.length) {
    const frame = parseMp3Frame(buffer, offset);
    if (frame === null || offset + frame.frameLengthBytes > buffer.length) break;
    duration += frame.samplesPerFrame / frame.sampleRateHz;
    offset += frame.frameLengthBytes;
  }
  return duration;
}

describe('synthesizeMp3 progressive encode (#1391)', () => {
  it('head ++ tail is the same stream as the whole-clip encode', async () => {
    const pcm = sinePcm(4);
    const result = await synthesizeMp3('hello', providerFor(pcm));
    expect(result.tail).toBeInstanceOf(Promise);
    const whole = Buffer.concat([result.mp3, await result.tail!]);
    const reference = encodePcmMp3(pcm);
    expect(durationSeconds(whole)).toBeCloseTo(durationSeconds(reference), 3);
    expect(whole.equals(reference)).toBe(true);
    expect((await wholeMp3(result)).equals(reference)).toBe(true);
  });

  it('the head covers at least one second of audio', async () => {
    const result = await synthesizeMp3('hello', providerFor(sinePcm(4)));
    expect(durationSeconds(result.mp3)).toBeGreaterThanOrEqual(1.0);
    expect(result.mp3.length).toBeLessThan(encodePcmMp3(sinePcm(4)).length);
  });

  it('times the head as encode_ms and the tail as encode_tail_ms once it resolves', async () => {
    const result = await synthesizeMp3('hello', providerFor(sinePcm(4)));
    expect(result.timing?.encode_ms).toBeGreaterThanOrEqual(0);
    await result.tail;
    expect(result.timing?.encode_tail_ms).toBeGreaterThanOrEqual(0);
  });

  it('a 0.5 s clip returns no tail', async () => {
    const pcm = sinePcm(0.5);
    const result = await synthesizeMp3('hi', providerFor(pcm));
    expect(result.tail).toBeUndefined();
    expect(result.mp3.equals(encodePcmMp3(pcm))).toBe(true);
    expect(result.timing).not.toHaveProperty('encode_tail_ms');
    expect((await wholeMp3(result)).equals(result.mp3)).toBe(true);
  });

  it('the event loop runs between tail slices', async () => {
    const result = await synthesizeMp3('hello', providerFor(sinePcm(6)));
    let ran = false;
    setImmediate(() => { ran = true; });
    let ranBeforeTail = false;
    await result.tail!.then(() => { ranBeforeTail = ran; });
    expect(ranBeforeTail).toBe(true);
  });
});
