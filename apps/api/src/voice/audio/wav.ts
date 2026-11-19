/**
 * WAV file helpers: PCM16 RIFF/WAVE header encoding and linear resampling
 * of mono PCM16 between sample rates.
 */
export interface WavOptions {
  sampleRateHz: number;
  channels: 1 | 2;
}

const PCM_BITS_PER_SAMPLE = 16;
const WAV_HEADER_BYTES = 44;

/** Parsed PCM16 WAV header: the values the downlink path actually needs. */
export interface Pcm16WavHeader {
  sampleRateHz: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
}

/**
 * Reads the sample rate, channel count and bits per sample from a PCM16
 * RIFF/WAVE header, returning the offset of the data chunk's payload.
 * Fails loudly on anything that is not PCM16 -- a plausible-looking wrong
 * rate is heard as chipmunk or slow-motion speech, which is worse than a
 * failed turn.
 */
export function readPcm16WavHeader(buffer: Uint8Array): Pcm16WavHeader {
  if (buffer.byteLength < 12) {
    throw new Error('Truncated WAV buffer: shorter than the RIFF/WAVE magic.');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error('Not a RIFF/WAVE file: missing RIFF/WAVE magic.');
  }
  if (buffer.byteLength < 36) {
    throw new Error('Truncated WAV header: missing the fmt chunk.');
  }
  const audioFormat = view.getUint16(20, true);
  if (audioFormat !== 1) {
    throw new Error(`Not a PCM WAV: audio format ${audioFormat} is not linear PCM.`);
  }
  const bitsPerSample = view.getUint16(34, true);
  if (bitsPerSample !== PCM_BITS_PER_SAMPLE) {
    throw new Error(`Not a PCM16 WAV: ${bitsPerSample} bits per sample.`);
  }
  const sampleRateHz = view.getUint32(24, true);
  if (sampleRateHz === 0) {
    throw new Error('Invalid WAV header: sample rate is zero.');
  }
  const channels = view.getUint16(22, true);
  // Walk the chunks after the fmt chunk to find the data chunk; a 16-byte fmt
  // body is common but not guaranteed, so the offset must be scanned for.
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 0x64617461) {
      return { sampleRateHz, channels, bitsPerSample, dataOffset: offset + 8 };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error('WAV data chunk not found.');
}

/** Wraps PCM16 samples in a 44-byte RIFF/WAVE header. */
export function createPcm16Wav(pcm: Uint8Array, options: WavOptions): Buffer {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error('PCM audio must contain a non-empty, even number of bytes.');
  }
  if (!Number.isInteger(options.sampleRateHz) || options.sampleRateHz <= 0) {
    throw new Error('Sample rate must be a positive integer.');
  }

  const blockAlign = options.channels * (PCM_BITS_PER_SAMPLE / 8);
  const byteRate = options.sampleRateHz * blockAlign;
  const output = Buffer.allocUnsafe(WAV_HEADER_BYTES + pcm.byteLength);

  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + pcm.byteLength, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(options.channels, 22);
  output.writeUInt32LE(options.sampleRateHz, 24);
  output.writeUInt32LE(byteRate, 28);
  output.writeUInt16LE(blockAlign, 32);
  output.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(pcm.byteLength, 40);
  output.set(pcm, WAV_HEADER_BYTES);

  return output;
}

/** Linearly resamples mono PCM16 from one sample rate to another. */
export function resamplePcm16Mono(
  pcm: Uint8Array,
  sourceRateHz: number,
  targetRateHz: number,
): Buffer {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error('PCM audio must contain a non-empty, even number of bytes.');
  }
  if (sourceRateHz <= 0 || targetRateHz <= 0) {
    throw new Error('Sample rates must be positive.');
  }
  if (sourceRateHz === targetRateHz) {
    return Buffer.from(pcm);
  }

  const input = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const inputSamples = input.byteLength / 2;
  const outputSamples = Math.max(1, Math.floor(inputSamples * targetRateHz / sourceRateHz));
  const output = Buffer.allocUnsafe(outputSamples * 2);

  for (let index = 0; index < outputSamples; index += 1) {
    const sourcePosition = index * sourceRateHz / targetRateHz;
    const lowerIndex = Math.min(Math.floor(sourcePosition), inputSamples - 1);
    const upperIndex = Math.min(lowerIndex + 1, inputSamples - 1);
    const fraction = sourcePosition - lowerIndex;
    const lower = input.readInt16LE(lowerIndex * 2);
    const upper = input.readInt16LE(upperIndex * 2);
    output.writeInt16LE(Math.round(lower + (upper - lower) * fraction), index * 2);
  }

  return output;
}

/** Parses a positive integer setting, falling back when the value is unset. */
export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received "${value}".`);
  }
  return parsed;
}