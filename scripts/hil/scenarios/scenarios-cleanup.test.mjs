import { describe, expect, it } from 'vitest';

import { SCENARIOS, WAVESHARE_SCENARIOS } from './index.mjs';

// `,` opens Settings from READY, and Settings stays open until a backtick closes
// it. A scenario that fails before its own backticks must back out in `finally`,
// or the next scenario starts in SETTINGS (HIL run 20261027-183230-922b:
// settings-wifi-list-end failed at step 11, and 7 later scenarios failed at the
// baseline's READY check).

const opensSettings = (scenario) => scenario.steps.some((step) => step.press === ',');
const pairs = (scenario) => ['T server pair auto', 'T token restore'].every((send) => (scenario.finally ?? []).some((step) => step.send === send));

/** True when `finally` backticks out of Settings and then asserts READY within 5 s. */
function leavesSettingsClosed(scenario) {
  const steps = scenario.finally ?? [];
  const last = steps.at(-1);
  return steps.some((step) => step.press === 'backtick')
    && last?.assertState?.state === 'READY'
    && last.timeoutMs >= 5000;
}

const opening = SCENARIOS.filter(opensSettings);

describe('a scenario that opens Settings closes it again, pass or fail', () => {
  it('finds the Settings scenarios this change covers', () => {
    expect(opening.map((s) => s.name)).toEqual(expect.arrayContaining([
      'settings-navigation', 'settings-wifi-list-end', 'factory-reset-guard',
      'ring-during-join-test', 'ring-over-settings', 'ring-over-settings-typing', 'settings-from-pairing',
    ]));
  });

  it.each(opening.map((scenario) => [scenario.name, scenario]))('%s backticks out of Settings in finally and ends READY', (_name, scenario) => {
    expect(leavesSettingsClosed(scenario)).toBe(true);
  });
});

// Epic #611: a scenario that forgets the owner's token must give it back. The
// restore runs once, in `finally`, so a failure midway still leaves the device
// on the owner's token (HIL run 20261028-180922-d498: 41 later scenarios failed
// at baseline step 2 after pair-from-scratch failed on a slow Wi-Fi rejoin).
const everyScenario = [...new Map([...SCENARIOS, ...WAVESHARE_SCENARIOS].map((s) => [s.name, s])).values()];
const forgetting = everyScenario.filter((scenario) => scenario.steps.some((step) => step.send === 'T token forget'));

describe('a scenario that forgets the owner token gives it back in finally, pass or fail', () => {
  it('finds the token-forgetting scenarios this change covers', () => {
    expect(forgetting.length).toBeGreaterThan(0);
    expect(forgetting.map((s) => s.name)).toEqual(expect.arrayContaining(['pair-from-scratch', 'revoke-4003']));
  });

  it.each(forgetting.map((scenario) => [scenario.name, scenario]))('%s sends T server pair auto and T token restore in finally, and ends READY', (_name, scenario) => {
    expect(pairs(scenario)).toBe(true);
    expect(scenario.finally.at(-1)?.assertState?.state).toBe('READY');
  });

  it.each(forgetting.map((scenario) => [scenario.name, scenario]))('%s sends T token restore nowhere in steps', (_name, scenario) => {
    expect(scenario.steps.some((step) => step.send === 'T token restore')).toBe(false);
  });
});
