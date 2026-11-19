/**
 * #898: createSentencePlayback synthesizes up to TTS_AHEAD (2) sentences at
 * once instead of one at a time, while playback itself stays in enqueue order.
 */
import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { MP3_16K_MONO_FORMAT } from '../../src/voice/protocol.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import type { TurnDeps } from '../../src/voice/turn/deps.ts';
import { createSentencePlayback, prewarmSpeech, streamPlayback, type SentencePlaybackResult } from '../../src/voice/turn/playback.ts';
import { setJournalSink } from '../../src/platform/logger.ts';

vi.mock('@bob/ai', async (orig) => ({
  ...(await orig<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, run) => run()),
}));

type FakeSocket = { readyState: number; bufferedAmount: number; send: ReturnType<typeof vi.fn> };
const fakeSocket = (): FakeSocket => ({ readyState: 1, bufferedAmount: 0, send: vi.fn() });
const asWs = (socket: FakeSocket): WebSocket => socket as unknown as WebSocket;
/** The raw (non-JSON) audio_down frames a fake socket received, in order. */
const binaryFrames = (socket: FakeSocket): Buffer[] =>
  socket.send.mock.calls.flatMap(([data]) => (typeof data === 'string' ? [] : [data as Buffer]));

function fakeDeps(ttsMp3: TurnDeps['ttsMp3']): TurnDeps {
  const unexpected = (name: string) => (): never => { throw new Error(`unexpected deps.${name}`); };
  return {
    getDb: unexpected('getDb') as TurnDeps['getDb'],
    deviceSessions: unexpected('deviceSessions') as unknown as TurnDeps['deviceSessions'],
    timersChanged: unexpected('timersChanged') as TurnDeps['timersChanged'],
    embedder: unexpected('embedder') as TurnDeps['embedder'],
    stt: unexpected('stt') as TurnDeps['stt'],
    ttsPcm: unexpected('ttsPcm') as TurnDeps['ttsPcm'],
    ttsMp3,
    agent: unexpected('agent') as unknown as TurnDeps['agent'],
    accountEvents: unexpected('accountEvents') as TurnDeps['accountEvents'],
  };
}

function mp3Session(): ReturnType<typeof createSession> {
  const session = createSession();
  session.formatId = MP3_16K_MONO_FORMAT;
  return session;
}

/** A promise plus the functions that settle it, for a controllable TTS call. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Drains the microtask queue (every already-queued promise reaction) without
 *  a real timer, so a negative check ("nothing happened yet") is deterministic
 *  instead of guessing how many milliseconds is enough. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('createSentencePlayback: TTS lookahead (#898)', () => {
  it('starts synthesizing the 2nd sentence before the 1st resolves, and makes the 3rd wait for a free slot', async () => {
    const calls: string[] = [];
    const pending: Array<(value: { mp3: Buffer }) => void> = [];
    const ttsMp3 = vi.fn((text: string) => {
      calls.push(text);
      const d = deferred<{ mp3: Buffer }>();
      pending.push(d.resolve);
      return d.promise;
    });
    const socket = fakeSocket();
    const playback = createSentencePlayback(fakeDeps(ttsMp3), asWs(socket), mp3Session(), 'turn_1', Date.now());

    playback.push('One. Two. Three. ');
    await vi.waitFor(() => expect(calls).toEqual(['One.', 'Two.']));

    pending[0]!({ mp3: Buffer.alloc(80) });
    await vi.waitFor(() => expect(calls).toEqual(['One.', 'Two.', 'Three.']));

    pending[1]!({ mp3: Buffer.alloc(80) });
    pending[2]!({ mp3: Buffer.alloc(80) });
    const result = await playback.finish();

    expect(result.sentences).toBe(3);
    expect(result.cut).toBeNull();
    expect(result.ttsMs).toHaveLength(3);
  });

  it('streams audio_down frames in enqueue order even when the 2nd sentence resolves before the 1st', async () => {
    const pending: Array<(value: { mp3: Buffer }) => void> = [];
    const ttsMp3 = vi.fn(() => {
      const d = deferred<{ mp3: Buffer }>();
      pending.push(d.resolve);
      return d.promise;
    });
    const socket = fakeSocket();
    const playback = createSentencePlayback(fakeDeps(ttsMp3), asWs(socket), mp3Session(), 'turn_1', Date.now());

    playback.push('One. Two. ');
    await vi.waitFor(() => expect(ttsMp3).toHaveBeenCalledTimes(2));

    // Sentence 2 resolves first; nothing should reach the socket yet because
    // play() is still waiting on sentence 1 in enqueue order.
    pending[1]!({ mp3: Buffer.alloc(80, 2) });
    await flushMicrotasks();
    expect(binaryFrames(socket)).toHaveLength(0);

    pending[0]!({ mp3: Buffer.alloc(80, 1) });
    await playback.finish();

    // Byte 20 is the first payload byte, past the 20-byte OLX2 frame header.
    const frames = binaryFrames(socket);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]![20]).toBe(1); // sentence 1's byte fill, played first
    expect(frames.at(-1)![20]).toBe(2); // sentence 2's byte fill, played last
  });

  it('sentence 1 failing while sentence 2 is still in flight cuts tts_failed, never plays sentence 2, and leaves no entry in ttsMs for the failure', async () => {
    const pending: Array<{ resolve: (value: { mp3: Buffer }) => void; reject: (error: unknown) => void }> = [];
    const ttsMp3 = vi.fn(() => {
      const d = deferred<{ mp3: Buffer }>();
      pending.push(d);
      return d.promise;
    });
    const socket = fakeSocket();
    const playback = createSentencePlayback(fakeDeps(ttsMp3), asWs(socket), mp3Session(), 'turn_1', Date.now());

    playback.push('One. Two. ');
    await vi.waitFor(() => expect(ttsMp3).toHaveBeenCalledTimes(2));

    pending[0]!.reject(new Error('tts provider down'));
    pending[1]!.resolve({ mp3: Buffer.alloc(80) }); // sentence 2's synthesis still completes in the background
    const result = await playback.finish();

    expect(result.cut).toBe('tts_failed');
    expect(result.sentences).toBe(0); // sentence 2's audio was never played
    expect(binaryFrames(socket)).toHaveLength(0);
    // Exactly 1 entry: sentence 2's completed synthesis. The old bug reserved
    // a slot for sentence 1 too, leaving a spurious 0 and a length of 2.
    expect(result.ttsMs).toHaveLength(1);
  });

  it('an abort stops a queued sentence from ever starting its TTS call', async () => {
    const calls: string[] = [];
    const ttsMp3 = vi.fn((text: string) => {
      calls.push(text);
      return new Promise<{ mp3: Buffer }>(() => undefined);
    });
    const socket = fakeSocket();
    const controller = new AbortController();
    const playback = createSentencePlayback(fakeDeps(ttsMp3), asWs(socket), mp3Session(), 'turn_1', Date.now(), controller.signal);

    playback.push('One. Two. Three. ');
    await vi.waitFor(() => expect(calls).toEqual(['One.', 'Two.']));

    controller.abort();
    const result = await playback.finish();

    expect(calls).toEqual(['One.', 'Two.']); // 'Three.' never started
    expect(result.started).toBe(false);
  });
});

/** Plays `reply` as one clause, the way a game reply is spoken; returns the result and its tts completed journal line. */
async function playClause(
  ttsMp3: TurnDeps['ttsMp3'], session: ReturnType<typeof createSession>, turnRef: string, reply: string,
): Promise<{ result: SentencePlaybackResult; completed: Record<string, unknown> | undefined }> {
  const lines: string[] = [];
  setJournalSink((line) => lines.push(line));
  try {
    const playback = createSentencePlayback(fakeDeps(ttsMp3), asWs(fakeSocket()), session, turnRef, Date.now());
    playback.push(reply);
    const result = await playback.finish();
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    return { result, completed: entries.find((entry) => entry.event === 'v2.turn_stage_tts_completed') };
  } finally {
    setJournalSink(null);
  }
}

describe('first clause TTS split (#1387)', () => {
  const timing = { headers_ms: 410.4, last_byte_ms: 520.6, decode_ms: 2.2, encode_ms: 40.5 };

  it('journals the four rounded split fields for the first clause', async () => {
    const ttsMp3 = vi.fn(async (_text: string) => ({ mp3: Buffer.alloc(80), timing }));
    const { completed } = await playClause(ttsMp3, mp3Session(), 'turn_1', 'Nice one!');
    expect(completed).toMatchObject({ tts_headers_ms: 410, tts_body_ms: 110, tts_decode_ms: 2, tts_encode_ms: 41 });
  });

  it('takes nothing from a later clause, and nothing when the first has no timing', async () => {
    const ttsMp3 = vi.fn(async (text: string) => (text.startsWith('First') ? { mp3: Buffer.alloc(80) } : { mp3: Buffer.alloc(80), timing }));
    const { completed } = await playClause(ttsMp3, mp3Session(), 'turn_1', 'First clause is here. Second clause is here.');
    expect(ttsMp3).toHaveBeenCalledTimes(2);
    for (const key of ['tts_headers_ms', 'tts_body_ms', 'tts_decode_ms', 'tts_encode_ms']) expect(completed).not.toHaveProperty(key);
  });

  it('journals the parse time from the last body byte to the SDK resolving', async () => {
    const ttsMp3 = vi.fn(async (_text: string) => ({ mp3: Buffer.alloc(80), timing: { ...timing, done_ms: 530.4 } }));
    const { completed } = await playClause(ttsMp3, mp3Session(), 'turn_1', 'Nice one!');
    expect(completed).toMatchObject({ tts_parse_ms: 10 });
  });

  it('a prewarm hit for the first clause journals no split: its call ran while the model was thinking', async () => {
    const ttsMp3 = vi.fn(async (_text: string) => ({ mp3: Buffer.alloc(80), timing }));
    const session = mp3Session();
    prewarmSpeech(fakeDeps(ttsMp3), session, 'turn_1', ['Nice one!']);
    const { result, completed } = await playClause(ttsMp3, session, 'turn_1', 'Nice one!');
    expect(result.started).toBe(true);
    expect(completed).toMatchObject({ prewarm_hits: 1 });
    for (const key of ['tts_headers_ms', 'tts_body_ms', 'tts_decode_ms', 'tts_encode_ms', 'tts_parse_ms']) expect(completed).not.toHaveProperty(key);
  });

  it('a finished MP3 reply through streamPlayback journals its first clause split', async () => {
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    try {
      const ttsMp3 = vi.fn(async (_text: string) => ({ mp3: Buffer.alloc(80), timing }));
      await streamPlayback(fakeDeps(ttsMp3), asWs(fakeSocket()), mp3Session(), 'Nice one!', 'turn_1', Date.now());
      const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const completed = entries.find((entry) => entry.event === 'v2.turn_stage_tts_completed');
      expect(completed).toMatchObject({ tts_headers_ms: 410, tts_body_ms: 110, tts_decode_ms: 2, tts_encode_ms: 41 });
    } finally {
      setJournalSink(null);
    }
  });
});

describe('prewarmSpeech: a previewed game line synthesizes while the model runs', () => {
  it('the reply that speaks a prewarmed line reuses its call: one TTS call, one hit', async () => {
    const ttsMp3 = vi.fn(async (_text: string) => ({ mp3: Buffer.alloc(80) }));
    const session = mp3Session();
    prewarmSpeech(fakeDeps(ttsMp3), session, 'turn_1', ['Nice one!', null]);
    expect(ttsMp3.mock.calls.map(([text]) => text)).toEqual(['Nice one!']);

    const { result, completed } = await playClause(ttsMp3, session, 'turn_1', 'Nice one!');

    expect(result.started).toBe(true);
    expect(ttsMp3.mock.calls.map(([text]) => text)).toEqual(['Nice one!']);
    expect(completed).toMatchObject({ prewarm_hits: 1, prewarm_lines: 1 });
  });

  it('a reply that speaks other words makes its own call, and the prewarm goes unused', async () => {
    const ttsMp3 = vi.fn(async (_text: string) => ({ mp3: Buffer.alloc(80) }));
    const session = mp3Session();
    prewarmSpeech(fakeDeps(ttsMp3), session, 'turn_1', ['Nice one!']);

    const { result, completed } = await playClause(ttsMp3, session, 'turn_1', 'Something else.');

    expect(result.started).toBe(true);
    expect(ttsMp3.mock.calls.map(([text]) => text)).toEqual(['Nice one!', 'Something else.']);
    expect(completed).toMatchObject({ prewarm_hits: 0, prewarm_lines: 1 });
  });

  it('a rejected prewarm is not used: the reply calls TTS again and still plays', async () => {
    let calls = 0;
    const ttsMp3 = vi.fn(async (_text: string) => {
      calls += 1;
      if (calls === 1) throw new Error('tts provider down');
      return { mp3: Buffer.alloc(80) };
    });
    const session = mp3Session();
    prewarmSpeech(fakeDeps(ttsMp3), session, 'turn_1', ['Nice one!']);

    const { result, completed } = await playClause(ttsMp3, session, 'turn_1', 'Nice one!');

    expect(result.started).toBe(true);
    expect(result.cut).toBeNull();
    expect(ttsMp3.mock.calls).toHaveLength(2);
    expect(completed).toMatchObject({ prewarm_hits: 0, prewarm_lines: 1 });
  });

  it('a prewarm for one turn is not used by another turn', async () => {
    const ttsMp3 = vi.fn(async (_text: string) => ({ mp3: Buffer.alloc(80) }));
    const session = mp3Session();
    prewarmSpeech(fakeDeps(ttsMp3), session, 'turn_a', ['Nice one!']);

    const { result, completed } = await playClause(ttsMp3, session, 'turn_b', 'Nice one!');

    expect(result.started).toBe(true);
    expect(ttsMp3.mock.calls.map(([text]) => text)).toEqual(['Nice one!', 'Nice one!']);
    expect(completed).toBeDefined();
    expect(completed).not.toHaveProperty('prewarm_hits');
  });

  it('an aborted prewarm leaves the map, so the same turn prewarms the line again and the reply uses it', async () => {
    let calls = 0;
    const ttsMp3 = vi.fn(async (_text: string) => {
      calls += 1;
      if (calls === 1) return new Promise<never>(() => undefined); // the speculative run's call, cut off by its abort
      return { mp3: Buffer.alloc(80) };
    });
    const session = mp3Session();
    const controller = new AbortController();
    prewarmSpeech(fakeDeps(ttsMp3), session, 'turn_1', ['Nice one!'], controller.signal);
    controller.abort();
    await flushMicrotasks();

    prewarmSpeech(fakeDeps(ttsMp3), session, 'turn_1', ['Nice one!']);
    expect(ttsMp3.mock.calls.map(([text]) => text)).toEqual(['Nice one!', 'Nice one!']);

    const { result, completed } = await playClause(ttsMp3, session, 'turn_1', 'Nice one!');

    expect(result.started).toBe(true);
    expect(ttsMp3.mock.calls).toHaveLength(2);
    expect(completed).toMatchObject({ prewarm_hits: 1, prewarm_lines: 1 });
  });

  it('a cancel while a prewarm is pending never starts a fresh TTS call when that prewarm then fails', async () => {
    const pending = deferred<{ mp3: Buffer }>();
    const ttsMp3 = vi.fn((_text: string) => pending.promise);
    const session = mp3Session();
    prewarmSpeech(fakeDeps(ttsMp3), session, 'turn_1', ['Nice one!']);
    const controller = new AbortController();
    const playback = createSentencePlayback(fakeDeps(ttsMp3), asWs(fakeSocket()), session, 'turn_1', Date.now(), controller.signal);
    playback.push('Nice one! '); // a sentence end, so the piece is queued (and its prewarm taken) before the cancel
    await flushMicrotasks();

    controller.abort();
    pending.reject(new Error('tts provider down'));
    await playback.finish();

    expect(ttsMp3).toHaveBeenCalledTimes(1);
  });

  it('lines with nothing speakable start no prewarm, so the turn journals no prewarm counts', async () => {
    const ttsMp3 = vi.fn(async (_text: string) => ({ mp3: Buffer.alloc(80) }));
    const session = mp3Session();
    prewarmSpeech(fakeDeps(ttsMp3), session, 'turn_1', [null, '']);

    const { result, completed } = await playClause(ttsMp3, session, 'turn_1', 'Something else.');

    expect(result.started).toBe(true);
    expect(completed).toBeDefined();
    expect(completed).not.toHaveProperty('prewarm_hits');
    expect(completed).not.toHaveProperty('prewarm_lines');
  });

  it('an already-aborted signal starts no prewarm', () => {
    const ttsMp3 = vi.fn(async (_text: string) => ({ mp3: Buffer.alloc(80) }));
    const controller = new AbortController();
    controller.abort();
    prewarmSpeech(fakeDeps(ttsMp3), mp3Session(), 'turn_1', ['Nice one!'], controller.signal);
    expect(ttsMp3).not.toHaveBeenCalled();
  });

  it('a previewed line of two sentences prewarms its first piece, and the reply hits that piece only', async () => {
    const line = 'Great job, you moved that very fast! Now stand still for the next one.';
    const ttsMp3 = vi.fn(async (_text: string) => ({ mp3: Buffer.alloc(80) }));
    const session = mp3Session();
    prewarmSpeech(fakeDeps(ttsMp3), session, 'turn_1', [line]);

    const { completed } = await playClause(ttsMp3, session, 'turn_1', line);

    expect(ttsMp3.mock.calls.map(([text]) => text.trim())).toEqual([
      'Great job, you moved that very fast!', 'Now stand still for the next one.',
    ]);
    expect(completed).toMatchObject({ prewarm_hits: 1, prewarm_lines: 1 });
  });

  it('a PCM session prewarms nothing', () => {
    const ttsMp3 = vi.fn(async (_text: string) => ({ mp3: Buffer.alloc(80) }));
    prewarmSpeech(fakeDeps(ttsMp3), createSession(), 'turn_1', ['Nice one!']);
    expect(ttsMp3).not.toHaveBeenCalled();
  });
});
