import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { computeNext, readCommits } from './next-version.mjs';

/*
 * fw-version.mjs — the firmware version build flags (#345), printed on one
 * line for platformio.ini's `!node ...` build_flags entry.
 *
 * A release build (the CI release job on main sets BOB_FW_VERSION to the
 * version it tags) gets -DBOB_FW_VERSION=x.y.z. Any other
 * build gets -DBOB_FW_DEV_VERSION=<the next version>, and the firmware reports
 * "<x.y.z>-dev+<sha>" (include/types.h). Both get -DBOB_FW_BUILD=<short sha>
 * when git is available. The values are bare tokens: types.h stringifies them.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const RELEASE_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const SHA_RE = /^[0-9a-f]{4,12}$/;
// The server's FirmwareVersionSchema bound (apps/api/src/voice/protocol.ts).
export const FW_VERSION_MAX = 32;

// Build flags for a release version or a dev base version plus a short sha.
// Throws on a malformed version so a bad release never builds.
export function fwBuildFlags({ release, base, sha }) {
  const build = SHA_RE.test(sha ?? '') ? sha : '';
  const buildFlag = build ? ` -DBOB_FW_BUILD=${build}` : '';
  if (release) {
    if (!RELEASE_RE.test(release)) throw new Error(`BOB_FW_VERSION is not x.y.z: ${release}`);
    return `-DBOB_FW_VERSION=${release}${buildFlag}`;
  }
  if (!RELEASE_RE.test(base)) throw new Error(`dev base version is not x.y.z: ${base}`);
  const reported = `${base}-dev${build ? `+${build}` : ''}`;
  if (reported.length > FW_VERSION_MAX) throw new Error(`firmware version over ${FW_VERSION_MAX} chars: ${reported}`);
  return `-DBOB_FW_DEV_VERSION=${base}${buildFlag}`;
}

// The version a dev build is heading for: the next release, else the last tag.
export function devBaseVersion(decision) {
  return decision.next || decision.current || '0.0.0';
}

function main() {
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const sha = head.status === 0 ? head.stdout.trim() : '';
  const release = (process.env.BOB_FW_VERSION ?? '').trim();
  const base = release ? '' : devBaseVersion(computeNext(readCommits()));
  process.stdout.write(`${fwBuildFlags({ release, base, sha })}\n`);
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === new URL(`file://${resolve(process.argv[1]).replace(/\\/g, '/')}`).href;

if (isDirectRun) main();
