// #999 item 2: one bounded ws.downlink span per reply. A socket send is not
// device receipt or playback; the span says how far the server got and why.
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordObservationMetrics, traceSpan } from '@bob/ai';
import { MP3_16K_MONO_FORMAT } from '../../src/voice/protocol.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import { flushDownlink } from '../../src/voice/turn/downlink.ts';
import { BACKPRESSURE_WATERMARK_BYTES, newPacerState, streamFrames } from '../../src/voice/turn/pacing.ts';
import { createSentencePlayback, streamPlayback } from '../../src/voice/turn/playback.ts';
import type { TurnDeps } from '../../src/voice/turn/deps.ts';

vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, fn: () => unknown) => fn()),
  recordObservationMetrics: vi.fn(),
}));
afterEach(() => { vi.clearAllMocks(); });

type FakeSocket = { readyState: number; bufferedAmount: number; send: ReturnType<typeof vi.fn> };
const fakeSocket = (): FakeSocket => ({ readyState: 1, bufferedAmount: 0, send: vi.fn() });
const asWs = (socket: FakeSocket): WebSocket => socket as unknown as WebSocket;
const frames = (count: number, bytes = 100): Buffer[] => Array.from({ length: count }, () => Buffer.alloc(bytes));

function mp3Session(): ReturnType<typeof createSession> {
  const session = createSession();
  session.formatId = MP3_16K_MONO_FORMAT;
  session.turnRef = 'turn_down01';
  return session;
}

function downlinkCalls(): Array<{ outcome: unknown; metrics: Record<string, number> }> {
  const spans = vi.mocked(traceSpan).mock.calls.filter(([name]) => name === 'ws.downlink');
  const metrics = vi.mocked(recordObservationMetrics).mock.calls
    .map(([list]) => Object.fromEntries(list.map((metric) => [metric.name, metric.value])))
    .filter((record) => 'ws.downlink.frames' in record);
  return spans.map(([, attrs], index) => ({ outcome: (attrs as { metadata?: { outcome?: unknown } }).metadata?.outcome, metrics: metrics[index] ?? {} }));
}

describe('ws.downlink span', () => {
  it('reports a completed reply: frames, bytes and the time paced', async () => {
    const session = mp3Session();
    const pacer = newPacerState();
    await streamFrames(asWs(fakeSocket()), session, frames(3), 0, null, undefined, undefined, pacer);
    await flushDownlink(session, pacer);
    expect(downlinkCalls()).toEqual([{ outcome: 'completed', metrics: expect.objectContaining({ 'ws.downlink.frames': 3, 'ws.downlink.bytes': 300 }) }]);
  });

  it('a cancel mid-stream is cancelled, with the frames that did go out', async () => {
    const session = mp3Session();
    const pacer = newPacerState();
    const abort = new AbortController();
    const socket = fakeSocket();
    socket.send.mockImplementation(() => { if (socket.send.mock.calls.length === 2) abort.abort(); });
    await streamFrames(asWs(socket), session, frames(5), 0, null, abort.signal, undefined, pacer);
    await flushDownlink(session, pacer);
    expect(downlinkCalls()).toEqual([{ outcome: 'cancelled', metrics: expect.objectContaining({ 'ws.downlink.frames': 2 }) }]);
  });

  it('a socket that closes under the stream is socket_closed', async () => {
    const session = mp3Session();
    const pacer = newPacerState();
    const socket = fakeSocket();
    socket.send.mockImplementation(() => { socket.readyState = 3; });
    await streamFrames(asWs(socket), session, frames(4), 0, null, undefined, undefined, pacer);
    await flushDownlink(session, pacer);
    expect(downlinkCalls()).toEqual([{ outcome: 'socket_closed', metrics: expect.objectContaining({ 'ws.downlink.frames': 1 }) }]);
  });

  it('backpressure wait is counted and the held frame is still sent once pressure clears', async () => {
    const session = mp3Session();
    const pacer = newPacerState();
    const socket = fakeSocket();
    socket.bufferedAmount = BACKPRESSURE_WATERMARK_BYTES + 1;
    setTimeout(() => { socket.bufferedAmount = 0; }, 120);
    await streamFrames(asWs(socket), session, frames(2), 0, null, undefined, undefined, pacer);
    await flushDownlink(session, pacer);
    expect(socket.send).toHaveBeenCalledTimes(2);
    const [call] = downlinkCalls();
    expect(call!.outcome).toBe('completed');
    expect(call!.metrics['ws.downlink.backpressure_wait_ms']).toBeGreaterThanOrEqual(100);
  });

  it('exports nothing for a reply that never sent or waited', async () => {
    await flushDownlink(mp3Session(), newPacerState());
    expect(downlinkCalls()).toEqual([]);
  });
});

function fakeDeps(over: Partial<TurnDeps>): TurnDeps {
  return { deviceSessions: { flushPending: vi.fn() }, ...over } as unknown as TurnDeps;
}

describe('one ws.downlink span per reply', () => {
  it('batch MP3 playback exports exactly one', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(2_048) });
    await streamPlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session(), 'Hello there.', 'turn_down01', Date.now());
    expect(downlinkCalls()).toHaveLength(1);
  });

  it('says "the link is in the chat" once in a reply, however many pieces are only a link (#1423)', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024) });
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session(), 'turn_down01', Date.now());
    playback.push('https://a.example. https://b.example. All done. ');
    await playback.finish();
    expect(ttsMp3.mock.calls.map(([text]) => text)).toEqual(['The link is in the chat.', 'All done.']);
  });

  it('a streamed reply of two sentences exports exactly one', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024) });
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session(), 'turn_down01', Date.now());
    playback.push('First one. Second one. ');
    await playback.finish();
    expect(ttsMp3).toHaveBeenCalledTimes(2);
    expect(downlinkCalls()).toHaveLength(1);
    expect(downlinkCalls()[0]!.outcome).toBe('completed');
  });

  it('a streamed reply cancelled between sentences is cancelled, not completed', async () => {
    const abort = new AbortController();
    let calls = 0;
    const ttsMp3 = vi.fn(async () => {
      calls += 1;
      if (calls === 2) abort.abort();
      return { mp3: Buffer.alloc(1_024) };
    });
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session(), 'turn_down01', Date.now(), abort.signal);
    playback.push('First one. Second one. ');
    await playback.finish();
    expect(downlinkCalls().map((call) => call.outcome)).toEqual(['cancelled']);
  });

  it('a streamed reply cut by a TTS failure is cut', async () => {
    const ttsMp3 = vi.fn()
      .mockResolvedValueOnce({ mp3: Buffer.alloc(1_024) })
      .mockRejectedValueOnce(new Error('provider down'));
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session(), 'turn_down01', Date.now());
    playback.push('First one. Second one. ');
    await playback.finish();
    expect(downlinkCalls().map((call) => call.outcome)).toEqual(['cut']);
  });
});
