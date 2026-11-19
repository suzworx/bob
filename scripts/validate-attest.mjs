import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/*
 * validate-attest.mjs — publish the local validate gate's result to GitHub.
 *
 * `npm run validate` writes data/validate-pass.json on PASS (tree hash + when).
 * After pushing, `npm run attest` posts that result as the `local/validate`
 * commit status on HEAD, and CI's validate job then skips the suite it would
 * otherwise re-run on a paid runner (scripts/validate-attested.mjs).
 *
 * The record is keyed by the git TREE hash, not the commit, so amending a
 * message or rebasing onto an unchanged base keeps the pass; changing a single
 * byte of content invalidates it.
 *
 * The pure helpers are exported for the scripts suite; the CLI body runs only
 * when this file is the entry point.
 */

const ROOT = resolve(import.meta.dirname, '..');

export const PASS_RECORD = 'data/validate-pass.json';
export const STATUS_CONTEXT = 'local/validate';

/** True when `git status --porcelain` shows nothing left to commit, so HEAD's
 *  tree really is the content the gate just ran against. */
export function isCleanTree(porcelain) {
  return (porcelain ?? '').trim() === '';
}

/** The tree hash a pass record vouches for, or null when it is unusable. */
export function recordTree(record) {
  const tree = record?.tree;
  return typeof tree === 'string' && /^[0-9a-f]{40}$/.test(tree) ? tree : null;
}

/** True when the record vouches for exactly this tree. */
export function isFresh(record, tree) {
  return recordTree(record) !== null && recordTree(record) === tree;
}

/** The `gh api` argv that posts the status. The tree rides in the description
 *  so CI can tell which content passed, not just which commit. */
export function statusArgs(repo, sha, tree) {
  return [
    'api',
    '-X',
    'POST',
    `repos/${repo}/statuses/${sha}`,
    '-f',
    'state=success',
    '-f',
    `context=${STATUS_CONTEXT}`,
    '-f',
    `description=tree=${tree}`,
  ];
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const sha = git(['rev-parse', 'HEAD']);
  if (!tree || !sha) {
    console.error('attest: not a git checkout.');
    process.exit(1);
  }

  let record = null;
  try {
    record = JSON.parse(readFileSync(resolve(ROOT, PASS_RECORD), 'utf8'));
  } catch {
    // no record; reported below
  }

  if (!isFresh(record, tree)) {
    console.error(
      `attest: no local validate PASS for the current tree (${tree.slice(0, 12)}).\n` +
        'Run `npm run validate` (it records the pass), then `npm run attest`.',
    );
    process.exit(1);
  }

  const repo = process.env.BOB_REPO ?? 'suzworx/Bob';

  // The status can only be attached to a commit GitHub already has. `git
  // ls-remote` matches ref NAMES, not commit ids, so ask the API instead.
  const known = spawnSync('gh', ['api', `repos/${repo}/commits/${sha}`, '--jq', '.sha'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (known.status !== 0) {
    console.error(`attest: GitHub does not have ${sha.slice(0, 12)} yet. Push the branch, then re-run.`);
    process.exit(1);
  }

  const posted = spawnSync('gh', statusArgs(repo, sha, tree), { cwd: ROOT, stdio: 'inherit' });
  if (posted.status !== 0) {
    console.error('attest: `gh api` failed. Is the GitHub CLI signed in?');
    process.exit(1);
  }
  console.log(`\nattest: ${STATUS_CONTEXT} posted for ${sha.slice(0, 12)} (tree ${tree.slice(0, 12)}).`);
  console.log("CI's validate job will skip the suite for this content.");
}
