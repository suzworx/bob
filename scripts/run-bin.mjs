/**
 * Runs a dependency's CLI without its node_modules/.bin shim. On Windows that shim
 * is a POSIX sh script beside a .cmd/.ps1 pair, and spawnSync without a shell can run
 * none of them (ENOENT); a shell breaks on a node path under Program Files. So read
 * the package's own "bin" entry and run it with the current node.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path of the JS file behind `command` in package `pkg` (bin may be a string or a map). */
export function resolveBin(pkg, command = pkg.split('/').pop(), root = ROOT) {
  const dir = join(root, 'node_modules', pkg);
  const { bin } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const entry = typeof bin === 'string' ? bin : bin?.[command];
  if (!entry) throw new Error(`${pkg} has no "${command}" bin entry`);
  return join(dir, entry);
}

/** spawnSync of `pkg`'s `command` CLI through process.execPath; no shell. */
export function runBin(pkg, command, args, options = {}) {
  return spawnSync(process.execPath, [resolveBin(pkg, command), ...args], { cwd: ROOT, shell: false, ...options });
}
