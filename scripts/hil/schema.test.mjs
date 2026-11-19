import { describe, expect, it } from 'vitest';

import { boardOf, commandFor, missingFeatures, missingFiles, validateScenario, wrongBoard } from './schema.mjs';

const good = () => ({
  name: 'new-conversation',
  issue: '#302',
  title: 'n then Enter starts a new conversation',
  requires: [{ event: 'new_conversation_acked', feature: 'new conversation (#302)' }],
  steps: [
    { assertState: { state: 'READY' } },
    { saveState: 'before' },
    { press: 'n' },
    { waitDevice: /new_conversation_opened/, timeoutMs: 5000 },
    { press: 'enter' },
    { waitServer: /"event":"v2\.conversation_cleared"/, timeoutMs: 5000 },
    { assertState: { state: 'READY', vol: { same: 'before' }, mode: { differs: 'before' } } },
    { assertHeapMin: { free: 40000, largest: 16000 } },
    { send: 'T audio tone 1500', expect: /^ok$/ },
    { sleep: 200 },
  ],
});

describe('validateScenario', () => {
  it('allows sessionFrom only as a RegExp on a server quiet window', () => {
    const step = { noServer: /closed/, sessionFrom: /pairing_required/, timeoutMs: 1000 };
    expect(validateScenario({ ...good(), steps: [step] })).toEqual([]);
    expect(validateScenario({ ...good(), steps: [{ ...step, sessionFrom: 'pairing_required' }] }).length).toBeGreaterThan(0);
    expect(validateScenario({ ...good(), steps: [{ noDevice: /closed/, sessionFrom: /pairing_required/, timeoutMs: 1000 }] }).length).toBeGreaterThan(0);
  });

  it('accepts a well-formed scenario', () => {
    expect(validateScenario(good())).toEqual([]);
  });

  it('requires a kebab-case name, an issue and at least one step', () => {
    expect(validateScenario({ ...good(), name: 'New Conv' })).toContainEqual(expect.stringMatching(/name/));
    expect(validateScenario({ ...good(), issue: '302' })).toContainEqual(expect.stringMatching(/issue/));
    expect(validateScenario({ ...good(), steps: [] })).toContainEqual(expect.stringMatching(/steps/));
  });

  it('rejects a step with no action, two actions, or an unknown action', () => {
    const errors = validateScenario({ ...good(), steps: [{}, { press: 'n', sleep: 5 }, { tap: 'n' }] });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/step 1/);
  });

  it('rejects presses the console cannot send', () => {
    expect(validateScenario({ ...good(), steps: [{ press: 'nn' }] })).toHaveLength(1);
    expect(validateScenario({ ...good(), steps: [{ press: '\n' }] })).toHaveLength(1);
    expect(validateScenario({ ...good(), steps: [{ press: 'btn sideways' }] })).toHaveLength(1);
  });

  it('requires regexes for waits and a bounded timeout', () => {
    expect(validateScenario({ ...good(), steps: [{ waitDevice: 'welcome' }] })).toHaveLength(1);
    expect(validateScenario({ ...good(), steps: [{ waitServer: /x/, timeoutMs: 0 }] })).toHaveLength(1);
    expect(validateScenario({ ...good(), steps: [{ waitServer: /x/, timeoutMs: 600_001 }] })).toHaveLength(1);
  });

  it('takes absence windows as a RegExp with a timeout, and cleanSerial as true', () => {
    expect(validateScenario({ ...good(), steps: [{ noServer: /x/, timeoutMs: 1500 }, { noDevice: /y/, timeoutMs: 10 }, { cleanSerial: true }] })).toEqual([]);
    expect(validateScenario({ ...good(), steps: [{ noServer: 'x', timeoutMs: 10 }] })).toHaveLength(1);
    expect(validateScenario({ ...good(), steps: [{ noDevice: /y/ }] })).toContainEqual(expect.stringMatching(/noDevice needs timeoutMs/));
    expect(validateScenario({ ...good(), steps: [{ cleanSerial: 'yes' }] })).toHaveLength(1);
  });

  it('checks state and heap assertions against the console contract', () => {
    expect(validateScenario({ ...good(), steps: [{ assertState: { colour: 'red' } }] })).toHaveLength(1);
    expect(validateScenario({ ...good(), steps: [{ assertState: { vol: 11 } }] })).toHaveLength(1);
    expect(validateScenario({ ...good(), steps: [{ assertState: { mode: 'shout' } }] })).toHaveLength(1);
    expect(validateScenario({ ...good(), steps: [{ assertState: { vol: { same: 'never-saved' } } }] })).toHaveLength(1);
    expect(validateScenario({ ...good(), steps: [{ assertHeapMin: { free: -1 } }] })).toHaveLength(1);
  });

  it('only lets sends through the T console', () => {
    expect(validateScenario({ ...good(), steps: [{ send: 'reboot' }] })).toHaveLength(1);
  });

  it('plays only repo-relative .wav files the scenario declares in requiresFiles', () => {
    const wav = 'data/wake-test/hey_jarvis.wav';
    expect(validateScenario({ ...good(), requiresFiles: [wav], steps: [{ playAudio: wav }] })).toEqual([]);
    expect(validateScenario({ ...good(), steps: [{ playAudio: wav }] })).toContainEqual(expect.stringMatching(/requiresFiles/));
    expect(validateScenario({ ...good(), requiresFiles: ['../x.wav'], steps: [{ playAudio: '../x.wav' }] })).toContainEqual(expect.stringMatching(/repo-relative/));
    expect(validateScenario({ ...good(), requiresFiles: ['C:/x.wav'] })).toContainEqual(expect.stringMatching(/repo-relative/));
    expect(validateScenario({ ...good(), requiresFiles: ['data/a.mp3'], steps: [{ playAudio: 'data/a.mp3' }] })).toContainEqual(expect.stringMatching(/\.wav/));
  });

  it('takes repeat (1-10) and an until RegExp on playAudio only', () => {
    const wav = 'data/a.wav';
    const play = (extra) => validateScenario({ ...good(), requiresFiles: [wav], steps: [{ playAudio: wav, ...extra }] });
    expect(play({ repeat: 3, until: /wake_detected/ })).toEqual([]);
    expect(play({ repeat: 0 })).toHaveLength(1);
    expect(play({ repeat: 11 })).toHaveLength(1);
    expect(play({ until: 'wake_detected' })).toHaveLength(1);
    expect(validateScenario({ ...good(), steps: [{ sleep: 5, repeat: 2 }] })).toHaveLength(1);
  });
});

describe('missingFiles', () => {
  it('names each required file the rig does not have', () => {
    const needs = { ...good(), requiresFiles: ['data/a.wav', 'data/b.wav'] };
    expect(missingFiles(needs, (p) => p === 'data/a.wav')).toEqual(['data/b.wav']);
    expect(missingFiles(good(), () => false)).toEqual([]);
  });
});

describe('commandFor', () => {
  it('maps presses onto the serial console contract', () => {
    expect(commandFor('n')).toBe('T key n');
    expect(commandFor('=')).toBe('T key =');
    expect(commandFor('enter')).toBe('T enter');
    expect(commandFor('backtick')).toBe('T backtick');
    expect(commandFor('btn down')).toBe('T btn down');
    expect(commandFor('btn up')).toBe('T btn up');
    // The text field keys (#677).
    expect(commandFor('del')).toBe('T del');
    expect(commandFor('tab')).toBe('T tab');
    expect(commandFor('fn ,')).toBe('T fn ,');
    expect(commandFor('fn /')).toBe('T fn /');
    expect(commandFor('fn `')).toBe('T fn `');
    expect(commandFor(',')).toBe('T key ,');
  });
});

describe('missingFeatures', () => {
  it('names each required firmware event the source does not contain', () => {
    const source = 'journal("new_conversation_acked", s, id);';
    expect(missingFeatures(good(), source)).toEqual([]);
    const needsMode = { ...good(), requires: [{ event: 'mode_changed', feature: 'mode cycle (#330)' }] };
    expect(missingFeatures(needsMode, source)).toEqual(['mode cycle (#330)']);
  });

  it('matches whole quoted event names only', () => {
    const needs = { ...good(), requires: [{ event: 'stop', feature: 'stop (#315)' }] };
    expect(missingFeatures(needs, 'journal("playback_stopped")')).toEqual(['stop (#315)']);
  });
});

describe('onlyIf', () => {
  const base = { name: 'x', issue: '#313', title: 'x' };
  it('takes a RegExp on any step', () => {
    expect(validateScenario({ ...base, steps: [{ waitDevice: /a/, onlyIf: /b/ }] })).toEqual([]);
    expect(validateScenario({ ...base, steps: [{ sleep: 5, onlyIf: 'b' }] })).toEqual(['step 1: onlyIf must be a RegExp']);
  });
});

describe('board', () => {
  it('takes cardputer or waveshare, and nothing else', () => {
    expect(validateScenario({ ...good(), board: 'waveshare' })).toEqual([]);
    expect(validateScenario({ ...good(), board: 'cardputer' })).toEqual([]);
    expect(validateScenario({ ...good(), board: 'round' })).toContainEqual(expect.stringMatching(/board/));
  });

  it("runs a board scenario only on its board's hil env, and an unmarked one everywhere", () => {
    expect(boardOf('waveshare-s3-185c-hil')).toBe('waveshare');
    expect(boardOf('m5stack-cardputer-hil')).toBe('cardputer');
    expect(wrongBoard({ ...good(), board: 'waveshare' }, 'waveshare-s3-185c-hil')).toBeNull();
    expect(wrongBoard({ ...good(), board: 'waveshare' }, 'm5stack-cardputer-hil')).toBe('waveshare only');
    expect(wrongBoard({ ...good(), board: 'cardputer' }, 'waveshare-s3-185c-hil')).toBe('cardputer only');
    expect(wrongBoard(good(), 'waveshare-s3-185c-hil')).toBeNull();
  });
});
