/**
 * Conditioning for a recorded speech-asset clip (PCM16 16 kHz mono), applied
 * once when a pack is built, never during a turn. Provider TTS pads each call
 * with up to a second of silence; joined clips would carry that as dead air.
 * Trimming keeps a fixed margin of the provider's own audio around the first
 * and last 10 ms window above the threshold, so a soft onset or decaying tail
 * inside that margin is never cut. One gain brings the speech to a common
 * loudness, capped by a peak ceiling, and short fades at the ends stop clicks.
 */
export interface SpeechClipShape {
  /** Audio kept (or silence added) before the first voiced window. */
  leadPadMs: number;
  /** Audio kept (or silence added) after the last voiced window. */
  tailPadMs: number;
  /** Voiced-region RMS after gain. */
  targetRmsDbfs: number;
  /** No sample exceeds this after gain. */
  peakCeilingDbfs: number;
  /** A 10 ms window at or above this RMS counts as speech. */
  thresholdDbfs: number;
  /** Linear fade at each end. */
  fadeMs: number;
}

/** A whole sentence: a short lead and a sentence-sized pause after it. */
export const SENTENCE_CLIP: SpeechClipShape = {
  leadPadMs: 30, tailPadMs: 250, targetRmsDbfs: -20, peakCeilingDbfs: -1, thresholdDbfs: -45, fadeMs: 5,
};

const SAMPLES_PER_MS = 16;
const WINDOW = 10 * SAMPLES_PER_MS;
const FULL_SCALE = 32768;

function toSamples(pcm: Buffer): Int16Array {
  const out = new Int16Array(pcm.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2);
  return out;
}

/** Whether each 10 ms window's RMS reaches the threshold. */
function voicedWindows(samples: Int16Array, threshold: number): boolean[] {
  const voiced: boolean[] = [];
  for (let start = 0; start < samples.length; start += WINDOW) {
    const window = samples.subarray(start, start + WINDOW);
    let squares = 0;
    for (const sample of window) squares += sample * sample;
    voiced.push(Math.sqrt(squares / window.length) >= threshold);
  }
  return voiced;
}

/** First and one-past-last sample of the voiced windows, or undefined if none. */
function voicedSpan(samples: Int16Array, threshold: number): [number, number] | undefined {
  const voiced = voicedWindows(samples, threshold);
  const first = voiced.indexOf(true);
  if (first === -1) return undefined;
  return [first * WINDOW, Math.min(samples.length, (voiced.lastIndexOf(true) + 1) * WINDOW)];
}

/**
 * The longest silence between the first and last voiced window, in ms, at the
 * sentence threshold. A provider take that pauses a second mid-sentence, or
 * trails a stray breath after its last word, shows up here; the pack recorder
 * retakes such clips instead of shipping them.
 */
export function longestPauseMs(pcm: Buffer, thresholdDbfs = SENTENCE_CLIP.thresholdDbfs): number {
  const voiced = voicedWindows(toSamples(pcm), FULL_SCALE * 10 ** (thresholdDbfs / 20));
  let longest = 0;
  let run = 0;
  for (let i = voiced.indexOf(true); i >= 0 && i <= voiced.lastIndexOf(true); i++) {
    run = voiced[i] === true ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return longest * (WINDOW / SAMPLES_PER_MS);
}

/** Gain to the target loudness, capped so no sample of the whole clip passes the ceiling. */
function gainFor(samples: Int16Array, span: [number, number], shape: SpeechClipShape): number {
  let squares = 0;
  for (const sample of samples.subarray(span[0], span[1])) squares += sample * sample;
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const rms = Math.sqrt(squares / (span[1] - span[0]));
  const target = FULL_SCALE * 10 ** (shape.targetRmsDbfs / 20);
  const ceiling = FULL_SCALE * 10 ** (shape.peakCeilingDbfs / 20);
  return Math.min(target / rms, ceiling / peak);
}

function fadeEnds(out: Int16Array, fadeSamples: number): void {
  const fade = Math.min(fadeSamples, Math.floor(out.length / 2));
  for (let i = 0; i < fade; i++) {
    const scale = i / fade;
    out[i] = Math.round((out[i] ?? 0) * scale);
    out[out.length - 1 - i] = Math.round((out[out.length - 1 - i] ?? 0) * scale);
  }
}

/** Trim, level and fade one clip; throws when it holds no speech at all. */
export function conditionSpeechClip(pcm: Buffer, shape: SpeechClipShape): Buffer {
  if (pcm.length % 2 !== 0) throw new Error('Speech clip is not whole PCM16 samples');
  const samples = toSamples(pcm);
  const span = voicedSpan(samples, FULL_SCALE * 10 ** (shape.thresholdDbfs / 20));
  if (span === undefined) throw new Error('Speech clip has no speech above the threshold');
  const lead = shape.leadPadMs * SAMPLES_PER_MS;
  const tail = shape.tailPadMs * SAMPLES_PER_MS;
  const from = Math.max(0, span[0] - lead);
  const to = Math.min(samples.length, span[1] + tail);
  const gain = gainFor(samples, span, shape);
  // Silence fills whatever part of the lead or tail the provider did not supply.
  const out = new Int16Array(lead + (span[1] - span[0]) + tail);
  const offset = lead - (span[0] - from);
  samples.subarray(from, to).forEach((sample, i) => {
    out[offset + i] = Math.max(-FULL_SCALE, Math.min(FULL_SCALE - 1, Math.round(sample * gain)));
  });
  fadeEnds(out, shape.fadeMs * SAMPLES_PER_MS);
  const bytes = Buffer.alloc(out.length * 2);
  out.forEach((sample, i) => bytes.writeInt16LE(sample, i * 2));
  return bytes;
}
