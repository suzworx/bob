import { execFileSync } from 'node:child_process';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/*
 * cleanup.mjs — release the ports Bob's dev processes hold, and optionally
 * clear the git-ignored logs.
 *
 * A stale `npm run dev` is the most common way to lose ten minutes here: the
 * API dies with an unhandled EADDRINUSE stack trace that names the port but
 * not the process holding it, and nothing tells you how to free it.
 *
 * This never kills blind. It prints what it found — command, pid, port — and
 * with --dry it only prints. It also refuses to kill itself or its own parent
 * npm, which would otherwise take the terminal down with it.
 *
 * A port is not sufficient evidence of ownership. 5353 in particular is a
 * shared multicast group: a dry run on a normal desktop turned up Microsoft
 * Edge and macOS mDNSResponder sitting on it beside our advertiser. So every
 * candidate is checked against its own command line, and anything that is not
 * demonstrably this repository's process is left alone.
 *
 * Usage: npm run cleanup [-- --dry] [-- --logs]
 */

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const alsoLogs = args.includes('--logs');

/** Ports Bob's dev processes bind, resolved the same way the code resolves them. */
function bobPorts() {
  const port = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
  };
  return [
    { port: port(process.env.BOB_V2_PORT, 7444), what: 'API / device websocket' },
    { port: port(process.env.BOB_WEB_PORT, 5173), what: 'web client (vite)' },
    { port: 5353, what: 'mDNS advertiser', udp: true },
  ];
}

/** Never kill this process, its parent shell, or the npm that spawned it. */
const PROTECTED = new Set([process.pid, process.ppid].filter(Boolean));

/**
 * A port match alone is not ownership — 5353 is shared with mDNSResponder and
 * anything else doing service discovery. Confirm the process is ours by its
 * command line: either it runs from this checkout, or it is one of the scripts
 * we start by name.
 */
const OWN_SCRIPTS = ['scripts/mdns.mjs', 'scripts/dev-ui.mjs', 'src/server.ts', 'vite'];

function commandLine(pid) {
  try {
    if (process.platform === 'win32') {
      return execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'], { encoding: 'utf8' });
    }
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function isOurs(pid) {
  const line = commandLine(pid);
  if (!line.trim()) return false;
  if (line.includes(process.cwd())) return true;
  return OWN_SCRIPTS.some((script) => line.includes(script));
}

function listeners({ port, udp }) {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('netstat', ['-ano', '-p', udp ? 'UDP' : 'TCP'], { encoding: 'utf8' });
      return [...new Set(out.split(/\r?\n/)
        .filter((line) => new RegExp(`[:.]${port}\\s`).test(line))
        .map((line) => Number(line.trim().split(/\s+/).at(-1)))
        .filter((pid) => Number.isInteger(pid) && pid > 0))]
        .map((pid) => ({ pid, command: 'pid ' + pid }));
    } catch {
      return [];
    }
  }
  try {
    const flags = ['-nP', `-i${udp ? 'UDP' : 'TCP'}:${port}`];
    if (!udp) flags.push('-sTCP:LISTEN');
    const out = execFileSync('lsof', [...flags, '-Fpc'], { encoding: 'utf8' });
    const found = [];
    let current = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) current = { pid: Number(line.slice(1)), command: '' };
      else if (line.startsWith('c') && current) {
        current.command = line.slice(1);
        found.push(current);
        current = null;
      }
    }
    return found.filter((entry, index, all) => all.findIndex((o) => o.pid === entry.pid) === index);
  } catch {
    return []; // lsof exits non-zero when nothing holds the port
  }
}

function kill(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

let released = 0;
let skipped = 0;

for (const entry of bobPorts()) {
  const holders = listeners(entry);
  if (holders.length === 0) {
    console.log(`  port ${String(entry.port).padEnd(5)} free            (${entry.what})`);
    continue;
  }
  for (const { pid, command } of holders) {
    const label = `  port ${String(entry.port).padEnd(5)} ${command} pid ${pid}`;
    if (PROTECTED.has(pid)) {
      console.log(`${label} — skipped, that is this cleanup process`);
      skipped += 1;
    } else if (!isOurs(pid)) {
      console.log(`${label} — skipped, not an Bob process`);
      skipped += 1;
    } else if (dryRun) {
      console.log(`${label} — would kill (${entry.what})`);
    } else if (kill(pid)) {
      console.log(`${label} — killed (${entry.what})`);
      released += 1;
    } else {
      console.log(`${label} — could not kill; try: kill -9 ${pid}`);
      skipped += 1;
    }
  }
}

if (alsoLogs) {
  const logDirs = ['data', join('apps', 'api', 'data')];
  for (const dir of logDirs) {
    if (!existsSync(dir)) continue;
    const logs = readdirSync(dir).filter((name) => name.endsWith('.log'));
    for (const name of logs) {
      if (dryRun) console.log(`  log  ${join(dir, name)} — would delete`);
      else {
        rmSync(join(dir, name), { force: true });
        console.log(`  log  ${join(dir, name)} — deleted`);
      }
    }
  }
}

console.log(
  dryRun
    ? `\n==== cleanup: dry run, nothing changed ====`
    : `\n==== cleanup: ${released} released, ${skipped} skipped ====`,
);
if (!alsoLogs && !dryRun) console.log('Add -- --logs to clear data/*.log too.');
