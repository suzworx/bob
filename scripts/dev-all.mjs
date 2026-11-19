import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { devPairingUrl, findLanIpv4 } from './dev-offline.mjs';
import { openLogFile } from './log-file.mjs';

/*
 * dev-all.mjs — run the API and the web client together, mirroring what each
 * one prints into data/dev-api.log and data/dev-ui.log.
 *
 * The server's own journal only carries v2.* events. Everything else a dev
 * run prints -- a tsx compile error, a vite transform failure, an unhandled
 * rejection and its stack, the port-bind advice from dev-ui.mjs -- lived in
 * terminal scrollback and nowhere else, so a crash that happened while nobody
 * was watching left no record. The console is still written to unchanged;
 * these files are a second copy for reading afterwards.
 *
 * They are git-ignored under data/ and swept by `npm run logs:clean`. Like
 * the journal they carry no payload: the dev servers do not print transcripts
 * or replies (that is BOB_DEBUG's separate, opt-in channel).
 */

// Repo root is the directory of this script file. The URL-based resolution is
// used deliberately over import.meta.dirname for Node <20.11 compatibility.
const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Mirrors a child stream to the terminal and to the log, a whole line at a
 * time. Partial trailing data is held until the next chunk completes it, so a
 * line is never split across two writes to the file.
 */
function mirror(stream, target, append) {
  let pending = '';
  stream.on('data', (chunk) => {
    target.write(chunk);
    pending += chunk.toString();
    for (let index = pending.indexOf('\n'); index >= 0; index = pending.indexOf('\n')) {
      append(pending.slice(0, index + 1));
      pending = pending.slice(index + 1);
    }
  });
  // A process that dies mid-line -- a stack trace cut short by a crash -- is
  // exactly the case these logs exist for, so flush whatever is held.
  stream.on('end', () => {
    if (pending.length > 0) append(`${pending}\n`);
    pending = '';
  });
}

/** True when a dotenv file sets `key` on an uncommented line. */
export function envFileDefines(text, key) {
  return String(text)
    .split(/\r?\n/)
    .some((line) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(line));
}

/**
 * The pairing URL the Cardputer should show for a local run, or null to leave
 * it alone. Without one the server falls back to https://app.heybob.xyz/pair,
 * which is the wrong app for a device talking to this machine. An explicit
 * value -- in the shell or the root .env -- always wins.
 */
export function localPairingUrl(env, envFileText, lanIp) {
  if (env.BOB_PAIRING_URL) return null;
  if (envFileDefines(envFileText, 'BOB_PAIRING_URL')) return null;
  return devPairingUrl(lanIp ?? 'localhost');
}

function main() {
  const envFile = resolve(ROOT, '.env');
  const pairingUrl = localPairingUrl(
    process.env,
    existsSync(envFile) ? readFileSync(envFile, 'utf8') : '',
    findLanIpv4(),
  );
  // dev-offline passes its own BOB_PAIRING_URL, so this only fills the gap
  // for a plain `npm run dev`. Children inherit it; dotenv never overrides it.
  if (pairingUrl) process.env.BOB_PAIRING_URL = pairingUrl;

  const children = [
    { script: 'dev:api', log: 'data/dev-api.log' },
    { script: 'dev:ui', log: 'data/dev-ui.log' },
  ].map(({ script, log }) => {
    const append = openLogFile(resolve(ROOT, log));
    const child = spawn(npm, ['run', script], {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    mirror(child.stdout, process.stdout, append);
    mirror(child.stderr, process.stderr, append);
    return child;
  });

  console.log('[dev-all] console mirrored to data/dev-api.log and data/dev-ui.log');
  if (pairingUrl) console.log(`[dev-all] pairing URL for the Cardputer: ${pairingUrl}`);

  const stop = () => children.forEach((child) => child.kill());
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) main();
