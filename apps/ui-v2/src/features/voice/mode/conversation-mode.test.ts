import { describe, expect, it } from 'vitest';
import {
  DISPLAY_LABELS,
  STATES,
  transition,
  micLive,
  type Effect,
  type Event,
  type State,
} from './conversation-mode';
import { DEFAULT_CONFIG } from './config';

const cfg = DEFAULT_CONFIG;
const ctx = { now: 0, config: cfg };
const e = (type: Event['type'], over: Partial<Event> = {}): Event =>
  ({ type, ...over }) as Event;

const effects = (...types: Effect['type'][]): { type: Effect['type'] }[] =>
  types.map((t) => ({ type: t }));

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TableCase {
  name: string;
  from: State;
  event: Event;
  to: State;
  effects: { type: Effect['type'] }[];
}

const CASES: TableCase[] = [
  { name: 'off -> START -> listening', from: 'off', event: e('START'), to: 'listening', effects: effects('openMic', 'startIdleTimer') },
  { name: 'off -> STOP stays off', from: 'off', event: e('STOP'), to: 'off', effects: effects('clearIdleTimer') },
  { name: 'off -> SPEECH_START illegal', from: 'off', event: e('SPEECH_START'), to: 'off', effects: [] },
  { name: 'listening -> SPEECH_START -> hearing', from: 'listening', event: e('SPEECH_START'), to: 'hearing', effects: [] },
  { name: 'listening -> SPEECH_END short discards', from: 'listening', event: e('SPEECH_END', { durationMs: 100 }), to: 'listening', effects: effects('discardUtterance') },
  { name: 'listening -> SPEECH_END long submits', from: 'listening', event: e('SPEECH_END', { durationMs: 2000 }), to: 'thinking', effects: effects('releaseMic', 'submitUtterance', 'startIdleTimer') },
  { name: 'hearing -> SPEECH_END long submits', from: 'hearing', event: e('SPEECH_END', { durationMs: 2000 }), to: 'thinking', effects: effects('releaseMic', 'submitUtterance', 'startIdleTimer') },
  { name: 'hearing -> SPEECH_END short discards', from: 'hearing', event: e('SPEECH_END', { durationMs: 100 }), to: 'listening', effects: effects('discardUtterance') },
  { name: 'thinking -> FIRST_AUDIO -> speaking', from: 'thinking', event: e('FIRST_AUDIO'), to: 'speaking', effects: [] },
  { name: 'thinking -> REPLY_STARTED no-op', from: 'thinking', event: e('REPLY_STARTED'), to: 'thinking', effects: [] },
  { name: 'speaking -> PLAYBACK_DONE -> listening', from: 'speaking', event: e('PLAYBACK_DONE'), to: 'listening', effects: effects('openMic', 'startIdleTimer') },
  { name: 'speaking -> SPEECH_START candidate no-op', from: 'speaking', event: e('SPEECH_START'), to: 'speaking', effects: [] },
  { name: 'speaking -> SPEECH_END short false trigger', from: 'speaking', event: e('SPEECH_END', { durationMs: 100 }), to: 'speaking', effects: [] },
  { name: 'speaking -> SPEECH_END long barge-in', from: 'speaking', event: e('SPEECH_END', { durationMs: 500 }), to: 'listening', effects: effects('stopPlayback', 'abortReply', 'recordHeardPortion', 'openMic', 'startIdleTimer') },
  { name: 'listening -> HIDDEN -> paused', from: 'listening', event: e('HIDDEN'), to: 'paused', effects: effects('releaseMic', 'clearIdleTimer') },
  { name: 'speaking -> HIDDEN -> paused stops playback', from: 'speaking', event: e('HIDDEN'), to: 'paused', effects: effects('stopPlayback', 'abortReply', 'clearIdleTimer') },
  { name: 'paused -> SHOWN stays paused', from: 'paused', event: e('SHOWN'), to: 'paused', effects: [] },
  { name: 'paused -> RESUME -> listening', from: 'paused', event: e('RESUME'), to: 'listening', effects: effects('openMic', 'startIdleTimer') },
  { name: 'paused -> HIDDEN stays paused', from: 'paused', event: e('HIDDEN'), to: 'paused', effects: [] },
  { name: 'listening -> IDLE_TIMEOUT -> off', from: 'listening', event: e('IDLE_TIMEOUT'), to: 'off', effects: effects('releaseMic', 'clearIdleTimer', 'setModeReason') },
  { name: 'listening -> MUTE -> muted', from: 'listening', event: e('MUTE'), to: 'muted', effects: effects('releaseMic', 'clearIdleTimer') },
  { name: 'muted -> UNMUTE -> listening', from: 'muted', event: e('UNMUTE'), to: 'listening', effects: effects('openMic', 'startIdleTimer') },
  { name: 'off -> LOCK_DENIED -> paused', from: 'off', event: e('LOCK_DENIED'), to: 'paused', effects: effects('clearIdleTimer', 'setModeReason') },
  { name: 'listening -> LOCK_DENIED -> paused releases', from: 'listening', event: e('LOCK_DENIED'), to: 'paused', effects: effects('releaseMic', 'clearIdleTimer', 'setModeReason') },
  { name: 'listening -> ERROR -> off', from: 'listening', event: e('ERROR', { code: 'denied' }), to: 'off', effects: effects('releaseMic', 'clearIdleTimer') },
  { name: 'thinking -> MUTE -> muted (mode stays on)', from: 'thinking', event: e('MUTE'), to: 'muted', effects: effects('clearIdleTimer') },
];

describe('conversation-mode table transitions', () => {
  it.each(CASES)('$name', ({ from, event, to, effects: expected }) => {
    const result = transition(from, event, ctx);
    expect(result.state).toBe(to);
    expect(result.effects.map((fx) => fx.type)).toEqual(expected.map((fx) => fx.type));
  });
});

function sampleEvents(): Event[] {
  return [
    e('START'),
    e('STOP'),
    e('MUTE'),
    e('UNMUTE'),
    e('SPEECH_START'),
    e('SPEECH_END', { durationMs: 0 }),
    e('SPEECH_END', { durationMs: 100 }),
    e('SPEECH_END', { durationMs: 400 }),
    e('SPEECH_END', { durationMs: 5000 }),
    e('REPLY_STARTED'),
    e('FIRST_AUDIO'),
    e('PLAYBACK_DONE'),
    e('HIDDEN'),
    e('SHOWN'),
    e('RESUME'),
    e('IDLE_TIMEOUT'),
    e('LOCK_DENIED'),
    e('ERROR', { code: 'x' }),
  ];
}

describe('invariants across every state and event', () => {
  it('returns a valid state and holds the mic-live and release rules for every pair', () => {
    for (const from of STATES) {
      for (const event of sampleEvents()) {
        const result = transition(from, event, ctx);
        expect(STATES).toContain(result.state);
        expect(micLive(result.state)).toBe(
          result.state === 'listening' || result.state === 'hearing',
        );
        if (
          (result.state === 'off' || result.state === 'paused' || result.state === 'muted') &&
          micLive(from)
        ) {
          expect(result.effects.some((fx) => fx.type === 'releaseMic')).toBe(true);
        }
      }
    }
  });
});

describe('property: 500 random sequences hold the invariant', () => {
  it('micLive only in listening/hearing and every entry to off/paused/muted releases a live mic', () => {
    const rand = mulberry32(0xc0ffee);
    const events = sampleEvents();
    let state: State = 'off';
    for (let i = 0; i < 500; i += 1) {
      const pick = events[Math.floor(rand() * events.length)];
      const event =
        pick.type === 'SPEECH_END'
          ? e('SPEECH_END', { durationMs: Math.floor(rand() * 6000) })
          : pick;
      const result = transition(state, event, ctx);
      expect(micLive(result.state)).toBe(
        result.state === 'listening' || result.state === 'hearing',
      );
      if (
        (result.state === 'off' || result.state === 'paused' || result.state === 'muted') &&
        micLive(state)
      ) {
        expect(result.effects.some((fx) => fx.type === 'releaseMic')).toBe(true);
      }
      state = result.state;
    }
    expect(state).toBeDefined();
  });
});

describe('named behaviours', () => {
  it('barge-in honours the echo guard: short speech never interrupts, long speech does', () => {
    const speaking = transition('listening', e('SPEECH_START'), ctx);
    expect(speaking).toEqual({ state: 'hearing', effects: [] });
    const submitted = transition(speaking.state, e('SPEECH_END', { durationMs: 2000 }), ctx);
    expect(submitted.state).toBe('thinking');
    const audio = transition(submitted.state, e('FIRST_AUDIO'), ctx);
    expect(audio.state).toBe('speaking');

    const candidate = transition(audio.state, e('SPEECH_START'), ctx);
    expect(candidate.state).toBe('speaking');
    const falseTrigger = transition(
      candidate.state,
      e('SPEECH_END', { durationMs: cfg.MIN_INTERRUPTION_MS - 1 }),
      ctx,
    );
    expect(falseTrigger.state).toBe('speaking');
    expect(falseTrigger.effects).toEqual([]);

    const bargeIn = transition(
      candidate.state,
      e('SPEECH_END', { durationMs: cfg.MIN_INTERRUPTION_MS }),
      ctx,
    );
    expect(bargeIn.state).toBe('listening');
    expect(bargeIn.effects.map((fx) => fx.type)).toEqual([
      'stopPlayback',
      'abortReply',
      'recordHeardPortion',
      'openMic',
      'startIdleTimer',
    ]);
  });

  it('idle auto-off: IDLE_TIMEOUT from listening ends the mode with a visible reason', () => {
    const result = transition('listening', e('IDLE_TIMEOUT'), ctx);
    expect(result.state).toBe('off');
    expect(result.effects).toEqual([
      { type: 'releaseMic' },
      { type: 'clearIdleTimer' },
      { type: 'setModeReason', reason: '5 minutes of silence' },
    ]);
  });

  it('hidden -> paused -> shown (still paused) -> resume by one tap', () => {
    const hidden = transition('listening', e('HIDDEN'), ctx);
    expect(hidden.state).toBe('paused');
    expect(hidden.effects.some((fx) => fx.type === 'releaseMic')).toBe(true);
    const shown = transition(hidden.state, e('SHOWN'), ctx);
    expect(shown.state).toBe('paused');
    expect(shown.effects).toEqual([]);
    const resumed = transition(shown.state, e('RESUME'), ctx);
    expect(resumed.state).toBe('listening');
    expect(resumed.effects.map((fx) => fx.type)).toEqual(['openMic', 'startIdleTimer']);
  });

  it('mute releases the mic but keeps the mode on; unmute returns to listening', () => {
    const muted = transition('listening', e('MUTE'), ctx);
    expect(muted.state).toBe('muted');
    expect(muted.effects.some((fx) => fx.type === 'releaseMic')).toBe(true);
    expect(micLive(muted.state)).toBe(false);
    const unmuted = transition(muted.state, e('UNMUTE'), ctx);
    expect(unmuted.state).toBe('listening');
    expect(unmuted.effects.map((fx) => fx.type)).toEqual(['openMic', 'startIdleTimer']);
  });

  it('starts off after a reload: the initial state is off and only START opens the mic', () => {
    expect(micLive('off')).toBe(false);
    const nothing = transition('off', e('SPEECH_START'), ctx);
    expect(nothing.state).toBe('off');
    expect(nothing.effects).toEqual([]);
    const started = transition('off', e('START'), ctx);
    expect(started.state).toBe('listening');
    expect(started.effects.map((fx) => fx.type)).toEqual(['openMic', 'startIdleTimer']);
  });

  it('exposes a display label for every state and names hearing as "Hearing you"', () => {
    for (const state of STATES) {
      expect(typeof DISPLAY_LABELS[state]).toBe('string');
    }
    expect(DISPLAY_LABELS.hearing).toBe('Hearing you');
  });
});