import { describe, expect, it, vi } from 'vitest';
import { recordObservationMetrics } from '@bob/ai';
vi.mock('@bob/ai', async (original) => ({ ...(await original<typeof import('@bob/ai')>()),
  recordObservationMetrics: vi.fn(), traceSpan: vi.fn(async (_name, _attrs, fn) => fn()),
}));
import { withTtsCache } from '../../src/voice/speech-cache.ts';
import type { SpeechPort } from '../../src/voice/speech-port.ts';

function counting(calls: string[]): SpeechPort {
  return {
    transcribe: () => { calls.push('stt'); return Promise.resolve({ text: 'x' }); },
    synthesizePcm: (t) => { calls.push(`pcm:${t}`); return Promise.resolve({ pcm: Buffer.from([1, 2]), sourceRateHz: 16_000 }); },
    synthesizeMp3: (t) => { calls.push(`mp3:${t}`); return Promise.resolve({ mp3: Buffer.from([3]) }); },
    transcribeEncoded: () => Promise.resolve({ text: 'x', model: 'm' }),
    synthesizeEncoded: (i) => { calls.push(`enc:${i.text}`); return Promise.resolve({ audio: 'AAA', format: 'mp3', contentType: 'audio/mpeg' }); },
  };
}

describe('withTtsCache', () => {
  it('scores eligible hit/miss and bypass without content or duplicate provider calls', async () => {
    vi.clearAllMocks();
    const calls: string[] = [];
    const port = withTtsCache(counting(calls), { maxChars: 5 });
    await port.synthesizeMp3('hi');
    await port.synthesizeMp3('hi');
    await port.synthesizeMp3('long private phrase');
    const samples = vi.mocked(recordObservationMetrics).mock.calls.flatMap(([values]) => values);
    expect(samples.filter((sample) => sample.name === 'speech.cache_hit').map((sample) => sample.value)).toEqual([0, 1]);
    expect(samples.filter((sample) => sample.name === 'speech.cache_bypass').map((sample) => sample.value)).toEqual([0, 0, 1]);
    expect(JSON.stringify(samples)).not.toContain('private');
    expect(calls).toHaveLength(2);
  });
  it('passes a miss timing through and strips it from a hit (#1387)', async () => {
    const timing = { headers_ms: 400, last_byte_ms: 500, decode_ms: 2, encode_ms: 30 };
    const port = withTtsCache({ ...counting([]), synthesizeMp3: () => Promise.resolve({ mp3: Buffer.from([3]), timing }) });
    expect((await port.synthesizeMp3('Done.')).timing).toEqual(timing);
    expect(await port.synthesizeMp3('Done.')).not.toHaveProperty('timing');
  });
  it('passes an encoded miss timing through and strips it from an encoded hit (#1387)', async () => {
    const timing = { headers_ms: 400, last_byte_ms: 500, done_ms: 450 };
    const port = withTtsCache({ ...counting([]), synthesizeEncoded: () => Promise.resolve({ audio: 'AAA', format: 'mp3', contentType: 'audio/mpeg', timing }) });
    expect((await port.synthesizeEncoded({ text: 'Done.', format: 'mp3' })).timing).toEqual(timing);
    expect(await port.synthesizeEncoded({ text: 'Done.', format: 'mp3' })).not.toHaveProperty('timing');
  });
  it('serves a repeated short phrase without a second provider call', async () => {
    const calls: string[] = [];
    const port = withTtsCache(counting(calls));
    await port.synthesizeMp3('Done.');
    await port.synthesizeMp3('Done.');
    await port.synthesizePcm('Done.');
    await port.synthesizePcm('Done.');
    expect(calls).toEqual(['mp3:Done.', 'pcm:Done.']);
  });

  it('keys device speech by voice, so a phrase cached in one voice never plays in another', async () => {
    const calls: string[] = [];
    const inner = counting(calls);
    const port = withTtsCache({
      ...inner,
      synthesizeMp3: (t, v) => { calls.push(`mp3:${t}:${v}`); return Promise.resolve({ mp3: Buffer.from([3]) }); },
      synthesizePcm: (t, v) => { calls.push(`pcm:${t}:${v}`); return Promise.resolve({ pcm: Buffer.from([1]), sourceRateHz: 16_000 }); },
    });
    await port.synthesizeMp3('Done.', 'en-US-Harper');
    await port.synthesizeMp3('Done.', 'en-US-Sage');
    await port.synthesizeMp3('Done.', 'en-US-Sage');
    await port.synthesizePcm('Done.', 'en-US-Harper');
    await port.synthesizePcm('Done.', 'en-US-Sage');
    expect(calls).toEqual(['mp3:Done.:en-US-Harper', 'mp3:Done.:en-US-Sage', 'pcm:Done.:en-US-Harper', 'pcm:Done.:en-US-Sage']);
  });

  it('misses for different text or encoded options', async () => {
    const calls: string[] = [];
    const port = withTtsCache(counting(calls));
    await port.synthesizeMp3('a');
    await port.synthesizeMp3('b');
    await port.synthesizeEncoded({ text: 'a', format: 'mp3' });
    await port.synthesizeEncoded({ text: 'a', format: 'wav' });
    expect(calls).toEqual(['mp3:a', 'mp3:b', 'enc:a', 'enc:a']);
  });

  it('bypasses the cache for long text and never caches STT', async () => {
    const calls: string[] = [];
    const port = withTtsCache(counting(calls), { maxChars: 5 });
    await port.synthesizeMp3('longer than five');
    await port.synthesizeMp3('longer than five');
    await port.transcribe(Buffer.alloc(2));
    await port.transcribe(Buffer.alloc(2));
    expect(calls).toEqual(['mp3:longer than five', 'mp3:longer than five', 'stt', 'stt']);
  });

  it('hands out copies so a caller cannot corrupt the cached audio', async () => {
    const port = withTtsCache(counting([]));
    const first = await port.synthesizePcm('hi');
    first.pcm.fill(9);
    expect((await port.synthesizePcm('hi')).pcm).toEqual(Buffer.from([1, 2]));
  });
});

describe('withTtsCache with a progressive MP3 (#1391)', () => {
  const progressive = (calls: string[], tail: () => Promise<Buffer>): SpeechPort => ({
    ...counting([]),
    synthesizeMp3: (t) => { calls.push(t); return Promise.resolve({ mp3: Buffer.from([1, 2]), tail: tail(), timing: { decode_ms: 1, encode_ms: 2 } }); },
  });

  it('returns the tail on a miss, then serves the whole clip with no tail and no timing', async () => {
    const calls: string[] = [];
    const port = withTtsCache(progressive(calls, () => Promise.resolve(Buffer.from([3, 4]))));
    const miss = await port.synthesizeMp3('Done.');
    expect(miss.mp3).toEqual(Buffer.from([1, 2]));
    expect(await miss.tail).toEqual(Buffer.from([3, 4]));
    expect(miss.timing).toBeDefined();
    const hit = await port.synthesizeMp3('Done.');
    expect(hit.mp3).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(hit).not.toHaveProperty('tail');
    expect(hit).not.toHaveProperty('timing');
    expect(calls).toEqual(['Done.']);
  });

  it('a miss does not wait for the tail', async () => {
    let release: (tail: Buffer) => void = () => undefined;
    const port = withTtsCache(progressive([], () => new Promise<Buffer>((resolve) => { release = resolve; })));
    const miss = await port.synthesizeMp3('Done.');
    expect(miss.mp3).toEqual(Buffer.from([1, 2]));
    release(Buffer.from([3]));
    expect(await miss.tail).toEqual(Buffer.from([3]));
  });

  it('a rejected tail leaves the key uncached', async () => {
    const calls: string[] = [];
    let fail = true;
    const port = withTtsCache(progressive(calls, () => (fail ? Promise.reject(new Error('encode failed')) : Promise.resolve(Buffer.from([9])))));
    const miss = await port.synthesizeMp3('Done.');
    await expect(miss.tail).rejects.toThrow('encode failed');
    await new Promise((resolve) => setTimeout(resolve, 5));
    fail = false;
    const retry = await port.synthesizeMp3('Done.');
    expect(await retry.tail).toEqual(Buffer.from([9]));
    expect(calls).toEqual(['Done.', 'Done.']);
  });
});
