import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/*
 * release-check.mjs — the one-command release gate.
 *
 * Steps run in order with streamed output, then a final PASS/FAIL table:
 *   - git working tree clean (warn only)
 *   - `node scripts/validate.mjs` (--skip-firmware is passed through)
 *   - `docker build -t bob:release-check .` (FAIL when docker is missing,
 *     unless --skip-docker)
 *   - `npm run device:integration`, only with --device
 *
 * Exits 1 if any required step failed. Uses spawnSync with a shell on win32,
 * exactly as scripts/validate.mjs does.
 */

const ROOT = resolve(import.meta.dirname, '..');
const shell = process.platform === 'win32';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const flags = new Set(process.argv.slice(2));
const skipFirmware = flags.has('--skip-firmware');
const skipDocker = flags.has('--skip-docker');
const doDevice = flags.has('--device');

const results = []; // { name, ok, ms }

function record(name, ok, ms) {
  results.push({ name, ok, ms });
}

function run(label, command, argsList, options = {}) {
  const start = Date.now();
  process.stdout.write(`\n==> ${label}\n`);
  const result = spawnSync(command, argsList, { cwd: ROOT, stdio: 'inherit', ...options });
  const ok = result.status === 0;
  record(label, ok, Date.now() - start);
  return ok;
}

// 1. git working tree clean — warn only, never a failure.
{
  const start = Date.now();
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const dirty = (result.stdout ?? '').trim() !== '';
  if (dirty) {
    process.stdout.write('\n==> WARN: working tree is not clean (continuing)\n');
  } else {
    process.stdout.write('\n==> git working tree clean\n');
  }
  record('git working tree clean', true, Date.now() - start);
}

// 2. the validation gate; pass --skip-firmware through.
{
  const argsList = [resolve(ROOT, 'scripts', 'validate.mjs')];
  if (skipFirmware) argsList.push('--skip-firmware');
  run('node scripts/validate.mjs', process.execPath, argsList, { shell: false });
}

// 3. the release image builds (docker must be present, unless skipped).
if (!skipDocker) {
  run('docker build -t bob:release-check .', 'docker', ['build', '-t', 'bob:release-check', '.'], { shell: false });
}

// 4. on-device integration, only when asked.
if (doDevice) {
  run('npm run device:integration', npm, ['run', 'device:integration'], { shell });
}

// --- summary table ---------------------------------------------------------

console.log('\n==== release:check summary ====');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.ms} ms)`);
}
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
console.log('\nPASS');
