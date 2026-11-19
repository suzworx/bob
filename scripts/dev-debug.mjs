// Runs the voice server with full debug logging enabled.
//
// Debug mode records what the v2 journal deliberately omits -- transcripts,
// agent reply text, prompts, tool calls, provider request/response metadata --
// to data/v2-debug.log. That file contains real user speech and model output:
// it is git-ignored, and must never be committed, shared, or shipped.
//
// A Node wrapper rather than an inline `BOB_DEBUG=1 npm run dev`, because
// that syntax is not portable to Windows shells, which is where this repo's
// device work happens.
//
// Usage (from repo root): npm run dev:debug
//                         npm run dev:debug -- --once     (no watch/restart)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const once = args.includes('--once');

const debugLogPath = process.env.BOB_DEBUG_LOG ?? resolve(REPO_ROOT, 'data', 'v2-debug.log');
mkdirSync(dirname(debugLogPath), { recursive: true });

console.log('[dev-debug] BOB_DEBUG=1 - verbose logging is ON');
console.log(`[dev-debug] debug log : ${debugLogPath}`);
console.log('[dev-debug] journal   : data/v2-journal.log (unchanged, still redacted)');
console.log('[dev-debug] WARNING   : the debug log contains transcripts and agent replies.');
console.log('[dev-debug]             It is git-ignored. Do not commit or share it.');
console.log('');

const child = spawn(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', once ? 'start' : 'dev'],
  {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, BOB_DEBUG: '1', BOB_DEBUG_LOG: debugLogPath },
    shell: process.platform === 'win32',
  },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
