#!/usr/bin/env node
/**
 * check-unit-gates.mjs — the one repo-wide gate every unit of agent work runs
 * last, before `git diff --check`.
 *
 * Workers that run only their task's narrow gates miss repo-wide checks
 * (import boundaries, the 600-line/complexity ratchet, the domain-agents
 * manifest, dead code, agent-double detection, typecheck) only surfaced in
 * the full `npm run validate`, costing a correction round each time.
 * This runs those same checks, in order, stopping at the first failure, by
 * spawning the existing npm scripts/vitest run — it never reimplements a
 * check.
 *
 * Exported for the Vitest suite: STEPS is the ordered step list, runGates
 * takes an injected spawn function so the suite can assert order and the
 * stop-on-first-failure behavior without any real subprocess.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Repo root is one level above scripts/. On Windows the npm.cmd/npx.cmd shims
// require a shell — spawnSync cannot resolve .cmd files without one.
const ROOT = resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const shell = process.platform === 'win32';

export const STEPS = [
  { label: 'import boundaries', command: npm, args: ['run', 'check:boundaries'] },
  { label: 'code quality (complexity, typing, size, cycles)', command: npm, args: ['run', 'check:quality'] },
  { label: 'domain agents manifest', command: npm, args: ['run', 'check:agents'] },
  { label: 'dead code (knip)', command: npm, args: ['run', 'lint:dead'] },
  { label: 'no agent doubles', command: npx, args: ['vitest', 'run', 'scripts/no-agent-doubles.test.mjs'] },
  { label: 'typecheck', command: npm, args: ['run', 'typecheck'] },
];

// Runs steps in order, stopping at the first non-zero status. spawn(step)
// returns the process exit status (0 = pass). Side-effect free apart from
// calling spawn, so the test suite can inject a fake and assert both the
// order steps ran in and that a failure stops the rest.
export function runGates(steps, spawn) {
  const results = [];
  for (const step of steps) {
    const start = Date.now();
    const status = spawn(step);
    results.push({ label: step.label, status, ms: Date.now() - start });
    if (status !== 0) break;
  }
  return results;
}

// Only run the gate when this file is executed directly, so the Vitest suite
// can import STEPS/runGates without spawning anything for real.
const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  function spawnStep(step) {
    process.stdout.write(`\n==> ${step.label}\n`);
    const result = spawnSync(step.command, step.args, { cwd: ROOT, stdio: 'inherit', shell });
    return result.status === 0 ? 0 : (result.status ?? 1);
  }

  const start = Date.now();
  const results = runGates(STEPS, spawnStep);
  const ranAll = results.length === STEPS.length;
  const passed = ranAll && results.every((result) => result.status === 0);
  const totalSeconds = ((Date.now() - start) / 1000).toFixed(1);

  process.stdout.write('\n');
  for (const result of results) {
    const seconds = (result.ms / 1000).toFixed(1);
    process.stdout.write(`${result.status === 0 ? 'PASS' : 'FAIL'} ${result.label} (${seconds}s)\n`);
  }

  console.log(`\n==== check-unit-gates: ${passed ? 'PASS' : 'FAIL'} (${totalSeconds}s) ====`);
  process.exit(passed ? 0 : 1);
}
