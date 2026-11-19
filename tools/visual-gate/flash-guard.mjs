// The Waveshare flash gate: no build reaches the round screen unless the visual gate passed for exactly the
// firmware on disk. Every flash path (apps/cardputer/scripts/run-pio.mjs, scripts/hil/run.mjs) asks here first.
// data/visual-pass.json is written by tools/visual-gate/gate.mjs.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import { firmwareHashOnDisk } from '../../scripts/hil/firmware-hash.mjs';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const PASS_FILE = 'data/visual-pass.json';
export const FORCE_LOG = 'data/visual-gate/force-unsafe.log';
export const FORCE_FLAG = '--force-unsafe';

/** The sources whose change makes `npm run validate` require a visual pass: the round UI, Bob, the ring light
 *  (round_ring*; ring_policy.h is audio), scenes, the art they draw, and Bob's portable core (libs/bob-device/src). */
export const VISUAL_SOURCE = /^(?:apps\/cardputer\/(?:(?:src|include)\/(?:round_ui|round_ring|bob_|scene)[^/]*|lib\/bob_art\/.*|assets\/bob\/.*)|libs\/bob-device\/src\/.*)$/;

/** Files changed against origin/main (committed, staged, unstaged or untracked) that the visual gate covers. */
export function visualSourcesChanged(root = ROOT) {
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const base = git(['merge-base', 'origin/main', 'HEAD']).stdout.trim() || 'HEAD';
  const lines = (args) => git(args).stdout.split(/\r?\n/);
  const names = [...lines(['diff', '--name-only', base]), ...lines(['ls-files', '--others', '--exclude-standard'])];
  return [...new Set(names.filter((n) => VISUAL_SOURCE.test(n)))];
}

/** The rig variant a flash from this environment builds: on only with BOB_RIG=1. Keep in step with
 *  apps/cardputer/scripts/bob_rig_flag.py, which makes that decision for the device build. */
export const deviceRig = (env = process.env) => env.BOB_RIG === '1';

/** Why a rig-off run cannot pass (its goldens are the rig demo), or null for the rig variant. */
export const rigOffHint = (rig) => (rig ? null
  : 'the whole-pose Bob (rig off) cannot pass: the goldens are the rig demo. Gate a rig build with BOB_RIG=1 npm run visual:gate and flash with the same variable set');

/** The cases one Bob variant is judged on: the rig renderer draws the moves, the whole-pose Bob has none. */
export const variantCases = (cases, rig) => cases.filter((c) => rig || !c.rigOnly);

/** Only the round-screen boards are gated; the Cardputer has no round UI. */
export const isGatedEnv = (env) => String(env ?? '').startsWith('waveshare-');

export const goldenManifestSha = (root = ROOT) =>
  createHash('sha256').update(readFileSync(resolve(root, 'docs/waveshare/golden/manifest.json'))).digest('hex');

/** Why the record does not allow a flash of this tree, or null when it does. */
export function passProblem(record, { firmwareHash, manifestSha, cases, rig }) {
  if (!record) return `no ${PASS_FILE}; run: npm run visual:gate`;
  if (record.firmwareHash !== firmwareHash) return `${PASS_FILE} is for firmware ${String(record.firmwareHash).slice(0, 12)}, the tree on disk is ${firmwareHash.slice(0, 12)}; run: npm run visual:gate`;
  if (record.source !== 'bob-sim') return `${PASS_FILE} was not rendered from this firmware by bob-sim; run: npm run visual:gate`;
  if (record.rig !== rig) {
    const v = (r) => (r === true ? 'the rig renderer' : r === false ? 'the whole-pose Bob' : 'an unknown Bob variant');
    return `${PASS_FILE} judged ${v(record.rig)}, this flash builds ${v(rig)} (BOB_RIG=${rig ? 1 : 'unset'}); run the gate the same way`;
  }
  if (record.goldenManifestSha !== manifestSha) return `${PASS_FILE} was judged against other goldens; run: npm run visual:gate`;
  if (record.caseCount !== cases.length) {
    return `${PASS_FILE} judged ${record.caseCount} states, this flash gates ${cases.length} (${record.variant ?? 'no variant'}); run: npm run visual:gate`;
  }
  const results = new Map((record.cases ?? []).map((c) => [c.id, c]));
  const failed = cases.filter((id) => results.get(id)?.pass !== true);
  if (failed.length) return `the visual gate did not pass ${failed.length}/${cases.length} states (${failed.join(', ')}); see data/visual-gate/report/`;
  return null;
}

export function checkVisualPass(root = ROOT, rig = deviceRig()) {
  const file = resolve(root, PASS_FILE);
  let record = null;
  try { record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { record = null; }
  const { cases } = JSON.parse(readFileSync(resolve(root, 'tools/visual-gate/cases.json'), 'utf8'));
  return passProblem(record, { firmwareHash: firmwareHashOnDisk(root), manifestSha: goldenManifestSha(root), cases: variantCases(cases, rig).map((c) => c.id), rig });
}

/**
 * Refuses (exit 3) a flash of a gated env without a visual pass. `--force-unsafe` on the command line lets it
 * through, loudly, and appends a line to data/visual-gate/force-unsafe.log.
 */
export function guardFlash(env, argv = process.argv, root = ROOT) {
  if (!isGatedEnv(env)) return;
  const problem = checkVisualPass(root);
  if (!problem) {
    console.log(`[visual-gate] PASS on record for this firmware; flashing ${env}.`);
    return;
  }
  const forced = argv.includes(FORCE_FLAG);
  if (!forced) {
    const hint = rigOffHint(deviceRig());
    console.error(`\n[visual-gate] REFUSED: ${env} is not flashed. ${problem}\n` +
      `[visual-gate] Fix the build until the gate passes, or flash anyway with ${FORCE_FLAG} (logged).\n` +
      (hint ? `[visual-gate] hint: ${hint}\n` : ''));
    process.exit(3);
  }
  const line = `${new Date().toISOString()} env=${env} firmware=${firmwareHashOnDisk(root).slice(0, 12)} reason="${problem}"\n`;
  mkdirSync(dirname(resolve(root, FORCE_LOG)), { recursive: true });
  appendFileSync(resolve(root, FORCE_LOG), line);
  const bar = '!'.repeat(78);
  console.error(`\n${bar}\n[visual-gate] ${FORCE_FLAG}: FLASHING A BUILD THE VISUAL GATE DID NOT PASS\n[visual-gate] ${problem}\n` +
    `[visual-gate] logged to ${FORCE_LOG}\n${bar}\n`);
}
