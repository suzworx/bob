/**
 * #1004: the device's late per-turn timing summary. Fake clocks drive the
 * correlation window; the real handleControl drives negotiation and the
 * old/new server x firmware matrix. A summary is never answered (an error
 * mid-turn would fail the device's next turn), and its export is a detached
 * span joined by session + turn id, never a rewrite of the turn's root.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { recordObservationMetrics, traceSpan } from '@bob/ai';
import { createSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { rememberSocketCaps } from '../../src/voice/device-caps.ts';
import { ClientControlDtoSchema, type ClientControlDto, type TurnTimingDto } from '../../src/voice/protocol.ts';
import {
  acceptTurnTiming, EXPECTED_CAPACITY, expectTurnTiming, milestonesOrdered, RUNNING_TTL_MS, SETTLED_TTL_MS, settleTurnTiming,
} from '../../src/voice/turn/device-timing.ts';
import { recordServerEndOfTurn, recordTurnEnd } from '../../src/voice/turn/stream-stt.ts';
import { createAppDeps } from '../../src/app-deps.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { recordBoard } from '../../src/voice/session-board.ts';

vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()),
  traceSpan: vi.fn((_name: string, _attrs: unknown, run: () => unknown) => Promise.resolve(run())),
  recordObservationMetrics: vi.fn(),
}));

const FIXTURES = resolve(import.meta.dirname, '../../../cardputer/test/fixtures/wire');
const fixture = (name: string): TurnTimingDto =>
  ClientControlDtoSchema.parse(JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'))) as TurnTimingDto;
const REF = 'turn_123456_v2';
const drained = fixture('turn_timing');
const stopped = fixture('turn_timing_stopped');

interface FakeSocket { readyState: number; send: ReturnType<typeof vi.fn>; once: (event: string, fn: () => void) => void }
const makeSocket = (caps?: string[]): FakeSocket => {
  const socket: FakeSocket = { readyState: 1, send: vi.fn(), once: () => undefined };
  if (caps !== undefined) rememberSocketCaps(socket as unknown as WebSocket, caps);
  return socket;
};
const asSocket = (socket: FakeSocket): WebSocket => socket as unknown as WebSocket;
const timingSpans = (): unknown[][] => vi.mocked(traceSpan).mock.calls.filter((call) => call[0] === 'device-turn-timing');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('device turn timing: correlation window', () => {
  it('accepts one summary for an expected turn and exports it as a detached span on the turn id', async () => {
    const socket = makeSocket(['turn_timing']);
    const session = createSession();
    expectTurnTiming(asSocket(socket), session, REF, 'user_12345678');
    vi.advanceTimersByTime(90_000);
    settleTurnTiming(session, REF);
    vi.advanceTimersByTime(SETTLED_TTL_MS - 1);
    expect(acceptTurnTiming({ socket: asSocket(socket), session }, drained)).toBe('accepted');
    await Promise.resolve();
    expect(timingSpans()).toHaveLength(1);
    expect(timingSpans()[0]?.[1]).toMatchObject({ detached: true, traceName: 'device-turn' });
    const metrics = vi.mocked(recordObservationMetrics).mock.calls.flatMap((call) => call[0]);
    expect(metrics).toEqual(expect.arrayContaining([
      { name: 'device.turn.capture_end_ms', value: 3200 },
      { name: 'device.turn.speaker_submission_ms', value: 4200 },
      { name: 'device.turn.end_to_speaker_ms', value: 1000 },
      { name: 'device.turn.down_frames', value: 41 },
    ]));
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('journals activation_source, board and stop_to_speaker_ms (#1331 8a), never under the reserved source key', () => {
    const lines: Record<string, unknown>[] = [];
    setJournalSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
    try {
      const socket = makeSocket(['turn_timing']);
      const session = createSession();
      recordBoard(session, 'waveshare-s3-185c');
      expectTurnTiming(asSocket(socket), session, REF);
      expect(acceptTurnTiming({ socket: asSocket(socket), session }, drained)).toBe('accepted');
      const stoppedSession = createSession();
      expectTurnTiming(asSocket(socket), stoppedSession, REF);
      expect(acceptTurnTiming({ socket: asSocket(socket), session: stoppedSession }, stopped)).toBe('accepted');
    } finally {
      setJournalSink(null);
    }
    const timing = lines.filter((line) => line.event === 'v2.device_turn_timing');
    expect(timing).toHaveLength(2);
    expect(timing[0]).toMatchObject({ activation_source: 'wake', board: 'waveshare-s3-185c', stop_to_speaker_ms: 1000, source: 'api' });
    expect(timing[1]).toMatchObject({ activation_source: 'ptt', board: 'cardputer' });
    expect(timing[1]).not.toHaveProperty('stop_to_speaker_ms');
    const metadata = (timingSpans()[0]?.[1] as { metadata?: Record<string, unknown> }).metadata;
    expect(metadata).toMatchObject({ activation_source: 'wake', board: 'waveshare-s3-185c' });
  });

  it('journals the later firmware fields and speech_end_to_speaker_ms (your last word to Bob speaking)', () => {
    const lines: Record<string, unknown>[] = [];
    setJournalSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
    const { speech_end_ms: _speechEnd, uplink_backlog: _b, mic_fps: _f, tx_busy: _t, tx_busy_max_ms: _m, ...older } = drained.payload;
    try {
      const socket = makeSocket(['turn_timing']);
      for (const dto of [drained, stopped, { ...drained, payload: older }]) {
        const session = createSession();
        expectTurnTiming(asSocket(socket), session, REF);
        expect(acceptTurnTiming({ socket: asSocket(socket), session }, dto)).toBe('accepted');
      }
    } finally {
      setJournalSink(null);
    }
    const [newer, noSpeech, old] = lines.filter((line) => line.event === 'v2.device_turn_timing');
    expect(newer).toMatchObject({
      speech_end_ms: 2050, speech_end_to_speaker_ms: 2150, stop_to_speaker_ms: 1000,
      uplink_backlog: 3, mic_fps: 99, tx_busy: 4, tx_busy_max_ms: 120,
    });
    expect(noSpeech).toMatchObject({ speech_end_ms: 'skipped', uplink_backlog: 0, mic_fps: 100, tx_busy: 0, tx_busy_max_ms: 0 });
    expect(noSpeech).not.toHaveProperty('speech_end_to_speaker_ms');
    for (const key of ['speech_end_ms', 'speech_end_to_speaker_ms', 'uplink_backlog', 'mic_fps', 'tx_busy', 'tx_busy_max_ms']) {
      expect(old).not.toHaveProperty(key);
    }
    const metrics = vi.mocked(recordObservationMetrics).mock.calls.flatMap((call) => call[0]);
    expect(metrics.filter((sample) => sample.name === 'device.turn.speech_end_to_speaker_ms')).toEqual([
      { name: 'device.turn.speech_end_to_speaker_ms', value: 2150 },
    ]);
  });

  it('ignores a duplicate, a wrong turn and a summary on a reconnected session', () => {
    const socket = makeSocket(['turn_timing']);
    const session = createSession();
    expectTurnTiming(asSocket(socket), session, REF);
    expect(acceptTurnTiming({ socket: asSocket(socket), session }, drained)).toBe('accepted');
    expect(acceptTurnTiming({ socket: asSocket(socket), session }, drained)).toBe('duplicate');
    expect(acceptTurnTiming({ socket: asSocket(socket), session }, { ...drained, turn_ref: 'turn_999999_v2' })).toBe('unknown_turn');
    // A reconnect is a new socket and a new session: the old turn is not joinable there.
    const reconnected = makeSocket(['turn_timing']);
    expect(acceptTurnTiming({ socket: asSocket(reconnected), session: createSession() }, stopped)).toBe('unknown_turn');
    expect(timingSpans()).toHaveLength(1);
  });

  it('expires a running turn after RUNNING_TTL_MS and a settled one after SETTLED_TTL_MS', () => {
    const socket = makeSocket(['turn_timing']);
    const session = createSession();
    expectTurnTiming(asSocket(socket), session, REF);
    vi.advanceTimersByTime(RUNNING_TTL_MS);
    expect(acceptTurnTiming({ socket: asSocket(socket), session }, drained)).toBe('expired');
    expectTurnTiming(asSocket(socket), session, 'turn_222222_v2');
    settleTurnTiming(session, 'turn_222222_v2');
    vi.advanceTimersByTime(SETTLED_TTL_MS);
    expect(acceptTurnTiming({ socket: asSocket(socket), session }, { ...drained, turn_ref: 'turn_222222_v2' })).toBe('expired');
    expect(timingSpans()).toHaveLength(0);
  });

  it('keeps at most EXPECTED_CAPACITY turns per session, dropping the oldest', () => {
    const socket = makeSocket(['turn_timing']);
    const session = createSession();
    for (let i = 0; i <= EXPECTED_CAPACITY; i += 1) expectTurnTiming(asSocket(socket), session, `turn_${String(i).padStart(6, '0')}_v2`);
    expect(acceptTurnTiming({ socket: asSocket(socket), session }, { ...drained, turn_ref: 'turn_000000_v2' })).toBe('unknown_turn');
    expect(acceptTurnTiming({ socket: asSocket(socket), session }, { ...drained, turn_ref: `turn_${String(EXPECTED_CAPACITY).padStart(6, '0')}_v2` }))
      .toBe('accepted');
  });

  it('never expects a summary from a socket that did not negotiate the cap', () => {
    const legacy = makeSocket(['device_log']);
    const session = createSession();
    expectTurnTiming(asSocket(legacy), session, REF);
    expect(acceptTurnTiming({ socket: asSocket(legacy), session }, drained)).toBe('not_negotiated');
    expect(legacy.send).not.toHaveBeenCalled();
  });

  it('refuses milestones out of device-clock order', () => {
    const socket = makeSocket(['turn_timing']);
    const session = createSession();
    expectTurnTiming(asSocket(socket), session, REF);
    const late = { ...drained, payload: { ...drained.payload, speaker_submission_ms: 4000 } };
    expect(acceptTurnTiming({ socket: asSocket(socket), session }, late)).toBe('out_of_order');
    expect(milestonesOrdered({ ...drained.payload, capture_end_ms: 9_000 })).toBe(false);
    expect(milestonesOrdered(stopped.payload)).toBe(true);
    // A stop before turn_end: nothing after it to order against.
    expect(milestonesOrdered({ ...stopped.payload, turn_end_ms: null, playback_start_ms: null, playback_end_ms: null })).toBe(true);
  });
});

describe('device turn timing: the old/new server x firmware matrix through handleControl', () => {
  const appDeps = createAppDeps();
  const control = (dto: Record<string, unknown>): ClientControlDto => ClientControlDtoSchema.parse({ v: 1, id: 'test_ctrl_000001', payload: {}, ...dto });

  async function runTurn(caps: string[]): Promise<{ socket: FakeSocket; session: ReturnType<typeof createSession> }> {
    const socket = makeSocket();
    const session = createSession();
    const onTurnEnd = vi.fn(async () => undefined);
    await handleControl(appDeps, asSocket(socket), session, control({ type: 'hello', payload: { format_id: 2, caps } }), onTurnEnd);
    await handleControl(appDeps, asSocket(socket), session, control({ type: 'turn_start', turn_ref: REF }), onTurnEnd);
    await handleControl(appDeps, asSocket(socket), session, control({ type: 'turn_end', turn_ref: REF, seq: 0 }), onTurnEnd);
    await session.turnDone;
    session.stage = 'ready';
    return { socket, session };
  }
  const welcomeOf = (socket: FakeSocket): Record<string, unknown> => {
    const sent = socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as { type: string; payload: Record<string, unknown> });
    return sent.find((message) => message.type === 'welcome')?.payload ?? {};
  };

  it('new firmware + new server: welcome acknowledges turn_timing and the late summary joins the turn', async () => {
    const { socket, session } = await runTurn(['device_log', 'turn_timing']);
    expect(welcomeOf(socket).turn_timing).toBe(true);
    vi.advanceTimersByTime(5_000);
    const sentBefore = socket.send.mock.calls.length;
    await handleControl(appDeps, asSocket(socket), session, drained, vi.fn());
    expect(timingSpans()).toHaveLength(1);
    expect(timingSpans()[0]?.[1]).toMatchObject({ detached: true });
    expect(socket.send.mock.calls.length).toBe(sentBefore);  // no reply, no error.
    // A second copy is a duplicate: still no reply.
    await handleControl(appDeps, asSocket(socket), session, drained, vi.fn());
    expect(timingSpans()).toHaveLength(1);
    expect(socket.send.mock.calls.length).toBe(sentBefore);
  });

  it('old firmware + new server: no ack, no expectation, nothing exported', async () => {
    const { socket, session } = await runTurn(['device_log', 'assistant_name']);
    expect(welcomeOf(socket)).not.toHaveProperty('turn_timing');
    await handleControl(appDeps, asSocket(socket), session, drained, vi.fn());
    expect(timingSpans()).toHaveLength(0);
  });

  async function cancelledTurn(): Promise<{ socket: FakeSocket; session: ReturnType<typeof createSession> }> {
    const socket = makeSocket();
    const session = createSession();
    await handleControl(appDeps, asSocket(socket), session, control({ type: 'hello', payload: { format_id: 2, caps: ['turn_timing'] } }), vi.fn());
    await handleControl(appDeps, asSocket(socket), session, control({ type: 'turn_start', turn_ref: REF }), vi.fn());
    await handleControl(appDeps, asSocket(socket), session, control({ type: 'cancel', turn_ref: REF }), vi.fn());
    return { socket, session };
  }

  it('a cancelled turn takes its summary within the settled window', async () => {
    const { socket, session } = await cancelledTurn();
    vi.advanceTimersByTime(SETTLED_TTL_MS - 1);
    await handleControl(appDeps, asSocket(socket), session, stopped, vi.fn());
    expect(timingSpans()).toHaveLength(1);
  });

  it("a cancelled turn's summary after the settled window is dropped", async () => {
    const { socket, session } = await cancelledTurn();
    vi.advanceTimersByTime(SETTLED_TTL_MS);
    await handleControl(appDeps, asSocket(socket), session, stopped, vi.fn());
    expect(timingSpans()).toHaveLength(0);
  });
});

describe('device turn timing: who closed capture (#1384)', () => {
  const SENT_AT = 1_000;
  /** The fixture's capture ends at 3200 ms; speech ends a gap before it. */
  const CAPTURE_END = 3200;
  const cases: Array<[string, Partial<TurnTimingDto['payload']>, boolean, Record<string, string>]> = [
    ['silence 435 ms after speech, end_of_turn sent before turn_end: server on the device basis',
      { source: 'wake', end_reason: 'silence', speech_end_ms: CAPTURE_END - 435 }, true, { eot_source: 'server', eot_basis: 'device' }],
    ['silence 1010 ms after speech: the device closed it, device basis',
      { source: 'wake', end_reason: 'silence', speech_end_ms: CAPTURE_END - 1010 }, true, { eot_source: 'device', eot_basis: 'device' }],
    ['push-to-talk release: the device closed it, device basis',
      { source: 'ptt', end_reason: 'release', speech_end_ms: CAPTURE_END - 435 }, true, { eot_source: 'device', eot_basis: 'device' }],
    ['no speech_end_ms (an older firmware): order basis',
      { source: 'wake', end_reason: 'silence', speech_end_ms: undefined }, true, { eot_source: 'server', eot_basis: 'order' }],
  ];
  it.each(cases)('%s', (_name, payload, sent, expected) => {
    const socket = makeSocket(['turn_timing']);
    const session = createSession();
    const lines: Record<string, unknown>[] = [];
    setJournalSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
    try {
      expectTurnTiming(asSocket(socket), session, REF);
      if (sent) recordServerEndOfTurn(session, REF, SENT_AT);
      recordTurnEnd(session, REF, SENT_AT + 150);
      expect(acceptTurnTiming({ socket: asSocket(socket), session }, { ...drained, payload: { ...drained.payload, ...payload } })).toBe('accepted');
    } finally {
      setJournalSink(null);
    }
    expect(lines.find((line) => line.event === 'v2.device_turn_timing')).toMatchObject(expected);
  });
});
