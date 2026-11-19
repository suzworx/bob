import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { STATUS_CONTEXT } from './validate-attest.mjs';

/*
 * validate-attested.mjs — CI side of the local validate gate.
 *
 * Writes `attested=true|false` to $GITHUB_OUTPUT. When it is true, the validate
 * job skips the suite: the identical content already passed `npm run validate`
 * on a developer machine and said so with the `local/validate` commit status
 * (scripts/validate-attest.mjs). That keeps the paid runner for content nobody
 * has validated.
 *
 * What counts as "identical content" depends on the event:
 *   pull_request — the status must belong to the PR's head commit.
 *   push (main)  — the merge commit's TREE must equal the tree the status
 *                  vouches for, which holds for a squash merge of a branch that
 *                  was up to date with main.
 *
 * Any doubt resolves to false: a missing status, an API failure, or a tree that
 * does not match runs the suite.
 */

const ROOT = resolve(import.meta.dirname, '..');

/** The tree hash a status description vouches for, or null. */
export function treeFromDescription(description) {
  const match = /^tree=([0-9a-f]{40})$/.exec((description ?? '').trim());
  return match ? match[1] : null;
}

/** The tree vouched for by the newest successful status of `context` (local/validate by default). */
export function attestedTree(statuses, context = STATUS_CONTEXT) {
  const hit = (Array.isArray(statuses) ? statuses : [])
    .filter((status) => status?.context === context && status?.state === 'success')
    .sort((a, b) => Date.parse(b?.created_at ?? 0) - Date.parse(a?.created_at ?? 0))[0];
  return hit ? treeFromDescription(hit.description) : null;
}

/** The whole decision, kept pure so the scripts suite can drive every branch. */
export function decide({ event, attested, headTree, currentTree }) {
  if (!attested) return false;
  if (event === 'pull_request') return Boolean(headTree) && attested === headTree;
  return Boolean(currentTree) && attested === currentTree;
}

function gh(args) {
  const result = spawnSync('gh', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    // A 403 here means the job's token lacks statuses/pull-requests read, which
    // silently costs a full suite every run. Say so; the caller still runs it.
    console.log(`gh ${args[1]} failed: ${(result.stderr ?? '').trim().slice(0, 200)}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout ?? '');
  } catch {
    return null;
  }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const event = process.env.GITHUB_EVENT_NAME ?? '';
  const repo = process.env.GITHUB_REPOSITORY ?? 'suzworx/Bob';
  const currentTree = git(['rev-parse', 'HEAD^{tree}']);

  // The commit that carries the status: a PR's head, or the PR a main commit
  // was merged from.
  let target = '';
  if (event === 'pull_request') {
    try {
      const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
      target = payload?.pull_request?.head?.sha ?? '';
    } catch {
      target = '';
    }
  } else {
    const sha = process.env.GITHUB_SHA ?? '';
    const pulls = sha ? gh(['api', `repos/${repo}/commits/${sha}/pulls`]) : null;
    target = Array.isArray(pulls) ? (pulls[0]?.head?.sha ?? '') : '';
  }

  const statuses = target ? gh(['api', `repos/${repo}/commits/${target}/statuses`]) : null;
  const attested = attestedTree(statuses);
  const headCommit = target ? gh(['api', `repos/${repo}/commits/${target}`]) : null;
  const headTree = headCommit?.commit?.tree?.sha ?? '';

  const skip = decide({ event, attested, headTree, currentTree });
  const output = process.env.GITHUB_OUTPUT;
  if (output) spawnSync('bash', ['-c', `echo "attested=${skip}" >> "${output}"`]);

  console.log(
    skip
      ? `local/validate vouches for this content (tree ${String(attested).slice(0, 12)}); skipping the suite.`
      : 'no local/validate status for this content; running the suite.',
  );
}
