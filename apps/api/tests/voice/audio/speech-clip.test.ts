import { describe, expect, it } from 'vitest';
import { conditionSpeechClip, longestPauseMs, SENTENCE_CLIP } from '../../../src/voice/audio/speech-clip.ts';

const RATE = 16;

function tone(ms: number, amplitude: number): Int16Array {
  const out = new Int16Array(ms * RATE);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / 16_000));
  return out;
}

function pcm(...parts: Int16Array[]): Buffer {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = Buffer.alloc(total * 2);
  let at = 0;
  for (const part of parts) for (const sample of part) { out.writeInt16LE(sample, at); at += 2; }
  return out;
}

function samples(buffer: Buffer): number[] {
  return Array.from({ length: buffer.length / 2 }, (_, i) => buffer.readInt16LE(i * 2));
}

function rmsDbfs(values: number[]): number {
  const mean = values.reduce((n, v) => n + v * v, 0) / values.length;
  return 20 * Math.log10(Math.sqrt(mean) / 32768);
}

describe('conditionSpeechClip', () => {
  it('trims provider silence padding to the configured lead and tail', () => {
    const out = conditionSpeechClip(pcm(tone(140, 0), tone(800, 8000), tone(900, 0)), SENTENCE_CLIP);
    expect(out.length / 2 / RATE).toBe(SENTENCE_CLIP.leadPadMs + 800 + SENTENCE_CLIP.tailPadMs);
  });

  it('never cuts quiet speech above the threshold at either edge', () => {
    const soft = tone(60, 400); // about -41 dBFS RMS: a soft fricative-level onset, above the -45 dBFS threshold
    const out = conditionSpeechClip(pcm(tone(200, 0), soft, tone(500, 8000), soft, tone(600, 0)), SENTENCE_CLIP);
    expect(out.length / 2 / RATE).toBe(SENTENCE_CLIP.leadPadMs + 620 + SENTENCE_CLIP.tailPadMs);
  });

  it('pads with silence when the provider left less than the configured edge', () => {
    const out = conditionSpeechClip(pcm(tone(500, 8000)), SENTENCE_CLIP);
    const values = samples(out);
    expect(values.length / RATE).toBe(SENTENCE_CLIP.leadPadMs + 500 + SENTENCE_CLIP.tailPadMs);
    expect(values.slice(0, SENTENCE_CLIP.leadPadMs * RATE).every((v) => v === 0)).toBe(true);
  });

  it('normalises speech loudness to the target without exceeding the peak ceiling', () => {
    const quiet = samples(conditionSpeechClip(pcm(tone(500, 1000)), SENTENCE_CLIP));
    const loud = samples(conditionSpeechClip(pcm(tone(500, 30000)), SENTENCE_CLIP));
    const voiced = (v: number[]): number[] => v.slice(SENTENCE_CLIP.leadPadMs * RATE + 80, -(SENTENCE_CLIP.tailPadMs * RATE + 80));
    expect(rmsDbfs(voiced(quiet))).toBeCloseTo(SENTENCE_CLIP.targetRmsDbfs, 0);
    expect(rmsDbfs(voiced(loud))).toBeCloseTo(SENTENCE_CLIP.targetRmsDbfs, 0);
    const ceiling = 32768 * 10 ** (SENTENCE_CLIP.peakCeilingDbfs / 20);
    const spiky = samples(conditionSpeechClip(pcm(tone(500, 1000), tone(5, 20000)), SENTENCE_CLIP));
    expect(Math.max(...spiky.map(Math.abs))).toBeLessThanOrEqual(Math.ceil(ceiling));
  });

  it('fades the very first and last samples so a join cannot click', () => {
    const values = samples(conditionSpeechClip(pcm(tone(500, 20000)), { ...SENTENCE_CLIP, leadPadMs: 0, tailPadMs: 0 }));
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(0);
  });

  it('refuses a clip with no speech above the threshold', () => {
    expect(() => conditionSpeechClip(pcm(tone(500, 20)), SENTENCE_CLIP)).toThrow(/no speech/);
  });

  it('measures the longest pause inside the speech, ignoring the edges', () => {
    const clip = pcm(tone(200, 0), tone(300, 8000), tone(450, 0), tone(300, 8000), tone(700, 0));
    expect(longestPauseMs(clip)).toBe(450);
    expect(longestPauseMs(pcm(tone(500, 8000)))).toBe(0);
    expect(longestPauseMs(pcm(tone(500, 0)))).toBe(0);
  });
});
