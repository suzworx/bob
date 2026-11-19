import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { attestDecision, PASS_RECORD, readPassRecord } from '../device-attest.mjs';
import { firmwareHashAt, isFirmwareInput } from './firmware-hash.mjs';

/*
 * push-gate.mjs — the firmware half of .githooks/pre-push.
 *
 * A branch push whose own change against the base (merge-base..local, what
 * its PR will merge; content merged in from the base does not count) touches
 * any firmware-hash input (apps/cardputer/{src,include,lib}, platformio.ini)
 * is refused unless data/hil-pass.json records a
 * passing hardware-in-the-loop run of exactly the firmware being pushed. The
 * owner's rule: firmware that has not run on the device over the cable is a
 * claim, not a result. BOB_SKIP_HOOKS=1 still gets through, with a warning
 * that the firmware-hil PR check will fail without an attested run.
 *
 * The base is the branch PRs merge into: $BOB_PUSH_BASE if set, else
 * origin/<integration.branch> from .flywheel/config.json if set and present,
 * else origin/main. A push to the base branch itself, or to main, is judged
 * on the pushed range. If the base is missing the gate falls back to the
 * pushed range and says so.
 *
 * git feeds the hook "<local ref> <local sha> <remote ref> <remote sha>" per
 * ref on stdin; the hook pipes it here. Exit 0 allows, 1 blocks.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
export const ZERO_SHA = '0'.repeat(40);
const RUN_HINT =
  '  node scripts/hil/run.mjs            flash the hil env and run every scenario on the device\n' +
  '  node scripts/device-attest.mjs      after pushing, publish the pass for the PR check\n' +
  '  docs/cardputer/hil.md               wiring, scenarios, evidence';

export function parsePushLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

/**
 * refs: [{ localSha, changedFiles, firmwareHash }] where firmwareHash is the
 * hash at localSha. Returns { allow, message }.
 */
export function decidePush({ refs, record, skip = false }) {
  const touching = refs.filter((r) => r.localSha !== ZERO_SHA && r.changedFiles.some(isFirmwareInput));
  if (touching.length === 0) return { allow: true, message: '' };
  const files = [...new Set(touching.flatMap((r) => r.changedFiles.filter(isFirmwareInput)))];
  const listed = files.slice(0, 8).map((f) => `    ${f}`).join('\n') + (files.length > 8 ? `\n    … ${files.length - 8} more` : '');

  const refusals = touching.map((r) => attestDecision(record, r.firmwareHash)).filter((d) => !d.ok);
  if (refusals.length === 0) {
    return { allow: true, message: `pre-push: firmware change backed by HIL run ${record.run_id} on the device.` };
  }
  const why = [...new Set(refusals.map((d) => d.reason))].join('; ');
  if (skip) {
    return {
      allow: true,
      message:
        '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
        'pre-push: WARNING — BOB_SKIP_HOOKS=1 is pushing UNTESTED FIRMWARE.\n' +
        `  ${why}.\n  Changed firmware inputs:\n${listed}\n` +
        '  Nothing proves this runs on the device. The firmware-hil PR check will\n' +
        '  fail until a HIL run of this exact firmware is attested:\n' + RUN_HINT + '\n' +
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n',
    };
  }
  return {
    allow: false,
    message:
      '\npre-push: BLOCKED — this push changes Cardputer firmware that has not passed\n' +
      `the hardware-in-the-loop run on a device (${why}).\n  Changed firmware inputs:\n${listed}\n\n` +
      'Plug the Cardputer in over USB and run:\n' + RUN_HINT + '\n' +
      `A passing run writes ${PASS_RECORD}; push again after it.\n`,
  };
}

function git(args, cwd = ROOT) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? (result.stdout ?? '').trim() : null;
}

const hasRemoteBranch = (name, cwd) =>
  git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}^{commit}`], cwd) !== null;

/** integration.branch from .flywheel/config.json, or null. */
function integrationBranch(cwd) {
  try {
    const branch = JSON.parse(readFileSync(resolve(cwd, '.flywheel', 'config.json'), 'utf8'))?.integration?.branch;
    return typeof branch === 'string' && branch ? branch : null;
  } catch {
    return null;
  }
}

/** The ref a branch is judged against, the one its PR merges into:
 *  BOB_PUSH_BASE if set, else origin/<integration.branch> from
 *  .flywheel/config.json if set and present, else origin/main. */
export function resolveBase(cwd = ROOT, env = process.env) {
  if (env.BOB_PUSH_BASE) return env.BOB_PUSH_BASE;
  const integration = integrationBranch(cwd);
  if (integration && hasRemoteBranch(integration, cwd)) return `origin/${integration}`;
  return 'origin/main';
}

/** Pushes to these branches are judged on the pushed range: main, and the
 *  branch the base tracks (origin/release -> refs/heads/release). */
function baseBranchRefs(base) {
  const name = base.replace(/^refs\/remotes\/[^/]+\//, '').replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  return new Set(['refs/heads/main', `refs/heads/${name}`]);
}

const unavailableNote = (base) =>
  `pre-push: ${base} is unavailable, so the firmware gate judged the pushed range instead of the branch’s own change.`;

/** The pushed range: the diff from the remote tip, or for a new branch from
 *  its merge-base with the base. No base at all means "everything". */
function pushedRange(localSha, remoteSha, base, cwd) {
  let from = remoteSha !== ZERO_SHA && git(['cat-file', '-e', `${remoteSha}^{commit}`], cwd) !== null ? remoteSha : null;
  if (!from) from = git(['merge-base', localSha, base], cwd);
  const out = from
    ? git(['diff', '--name-only', from, localSha], cwd)
    : git(['ls-tree', '-r', '--name-only', localSha], cwd);
  return out === null ? ['apps/cardputer/platformio.ini'] : out.split('\n').filter(Boolean);
}

/** What a branch push is judged on: the branch's own change against the base
 *  (merge-base..local, what the PR will merge), so content merged in from
 *  the base never counts. A push to the base branch itself (or main) is
 *  judged on the pushed range. */
function changedFiles({ localSha, remoteRef, remoteSha }, base, cwd) {
  if (baseBranchRefs(base).has(remoteRef)) return { files: pushedRange(localSha, remoteSha, base, cwd), note: '' };
  const from = git(['merge-base', localSha, base], cwd);
  const out = from ? git(['diff', '--name-only', from, localSha], cwd) : null;
  if (out === null) return { files: pushedRange(localSha, remoteSha, base, cwd), note: unavailableNote(base) };
  return { files: out.split('\n').filter(Boolean), note: '' };
}

/** The whole hook: git's pre-push stdin in, a decision out. */
export function judgePush({ stdin, record, skip = false, cwd = ROOT, env = process.env }) {
  const notes = new Set();
  const base = resolveBase(cwd, env);
  const refs = parsePushLines(stdin).map((r) => {
    if (r.localSha === ZERO_SHA) return { ...r, changedFiles: [], firmwareHash: '' };
    const { files, note } = changedFiles(r, base, cwd);
    if (note) notes.add(note);
    return { ...r, changedFiles: files, firmwareHash: files.some(isFirmwareInput) ? firmwareHashAt(r.localSha, cwd) : '' };
  });
  const decision = decidePush({ refs, record, skip });
  const message = [...notes, decision.message].filter(Boolean).join('\n');
  return { ...decision, message };
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const decision = judgePush({
    stdin: readFileSync(0, 'utf8'),
    record: readPassRecord(ROOT),
    skip: process.env.BOB_SKIP_HOOKS === '1',
  });
  if (decision.message) (decision.allow ? console.log : console.error)(decision.message);
  process.exit(decision.allow ? 0 : 1);
}
