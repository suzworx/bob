import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { attestedTree } from './validate-attested.mjs';

/*
 * ci-reuse.mjs — main reuses the PR run that already tested this exact tree (#1033, #1307).
 *
 * A pull request run checks out the PR's merge ref. When its test jobs pass,
 * ci.yml's `tree-pass` job posts the commit status `ci/tree-pass` on the PR
 * head, with `tree=<merge-ref tree>` as its description. A squash merge of a
 * branch that was up to date with main produces a main commit with that same
 * tree, so the web/server/db/integration/e2e suites would run on content they
 * already passed.
 *
 * On a main push this writes `reuse=true|false` to $GITHUB_OUTPUT, and ci.yml
 * skips the test jobs when it is true. The migrations, firmware, docker
 * and release jobs always run as their scope says.
 *
 * Any doubt resolves to false: another event, a missing or failed status, an
 * API failure, or a tree that does not match runs everything.
 */

export const STATUS_CONTEXT = 'ci/tree-pass';

const ROOT = resolve(import.meta.dirname, '..');

/** The whole decision, kept pure so the scripts suite can drive every branch. */
export function decide({ event, ref, passedTree, currentTree }) {
  if (event !== 'push' || ref !== 'refs/heads/main') return false;
  return Boolean(passedTree) && Boolean(currentTree) && passedTree === currentTree;
}

function gh(args) {
  const result = spawnSync('gh', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    console.log(`gh ${args[1]} failed: ${(result.stderr ?? '').trim().slice(0, 200)}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout ?? '');
  } catch {
    return null;
  }
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const event = process.env.GITHUB_EVENT_NAME ?? '';
  const ref = process.env.GITHUB_REF ?? '';
  const repo = process.env.GITHUB_REPOSITORY ?? 'suzworx/Bob';
  const sha = process.env.GITHUB_SHA ?? '';
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8' });
  const currentTree = tree.status === 0 ? tree.stdout.trim() : '';

  let passedTree = null;
  let pr = null;
  if (event === 'push' && sha) {
    const pulls = gh(['api', `repos/${repo}/commits/${sha}/pulls`]);
    pr = Array.isArray(pulls) ? pulls[0] : null;
    const head = pr?.head?.sha;
    passedTree = head ? attestedTree(gh(['api', `repos/${repo}/commits/${head}/statuses`]), STATUS_CONTEXT) : null;
  }

  const reuse = decide({ event, ref, passedTree, currentTree });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${reuse}\n`);
  const line = reuse
    ? `Reusing the passing run of #${pr.number} (tree ${currentTree.slice(0, 12)}): web, server, db, integration and e2e are skipped.`
    : `No ${STATUS_CONTEXT} for tree ${currentTree.slice(0, 12) || '?'}${pr ? ` on #${pr.number}` : ''}; the suites run.`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}
