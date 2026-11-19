import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { firmwareHashAt } from './hil/firmware-hash.mjs';

/*
 * device-attest.mjs — publish a hardware-in-the-loop pass to GitHub.
 *
 * `node scripts/hil/run.mjs` writes data/hil-pass.json when every scenario ran
 * on a real Cardputer over the USB cable and none failed. After pushing,
 * `node scripts/device-attest.mjs` posts it as the `local/device-hil` commit
 * status on HEAD; the firmware-hil workflow then accepts a PR that changes
 * firmware only when that status names the PR head's firmware hash.
 *
 * The record is keyed by the FIRMWARE hash (scripts/hil/firmware-hash.mjs),
 * not the tree: a docs or server edit after the run keeps the pass, while any
 * byte of firmware source, header, library or platformio.ini invalidates it.
 * This mirrors scripts/validate-attest.mjs; the pure helpers are exported for
 * the scripts suite and the CLI body runs only when this is the entry point.
 */

const ROOT = resolve(import.meta.dirname, '..');

export const PASS_RECORD = 'data/hil-pass.json';
export const STATUS_CONTEXT = 'local/device-hil';
const STATUSES = new Set(['pass', 'fail', 'skip']);

/** The device id the HIL build's `T ping` reports (`id=`): the first 12 hex
 *  digits of sha256 over the MAC as 12 lowercase hex digits, the same as
 *  apps/cardputer/src/test_console.cpp deviceId(). Null for anything that is
 *  not a MAC. The device computes it, so the raw MAC never reaches serial,
 *  the run logs, the record, the status or a PR. */
export function deviceIdFromMac(mac) {
  const normalised = String(mac ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return normalised.length === 12 ? createHash('sha256').update(normalised).digest('hex').slice(0, 12) : null;
}

/** A `T ping` id as recorded (12 lowercase hex digits), or null. */
export function normaliseDeviceId(id) {
  const value = String(id ?? '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(value) ? value : null;
}

export function makePassRecord({ firmwareHash, tree, runId, scenarios, deviceId, ts, runnerVersion }) {
  return {
    firmware_hash: firmwareHash,
    tree,
    run_id: runId,
    scenarios,
    device_id_hash: normaliseDeviceId(deviceId),
    ts,
    runner_version: runnerVersion,
  };
}

/** Counts, and whether the run proves anything: no failure, nothing
 *  unrecognised, and at least one scenario that actually passed. */
export function recordVerdict(record) {
  const list = Array.isArray(record?.scenarios) ? record.scenarios : [];
  const count = (status) => list.filter((s) => s?.status === status).length;
  const verdict = { pass: count('pass'), fail: count('fail'), skip: count('skip') };
  const known = list.every((s) => STATUSES.has(s?.status));
  const hashOk = /^[0-9a-f]{64}$/.test(record?.firmware_hash ?? '');
  return { ok: hashOk && known && verdict.fail === 0 && verdict.pass > 0, ...verdict };
}

/** Whether `record` may be attested for firmware `headHash`, and why not. */
export function attestDecision(record, headHash) {
  if (!record) return { ok: false, reason: `no ${PASS_RECORD}` };
  const verdict = recordVerdict(record);
  if (!verdict.ok) {
    return { ok: false, reason: `run ${record.run_id ?? '?'} is not a pass (${verdict.pass} passed, ${verdict.fail} failed, ${verdict.skip} skipped)` };
  }
  if (record.firmware_hash !== headHash) {
    return { ok: false, reason: `the run tested firmware ${record.firmware_hash.slice(0, 12)}, this commit builds ${String(headHash).slice(0, 12)}` };
  }
  return { ok: true };
}

export function statusDescription(record) {
  const { pass, fail, skip } = recordVerdict(record);
  return `run=${record.run_id} pass=${pass} fail=${fail} skip=${skip} fw=${record.firmware_hash}`;
}

export function statusArgs(repo, sha, record) {
  return [
    'api', '-X', 'POST', `repos/${repo}/statuses/${sha}`,
    '-f', 'state=success',
    '-f', `context=${STATUS_CONTEXT}`,
    '-f', `description=${statusDescription(record)}`,
  ];
}

export function readPassRecord(root = ROOT) {
  try {
    return JSON.parse(readFileSync(resolve(root, PASS_RECORD), 'utf8'));
  } catch {
    return null;
  }
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim();
  if (!sha) {
    console.error('attest:device: not a git checkout.');
    process.exit(1);
  }
  const decision = attestDecision(readPassRecord(), firmwareHashAt('HEAD'));
  if (!decision.ok) {
    console.error(`attest:device: ${decision.reason}.\nRun \`node scripts/hil/run.mjs\` with the Cardputer on the cable, then re-run this.`);
    process.exit(1);
  }
  const repo = process.env.BOB_REPO ?? 'suzworx/Bob';
  const known = spawnSync('gh', ['api', `repos/${repo}/commits/${sha}`, '--jq', '.sha'], { cwd: ROOT, encoding: 'utf8' });
  if (known.status !== 0) {
    console.error(`attest:device: GitHub does not have ${sha.slice(0, 12)} yet. Push the branch, then re-run.`);
    process.exit(1);
  }
  const record = readPassRecord();
  const posted = spawnSync('gh', statusArgs(repo, sha, record), { cwd: ROOT, stdio: 'inherit' });
  if (posted.status !== 0) {
    console.error('attest:device: `gh api` failed. Is the GitHub CLI signed in?');
    process.exit(1);
  }
  console.log(`\nattest:device: ${STATUS_CONTEXT} posted for ${sha.slice(0, 12)} (${statusDescription(record)}).`);
}
