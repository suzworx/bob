import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/*
 * deploy.mjs — start the voice API server detached from the terminal.
 *
 * Spawns `npm run start --workspace @bob/api` (npm.cmd on Windows) from the
 * repo root in its own process group with stdio ignored, then unrefs the child
 * so the parent exits immediately while the server keeps running. Spawning from
 * the repo root keeps the journal at <repo>/data/v2-journal.log.
 *
 * Exit behavior: prints the child pid plus health/journal hints and exits 0.
 */

// Repo root is two levels above apps/api/scripts/. fileURLToPath keeps this
// working on any Node ESM version (no import.meta.dirname dependency).
const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
// win32 note: npm.cmd is a .cmd shim that spawn cannot launch directly, so a
// shell is required on Windows.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// detached: new process group, so the server survives terminal close; stdio
// ignored (journal goes to its own file); unref lets the parent exit at once.
const child = spawn(npm, ['run', 'start', '--workspace', '@bob/api'], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
  shell: process.platform === 'win32',
});
child.unref();

console.log(`[deploy] api server starting detached (pid ${child.pid ?? 'n/a'}).`);
console.log('[deploy] health: http://localhost:7444/health  (or BOB_V2_HOST:7444 from the device)');
console.log('[deploy] journal: data/v2-journal.log');
console.log('[deploy] stop with:  Stop-Process -Name node -Force  (or taskkill /PID <pid> /T /F)');