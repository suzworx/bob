import type { ConversationModeConfig } from './config';

export type State =
  | 'off'
  | 'listening'
  | 'hearing'
  | 'thinking'
  | 'speaking'
  | 'muted'
  | 'paused';

export const STATES: readonly State[] = [
  'off',
  'listening',
  'hearing',
  'thinking',
  'speaking',
  'muted',
  'paused',
];

const LIVE_STATES: ReadonlySet<State> = new Set(['listening', 'hearing']);

export const DISPLAY_LABELS: Readonly<Record<State, string>> = Object.freeze({
  off: 'Off',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Thinking',
  speaking: 'Speaking',
  muted: 'Muted',
  paused: 'Paused',
});

export type Event =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'MUTE' }
  | { type: 'UNMUTE' }
  | { type: 'SPEECH_START' }
  | { type: 'SPEECH_END'; durationMs: number }
  | { type: 'REPLY_STARTED' }
  | { type: 'FIRST_AUDIO' }
  | { type: 'PLAYBACK_DONE' }
  | { type: 'HIDDEN' }
  | { type: 'SHOWN' }
  | { type: 'RESUME' }
  | { type: 'IDLE_TIMEOUT' }
  | { type: 'LOCK_DENIED' }
  | { type: 'ERROR'; code: string };

export type Effect =
  | { type: 'openMic' }
  | { type: 'releaseMic' }
  | { type: 'startIdleTimer' }
  | { type: 'clearIdleTimer' }
  | { type: 'stopPlayback' }
  | { type: 'abortReply' }
  | { type: 'recordHeardPortion' }
  | { type: 'submitUtterance' }
  | { type: 'discardUtterance' }
  | { type: 'setModeReason'; reason: string };

interface TransitionContext {
  now: number;
  config: ConversationModeConfig;
}

interface TransitionResult {
  state: State;
  effects: Effect[];
}

export function micLive(state: State): boolean {
  return LIVE_STATES.has(state);
}

const releaseIfLive = (from: State): Effect[] =>
  micLive(from) ? [{ type: 'releaseMic' }] : [];

export function transition(
  state: State,
  event: Event,
  ctx: TransitionContext,
): TransitionResult {
  const { config } = ctx;
  switch (event.type) {
    case 'START':
      if (state === 'off') {
        return {
          state: 'listening',
          effects: [{ type: 'openMic' }, { type: 'startIdleTimer' }],
        };
      }
      return { state, effects: [] };
    case 'STOP':
      return {
        state: 'off',
        effects: [...releaseIfLive(state), { type: 'clearIdleTimer' }],
      };
    case 'MUTE':
      return {
        state: 'muted',
        effects: [...releaseIfLive(state), { type: 'clearIdleTimer' }],
      };
    case 'UNMUTE':
      if (state === 'muted') {
        return {
          state: 'listening',
          effects: [{ type: 'openMic' }, { type: 'startIdleTimer' }],
        };
      }
      return { state, effects: [] };
    case 'SPEECH_START':
      if (state === 'listening') return { state: 'hearing', effects: [] };
      if (state === 'speaking') return { state: 'speaking', effects: [] };
      return { state, effects: [] };
    case 'SPEECH_END': {
      const { durationMs } = event;
      if (state === 'hearing') {
        if (durationMs < config.MIN_SPEECH_MS) {
          return { state: 'listening', effects: [{ type: 'discardUtterance' }] };
        }
        return {
          state: 'thinking',
          effects: [
            ...releaseIfLive(state),
            { type: 'submitUtterance' },
            { type: 'startIdleTimer' },
          ],
        };
      }
      if (state === 'listening') {
        if (durationMs < config.MIN_SPEECH_MS) {
          return { state: 'listening', effects: [{ type: 'discardUtterance' }] };
        }
        return {
          state: 'thinking',
          effects: [
            ...releaseIfLive(state),
            { type: 'submitUtterance' },
            { type: 'startIdleTimer' },
          ],
        };
      }
      if (state === 'speaking') {
        if (durationMs >= config.MIN_INTERRUPTION_MS) {
          return {
            state: 'listening',
            effects: [
              { type: 'stopPlayback' },
              { type: 'abortReply' },
              { type: 'recordHeardPortion' },
              { type: 'openMic' },
              { type: 'startIdleTimer' },
            ],
          };
        }
        return { state: 'speaking', effects: [] };
      }
      return { state, effects: [] };
    }
    case 'REPLY_STARTED':
      if (state === 'thinking') return { state: 'thinking', effects: [] };
      return { state, effects: [] };
    case 'FIRST_AUDIO':
      if (state === 'thinking') return { state: 'speaking', effects: [] };
      return { state, effects: [] };
    case 'PLAYBACK_DONE':
      if (state === 'speaking') {
        return {
          state: 'listening',
          effects: [{ type: 'openMic' }, { type: 'startIdleTimer' }],
        };
      }
      return { state, effects: [] };
    case 'HIDDEN':
      if (state === 'listening' || state === 'hearing') {
        return {
          state: 'paused',
          effects: [...releaseIfLive(state), { type: 'clearIdleTimer' }],
        };
      }
      if (state === 'thinking') {
        return { state: 'paused', effects: [{ type: 'clearIdleTimer' }] };
      }
      if (state === 'speaking') {
        return {
          state: 'paused',
          effects: [
            { type: 'stopPlayback' },
            { type: 'abortReply' },
            { type: 'clearIdleTimer' },
          ],
        };
      }
      if (state === 'muted') {
        return { state: 'paused', effects: [{ type: 'clearIdleTimer' }] };
      }
      return { state, effects: [] };
    case 'SHOWN':
      if (state === 'paused') return { state: 'paused', effects: [] };
      return { state, effects: [] };
    case 'RESUME':
      if (state === 'paused') {
        return {
          state: 'listening',
          effects: [{ type: 'openMic' }, { type: 'startIdleTimer' }],
        };
      }
      return { state, effects: [] };
    case 'IDLE_TIMEOUT':
      if (state === 'listening') {
        return {
          state: 'off',
          effects: [
            ...releaseIfLive(state),
            { type: 'clearIdleTimer' },
            { type: 'setModeReason', reason: '5 minutes of silence' },
          ],
        };
      }
      return { state, effects: [] };
    case 'LOCK_DENIED':
      return {
        state: 'paused',
        effects: [
          ...releaseIfLive(state),
          { type: 'clearIdleTimer' },
          { type: 'setModeReason', reason: 'Voice is on in another tab' },
        ],
      };
    case 'ERROR':
      return {
        state: 'off',
        effects: [...releaseIfLive(state), { type: 'clearIdleTimer' }],
      };
    default:
      return { state, effects: [] };
  }
}