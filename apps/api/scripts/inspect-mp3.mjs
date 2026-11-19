// Minimal MP3 frame-header inspector (no deps). Walks every frame and reports
// format mix, frame count and total duration.
// Usage: node scripts/inspect-mp3.mjs <file.mp3> [maxFrames]
//
// Duration matters as much as the format mix: it is the reference the on-device
// playback span is scored against, so an error here sends firmware debugging
// after phantom bugs. An earlier version inverted the layer bit-field (see
// LAYER_BY_BITS below) and priced Layer III frames off the Layer I bitrate
// table, reporting this repo's 64 kbps audio.mp3 as 160 kbps -> a 1.5 s clip
// that is really 3.72 s. It also lacked the ID3v2 skip and false-synced inside
// the tag, inventing a 22050 Hz frame that does not exist in the file.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Bitrate tables in kbps, keyed [1=MPEG1 | 2=MPEG2/2.5][layer 1..3][index].
const BITRATE = {
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
const SAMPLE_RATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const VERSION_NAME = { 3: 'MPEG1', 2: 'MPEG2', 0: 'MPEG2.5' };
// The layer bit-field counts DOWN: 0b11 = Layer I, 0b10 = Layer II,
// 0b01 = Layer III. Every table below is keyed by real layer number, so the
// raw bits must be mapped through here exactly once, at parse time.
const LAYER_BY_BITS = { 3: 1, 2: 2, 1: 3 };
const LAYER_NAME = { 1: 'I', 2: 'II', 3: 'III' };
const CHANNEL_NAME = { 0: 'stereo', 1: 'joint-stereo', 2: 'dual', 3: 'mono' };

/** Byte offset of the first frame, skipping an ID3v2 tag if one is present. */
export function audioStart(buf) {
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    // ID3v2 size is 4 syncsafe bytes (7 significant bits each).
    // Each syncsafe byte carries only 7 significant bits; mask the high bit
    // or a malformed tag yields an offset past the first frame.
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    const footer = buf[5] & 0x10 ? 10 : 0;  // ID3v2.4 footer, when flagged
    return 10 + size + footer;
  }
  return 0;
}

/** Parses a frame header at `off`, or returns null if it is not a valid one. */
export function parseFrame(buf, off) {
  if (off + 4 > buf.length) return null;
  const h = buf.readUInt32BE(off);
  if ((h >>> 21) !== 0x7ff) return null; // no sync word
  const versionBits = (h >>> 19) & 3;
  const layerBits = (h >>> 17) & 3;
  if (versionBits === 1 || layerBits === 0) return null; // reserved
  const bitrateIdx = (h >>> 12) & 15;
  const sampleRateIdx = (h >>> 10) & 3;
  if (bitrateIdx === 0 || bitrateIdx === 15 || sampleRateIdx === 3) return null;

  const layer = LAYER_BY_BITS[layerBits];
  const isMpeg1 = versionBits === 3;
  const padding = (h >>> 9) & 1;
  const bitrate = BITRATE[isMpeg1 ? 1 : 2][layer][bitrateIdx] * 1000;
  const sampleRate = SAMPLE_RATE[versionBits][sampleRateIdx];
  if (!bitrate || !sampleRate) return null;

  // Layer I is 384 samples/frame; Layer III on MPEG2/2.5 halves to 576.
  const samplesPerFrame = layer === 1 ? 384 : layer === 3 && !isMpeg1 ? 576 : 1152;
  const frameLen =
    layer === 1
      ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
      : Math.floor((samplesPerFrame / 8 * bitrate) / sampleRate) + padding;
  if (frameLen < 4) return null;

  return {
    off,
    version: VERSION_NAME[versionBits],
    layer: LAYER_NAME[layer],
    bitrateKbps: bitrate / 1000,
    sampleRate,
    channels: CHANNEL_NAME[(h >>> 6) & 3],
    samplesPerFrame,
    frameLen,
  };
}

/**
 * True if this frame is a Xing/Info/VBRI header rather than audio. Such a
 * frame carries only stream metadata; every decoder skips it, so counting its
 * 1152 samples as audio overstates the file by one frame. That is not
 * academic: it made a device that decoded the stream EXACTLY look like it was
 * dropping a frame, and forced a two-frame fudge into the truncation check.
 */
export function isHeaderFrame(buf, frame) {
  const body = buf.toString('latin1', frame.off + 4, frame.off + Math.min(frame.frameLen, 64));
  return body.includes('Xing') || body.includes('Info') || body.includes('VBRI');
}

/** Walks every frame, returning the format mix, sample total and duration. */
export function inspectMp3(buf, maxFrames = Infinity) {
  const frames = [];
  let samples = 0;
  let durationMs = 0;
  let resyncBytes = 0;
  let off = audioStart(buf);
  // <=, not <: buf.length - 4 is the last offset a header can occupy.
  while (off <= buf.length - 4 && frames.length < maxFrames) {
    const f = parseFrame(buf, off);
    if (!f) {
      off += 1;
      resyncBytes += 1;
      continue;
    }
    f.isHeader = isHeaderFrame(buf, f);
    frames.push(f);
    if (!f.isHeader) {
      samples += f.samplesPerFrame;
      durationMs += (f.samplesPerFrame * 1000) / f.sampleRate;
    }
    off += f.frameLen;
  }
  const headerFrames = frames.filter((f) => f.isHeader).length;
  return {
    frames,
    headerFrames,
    audioFrames: frames.length - headerFrames,
    samples,
    durationMs: Math.round(durationMs),
    resyncBytes,
  };
}

// CLI entry point; stays inert when this module is imported by tests.
// Compare via pathToFileURL, not a hand-built `file://` string: on Windows
// import.meta.url is `file:///D:/...` (three slashes) so the hand-built form
// never matched and the whole CLI silently no-opped with exit 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  const maxFrames = process.argv[3] ? Number(process.argv[3]) : Infinity;
  const buf = readFileSync(file);
  const { frames, headerFrames, audioFrames, samples, durationMs, resyncBytes } =
    inspectMp3(buf, maxFrames);

  console.log(`file=${file} size=${buf.length}B frames=${frames.length} audio=${audioFrames} header=${headerFrames}`);
  if (frames.length === 0) {
    console.log('NO valid MP3 frame headers found');
    process.exit(1);
  }
  const uniq = new Map();
  for (const f of frames) {
    const key = `${f.version}/${f.layer} ${f.bitrateKbps}kbps ${f.sampleRate}Hz ${f.channels}`;
    uniq.set(key, (uniq.get(key) ?? 0) + 1);
  }
  console.log('summary:');
  for (const [k, v] of uniq) console.log(`  ${v}x ${k}`);
  console.log(`samples=${samples} duration_ms=${durationMs} resync_bytes=${resyncBytes}`);
  console.log(`first frame at offset ${frames[0].off}, avg frame len ${Math.round(frames.reduce((a, f) => a + f.frameLen, 0) / frames.length)}`);
}
