/**
 * Voice latency RCA causes 3-4: a reply known only once the model has finished
 * (a guarded game reply, a generate-only agent) is still spoken clause by
 * clause, so the first clause plays while the rest synthesizes; the tts stage
 * journals when the first synthesized byte was ready.
 */
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_DOWNLINK_MP3_BYTES, MP3_16K_MONO_FORMAT, PCM16_16K_MONO_FORMAT } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import type { TurnDeps } from '../../src/voice/turn/deps.ts';
import { createSentencePlayback, prewarmSpeech, streamPlayback } from '../../src/voice/turn/playback.ts';

vi.mock('@bob/ai', async (orig) => ({
  ...(await orig<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, run) => run()),
}));

type FakeSocket = { readyState: number; bufferedAmount: number; send: ReturnType<typeof vi.fn> };
const fakeSocket = (): FakeSocket => ({ readyState: 1, bufferedAmount: 0, send: vi.fn() });
const asWs = (socket: FakeSocket): WebSocket => socket as unknown as WebSocket;
const sentAudio = (socket: FakeSocket): number => socket.send.mock.calls.filter(([data]) => typeof data !== 'string').length;

function fakeDeps(over: Partial<TurnDeps>): TurnDeps {
  const unexpected = (name: string) => (): never => { throw new Error(`unexpected deps.${name}`); };
  return {
    getDb: unexpected('getDb') as TurnDeps['getDb'],
    deviceSessions: { flushPending: vi.fn() } as unknown as TurnDeps['deviceSessions'],
    timersChanged: unexpected('timersChanged') as TurnDeps['timersChanged'],
    embedder: unexpected('embedder') as TurnDeps['embedder'],
    stt: unexpected('stt') as TurnDeps['stt'],
    ttsPcm: unexpected('ttsPcm') as TurnDeps['ttsPcm'],
    ttsMp3: unexpected('ttsMp3') as TurnDeps['ttsMp3'],
    agent: unexpected('agent') as unknown as TurnDeps['agent'],
    accountEvents: unexpected('accountEvents') as TurnDeps['accountEvents'],
    ...over,
  };
}

function session(formatId: number = MP3_16K_MONO_FORMAT): ReturnType<typeof createSession> {
  const created = createSession();
  created.formatId = formatId as typeof created.formatId;
  return created;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Journal lines emitted while `run` runs, parsed. */
async function journaled(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = [];
  setJournalSink((line) => lines.push(line));
  try {
    await run();
  } finally {
    setJournalSink(null);
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const ttsCompleted = (journal: Array<Record<string, unknown>>): Record<string, unknown> | undefined =>
  journal.find((entry) => entry.event === 'v2.turn_stage_tts_completed');

describe('a finished reply is spoken clause by clause', () => {
  it('synthesizes each sentence of a finished MP3 reply in order and plays the first before the last is synthesized', async () => {
    let lastSettled = false;
    let audioBeforeLast = 0;
    const socket = fakeSocket();
    const ttsMp3 = vi.fn(async (text: string) => {
      await sleep(text.startsWith('Now') ? 120 : 10);
      if (text.startsWith('Now')) { audioBeforeLast = sentAudio(socket); lastSettled = true; }
      return { mp3: Buffer.alloc(2_048) };
    });
    const result = await streamPlayback(
      fakeDeps({ ttsMp3 }), asWs(socket), session(), 'Nice one! Now watch closely: red, green, blue.', 'turn_1', Date.now(),
    );
    expect(ttsMp3.mock.calls.map((call) => call[0])).toEqual(['Nice one!', 'Now watch closely: red, green, blue.']);
    expect(lastSettled).toBe(true);
    expect(audioBeforeLast).toBeGreaterThan(0);
    expect(result.downFrames).toBe(result.totalFrames);
  });

  it('a reply with nothing speakable (a bare fence) still plays, its raw text spoken once', async () => {
    const socket = fakeSocket();
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(2_048) });
    const result = await streamPlayback(fakeDeps({ ttsMp3 }), asWs(socket), session(), '```\n```', 'turn_1', Date.now());
    expect(ttsMp3.mock.calls.map((call) => call[0])).toEqual(['```\n```']);
    expect(result.downFrames).toBeGreaterThan(0);
    expect(sentAudio(socket)).toBe(result.downFrames);
  });

  it('a first-sentence TTS failure still rejects, as the whole-reply call did', async () => {
    const ttsMp3 = vi.fn().mockRejectedValue(new Error('tts provider down'));
    await expect(streamPlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), session(), 'One. Two.', 'turn_1', Date.now()))
      .rejects.toThrow('tts provider down');
  });
});

describe('tts_first_byte_ms on v2.turn_stage_tts_completed', () => {
  it('a multi-sentence reply reports the first byte and its first sentence separately', async () => {
    const ttsMp3 = vi.fn(async (text: string) => {
      await sleep(text === 'One.' ? 20 : 80);
      return { mp3: Buffer.alloc(1_024) };
    });
    const journal = await journaled(async () => {
      const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), session(), 'turn_1', Date.now());
      playback.push('One. Two words here. ');
      await playback.finish();
    });
    const completed = ttsCompleted(journal)!;
    expect(completed).toMatchObject({ sentences: 2, first_sentence_chars: 4 });
    expect(completed.tts_first_byte_ms).toEqual(expect.any(Number));
    expect(completed.first_sentence_ms).toEqual(expect.any(Number));
    expect(completed.tts_first_byte_ms as number).toBeGreaterThanOrEqual(15);
    expect(completed.tts_first_byte_ms as number).toBeLessThan(70);
    expect(JSON.stringify(completed)).not.toContain('One');
  });

  it('a one-sentence reply reports the first byte without the first-sentence fields', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024) });
    const journal = await journaled(() => streamPlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), session(), 'Hello there.', 'turn_1', Date.now()));
    const completed = ttsCompleted(journal)!;
    expect(completed.tts_first_byte_ms).toEqual(expect.any(Number));
    expect(completed).not.toHaveProperty('first_sentence_ms');
  });

  it('the PCM whole-reply path reports the first byte too', async () => {
    const ttsPcm = vi.fn().mockResolvedValue({ pcm: Buffer.alloc(640), sourceRateHz: 16_000 });
    const journal = await journaled(() => streamPlayback(fakeDeps({ ttsPcm }), asWs(fakeSocket()), session(PCM16_16K_MONO_FORMAT), 'Hi.', 'turn_1', Date.now()));
    expect(ttsCompleted(journal)!.tts_first_byte_ms).toEqual(expect.any(Number));
  });
});

describe('a progressive MP3 clause (#1391)', () => {
  const sequences = (socket: FakeSocket): number[] =>
    socket.send.mock.calls.filter(([data]) => typeof data !== 'string').map(([data]) => (data as Buffer).readUInt32BE(12));
  const messageTypes = (socket: FakeSocket): string[] =>
    socket.send.mock.calls.filter(([data]) => typeof data === 'string').map(([data]) => (JSON.parse(data as string) as { type: string }).type);

  it('sends playback_start and the head frames before the tail resolves, then the tail with continuous sequence numbers', async () => {
    const timing = { decode_ms: 1, encode_ms: 2, encode_tail_ms: 12.4 };
    let release: (tail: Buffer) => void = () => undefined;
    const tail = new Promise<Buffer>((resolve) => { release = resolve; });
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(2_048), tail, timing });
    const socket = fakeSocket();
    let headSequences: number[] = [];
    let typesBeforeTail: string[] = [];
    const journal = await journaled(async () => {
      const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(socket), session(), 'turn_1', Date.now());
      playback.push('One.');
      const finished = playback.finish();
      await sleep(80);
      headSequences = sequences(socket);
      typesBeforeTail = messageTypes(socket);
      release(Buffer.alloc(2_048));
      await finished;
    });
    expect(typesBeforeTail).toContain('playback_start');
    expect(headSequences.length).toBeGreaterThan(0);
    const all = sequences(socket);
    expect(all.length).toBeGreaterThan(headSequences.length);
    expect(all).toEqual(all.map((_, index) => index));
    expect(ttsCompleted(journal)).toMatchObject({ tts_encode_ms: 2, tts_encode_tail_ms: 12, sentences: 1 });
  });

  it('a rejected tail ends with tts_failed and keeps the head frames', async () => {
    const tail = new Promise<Buffer>((_resolve, reject) => { setTimeout(() => reject(new Error('encode failed')), 30); });
    tail.catch(() => undefined);
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(2_048), tail });
    const socket = fakeSocket();
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(socket), session(), 'turn_1', Date.now());
    playback.push('One.');
    const result = await playback.finish();
    expect(result.cut).toBe('tts_failed');
    expect(result.downFrames).toBeGreaterThan(0);
    expect(sequences(socket)).toHaveLength(result.downFrames);
  });
});

describe('progressive playback interruption boundaries', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('does not count text as heard when cancelled inside a head whose tail length is unknown', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const socket = fakeSocket();
    socket.send.mockImplementation((data: Buffer | string) => {
      if (typeof data !== 'string') controller.abort();
    });
    const tail = new Promise<Buffer>(() => undefined);
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(2_048), tail });
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(socket), session(), 'turn_cut_head', Date.now(), controller.signal);
    playback.push('A complete synthetic sentence.');
    const finished = playback.finish();
    await vi.runAllTimersAsync();
    const result = await finished;
    expect(result.downFrames).toBe(1);
    expect(result.heardChars).toBe(0);
  });

  it('abandons an unresolved tail immediately when cancelled after the whole head', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const socket = fakeSocket();
    const tail = new Promise<Buffer>(() => undefined);
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024), tail });
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(socket), session(), 'turn_cut_tail', Date.now(), controller.signal);
    playback.push('A complete synthetic sentence.');
    const finished = playback.finish();
    await vi.runAllTimersAsync();
    expect(sentAudio(socket)).toBe(1);
    controller.abort();
    await vi.runAllTimersAsync();
    const result = await finished;
    expect(result.downFrames).toBe(1);
    expect(result.heardChars).toBe(0);
  });

  it('does not claim the whole sentence was heard when the tail exceeds the byte cap', async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024), tail: Promise.resolve(Buffer.alloc(MAX_DOWNLINK_MP3_BYTES)) });
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(socket), session(), 'turn_tail_cap', Date.now());
    playback.push('A complete synthetic sentence.');
    const finished = playback.finish();
    await vi.runAllTimersAsync();
    const result = await finished;
    expect(result.cut).toBe('size_cap');
    expect(result.downFrames).toBe(1);
    expect(result.heardChars).toBeLessThan('A complete synthetic sentence.'.length);
  });

  it('falls back to fresh synthesis if a prewarmed progressive tail fails', async () => {
    vi.useFakeTimers();
    const tail = Promise.reject<Buffer>(new Error('synthetic tail failure'));
    void tail.catch(() => undefined);
    const ttsMp3 = vi.fn()
      .mockResolvedValueOnce({ mp3: Buffer.alloc(1_024), tail })
      .mockResolvedValueOnce({ mp3: Buffer.alloc(2_048) });
    const deps = fakeDeps({ ttsMp3 });
    const current = session();
    prewarmSpeech(deps, current, 'turn_prewarm_tail', ['A synthetic game line.']);
    const playback = createSentencePlayback(deps, asWs(fakeSocket()), current, 'turn_prewarm_tail', Date.now());
    playback.push('A synthetic game line.');
    const finished = playback.finish();
    await vi.runAllTimersAsync();
    const result = await finished;
    expect(ttsMp3).toHaveBeenCalledTimes(2);
    expect(result.cut).toBeNull();
    expect(result.heardChars).toBe('A synthetic game line.'.length);
  });

  it('finishes cancellation while a prewarmed head waits for its unresolved tail without retrying synthesis', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let releaseTail: (value: Buffer) => void = () => undefined;
    const tail = new Promise<Buffer>((resolve) => { releaseTail = resolve; });
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024), tail });
    const deps = fakeDeps({ ttsMp3 });
    const current = session();
    const socket = fakeSocket();
    prewarmSpeech(deps, current, 'turn_prewarm_abort', ['A synthetic game line.']);
    const playback = createSentencePlayback(deps, asWs(socket), current, 'turn_prewarm_abort', Date.now(), controller.signal);
    playback.push('A synthetic game line.');
    const finished = playback.finish();
    let settled = false;
    void finished.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.runAllTimersAsync();
      expect(settled).toBe(false);
      expect(ttsMp3).toHaveBeenCalledTimes(1);
      controller.abort();
      await vi.runAllTimersAsync();
      expect(settled).toBe(true);
      expect(ttsMp3).toHaveBeenCalledTimes(1);
      expect(sentAudio(socket)).toBe(0);
    } finally {
      releaseTail(Buffer.alloc(1_024));
      await vi.runAllTimersAsync();
      await finished;
    }
  });

});

describe('a fallback reply is synthesized once', () => {
  it('a second finish() does not send the fallback text to TTS again', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024) });
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), session(), 'turn_fallback_once', Date.now());
    playback.fallback('A fenced reply.');
    await playback.finish();
    await playback.finish();
    expect(ttsMp3).toHaveBeenCalledTimes(1);
  });
});
