import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { scanSecrets } from '../validate.mjs';
import { parseCommit, resolveRange } from './next-version.mjs';

/*
 * release-notes.mjs — human-readable markdown notes for a commit range.
 *
 * Default range is the last vX.Y.Z tag..HEAD; --preview prints those same
 * notes to stdout for a human without changing the range. Lines matching a
 * credential pattern are dropped so notes can never leak a secret.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['docs', 'Docs'],
  ['test', 'Tests'],
  ['chore', 'Chores'],
];

function readRange(range, cwd = ROOT) {
  const format = '--format=%H%x1f%s%x1f%b%x1e';
  const result = spawnSync('git', ['log', format, range], { cwd, encoding: 'utf8' });
  return (result.stdout || '')
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, subject, body] = chunk.split('\x1f');
      return parseCommit({ sha, subject, body });
    });
}

// True when the rendered line carries credential-shaped content.
export function isSecretLine(line) {
  return scanSecrets(line).length > 0;
}

// Build the full markdown document from parsed commits.
export function buildNotes(commits) {
  const features = commits.filter((c) => c.type === 'feat');
  const highlights = features
    .filter((c) => c.scope !== 'flywheel')
    .map((c) => {
      const label = c.scope ? `**${c.scope}**: ` : '';
      return `- ${label}${c.description}${link(c)}`;
    });

  const lines = [];
  lines.push('## Highlights');
  lines.push('');
  if (highlights.length > 0) {
    lines.push(...highlights);
  } else {
    lines.push('- Maintenance release.');
  }
  lines.push('');

  for (const [type, heading] of SECTIONS) {
    const entries = commits.filter((c) => c.type === type);
    if (entries.length === 0) continue;
    const body = entries.map((c) => `- ${c.description}${link(c)}`);
    if (type === 'chore') {
      lines.push('<details><summary>Chores</summary>');
      lines.push('');
      lines.push(...body);
      lines.push('');
      lines.push('</details>');
    } else {
      lines.push(`## ${heading}`);
      lines.push('');
      lines.push(...body);
    }
    lines.push('');
  }

  return lines
    .filter((line) => !isSecretLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n';
}

function link(commit) {
  const sha = commit.sha ? commit.sha.slice(0, 7) : '';
  const pr = commit.pr ? ` (#${commit.pr})` : '';
  return sha ? ` (\`${sha}\`${pr})` : pr;
}

function main() {
  const described = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], { cwd: ROOT, encoding: 'utf8' });
  const tagged = described.status === 0 ? described.stdout.trim() : '';
  const range = resolveRange(tagged);
  process.stdout.write(buildNotes(readRange(range)));
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === new URL(`file://${resolve(process.argv[1]).replace(/\\/g, '/')}`).href;

if (isDirectRun) main();