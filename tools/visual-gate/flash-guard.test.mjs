import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { deviceRig, isGatedEnv, passProblem, rigOffHint, variantCases, VISUAL_SOURCE } from './flash-guard.mjs';

const all = JSON.parse(readFileSync(resolve(import.meta.dirname, 'cases.json'), 'utf8')).cases;

const tree = { firmwareHash: 'a'.repeat(64), manifestSha: 'b'.repeat(64), cases: ['ready', 'reply'], rig: false };
const record = (over = {}) => ({
  firmwareHash: tree.firmwareHash,
  goldenManifestSha: tree.manifestSha,
  source: 'bob-sim',
  rig: false,
  variant: 'rig-off',
  caseCount: 2,
  cases: [{ id: 'ready', pass: true }, { id: 'reply', pass: true }],
  ...over,
});

describe('visual flash gate record', () => {
  it('allows a flash only when every state passed for this firmware and these goldens', () => {
    expect(passProblem(record(), tree)).toBeNull();
  });

  it('refuses without a record', () => {
    expect(passProblem(null, tree)).toMatch(/no data\/visual-pass\.json/);
  });

  it('refuses a record for other firmware', () => {
    expect(passProblem(record({ firmwareHash: 'c'.repeat(64) }), tree)).toMatch(/is for firmware cccccccccccc/);
  });

  it('refuses a record judged from given renders instead of this firmware', () => {
    expect(passProblem(record({ source: 'renders in /tmp/captures' }), tree)).toMatch(/not rendered from this firmware/);
  });

  it('refuses a pass for the other Bob variant (a whole-pose pass cannot unlock a rig flash, or back)', () => {
    expect(passProblem(record(), { ...tree, rig: true })).toMatch(/judged the whole-pose Bob, this flash builds the rig renderer/);
    expect(passProblem(record({ rig: true }), tree)).toMatch(/judged the rig renderer, this flash builds the whole-pose Bob/);
    expect(passProblem(record({ rig: undefined }), tree)).toMatch(/unknown Bob variant/);
  });

  it('reads the flashed variant the way scripts/bob_rig_flag.py does', () => {
    expect(deviceRig({ BOB_RIG: '1' })).toBe(true);
    expect(deviceRig({})).toBe(false);
    expect(deviceRig({ BOB_RIG: '0' })).toBe(false);
  });

  it('says why a rig-off build cannot pass, and only for the rig-off build', () => {
    expect(rigOffHint(true)).toBeNull();
    const hint = rigOffHint(false);
    expect(hint).toMatch(/the whole-pose Bob \(rig off\) cannot pass: the goldens are the rig demo/);
    expect(hint).toContain('BOB_RIG=1 npm run visual:gate');
    expect(hint).toMatch(/flash with the same variable set/);
  });

  it('refuses a record judged against other goldens', () => {
    expect(passProblem(record({ goldenManifestSha: 'd'.repeat(64) }), tree)).toMatch(/other goldens/);
  });

  it('refuses when one state failed or is missing', () => {
    expect(passProblem(record({ cases: [{ id: 'ready', pass: true }, { id: 'reply', pass: false }] }), tree)).toMatch(/1\/2 states \(reply\)/);
    expect(passProblem(record({ cases: [{ id: 'ready', pass: true }] }), tree)).toMatch(/\(reply\)/);
  });
});

describe('the rig-off build is judged on its own case list (rig-only moves cannot pass without the rig)', () => {
  const rigOff = variantCases(all, false).map((c) => c.id);
  const rigOn = variantCases(all, true).map((c) => c.id);
  const judged = (ids, rig) => record({
    rig, variant: rig ? 'rig-on' : 'rig-off', caseCount: ids.length, cases: ids.map((id) => ({ id, pass: true })),
  });
  const offTree = { ...tree, cases: rigOff, rig: false };

  it('accepts a rig-off pass made over the rig-off list, for a rig-off flash', () => {
    expect(rigOff).toHaveLength(15);
    expect(passProblem(judged(rigOff, false), offTree)).toBeNull();
  });

  it('refuses that rig-off pass for a rig-on flash', () => {
    expect(passProblem(judged(rigOff, false), { ...tree, cases: rigOn, rig: true })).toMatch(/judged the whole-pose Bob, this flash builds the rig renderer/);
  });

  it('refuses a rig-on 27/27 pass for a rig-off flash, though every case passed', () => {
    expect(passProblem(judged(rigOn, true), offTree)).toMatch(/judged the rig renderer, this flash builds the whole-pose Bob/);
  });

  it('refuses a pass judged over another case list, naming both counts', () => {
    expect(passProblem(judged(rigOn, false), offTree)).toMatch(/judged 27 states, this flash gates 15/);
  });
});

describe('what is gated', () => {
  it('gates the Waveshare envs only', () => {
    expect(isGatedEnv('waveshare-s3-185c')).toBe(true);
    expect(isGatedEnv('waveshare-s3-185c-hil')).toBe(true);
    expect(isGatedEnv('m5stack-cardputer-v2-poc')).toBe(false);
    expect(isGatedEnv(undefined)).toBe(false);
  });

  it('treats round UI, Bob, ring and scene sources as visual', () => {
    for (const p of ['apps/cardputer/src/round_ui_chrome.cpp', 'apps/cardputer/include/round_ui.h', 'libs/bob-device/src/bob_rig.cpp', 'libs/bob-device/src/bob_tokens.h',
      'apps/cardputer/src/round_ring.cpp', 'apps/cardputer/src/scene_engine.cpp', 'apps/cardputer/lib/bob_art/rig/visor.rgb565a8']) {
      expect(VISUAL_SOURCE.test(p)).toBe(true);
    }
    for (const p of ['apps/cardputer/src/main.cpp', 'apps/cardputer/src/audio_capture.cpp', 'apps/cardputer/include/ring_policy.h', 'tools/bob-sim/src/main.cpp', 'libs/bob-device/README.md']) {
      expect(VISUAL_SOURCE.test(p)).toBe(false);
    }
  });
});
