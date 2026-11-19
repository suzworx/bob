#!/usr/bin/env node
/**
 * Stale-doc path check (epic #611, #615): every file or folder named in
 * backticks in the developer docs must exist. Docs that point at files that
 * moved or were deleted send people (and agents) to code that is not there.
 *
 * A backticked span counts as a path when it has no spaces and either ends in
 * a known source/config extension or ends in `/`. It exists when a tracked file
 * (or folder) equals it or ends with `/<path>`, because the docs also use
 * workspace-relative forms such as `store/db.ts` or `schemas.ts`. Generated or
 * git-ignored paths go in GENERATED. Used by `npm run validate`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DOCS = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'docs/log-reference.md'];

const EXT = 'ts|tsx|mjs|cjs|js|jsx|json|jsonc|md|h|hpp|cpp|c|yml|yaml|toml|sql|ini|sh|css|html|txt';
const PATH_RE = new RegExp(`^(?:[\\w@.~-]+/)*[\\w@.~-]+\\.(?:${EXT})$|^(?:[\\w@.~-]+/)+$`, 'u');

/** Paths the docs name that are created at runtime, git-ignored or per-machine, so no tracked file matches. */
export const GENERATED = [
  /^data\//u, /(^|\/)data\/$/u, /(^|\/)data\/[\w.-]+$/u, /^\.env(?:\.|$)/u, /(^|\/)\.env[\w.-]*$/u, /(^|\/)secrets\.h$/u,
  /^\.email-preview\//u, /^node_modules\//u, /^~\//u, /^\.pio\//u, /^dist\//u, /^\.claude\/worktrees\//u,
];

/** Backticked path-like spans of a markdown text, with their 1-based line numbers. */
export function pathsIn(text) {
  const found = [];
  let inFence = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*```/u.test(line)) inFence = !inFence;
    if (inFence) return;
    for (const match of line.matchAll(/`([^`\n]+)`/gu)) {
      const span = match[1].replace(/:\d+(?:-\d+)?$/u, '');
      if (PATH_RE.test(span) && !/^https?:/u.test(span) && !span.includes('*') && !span.includes('<')) {
        found.push({ path: span.replace(/^\.\//u, ''), line: index + 1 });
      }
    }
  });
  return found;
}

/** True when `path` names a tracked file or folder, in full or as a workspace-relative suffix. */
export function exists(path, tracked) {
  if (GENERATED.some((re) => re.test(path))) return true;
  const folder = path.endsWith('/');
  return tracked.some((file) =>
    folder
      ? file.startsWith(path) || file.includes(`/${path}`)
      : file === path || file.endsWith(`/${path}`));
}

function main() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  const missing = [];
  for (const doc of DOCS) {
    for (const { path, line } of pathsIn(readFileSync(resolve(ROOT, doc), 'utf8'))) {
      if (!exists(path, tracked)) missing.push(`${doc}:${line}: \`${path}\` does not exist`);
    }
  }
  if (missing.length === 0) {
    console.log(`doc paths: ok (${DOCS.length} docs)`);
    return;
  }
  console.error(missing.join('\n'));
  console.error(`\n${missing.length} stale path(s) in the docs. Fix the doc, or add a runtime-only path to GENERATED in scripts/check-doc-paths.mjs.`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
