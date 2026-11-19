/** Turn intent classifier: the tool name -> intent map and deriveIntent's first-mapped-tool rule. */
import { describe, expect, it } from 'vitest';
import { deriveIntent, TOOL_INTENT, type TurnIntent } from '../src/intents.ts';
import { createDeviceTools } from '../src/device-tools.ts';
import { createMemoryTools } from '../src/memory-tools.ts';
import { createProductivityTools, createSpaceMemberTools } from '../src/productivity-tools.ts';
import { createTimerTools } from '../src/timer-tools.ts';
import { createVoiceTools } from '../src/voice-tools.ts';
import { createEngineTools } from '../src/games/engine-tools.ts';

const EXPECTED: Record<TurnIntent, string[]> = {
  timer_reminder: ['set_timer', 'set_alarm', 'list_timers', 'cancel_timer', 'create_reminder', 'list_reminders', 'cancel_reminder'],
  calendar: ['list_agenda', 'create_event'],
  task_note: ['list_tasks', 'create_task', 'complete_task', 'update_task', 'create_note', 'append_note', 'read_note'],
  memory: ['remember', 'forget', 'list_actions', 'complete_action'],
  game: ['list_games', 'start_game', 'pause_game', 'resume_game', 'stop_game', 'game_status', 'play_again', 'riddle_guess', 'riddle_hint', 'riddle_skip', 'simon_next', 'simon_caught'],
  device_control: ['set_volume', 'set_mode', 'express'],
  search_info: ['search', 'currentDateTime'],
  space_collab: ['read_inbox', 'list_space_members'],
  chat: [],
  other: [],
};

describe('TOOL_INTENT', () => {
  for (const [intent, names] of Object.entries(EXPECTED)) {
    for (const name of names) {
      it(`maps ${name} to ${intent}`, () => {
        expect(TOOL_INTENT[name]).toBe(intent);
      });
    }
  }

  it('has no entry beyond the documented tools', () => {
    expect(Object.keys(TOOL_INTENT).sort()).toEqual(Object.values(EXPECTED).flat().sort());
  });
});

describe('deriveIntent', () => {
  it('is chat when no tool was called', () => {
    expect(deriveIntent([])).toBe('chat');
  });

  it('takes the intent of the first mapped tool', () => {
    expect(deriveIntent(['currentDateTime', 'set_timer'])).toBe('search_info');
    expect(deriveIntent(['set_timer', 'currentDateTime'])).toBe('timer_reminder');
  });

  it('skips unmapped names before the first mapped one', () => {
    expect(deriveIntent(['mystery', 'create_event'])).toBe('calendar');
  });

  it('is other when only unmapped tools were called', () => {
    expect(deriveIntent(['mystery', 'other_mystery'])).toBe('other');
  });
});

describe('coverage of the real tool factories', () => {
  const stub = {} as never;
  const factories: Array<[string, () => string[]]> = [
    ['createTimerTools', () => Object.keys(createTimerTools(stub))],
    ['createMemoryTools', () => Object.keys(createMemoryTools(stub))],
    ['createDeviceTools', () => Object.keys(createDeviceTools(stub))],
    ['createVoiceTools', () => Object.keys(createVoiceTools(stub))],
    ['createProductivityTools', () => Object.keys(createProductivityTools(stub))],
    ['createSpaceMemberTools', () => Object.keys(createSpaceMemberTools(stub))],
    ['createEngineTools', () => Object.keys(createEngineTools(stub))],
  ];
  for (const [factory, names] of factories) {
    it(`maps every tool of ${factory}`, () => {
      const unmapped = names().filter((name) => !(name in TOOL_INTENT));
      expect(unmapped).toEqual([]);
    });
  }
});
