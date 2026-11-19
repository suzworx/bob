// One command for the whole consistency check: build the sim, render every device state, shoot every demo
// state, and write demo|device side-by-sides with the numeric disc check.
//   node design/bob/consistency/run.mjs [outDir=out/consistency] [sideBySideDir=docs/waveshare/screenshots]
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = process.argv[2] || 'out/consistency';
const side = process.argv[3] || 'docs/waveshare/screenshots';
const STATES = ['ready', 'hello', 'offline', 'error', 'updating', 'sleeping', 'reply', 'announce', 'field', 'thinking', 'speaking', 'pairing', 'listening'];
const run = (cmd, args, quiet) => spawnSync(cmd, args, { cwd: root, stdio: quiet ? 'ignore' : 'inherit' });

if (run('node', ['tools/bob-sim/run.mjs', 'build'], true).status !== 0) { console.error('bob-sim build failed'); process.exit(1); }
for (const s of STATES) {
  const r = run('node', ['tools/bob-sim/run.mjs', 'render', '--state', s, '--frames', '30', '--out', out], true);
  if (r.status !== 0) console.error(`render ${s} failed`);
}
run('node', ['design/bob/consistency/shoot-demo.mjs', out], true);
const cmp = run('py', ['-3.11', 'design/bob/consistency/compare.py', out, out, side], false);
process.exit(cmp.status ?? 1);
