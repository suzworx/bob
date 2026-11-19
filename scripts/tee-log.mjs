import { spawn } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLogFile } from './log-file.mjs';

/*
 * tee-log.mjs — mirror output to both the console and a log file.
 *
 * Usage:
 *   node scripts/tee-log.mjs tee <relative-log-path> <command> [args...]
 *   node scripts/tee-log.mjs tail <relative-log-path> <relative-source>
 *   node scripts/tee-log.mjs both <device-log> <api-log> <journal-source> <command> [args...]
 *
 * `tee` runs a command from the repo root and mirrors its stdout/stderr into
 * the log file (used by `npm run device:monitor` -> data/device.log).
 * `tail` follows a growing file (used by `npm run api:monitor` ->
 * data/api.log): it prints the file's existing content, then mirrors new
 * lines as they are appended.
 * `both` runs both at once for `npm run monitor`: the command's output is
 * shown with a "DEV " prefix (and teed to <device-log>) while the journal is
 * tailed with an "API " prefix (teed to <api-log>), so device and server
 * streams interleave in one terminal. Log paths resolve against the repo
 * root; parent directories are created if needed.
 */

// Repo root is the directory of this script file. The URL-based resolution is
// used deliberately over import.meta.dirname for Node <20.11 compatibility.
const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));

const mode = process.argv[2];
const logPath = process.argv[3];
const command = process.argv[4];
const args = process.argv.slice(5);

if (
  (mode !== 'tee' && mode !== 'tail' && mode !== 'both') ||
  !logPath ||
  ((mode === 'tee' || mode === 'both') && !command) ||
  (mode === 'both' && !args[0])
) {
  console.error('Usage: node scripts/tee-log.mjs <tee|tail|both> <paths...> [command args...]');
  process.exit(1);
}

// Resolve the log path against the repo root; openLogFile creates the
// directory and rotates the file once it reaches its size cap.
const logFile = resolve(ROOT, logPath);
const appendLog = openLogFile(logFile);

// Line-buffered writer that prefixes each complete line on the console while
// appending the raw line to the log file. Partial trailing data is held until
// the next chunk completes it.
function prefixedWriter(target, append, prefix) {
  let pending = '';
  return (chunk) => {
    pending += chunk.toString();
    for (let idx = pending.indexOf('\n'); idx >= 0; idx = pending.indexOf('\n')) {
      const line = pending.slice(0, idx + 1);
      pending = pending.slice(idx + 1);
      target.write(prefix + line);
      append(line);
    }
  };
}

// The journal's location depends on how the server was started: `npm run
// dev`/workspace runs write apps/api/data/v2-journal.log, the detached root
// deploy writes data/v2-journal.log. Track whichever is newest at startup.
function resolveJournalSource() {
  const candidates = ['apps/api/data/v2-journal.log', 'data/v2-journal.log'];
  return candidates
    .map((p) => resolve(ROOT, p))
    .sort((a, b) => {
      let ma = 0;
      let mb = 0;
      try {
        ma = statSync(a).mtimeMs;
      } catch {}
      try {
        mb = statSync(b).mtimeMs;
      } catch {}
      return mb - ma;
    })[0];
}

// Poll a growing file, feeding newly appended bytes to `onData`. Handles
// rotation (file shrinks -> restart at 0). The interval keeps the loop alive.
function startTail(sourceFile, onData) {
  let offset = 0;
  setInterval(() => {
    try {
      const size = statSync(sourceFile).size;
      if (size < offset) offset = 0;  // rotated or truncated
      if (size === offset) return;
      const fd = openSync(sourceFile, 'r');
      try {
        const chunk = Buffer.allocUnsafe(size - offset);
        let read = 0;
        while (read < chunk.length) {
          const n = readSync(fd, chunk, read, chunk.length - read, offset + read);
          if (n <= 0) break;
          read += n;
        }
        offset += read;
        if (read > 0) onData(chunk.subarray(0, read));
      } finally {
        closeSync(fd);
      }
    } catch {
      // Source not there yet — keep polling.
    }
  }, 500);
}

// Spawn with a shell (Windows needs one to resolve npm.cmd). On Windows the
// full command line is passed as a single string, which is what cmd.exe
// expects and avoids the Node DEP0190 warning for shell:true with args.
function spawnCommand(command, args) {
  return spawn(
    process.platform === 'win32' ? [command, ...args].join(' ') : command,
    process.platform === 'win32' ? [] : args,
    {
      cwd: ROOT,
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
    },
  );
}

if (mode === 'tail') {
  // Follow a growing file and print new lines to the console while mirroring
  // them into the log file. This branch never exits on its own.
  startTail(resolveJournalSource(), (chunk) => {
    process.stdout.write(chunk);
    appendLog(chunk);
  });
} else if (mode === 'both') {
  // Multiplex the device serial monitor ("DEV") and the journal tail ("API")
  // into one console stream, teeing each into its own log file.
  // argv layout: both <device-log> <api-log> <journal-source> <command> [args...]
  const apiLog = resolve(ROOT, command);
  const appendApiLog = openLogFile(apiLog);

  const child = spawnCommand(args[1], args.slice(2));
  const devWriter = prefixedWriter(process.stdout, appendLog, 'DEV ');
  child.stdout.on('data', devWriter);
  child.stderr.on('data', devWriter);

  const apiWriter = prefixedWriter(process.stdout, appendApiLog, 'API ');
  startTail(resolveJournalSource(), apiWriter);

  child.on('error', (err) => {
    console.error(`[tee-log] failed to spawn "${args[1]}": ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code ?? 1);
  });
} else {
  // Mirror each output chunk to the console and append it to the log file.
  // stdin stays inherited so interactive serial monitors (Ctrl+C / Ctrl+T
  // passthrough for pio device monitor) keep working.
  const child = spawnCommand(command, args);
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    appendLog(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stdout.write(chunk);
    appendLog(chunk);
  });

  child.on('error', (err) => {
    console.error(`[tee-log] failed to spawn "${command}": ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code ?? 1);
  });
}