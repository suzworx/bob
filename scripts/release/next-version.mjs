import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/*
 * next-version.mjs — compute the next semver version from the conventional
 * commits since the last vX.Y.Z tag.
 *
 * Pure helpers are exported for the node --test suite; the git-reading CLI
 * runs only when this file is the entry point.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');

const MERGE_RE = /^Merge pull request #(\d+) from /;
const SUBJECT_RE = /^(feat|fix|perf|refactor|docs|test|chore|ci|build|style|revert)(\(([a-z0-9/-]+)\))?(!)?: (.+)$/;
const PATCH_TYPES = new Set(['fix', 'perf', 'refactor', 'docs', 'revert']);

// Parse a raw commit ({ sha, subject, body }) into a structured record. Merge
// commits are kept with their PR number and the first non-empty body line (the
// PR title) so notes can link back to them. Returns null for the merge commit
// itself when there is no subject/body — the caller filters.
export function parseCommit({ sha, subject, body }) {
  const merge = MERGE_RE.exec(subject || '');
  if (merge) {
    const title = (body || '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) || '';
    return { sha, type: 'merge', scope: null, breaking: false, description: subject, pr: Number(merge[1]), title };
  }
  const parsed = SUBJECT_RE.exec(subject || '');
  if (!parsed) {
    return { sha, type: 'other', scope: null, breaking: false, description: subject || '', pr: null };
  }
  const [, type, , scope, bang, description] = parsed;
  const bodyText = body || '';
  const breaking = Boolean(bang) || /(^|\n)BREAKING CHANGE:/.test(bodyText);
  const prMatch = /\(#(\d+)\)/.exec(description);
  return {
    sha,
    type,
    scope: scope || null,
    breaking,
    description,
    pr: prMatch ? Number(prMatch[1]) : null,
  };
}

// Decide the bump for a list of parsed commits, highest wins. A breaking
// change is major while the major is > 0, but only minor while the major is 0.
export function computeBump(commits, current) {
  const major = Number(String(current).split('.')[0]) || 0;
  let bump = 'none';
  const rank = { none: 0, patch: 1, minor: 2, major: 3 };
  const raise = (next) => {
    if (rank[next] > rank[bump]) bump = next;
  };
  for (const commit of commits) {
    if (commit.type === 'merge' || commit.type === 'other') continue;
    if (commit.breaking) {
      raise(major === 0 ? 'minor' : 'major');
    } else if (commit.type === 'feat') {
      raise('minor');
    } else if (PATCH_TYPES.has(commit.type)) {
      raise('patch');
    }
  }
  return bump;
}

// Apply a bump to a current version string.
export function applyBump(current, bump) {
  const [major, minor, patch] = String(current).split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  return null;
}

// The commit range covered by a release: lastTag..HEAD when a tag exists,
// else the whole history. Shared by version and notes so they cannot disagree.
export function resolveRange(lastTag) {
  return lastTag ? `${lastTag}..HEAD` : 'HEAD';
}

// Read the commits since the last matching tag (or since the root) as records.
export function readCommits(cwd = ROOT) {
  const described = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], { cwd, encoding: 'utf8' });
  const tagged = described.status === 0 ? described.stdout.trim() : '';
  const range = resolveRange(tagged);
  const format = '--format=%H%x1f%s%x1f%b%x1e';
  const args = ['log', format, range];
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  const raw = result.stdout || '';
  const commits = raw
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, subject, body] = chunk.split('\x1f');
      return parseCommit({ sha, subject, body });
    });
  const current = tagged ? tagged.replace(/^v/, '') : '0.0.0';
  const first = !tagged;
  return { current, first, commits };
}

// Compute the whole release decision for a range.
export function computeNext({ current, first, commits }) {
  const bump = computeBump(commits, current);
  if (first) {
    return { current: null, next: '0.1.0', bump: 'minor', commits };
  }
  const next = applyBump(current, bump);
  return { current, next, bump, commits };
}

function main() {
  const decision = computeNext(readCommits());
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${decision.next || 'none'}\n`);
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === new URL(`file://${resolve(process.argv[1]).replace(/\\/g, '/')}`).href;

if (isDirectRun) main();