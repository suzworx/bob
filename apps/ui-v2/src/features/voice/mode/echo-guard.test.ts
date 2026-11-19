import { describe, expect, it } from 'vitest';
import { shouldInterrupt } from './echo-guard';
import { DEFAULT_CONFIG, withOverrides } from './config';
import type { State } from './conversation-mode';

const NON_SPEAKING_STATES: readonly State[] = [
  'off',
  'listening',
  'hearing',
  'thinking',
  'muted',
  'paused',
];

describe('shouldInterrupt', () => {
  it('while speaking, only sustained speech at MIN_INTERRUPTION_MS counts as barge-in', () => {
    const config = DEFAULT_CONFIG;
    const table: ReadonlyArray<{ speechMs: number; expected: boolean }> = [
      { speechMs: 0, expected: false },
      { speechMs: config.MIN_INTERRUPTION_MS - 1, expected: false },
      { speechMs: config.MIN_INTERRUPTION_MS, expected: true },
      { speechMs: config.MIN_INTERRUPTION_MS + 1, expected: true },
      { speechMs: 5000, expected: true },
    ];
    for (const row of table) {
      expect(
        shouldInterrupt({ state: 'speaking', speechMs: row.speechMs, config }),
      ).toBe(row.expected);
    }
  });

  it('outside speaking, defers to MIN_SPEECH_MS for every other state', () => {
    const config = DEFAULT_CONFIG;
    for (const state of NON_SPEAKING_STATES) {
      expect(
        shouldInterrupt({ state, speechMs: config.MIN_SPEECH_MS - 1, config }),
      ).toBe(false);
      expect(
        shouldInterrupt({ state, speechMs: config.MIN_SPEECH_MS, config }),
      ).toBe(true);
      expect(
        shouldInterrupt({ state, speechMs: config.MIN_SPEECH_MS + 1, config }),
      ).toBe(true);
    }
  });

  it('honours tuned interrupt and speech thresholds', () => {
    const config = withOverrides({ MIN_INTERRUPTION_MS: 500, MIN_SPEECH_MS: 100 });
    expect(shouldInterrupt({ state: 'speaking', speechMs: 499, config })).toBe(false);
    expect(shouldInterrupt({ state: 'speaking', speechMs: 500, config })).toBe(true);
    expect(shouldInterrupt({ state: 'listening', speechMs: 99, config })).toBe(false);
    expect(shouldInterrupt({ state: 'listening', speechMs: 100, config })).toBe(true);
  });
});