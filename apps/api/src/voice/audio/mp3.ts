/**
 * MP3 frame-header reader for downlink pacing: streaming faster than the
 * device's decoder consumes overflows its 48 KB ring and silently drops the end
 * of the reply. The tables mirror scripts/inspect-mp3.mjs.
 */

/** Bitrate tables in kbps, keyed [1=MPEG1 | 2=MPEG2/2.5][layer 1..3][index]. */
const BITRATE: Record<1 | 2, Record<1 | 2 | 3, readonly number[]>> = {
  1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};

const SAMPLE_RATE: Record<number, readonly number[]> = {
  3: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  0: [11_025, 12_000, 8_000],
};

/** The layer bit-field counts DOWN: 0b11 = Layer I, 0b10 = II, 0b01 = III. */
const LAYER_BY_BITS: Record<number, 1 | 2 | 3 | undefined> = { 3: 1, 2: 2, 1: 3 };

interface Mp3FrameInfo {
  bitrateKbps: number;
  sampleRateHz: number;
  samplesPerFrame: number;
  frameLengthBytes: number;
}

/** Byte offset of the first frame, skipping an ID3v2 tag if one is present. */
export function audioStartOffset(buffer: Buffer): number {
  if (buffer.length >= 10 && buffer.toString('latin1', 0, 3) === 'ID3') {
    // ID3v2 size is 4 syncsafe bytes; mask each high bit or the offset lands
    // past the first frame and the sync search false-matches inside the tag.
    const size =
      ((buffer[6]! & 0x7f) << 21) |
      ((buffer[7]! & 0x7f) << 14) |
      ((buffer[8]! & 0x7f) << 7) |
      (buffer[9]! & 0x7f);
    const footer = buffer[5]! & 0x10 ? 10 : 0;
    return 10 + size + footer;
  }
  return 0;
}

export function parseMp3Frame(buffer: Buffer, offset: number): Mp3FrameInfo | null {
  if (offset + 4 > buffer.length) return null;
  const header = buffer.readUInt32BE(offset);
  if (header >>> 21 !== 0x7ff) return null; // no sync word
  const versionBits = (header >>> 19) & 3;
  const layerBits = (header >>> 17) & 3;
  if (versionBits === 1 || layerBits === 0) return null; // reserved
  const bitrateIndex = (header >>> 12) & 15;
  const sampleRateIndex = (header >>> 10) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const layer = LAYER_BY_BITS[layerBits];
  if (!layer) return null;
  const isMpeg1 = versionBits === 3;
  const padding = (header >>> 9) & 1;
  const bitrate = (BITRATE[isMpeg1 ? 1 : 2][layer][bitrateIndex] ?? 0) * 1000;
  const sampleRateHz = SAMPLE_RATE[versionBits]?.[sampleRateIndex] ?? 0;
  if (!bitrate || !sampleRateHz) return null;

  // Layer I is 384 samples/frame; Layer III on MPEG2/2.5 halves to 576.
  const samplesPerFrame = layer === 1 ? 384 : layer === 3 && !isMpeg1 ? 576 : 1152;
  const frameLengthBytes =
    layer === 1
      ? (Math.floor((12 * bitrate) / sampleRateHz) + padding) * 4
      : Math.floor(((samplesPerFrame / 8) * bitrate) / sampleRateHz) + padding;
  if (frameLengthBytes < 4) return null;

  return { bitrateKbps: bitrate / 1000, sampleRateHz, samplesPerFrame, frameLengthBytes };
}

/**
 * Bytes per second the decoder will consume from this stream, or null when no
 * frame header can be found. Null is not a failure: callers fall back to the
 * previous fixed pacing rather than failing a turn over an optimisation.
 *
 * Read from the first audio frame, which is exact for the CBR output the TTS
 * provider returns. A VBR stream would drift from this estimate, which the
 * pacer's buffer headroom absorbs.
 */
export function mp3DrainBytesPerSecond(buffer: Buffer): number | null {
  const start = audioStartOffset(buffer);
  // Scan a bounded window for the first valid header rather than trusting the
  // stream to begin with one.
  const limit = Math.min(buffer.length - 4, start + 8192);
  let firstOffset = -1;
  let firstFrame: Mp3FrameInfo | null = null;
  for (let offset = Math.max(0, start); offset <= limit; offset += 1) {
    const frame = parseMp3Frame(buffer, offset);
    if (frame) {
      firstOffset = offset;
      firstFrame = frame;
      break;
    }
  }
  if (firstFrame === null) return null;

  // TTS responses are not guaranteed to be CBR. Using only the first header
  // can under-estimate a VBR stream and make the device's decoder starve,
  // which sounds like gaps and broken words. Average the declared bitrate
  // over the contiguous frame headers we can inspect instead.
  let offset = firstOffset;
  let durationSeconds = 0;
  let encodedBits = 0;
  let frames = 0;
  while (offset + 4 <= buffer.length && frames < 64) {
    const frame = parseMp3Frame(buffer, offset);
    if (frame === null || offset + frame.frameLengthBytes > buffer.length) break;
    const frameSeconds = frame.samplesPerFrame / frame.sampleRateHz;
    durationSeconds += frameSeconds;
    encodedBits += frame.bitrateKbps * 1000 * frameSeconds;
    offset += frame.frameLengthBytes;
    frames += 1;
  }

  if (durationSeconds <= 0) return null;
  return Math.round(encodedBits / durationSeconds / 8);
}
