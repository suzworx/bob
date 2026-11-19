import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * firmware-hash.mjs — one number for "the firmware this content builds".
 *
 * The HIL pass record (data/hil-pass.json), the `local/device-hil` status, the
 * pre-push hook and the firmware-hil workflow all compare this hash. It covers
 * the tracked files under apps/cardputer/{src,include,lib} and libs/bob-device (Bob's portable core) plus
 * apps/cardputer/platformio.ini and the cabin PCM build generators, sorted by
 * path, with CRLF normalised to LF so Windows and Linux agree. Other scripts,
 * docs and the HIL harness do not change what runs on the device.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');

export const FIRMWARE_DIRS = ['apps/cardputer/src/', 'apps/cardputer/include/', 'apps/cardputer/lib/', 'libs/bob-device/'];
export const FIRMWARE_FILES = [
  'apps/cardputer/platformio.ini',
  'apps/cardputer/scripts/earcons_wave.py',
  'apps/cardputer/scripts/earcons_build.py',
];
/** The pathspecs git uses to list the inputs. */
export const FIRMWARE_PATHSPECS = [...FIRMWARE_DIRS.map((d) => d.slice(0, -1)), ...FIRMWARE_FILES];

/** True when a repo-relative path feeds the firmware build. */
export function isFirmwareInput(path) {
  const p = String(path ?? '').replace(/\\/g, '/');
  return FIRMWARE_FILES.includes(p) || FIRMWARE_DIRS.some((dir) => p.startsWith(dir));
}

/** sha256 over the sorted inputs. Each entry is length-prefixed, so bytes
 *  cannot move between a path and its content without changing the hash. */
export function firmwareHash(files) {
  const inputs = files
    .map((f) => ({ path: String(f.path).replace(/\\/g, '/'), content: Buffer.from(f.content) }))
    .filter((f) => isFirmwareInput(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash('sha256');
  for (const { path, content } of inputs) {
    const body = Buffer.from(content.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    hash.update(`${path.length}:${path}\n${body.length}:`);
    hash.update(body);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').toString().trim()}`);
  }
  return result.stdout;
}

/** The firmware inputs as committed at `ref` (a commit, branch or tag). */
export function filesAtRef(ref, cwd = ROOT) {
  const names = git(['ls-tree', '-r', '--name-only', ref, '--', ...FIRMWARE_PATHSPECS], cwd)
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
  return names.map((path) => ({ path, content: git(['show', `${ref}:${path}`], cwd) }));
}

/** The tracked firmware inputs as they are on disk (uncommitted edits
 *  included), so the runner can tell when the device ran something HEAD is not. */
export function filesOnDisk(cwd = ROOT) {
  const names = git(['ls-files', '--', ...FIRMWARE_PATHSPECS], cwd)
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
  return names.map((path) => ({ path, content: readFileSync(resolve(cwd, path)) }));
}

export function firmwareHashAt(ref, cwd = ROOT) {
  return firmwareHash(filesAtRef(ref, cwd));
}

export function firmwareHashOnDisk(cwd = ROOT) {
  return firmwareHash(filesOnDisk(cwd));
}
