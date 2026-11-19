import { spawn } from 'node:child_process';
import { DEFAULT_WEB_PORT, bindAdvice, checkPorts, resolvePort } from './dev-ports.mjs';

/*
 * Preflight before spawning: a bind failure otherwise surfaces as a vite stack
 * trace from a child process with no hint that the port is simply taken.
 */
const webPort = resolvePort(process.env.BOB_WEB_PORT, DEFAULT_WEB_PORT);

const failures = await checkPorts([webPort]);
if (failures.length > 0) {
  console.error(bindAdvice(failures));
  process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const vite = spawn(npm, ['run', 'dev', '--workspace', '@bob/ui-v2'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
const stop = () => vite.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
