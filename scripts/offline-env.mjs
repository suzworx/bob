import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';

/*
 * offline-env.mjs — where the per-machine bob_server password lives.
 *
 * The local Supabase stack is one Docker stack per machine, but data/ is per
 * checkout. When every git worktree kept its own data/offline.env, each test
 * run re-applied ITS password to the shared bob_server role, and a run in
 * another worktree then failed with `password authentication failed for user
 * "bob_server"`. So the file lives in the main checkout's data/, which every
 * worktree of the repo resolves to the same place.
 */

/** The main checkout for `root`: the parent of git's common `.git` dir, or
 *  `root` itself when that cannot be resolved (no git, a bare layout). */
export function mainCheckout(root) {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf8',
  });
  const common = result.status === 0 ? (result.stdout ?? '').trim() : '';
  return common && basename(common) === '.git' ? dirname(common) : root;
}

/** The shared data/offline.env for the checkout at `root`. */
export function offlineEnvPath(root) {
  return join(mainCheckout(root), 'data', 'offline.env');
}
