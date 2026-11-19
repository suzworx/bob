/**
 * Vitest suite for the MP3 header probe and the downlink pacer.
 *
 * Frame headers are synthesised rather than loaded from a fixture: *.mp3 is
 * git-ignored, so a committed binary fixture is not available, and the
 * existing pipeline mocks use zero-filled buffers that parse as nothing.
 */
import { describe, expect, it } from 'vitest';
import { audioStartOffset, mp3DrainBytesPerSecond, parseMp3Frame } from '../../src/voice/audio/mp3.ts';
import { MP3_TARGET_BUFFER_BYTES, pacingDelayMs } from '../../src/voice/turn/pacing.ts';

/**
 * Builds an MPEG1 Layer III frame header.
 * Bits: 11 sync | 2 version | 2 layer | 1 crc | 4 bitrate | 2 rate | 1 pad ...
 * versionBits 3 = MPEG1, layerBits 1 = Layer III (the field counts down).
 */
function mpeg1Layer3Header(bitrateIndex: number, sampleRateIndex = 0): Buffer {
  const header =
    (0x7ff << 21) |
    (3 << 19) |
    (1 << 17) |
    (1 << 16) |
    (bitrateIndex << 12) |
    (sampleRateIndex << 10) |
    (3 << 6); // mono
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(header >>> 0, 0);
  return buffer;
}

/** A frame header padded out to a plausible frame body. */
function frame(bitrateIndex: number, bodyBytes = 400): Buffer {
  return Buffer.concat([mpeg1Layer3Header(bitrateIndex), Buffer.alloc(bodyBytes)]);
}

function exactFrame(bitrateIndex: number): Buffer {
  const header = mpeg1Layer3Header(bitrateIndex);
  const parsed = parseMp3Frame(header, 0);
  if (!parsed) throw new Error('test header did not parse');
  return Buffer.concat([header, Buffer.alloc(parsed.frameLengthBytes - header.length)]);
}

describe('parseMp3Frame', () => {
  it('reads bitrate, sample rate and frame length for MPEG1 Layer III', () => {
    // Bitrate index 5 on the MPEG1 Layer III table is 64 kbps.
    const parsed = parseMp3Frame(frame(5), 0);
    expect(parsed).not.toBeNull();
    expect(parsed!.bitrateKbps).toBe(64);
    expect(parsed!.sampleRateHz).toBe(44_100);
    expect(parsed!.samplesPerFrame).toBe(1152);
  });

  it('maps the layer bit-field counting down, not up', () => {
    // layerBits 1 must resolve to Layer III and price off the Layer III table
    // (64 kbps at index 5), not Layer I's table where index 5 is 160 kbps.
    // Reading this field backwards is what produced the phantom "5.6x slow
    // playback" investigation.
    expect(parseMp3Frame(frame(5), 0)!.bitrateKbps).toBe(64);
  });

  it('rejects reserved and malformed headers', () => {
    expect(parseMp3Frame(Buffer.alloc(4), 0)).toBeNull();
    expect(parseMp3Frame(frame(0), 0)).toBeNull(); // bitrate index 0 = free
    expect(parseMp3Frame(frame(15), 0)).toBeNull(); // bitrate index 15 = bad
    expect(parseMp3Frame(Buffer.from([0xff]), 0)).toBeNull(); // truncated
  });
});

describe('audioStartOffset', () => {
  it('returns 0 when there is no ID3v2 tag', () => {
    expect(audioStartOffset(frame(5))).toBe(0);
  });

  it('skips an ID3v2 tag using syncsafe sizing', () => {
    const tag = Buffer.alloc(10);
    tag.write('ID3', 0, 'latin1');
    tag[6] = 0; tag[7] = 0; tag[8] = 1; tag[9] = 0x7f; // (1 << 7) | 127 = 255
    expect(audioStartOffset(Buffer.concat([tag, frame(5)]))).toBe(10 + 255);
  });
});

describe('mp3DrainBytesPerSecond', () => {
  it('reports the byte rate the decoder will consume', () => {
    // 64 kbps = 8000 bytes/sec.
    expect(mp3DrainBytesPerSecond(frame(5))).toBe(8000);
  });

  it('finds the first frame after an ID3v2 tag', () => {
    const tag = Buffer.alloc(10);
    tag.write('ID3', 0, 'latin1');
    expect(mp3DrainBytesPerSecond(Buffer.concat([tag, frame(5)]))).toBe(8000);
  });

  it('averages contiguous frame bitrates for VBR replies', () => {
    // MPEG1 Layer III indexes 5 and 8 are 64 and 112 kbps. Equal-duration
    // frames should therefore model an 88 kbps stream, not the first frame's
    // 64 kbps rate.
    const mp3 = Buffer.concat([exactFrame(5), exactFrame(8)]);
    expect(mp3DrainBytesPerSecond(mp3)).toBe(11_000);
  });

  it('returns null for a buffer with no parseable frame', () => {
    // This is the shape the pipeline tests mock, and the reason the pacer must
    // fall back rather than throw.
    expect(mp3DrainBytesPerSecond(Buffer.alloc(3072))).toBeNull();
  });
});

describe('pacingDelayMs', () => {
  const drain = 8000; // 64 kbps

  it('does not delay while the device buffer has room', () => {
    expect(pacingDelayMs(0, 1024, drain)).toBe(0);
    expect(pacingDelayMs(MP3_TARGET_BUFFER_BYTES - 2048, 1024, drain)).toBe(0);
  });

  it('waits exactly long enough to drain the overflow', () => {
    // 1024 B over target at 8000 B/s = 128 ms.
    expect(pacingDelayMs(MP3_TARGET_BUFFER_BYTES, 1024, drain)).toBe(128);
  });

  it('never divides by a zero or negative drain rate', () => {
    expect(pacingDelayMs(999_999, 1024, 0)).toBe(0);
    expect(pacingDelayMs(999_999, 1024, -5)).toBe(0);
  });

  it('keeps modeled occupancy under the ring size for a long reply', () => {
    // The regression this whole change exists for: a 160 KB reply is 160
    // frames, far past the ~57 at which the old fixed interval saturated the
    // 48 KB ring. Simulate the pacer's own model and assert it never reaches
    // the real ring size.
    const chunk = 1024;
    const RING_BYTES = 48 * 1024;
    let occupancy = 0;
    let peak = 0;
    for (let sent = 0; sent < 160 * chunk; sent += chunk) {
      const wait = pacingDelayMs(occupancy, chunk, drain);
      occupancy = Math.max(0, occupancy - (wait / 1000) * drain) + chunk;
      peak = Math.max(peak, occupancy);
    }
    expect(peak).toBeLessThanOrEqual(MP3_TARGET_BUFFER_BYTES + chunk);
    expect(peak).toBeLessThan(RING_BYTES);
  });

  it('holds for a very long reply too, where a fixed multiplier would not', () => {
    const chunk = 1024;
    let occupancy = 0;
    let peak = 0;
    for (let sent = 0; sent < 600 * chunk; sent += chunk) {
      const wait = pacingDelayMs(occupancy, chunk, drain);
      occupancy = Math.max(0, occupancy - (wait / 1000) * drain) + chunk;
      peak = Math.max(peak, occupancy);
    }
    expect(peak).toBeLessThan(48 * 1024);
  });
});
