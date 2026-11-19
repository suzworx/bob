import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { guardFlash } from '../../../tools/visual-gate/flash-guard.mjs';

// PlatformIO build helper for the Cardputer firmware (apps/cardputer).
// Runs `platformio` through the Python launcher so the npm scripts
// (compile/flash/monitor/run/debug) work from any shell.

// ENV is the PlatformIO environment: BOB_PIO_ENV overrides the default
// (m5stack-cardputer-v2-poc, e.g. waveshare-s3-185c); BOB_COM_PORT overrides
// the serial port (default COM3); BOB_PIO_PY overrides the Python launcher
// (default `py -3.11` on Windows, `python3` elsewhere, e.g. a cloud session).
// A Waveshare upload is refused unless the visual gate passed for this exact
// firmware (tools/visual-gate/flash-guard.mjs); --force-unsafe overrides, loudly.
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = process.env.BOB_PIO_ENV ?? 'm5stack-cardputer-v2-poc';
const PORT = process.env.BOB_COM_PORT ?? 'COM3';
const PY = process.env.BOB_PIO_PY ?? (process.platform === 'win32' ? 'py -3.11' : 'python3');

const mode = process.argv[2] ?? 'build';
if (!['build', 'upload', 'monitor', 'run'].includes(mode)) {
  console.error(`Usage: node scripts/run-pio.mjs <build|upload|monitor|run> [--force-unsafe]`);
  process.exit(1);
}

// Run platformio with the given args inside apps/cardputer and exit with its
// status. Modes dispatch as: build -> `run`, upload -> `run --target upload`
// to BOB_COM_PORT, monitor -> `device monitor` at 115200 baud, run -> flash
// then monitor.
function pio(args) {
  const [py, ...pyArgs] = PY.split(' ');
  const result = spawnSync(py, [...pyArgs, '-m', 'platformio', ...args], {
    cwd: APP_DIR,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`[cardputer] env=${ENV} port=${PORT}`);
if (mode === 'upload' || mode === 'run') guardFlash(ENV);
if (mode === 'build' || mode === 'run') pio(['run', '-e', ENV]);
if (mode === 'upload' || mode === 'run') pio(['run', '-e', ENV, '--target', 'upload', '--upload-port', PORT]);
if (mode === 'monitor' || mode === 'run') pio(['device', 'monitor', '--port', PORT, '--baud', '115200']);