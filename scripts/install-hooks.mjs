import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * install-hooks.mjs — point git at .githooks (npm `prepare`, so `npm install`
 * enables it). The husky equivalent without the dependency.
 *
 * Silent no-op outside a git checkout (the Docker build runs `npm ci` on a copy
 * of the sources) and in CI, where the hooks would never fire anyway.
 *
 * With `extensions.worktreeConfig` on, a worktree's own config.worktree beats
 * the repo config. Worktree tooling has been seen writing an ABSOLUTE
 * core.hooksPath there, pointing at the main checkout's .githooks: on any
 * branch that predates .githooks that directory does not exist, and git then
 * silently runs no hook at all (12 of 27 worktrees on 2026-09-22). So set the
 * relative path at worktree scope as well; it resolves inside each worktree.
 */

const ROOT = resolve(import.meta.dirname, '..');

if (!process.env.CI && existsSync(resolve(ROOT, '.git'))) {
  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const set = git(['config', 'core.hooksPath', '.githooks']);
  if (git(['config', '--bool', 'extensions.worktreeConfig']).stdout.trim() === 'true') {
    git(['config', '--worktree', 'core.hooksPath', '.githooks']);
  }
  if (set.status === 0) console.log('hooks: git core.hooksPath -> .githooks');
}
