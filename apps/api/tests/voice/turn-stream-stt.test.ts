/**
 * #1331 item 2: transcribe while the user talks (BOB_STT_STREAMING=1).
 * Driven through an injected fake stream transcriber: no network, no database.
 * The stream opens at turn_start, every accepted audio_up payload is pushed,
 * and turn_end takes its final transcript or falls back to the batch STT.
 */
import type { WebSocket } from 'ws';
import type { TranscriptStream } from '@bob/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_HEADER_BYTES, V2_VERSION, type ClientControlDto, type SessionDto } from '../../src/voice/protocol.ts';
import { createSession, type SessionDeps } from '../../src/voice/session-handlers.ts';
import { handleBinary, handleControl } from '../../src/voice/session.ts';
import { rememberSocketCaps } from '../../src/voice/device-caps.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import type { TurnDeps } from '../../src/voice/turn/deps.ts';
import { TurnCancelledError } from '../../src/voice/turn/abort.ts';
import { transcribeTurn } from '../../src/voice/turn/transcribe.ts';
import {
  STREAM_STT_FINAL_DEADLINE_MS, abortSttStream, finishSttStream, openSttStream, pushSttStream, serverEndedTurn,
  watchSttHypothesis, type EndOfTurnEvent,
} from '../../src/voice/turn/stream-stt.ts';
import { selectSpeech, speechConfigFromEnv, speechTurnFns } from '../../src/voice/speech-adapters.ts';
import type { SpeechPort } from '../../src/voice/speech-port.ts';

/** A fake stream: `setupMs` is what the adapter reports, `finish` is what the test scripts. */
function fakeStream(over: Partial<TranscriptStream> & { setupMs?: number } = {}): TranscriptStream & { pushed: Buffer[]; hypothesis: string } {
  const pushed: Buffer[] = [];
  return {
    pushed,
    model: 'test/stream-1',
    setupMs: 40,
    stats: { finals: 1, partials: 0, bytesRead: 320 },
    hypothesis: '',
    push: vi.fn((pcm: Uint8Array) => { pushed.push(Buffer.from(pcm)); }),
    finish: vi.fn(async () => ({ text: 'turn the lights on', model: 'test/stream-1' })),
    abort: vi.fn(),
    ...over,
  };
}

function fakeDeps(stt = vi.fn(async () => ({ text: 'batch words', model: 'test/batch-1', seconds: 1 }))): TurnDeps {
  return { stt } as unknown as TurnDeps;
}

let journalLines: Array<Record<string, unknown>>;
const sttCompleted = (): Record<string, unknown> | undefined =>
  journalLines.find((line) => line.event === 'v2.turn_stage_stt_completed');

beforeEach(() => {
  journalLines = [];
  setJournalSink((line) => journalLines.push(JSON.parse(line)));
});
afterEach(() => {
  setJournalSink(null);
  vi.useRealTimers();
});

describe('transcribeTurn with a stream', () => {
  it('uses the streamed text and never calls the batch STT', async () => {
    const session = createSession();
    const stream = fakeStream();
    openSttStream(session, () => stream);
    const deps = fakeDeps();
    expect(await transcribeTurn(deps, session, Buffer.alloc(32_000), 'turn_s1')).toBe('turn the lights on');
    expect(deps.stt).not.toHaveBeenCalled();
    expect(sttCompleted()).toMatchObject({
      streamed: true, fallback_reason: 'none', model: 'test/stream-1', stream_setup_ms: 40,
    });
    expect(typeof sttCompleted()?.final_after_end_ms).toBe('number');
    expect(JSON.stringify(journalLines)).not.toContain('lights');
  });

  it('falls back to the batch STT when the stream errors', async () => {
    const session = createSession();
    openSttStream(session, () => fakeStream({ finish: vi.fn(async () => { throw new Error('socket closed'); }) }));
    const deps = fakeDeps();
    const pcm = Buffer.alloc(32_000, 1);
    expect(await transcribeTurn(deps, session, pcm, 'turn_s2')).toBe('batch words');
    expect(deps.stt).toHaveBeenCalledWith(pcm);
    expect(sttCompleted()).toMatchObject({ streamed: false, fallback_reason: 'error', model: 'test/batch-1', stream_setup_ms: 40 });
  });

  it('falls back to the batch STT when no final arrives by the deadline, and aborts the stream', async () => {
    vi.useFakeTimers();
    const session = createSession();
    const stream = fakeStream({ finish: vi.fn(() => new Promise<never>(() => undefined)) });
    openSttStream(session, () => stream);
    const deps = fakeDeps();
    const pending = transcribeTurn(deps, session, Buffer.alloc(32_000), 'turn_s3');
    await vi.advanceTimersByTimeAsync(STREAM_STT_FINAL_DEADLINE_MS - 1);
    expect(deps.stt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('batch words');
    expect(stream.abort).toHaveBeenCalled();
    expect(sttCompleted()).toMatchObject({ streamed: false, fallback_reason: 'deadline' });
    expect(STREAM_STT_FINAL_DEADLINE_MS).toBe(1500);
  });

  it('reports not_ready when the provider never started reading by the deadline', async () => {
    vi.useFakeTimers();
    const session = createSession();
    openSttStream(session, () => fakeStream({ setupMs: undefined, finish: vi.fn(() => new Promise<never>(() => undefined)) }));
    const pending = transcribeTurn(fakeDeps(), session, Buffer.alloc(32_000), 'turn_s4');
    await vi.advanceTimersByTimeAsync(STREAM_STT_FINAL_DEADLINE_MS);
    expect(await pending).toBe('batch words');
    expect(sttCompleted()).toMatchObject({ streamed: false, fallback_reason: 'not_ready' });
    expect(sttCompleted()).not.toHaveProperty('stream_setup_ms');
  });

  it('falls back when the stream returns an empty transcript for audio', async () => {
    const session = createSession();
    openSttStream(session, () => fakeStream({ finish: vi.fn(async () => ({ text: '  ', model: 'test/stream-1' })) }));
    expect(await transcribeTurn(fakeDeps(), session, Buffer.alloc(32_000), 'turn_s5')).toBe('batch words');
    expect(sttCompleted()).toMatchObject({ streamed: false, fallback_reason: 'empty' });
  });

  it('uses the latest partial when the final is blank, and skips the batch STT (FR-027)', async () => {
    const session = createSession();
    const stream = fakeStream({
      stats: { finals: 1, partials: 2, bytesRead: 640 },
      finish: vi.fn(async () => ({ text: '  ', model: 'test/stream-1' })),
    });
    openSttStream(session, () => stream);
    stream.hypothesis = 'set a timer';
    pushSttStream(session, new Uint8Array(320));
    stream.hypothesis = 'set a timer for five minutes';
    pushSttStream(session, new Uint8Array(320));
    const deps = fakeDeps();
    expect(await transcribeTurn(deps, session, Buffer.alloc(32_000), 'turn_s5p')).toBe('set a timer for five minutes');
    expect(deps.stt).not.toHaveBeenCalled();
    expect(sttCompleted()).toMatchObject({
      streamed: true, fallback_reason: 'none', from_partial: true, model: 'test/stream-1', stream_partials: 2,
    });
    expect(JSON.stringify(journalLines)).not.toContain('timer');
  });

  it('falls back with reason error when the stream could not be opened', async () => {
    const session = createSession();
    openSttStream(session, () => { throw new Error('unsupported'); });
    expect(await transcribeTurn(fakeDeps(), session, Buffer.alloc(32_000), 'turn_s6')).toBe('batch words');
    expect(sttCompleted()).toMatchObject({ streamed: false, fallback_reason: 'error' });
  });

  it('journals disabled and runs the batch STT when no stream was opened', async () => {
    const deps = fakeDeps();
    expect(await transcribeTurn(deps, createSession(), Buffer.alloc(32_000), 'turn_s7')).toBe('batch words');
    expect(deps.stt).toHaveBeenCalledTimes(1);
    expect(sttCompleted()).toMatchObject({ streamed: false, fallback_reason: 'disabled', model: 'test/batch-1' });
  });

  it('aborts the stream when the turn is cancelled while waiting for the final', async () => {
    const session = createSession();
    const stream = fakeStream({ finish: vi.fn(() => new Promise<never>(() => undefined)) });
    openSttStream(session, () => stream);
    const controller = new AbortController();
    const deps = fakeDeps();
    const pending = transcribeTurn(deps, session, Buffer.alloc(32_000), 'turn_s8', controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(TurnCancelledError);
    expect(stream.abort).toHaveBeenCalled();
    expect(deps.stt).not.toHaveBeenCalled();
  });
});

describe('stream lifecycle on the device session', () => {
  type FakeSocket = { readyState: number; send: ReturnType<typeof vi.fn> };
  const control = (type: string, extra: Record<string, unknown> = {}): ClientControlDto =>
    ({ v: V2_VERSION, type, id: 'test_ctrl_000001', payload: {}, ...extra }) as unknown as ClientControlDto;
  function setup(opener?: () => TranscriptStream) {
    const socket: FakeSocket = { readyState: 1, send: vi.fn() };
    const session = createSession();
    session.stage = 'ready';
    const deps = {
      getDb: () => { throw new Error('unexpected getDb'); },
      deviceSessions: { flushPending: vi.fn() },
      ...(opener ? { turn: { sttStream: opener } } : {}),
    } as unknown as SessionDeps;
    const ws = socket as unknown as WebSocket;
    return { socket, ws, session, deps };
  }

  it('opens one stream at turn_start and pushes each accepted audio_up payload in order', async () => {
    const stream = fakeStream();
    const opener = vi.fn(() => stream);
    const { ws, session, deps } = setup(opener);
    await handleControl(deps, ws, session, control('turn_start', { turn_ref: 'turn_life_0001' }), vi.fn());
    expect(opener).toHaveBeenCalledTimes(1);
    handleBinary(deps, ws, session, uplinkFrame(0, 7));
    handleBinary(deps, ws, session, uplinkFrame(1, 9));
    expect(stream.pushed.map((chunk) => chunk[0])).toEqual([7, 9]);
    expect(stream.pushed.every((chunk) => chunk.length === 320)).toBe(true);
  });

  it('aborts the stream on cancel, and a new turn never leaves two streams open', async () => {
    const first = fakeStream();
    const second = fakeStream();
    const opener = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { ws, session, deps } = setup(opener);
    await handleControl(deps, ws, session, control('turn_start', { turn_ref: 'turn_life_0002' }), vi.fn());
    await handleControl(deps, ws, session, control('cancel'), vi.fn());
    expect(first.abort).toHaveBeenCalledTimes(1);
    await handleControl(deps, ws, session, control('turn_start', { turn_ref: 'turn_life_0003' }), vi.fn());
    expect(opener).toHaveBeenCalledTimes(2);
    // A turn_start while a stream is still open (no reset between) replaces it.
    openSttStream(session, () => fakeStream());
    expect(second.abort).toHaveBeenCalledTimes(1);
  });

  it('aborts the stream on disconnect and on cancel', async () => {
    const { ws, session, deps } = setup();
    const onDisconnect = fakeStream();
    openSttStream(session, () => onDisconnect);
    abortSttStream(session);
    expect(onDisconnect.abort).toHaveBeenCalledTimes(1);
    const onCancel = fakeStream();
    openSttStream(session, () => onCancel);
    await handleControl(deps, ws, session, control('cancel', {}), vi.fn());
    expect(onCancel.abort).toHaveBeenCalledTimes(1);
    pushSttStream(session, Buffer.alloc(2));
    expect(onCancel.push).not.toHaveBeenCalled();
  });

  it('never opens a stream when the flag is off', async () => {
    const { ws, session, deps } = setup();
    await handleControl(deps, ws, session, control('turn_start', { turn_ref: 'turn_life_0004' }), vi.fn());
    handleBinary(deps, ws, session, uplinkFrame(0, 1));
    await transcribeTurn(fakeDeps(), session, Buffer.alloc(32_000), 'turn_life_0004');
    expect(sttCompleted()).toMatchObject({ fallback_reason: 'disabled' });
  });
});

describe('stream counts on the stt journal (#1331)', () => {
  it('journals the stream counts and final_after_end_ms on a streamed turn', async () => {
    const session = createSession();
    openSttStream(session, () => fakeStream({ stats: { finals: 2, partials: 3, bytesRead: 640 } }));
    expect(await transcribeTurn(fakeDeps(), session, Buffer.alloc(32_000), 'turn_s9')).toBe('turn the lights on');
    expect(sttCompleted()).toMatchObject({ stream_finals: 2, stream_partials: 3, stream_bytes_read: 640 });
    expect(typeof sttCompleted()?.final_after_end_ms).toBe('number');
  });

  it('journals the counts and final_after_end_ms on a fallback once a final arrived', async () => {
    const session = createSession();
    openSttStream(session, () => fakeStream({
      stats: { finals: 1, partials: 0, bytesRead: 320 },
      finish: vi.fn(async () => ({ text: '  ', model: 'test/stream-1' })),
    }));
    expect(await transcribeTurn(fakeDeps(), session, Buffer.alloc(32_000), 'turn_s10')).toBe('batch words');
    expect(sttCompleted()).toMatchObject({ fallback_reason: 'empty', stream_finals: 1, stream_partials: 0, stream_bytes_read: 320 });
    expect(typeof sttCompleted()?.final_after_end_ms).toBe('number');
  });

  it('journals the counts but no final_after_end_ms on a fallback where no final arrived', async () => {
    const session = createSession();
    openSttStream(session, () => fakeStream({
      stats: { finals: 0, partials: 2, bytesRead: 960 },
      finish: vi.fn(async () => { throw new Error('socket closed'); }),
    }));
    expect(await transcribeTurn(fakeDeps(), session, Buffer.alloc(32_000), 'turn_s11')).toBe('batch words');
    expect(sttCompleted()).toMatchObject({ fallback_reason: 'error', stream_partials: 2, stream_bytes_read: 960 });
    expect(sttCompleted()).not.toHaveProperty('final_after_end_ms');
  });
});

describe('BOB_STT_STREAMING wiring', () => {
  const real = { openTranscriptStream: vi.fn() } as unknown as SpeechPort;

  it('is off unless BOB_STT_STREAMING=1, and never on stubbed STT', () => {
    expect(speechTurnFns(selectSpeech(speechConfigFromEnv(false, {}), real)).sttStream).toBeUndefined();
    expect(speechTurnFns(selectSpeech(speechConfigFromEnv(false, { BOB_STT_STREAMING: '0' }), real)).sttStream).toBeUndefined();
    expect(speechTurnFns(selectSpeech(speechConfigFromEnv(true, { BOB_STT_STREAMING: '1' }), real)).sttStream).toBeUndefined();
    expect(speechTurnFns(selectSpeech(speechConfigFromEnv(false, { BOB_STT_STREAMING: '1' }), real)).sttStream).toBeTypeOf('function');
  });
});

describe('watchSttHypothesis: the words so far start the memory recall', () => {
  it('fires once, on the first pushed frame whose hypothesis has four words or more', () => {
    const session = createSession();
    const stream = fakeStream();
    openSttStream(session, () => stream);
    const onStable = vi.fn();
    watchSttHypothesis(session, onStable);
    stream.hypothesis = 'what is my';
    pushSttStream(session, new Uint8Array(320));
    expect(onStable).not.toHaveBeenCalled();
    stream.hypothesis = 'what is my sister';
    pushSttStream(session, new Uint8Array(320));
    stream.hypothesis = 'what is my sister called';
    pushSttStream(session, new Uint8Array(320));
    expect(onStable).toHaveBeenCalledTimes(1);
    expect(onStable).toHaveBeenCalledWith('what is my sister');
  });

  it('never fires at turn_end (a recall started then is almost never ready), and an abort or a new stream drops it unfired', async () => {
    const session = createSession();
    const stream = fakeStream({ hypothesis: 'turn the lights on' });
    openSttStream(session, () => stream);
    const atEnd = vi.fn();
    watchSttHypothesis(session, atEnd);
    await finishSttStream(session);
    expect(atEnd).not.toHaveBeenCalled();

    const dropped = vi.fn();
    const next = fakeStream();
    openSttStream(session, () => next);
    watchSttHypothesis(session, dropped);
    abortSttStream(session);
    openSttStream(session, () => next);
    next.hypothesis = 'turn the lights on';
    pushSttStream(session, new Uint8Array(320));
    expect(dropped).not.toHaveBeenCalled();
  });
});

/** One 10 ms uplink frame of `fill` bytes, numbered `sequence`. */
function uplinkFrame(sequence: number, fill: number): Buffer {
  const frame = Buffer.alloc(AUDIO_HEADER_BYTES + 320, fill);
  frame.write('OLX2', 0, 'ascii');
  frame.writeUInt8(V2_VERSION, 4);
  frame.writeUInt8(1, 5);
  frame.writeUInt8(1, 6);
  frame.writeUInt8(1, 7);
  frame.writeUInt32BE(1, 8);
  frame.writeUInt32BE(sequence, 12);
  frame.writeUInt32BE(320, 16);
  return frame;
}

/** A 10 ms uplink frame of a 300 Hz sine at `amp` (0 = silence): the voice the detector hears. */
function sineFrame(sequence: number, amp: number): Buffer {
  const frame = uplinkFrame(sequence, 0);
  for (let i = 0; i < 160; i += 1) {
    const value = amp === 0 ? 0 : Math.round(amp * Math.sin((2 * Math.PI * 300 * (sequence * 160 + i)) / 16_000));
    frame.writeInt16LE(value, AUDIO_HEADER_BYTES + i * 2);
  }
  return frame;
}

describe('end of turn on the device session (PR3-EOT)', () => {
  type EotSocket = { readyState: number; send: ReturnType<typeof vi.fn> };
  const turnStart = (turnRef: string): ClientControlDto =>
    ({ v: V2_VERSION, type: 'turn_start', id: 'test_ctrl_000002', payload: {}, turn_ref: turnRef }) as unknown as ClientControlDto;
  const cancel = (): ClientControlDto => ({ v: V2_VERSION, type: 'cancel', id: 'test_ctrl_000003', payload: {} }) as unknown as ClientControlDto;

  /** A paired device session whose hello advertised `caps`; `events` collects onEndOfTurn calls. */
  function pairedTurn(caps: string[], events: Array<[EndOfTurnEvent, string]>) {
    const socket: EotSocket = { readyState: 1, send: vi.fn() };
    const ws = socket as unknown as WebSocket;
    rememberSocketCaps(ws, caps);
    const stream = fakeStream();
    const session = createSession();
    session.stage = 'ready';
    session.auth = { kind: 'legacy', userId: 'user_eot', deviceId: null };
    const turn = {
      sttStream: () => stream,
      onEndOfTurn: (_session: SessionDto, _turnRef: string, event: EndOfTurnEvent, hypothesis: string) => { events.push([event, hypothesis]); },
    };
    const deps = { getDb: () => { throw new Error('unexpected getDb'); }, deviceSessions: { flushPending: vi.fn() }, turn } as unknown as SessionDeps;
    return { socket, ws, session, deps, stream };
  }
  type Paired = ReturnType<typeof pairedTurn>;
  /** `ms` of audio, 100 frames a second, each frame carrying the hypothesis in force. */
  function speak(p: Paired, ms: number, amp: number, hypothesis: string): void {
    p.stream.hypothesis = hypothesis;
    for (let i = 0; i < ms / 10; i += 1) handleBinary(p.deps, p.ws, p.session, sineFrame(p.session.nextUplinkSeq, amp));
  }
  const endOfTurnSent = (p: Paired) => p.socket.send.mock.calls.map(([raw]) => String(raw)).filter((raw) => raw.includes('"end_of_turn"'));

  it('sends one end_of_turn with the turn_ref to a socket that advertised the cap, and journals no text', async () => {
    const p = pairedTurn(['end_of_turn'], []);
    await handleControl(p.deps, p.ws, p.session, turnStart('turn_eot_0001'), vi.fn());
    speak(p, 500, 3000, 'turn the lights on.');
    speak(p, 300, 0, 'turn the lights on.');
    expect(endOfTurnSent(p)).toHaveLength(1);
    const [sent = ''] = endOfTurnSent(p);
    expect(JSON.parse(sent)).toMatchObject({ type: 'end_of_turn', turn_ref: 'turn_eot_0001' });
    expect(journalLines.find((line) => line.event === 'v2.turn_end_of_turn')).toMatchObject({ turn_id: 'turn_eot_0001', sent: true, n: 1 });
    expect(JSON.stringify(journalLines)).not.toContain('lights');
  });

  it('sends nothing to a socket without the cap, and the journal says sent:false', async () => {
    const p = pairedTurn(['device_control'], []);
    await handleControl(p.deps, p.ws, p.session, turnStart('turn_eot_0002'), vi.fn());
    speak(p, 500, 3000, 'turn the lights on.');
    speak(p, 300, 0, 'turn the lights on.');
    expect(endOfTurnSent(p)).toHaveLength(0);
    expect(journalLines.find((line) => line.event === 'v2.turn_end_of_turn')).toMatchObject({ sent: false, n: 1 });
  });

  it('reaches onEndOfTurn with end, resume, end, then drop after a cancel', async () => {
    const events: Array<[EndOfTurnEvent, string]> = [];
    const p = pairedTurn(['end_of_turn'], events);
    await handleControl(p.deps, p.ws, p.session, turnStart('turn_eot_0004'), vi.fn());
    speak(p, 500, 3000, 'turn the lights on.');
    speak(p, 300, 0, 'turn the lights on.');
    speak(p, 200, 0, 'turn the lights on. Thanks.');
    await handleControl(p.deps, p.ws, p.session, cancel(), vi.fn());
    expect(events.map(([event]) => event)).toEqual(['end', 'resume', 'end', 'drop']);
    expect(endOfTurnSent(p)).toHaveLength(1);
    // Only the decision that sent the message says sent:true.
    expect(journalLines.filter((line) => line.event === 'v2.turn_end_of_turn').map((line) => line.sent)).toEqual([true, false]);
  });

  it('does not send drop when the stream finishes at turn_end', async () => {
    const events: Array<[EndOfTurnEvent, string]> = [];
    const p = pairedTurn(['end_of_turn'], events);
    await handleControl(p.deps, p.ws, p.session, turnStart('turn_eot_0005'), vi.fn());
    speak(p, 500, 3000, 'turn the lights on.');
    speak(p, 300, 0, 'turn the lights on.');
    await finishSttStream(p.session);
    expect(events.map(([event]) => event)).toEqual(['end']);
  });

  it('a throwing onEndOfTurn leaves the uplink working and journals the failure without text', async () => {
    const base = pairedTurn(['end_of_turn'], []);
    const deps = {
      ...base.deps,
      turn: { sttStream: () => base.stream, onEndOfTurn: () => { throw new Error('hook boom'); } },
    } as unknown as SessionDeps;
    const p = { ...base, deps };
    await handleControl(p.deps, p.ws, p.session, turnStart('turn_eot_0007'), vi.fn());
    speak(p, 500, 3000, 'turn the lights on.');
    speak(p, 300, 0, 'turn the lights on.');
    const before = p.session.nextUplinkSeq;
    speak(p, 100, 3000, 'turn the lights on.');
    expect(p.session.nextUplinkSeq).toBe(before + 10);
    const onTurnEnd = vi.fn();
    const turnEnd = { v: V2_VERSION, type: 'turn_end', id: 'test_ctrl_000004', payload: {}, turn_ref: 'turn_eot_0007', seq: p.session.nextUplinkSeq - 1 };
    await handleControl(p.deps, p.ws, p.session, turnEnd as unknown as ClientControlDto, onTurnEnd);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(endOfTurnSent(p)).toHaveLength(1);
    expect(journalLines.find((line) => line.event === 'v2.turn_end_of_turn_failed')).toMatchObject({
      turn_id: 'turn_eot_0007', stage: 'hook', error: 'Error',
    });
    expect(JSON.stringify(journalLines)).not.toContain('lights');
  });

  it('serverEndedTurn is true only where this server sent end_of_turn', async () => {
    const capped = pairedTurn(['end_of_turn'], []);
    const plain = pairedTurn(['device_control'], []);
    for (const p of [capped, plain]) {
      await handleControl(p.deps, p.ws, p.session, turnStart('turn_eot_0006'), vi.fn());
      speak(p, 500, 3000, 'turn the lights on.');
      speak(p, 300, 0, 'turn the lights on.');
    }
    expect(serverEndedTurn(capped.session, 'turn_eot_0006')).toBe(true);
    expect(serverEndedTurn(plain.session, 'turn_eot_0006')).toBe(false);
  });
});
