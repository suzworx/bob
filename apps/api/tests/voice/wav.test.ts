/**
 * Vitest suite for the WAV helpers in wav.ts: PCM16 RIFF/WAVE header
 * encoding and parsing, linear PCM16 resampling, and positive-integer parsing.
 */
import { describe, expect, it } from 'vitest';
import { createPcm16Wav, readPcm16WavHeader, parsePositiveInteger, resamplePcm16Mono } from '../../src/voice/audio/wav.ts';

const HEADER_BYTES = 44;

/** Encodes a sample list as little-endian PCM16 bytes. */
function int16Samples(samples: number[]): Buffer {
  const output = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => output.writeInt16LE(sample, index * 2));
  return output;
}

describe('createPcm16Wav', () => {
  it('emits a 44-byte RIFF/WAVE header with a copied payload', () => {
    const pcm = int16Samples([0, 1, -1, 32767, -32768]);
    const wav = createPcm16Wav(pcm, { sampleRateHz: 16000, channels: 1 });

    expect(wav.length).toBe(HEADER_BYTES + pcm.length);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1); // audioFormat: linear PCM
    expect(wav.readUInt16LE(22)).toBe(1); // channels
    expect(wav.readUInt32LE(24)).toBe(16000); // sampleRate
    expect(wav.readUInt32LE(28)).toBe(16000 * 2); // byteRate
    expect(wav.readUInt16LE(32)).toBe(2); // blockAlign
    expect(wav.readUInt16LE(34)).toBe(16); // bitsPerSample
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(HEADER_BYTES)).toEqual(pcm);
  });

  it('scales byteRate and blockAlign for stereo', () => {
    const wav = createPcm16Wav(Buffer.alloc(4), { sampleRateHz: 44100, channels: 2 });
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(28)).toBe(44100 * 4);
    expect(wav.readUInt16LE(32)).toBe(4);
  });

  it('throws on empty or odd-length PCM', () => {
    expect(() => createPcm16Wav(Buffer.alloc(0), { sampleRateHz: 16000, channels: 1 }))
      .toThrow(/non-empty, even number of bytes/);
    expect(() => createPcm16Wav(Buffer.alloc(3), { sampleRateHz: 16000, channels: 1 }))
      .toThrow(/non-empty, even number of bytes/);
  });

  it('throws on non-positive or non-integer sample rates', () => {
    expect(() => createPcm16Wav(Buffer.alloc(2), { sampleRateHz: 0, channels: 1 })).toThrow(/positive integer/);
    expect(() => createPcm16Wav(Buffer.alloc(2), { sampleRateHz: -8000, channels: 1 })).toThrow(/positive integer/);
    expect(() => createPcm16Wav(Buffer.alloc(2), { sampleRateHz: 44100.5, channels: 1 })).toThrow(/positive integer/);
  });
});

describe('resamplePcm16Mono', () => {
  it('returns an equal copy for identical source and target rates', () => {
    const input = int16Samples([0, 100, 200, 300, -400]);
    const result = resamplePcm16Mono(input, 16000, 16000);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it('produces max(1, floor(inputSamples * target / source)) * 2 bytes', () => {
    // 100 samples at 16 kHz down to 8 kHz -> 50 samples.
    expect(resamplePcm16Mono(Buffer.alloc(200), 16000, 8000).length).toBe(100);
    // 2 samples from 44100 to 8000 Hz floors to the 1-sample minimum.
    expect(resamplePcm16Mono(Buffer.alloc(4), 44100, 8000).length).toBe(2);
  });

  it('halves roughly when downsampling 16 kHz to 8 kHz', () => {
    const result = resamplePcm16Mono(int16Samples(Array.from({ length: 160 }, () => 0)), 16000, 8000);
    expect(result.length).toBe(160);
  });

  it('linearly interpolates between samples when upsampling', () => {
    // Two samples [0, 1000] upsampled 2x -> [0, 500, 1000, 1000].
    const result = resamplePcm16Mono(int16Samples([0, 1000]), 1000, 2000);
    expect(Array.from(result)).toEqual([0x00, 0x00, 0xf4, 0x01, 0xe8, 0x03, 0xe8, 0x03]);
  });

  it('throws on empty, odd-length, or non-positive rates', () => {
    expect(() => resamplePcm16Mono(Buffer.alloc(0), 16000, 8000)).toThrow(/non-empty, even number of bytes/);
    expect(() => resamplePcm16Mono(Buffer.alloc(3), 16000, 8000)).toThrow(/non-empty, even number of bytes/);
    expect(() => resamplePcm16Mono(Buffer.alloc(2), 0, 8000)).toThrow(/positive/);
    expect(() => resamplePcm16Mono(Buffer.alloc(2), 16000, -8000)).toThrow(/positive/);
  });
});

describe('readPcm16WavHeader', () => {
  it('parses a valid 24 kHz mono PCM16 header to rate, channels and data offset', () => {
    const wav = createPcm16Wav(Buffer.alloc(320), { sampleRateHz: 24000, channels: 1 });
    const header = readPcm16WavHeader(wav);
    expect(header.sampleRateHz).toBe(24000);
    expect(header.channels).toBe(1);
    expect(header.bitsPerSample).toBe(16);
    expect(header.dataOffset).toBe(44);
  });

  it('finds the data chunk after a larger fmt chunk', () => {
    const pcm = Buffer.alloc(64);
    const base = createPcm16Wav(pcm, { sampleRateHz: 16000, channels: 1 });
    // Standard header with a 40-byte fmt body instead of the usual 16.
    const extended = Buffer.alloc(12 + 8 + 40 + 8 + pcm.length);
    base.subarray(0, 12).copy(extended, 0);
    extended.writeUInt32LE(extended.length - 8, 4); // RIFF size
    extended.write('fmt ', 12, 'ascii');
    extended.writeUInt32LE(40, 16); // fmt chunk size
    base.subarray(20, 36).copy(extended, 20); // audioFormat, channels, sampleRate, byteRate, blockAlign, bitsPerSample
    const dataOffset = 12 + 8 + 40 + 8;
    extended.write('data', dataOffset - 8, 'ascii');
    extended.writeUInt32LE(pcm.length, dataOffset - 4);
    pcm.copy(extended, dataOffset);
    const header = readPcm16WavHeader(extended);
    expect(header.sampleRateHz).toBe(16000);
    expect(header.dataOffset).toBe(dataOffset);
  });

  it('fails loudly on a truncated header', () => {
    const wav = createPcm16Wav(Buffer.alloc(320), { sampleRateHz: 16000, channels: 1 });
    expect(() => readPcm16WavHeader(wav.subarray(0, 30))).toThrow(/truncated|too short/i);
    expect(() => readPcm16WavHeader(Buffer.alloc(10))).toThrow(/truncated|too short/i);
  });

  it('fails loudly on a non-RIFF buffer', () => {
    const junk = Buffer.concat([Buffer.from('NOTRIFFWAVE'), Buffer.alloc(40)]);
    expect(() => readPcm16WavHeader(junk)).toThrow(/RIFF|WAVE/i);
  });

  it('fails loudly on anything that is not PCM16', () => {
    const wav = createPcm16Wav(Buffer.alloc(320), { sampleRateHz: 16000, channels: 1 });
    const float = Buffer.from(wav);
    float.writeUInt16LE(3, 20); // audioFormat 3 = IEEE float
    expect(() => readPcm16WavHeader(float)).toThrow(/PCM/);
    const eightBit = Buffer.from(wav);
    eightBit.writeUInt16LE(8, 34); // bits per sample 8
    expect(() => readPcm16WavHeader(eightBit)).toThrow(/16/);
  });

  it('fails loudly when the data chunk is missing', () => {
    const wav = createPcm16Wav(Buffer.alloc(320), { sampleRateHz: 16000, channels: 1 });
    const withoutData = wav.subarray(0, 36);
    expect(() => readPcm16WavHeader(Buffer.concat([withoutData, Buffer.alloc(8, 0)]))).toThrow(/data/i);
  });
});

describe('parsePositiveInteger', () => {
  it('falls back when the value is unset', () => {
    expect(parsePositiveInteger(undefined, 44100)).toBe(44100);
  });

  it('parses a numeric string', () => {
    expect(parsePositiveInteger('8000', 1)).toBe(8000);
  });

  it('rejects zero, negative, fractional, and non-numeric strings', () => {
    expect(() => parsePositiveInteger('0', 1)).toThrow(/positive integer/);
    expect(() => parsePositiveInteger('-1', 1)).toThrow(/positive integer/);
    expect(() => parsePositiveInteger('1.5', 1)).toThrow(/positive integer/);
    expect(() => parsePositiveInteger('abc', 1)).toThrow(/positive integer/);
  });
});