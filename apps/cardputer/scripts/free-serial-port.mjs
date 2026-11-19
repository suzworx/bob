// Kills leftover processes holding the Cardputer test resources: the serial
// port AND the mock server's TCP port. On Windows, `pio device monitor` /
// `npm run device:monitor` processes started in the background don't
// self-terminate when their parent shell exits, and the next flash/monitor
// attempt fails with `PermissionError: could not open port 'COM3'` until the
// stale holder is killed by hand. Matches on command line (not image name)
// since node/python are also used for unrelated processes.
//
// A wedged device-test.mjs and its mock-mp3-server leak the same way, and the
// mock is worse than a dead process: it keeps serving 7445, so the next run's
// mock fails to bind with EADDRINUSE while the device happily talks to the
// STALE one. The new run then sees no traffic from its own mock and reports
// every cycle as a timeout, which reads as a device fault. Kill the whole
// test tree here, not just the monitor.
// Usage: node scripts/free-serial-port.mjs (exits 0 either way; prints what it killed)
import { execFileSync } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log('[free-serial-port] non-Windows platform, nothing to do');
  process.exit(0);
}

const PATTERNS = [
  'platformio device monitor',
  'run-pio.mjs monitor',
  'npm-cli.js run monitor',
  'npm-cli.js run device:monitor',
  'tee-log.mjs',
  // Stale harness orchestrators and their mock servers (see header).
  'device-test.mjs',
  'mock-mp3-server.mjs',
];

function ps(script) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// Our own ancestor chain. This script is spawned BY device-test.mjs, whose
// command line matches the patterns above, and taskkill /T kills a whole tree
// — so without this the preflight would terminate the very run it is clearing
// the way for. Walk parents to the root and treat them all as untouchable.
function selfAncestry() {
  const chain = new Set([String(process.pid)]);
  let pid = process.pid;
  for (let depth = 0; depth < 16; depth++) {
    const [parent] = ps(`(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").ParentProcessId`);
    if (!parent || parent === '0' || chain.has(parent)) break;
    chain.add(parent);
    pid = Number(parent);
  }
  return chain;
}

function findPids() {
  const self = selfAncestry();
  const filter = PATTERNS.map((p) => `$_.CommandLine -match '${p.replace(/'/g, "''")}'`).join(' -or ');
  return ps(`(Get-CimInstance Win32_Process | Where-Object { ${filter} }).ProcessId`)
    .filter((pid) => !self.has(pid));
}

const pids = findPids();
if (pids.length === 0) {
  console.log('[free-serial-port] no stray test processes found');
  process.exit(0);
}

for (const pid of pids) {
  try {
    execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
    console.log(`[free-serial-port] killed ${pid}`);
  } catch {
    // Already gone between the query and the kill — fine.
  }
}
console.log(`[free-serial-port] cleaned up ${pids.length} process(es)`);
