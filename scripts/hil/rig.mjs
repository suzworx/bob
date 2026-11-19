import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLineStream } from './engine.mjs';
import { redactMacs } from './report.mjs';

/*
 * rig.mjs — the processes behind a HIL run: PlatformIO build/flash, the real
 * API server (server-harness.ts), and the serial bridge. Every child is
 * tracked and force-killed on any exit path (normal, error, Ctrl+C), the same
 * discipline as apps/cardputer/scripts/device-test.mjs: nothing may be left
 * holding COM3 or port 7444 after the runner prints its verdict.
 */

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const CARDPUTER_DIR = resolve(ROOT, 'apps', 'cardputer');
/** The PlatformIO envs a run flashes. Defaults are the Cardputer's; another
 *  board sets BOB_HIL_ENV / BOB_PRODUCT_ENV (see docs/cardputer/hil.md). */
export function resolveEnvs(env = process.env) {
  return {
    hil: env.BOB_HIL_ENV || 'm5stack-cardputer-hil',
    // The firmware the device runs day to day; every run flashes it back.
    product: env.BOB_PRODUCT_ENV || 'm5stack-cardputer-v2-poc',
  };
}
export const HIL_ENV = resolveEnvs().hil;
export const PRODUCT_ENV = resolveEnvs().product;
export const COM_PORT = process.env.BOB_COM_PORT ?? 'COM3';
export const SERVER_PORT = 7444;
const PY = (process.env.BOB_PIO_PY ?? 'py -3.11').split(' ');

const children = [];
let cleanedUp = false;
let harness = null;  // the server-harness child, for `T server …` commands.

export function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const child of children) killChild(child);
  releaseHilDatabase();
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

/** Kills stale monitors / device-test trees that would hold the serial port. */
export function freeSerialPort() {
  spawnSync(process.execPath, [resolve(CARDPUTER_DIR, 'scripts', 'free-serial-port.mjs')], { stdio: 'inherit' });
}

export function portInUse(port) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
  });
}

/**
 * Runs a command to completion, streaming its output (MACs redacted) into
 * `logFile` as it arrives, so a run that dies midway still leaves an exact
 * log. Resolves { ok, code, signal, output } once the process has exited;
 * the exit is logged too, so a flash that was killed is never mistaken for
 * one still running (HIL run 20260924-082431-3e28: the restore's log stopped
 * mid-compile with no exit recorded).
 */
export function runLogged(command, args, { cwd = CARDPUTER_DIR, logFile, label = `${command} ${args.join(' ')}` }) {
  appendFileSync(logFile, redactMacs(`$ ${label}\n`));
  return new Promise((done) => {
    let output = '';
    let partial = '';
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (d) => {
      const text = partial + d.toString('utf8');
      const cut = text.lastIndexOf('\n');
      partial = cut >= 0 ? text.slice(cut + 1) : text;
      if (cut < 0) return;
      const lines = redactMacs(text.slice(0, cut + 1));
      output += lines;
      appendFileSync(logFile, lines);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const finish = (code, signal, error) => {
      if (partial) {
        output += redactMacs(`${partial}\n`);
        appendFileSync(logFile, redactMacs(`${partial}\n`));
        partial = '';
      }
      const how = error ? `failed to start (${error.code ?? error.name})` : signal ? `killed by ${signal}` : `exit ${code}`;
      appendFileSync(logFile, `$ ${how}\n`);
      done({ ok: !error && code === 0, code, signal, how, output });
    };
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal, null));
  });
}

/** Runs platformio through runLogged, echoing the tail; resolves like it. */
export async function pio(args, logFile) {
  const result = await runLogged(PY[0], [...PY.slice(1), '-m', 'platformio', ...args], { logFile, label: `pio ${args.join(' ')}` });
  process.stdout.write(`${result.output.split('\n').slice(-6).join('\n')}\n`);
  return result;
}

/**
 * Flashes the product env back so the device is never left on the hil build
 * (whose server is gone); `keepHil` skips it. `flash` is injectable for
 * tests. Awaits the upload and says SUCCESS or FAIL; resolves true only when
 * the product firmware is on the device (or it was kept on purpose).
 */
export async function restoreProduct({ keepHil, runDir, flash = (args) => pio(args, resolve(runDir, 'flash.log')), log = console.log, error = console.error }) {
  if (keepHil) {
    log(`--keep-hil: the ${HIL_ENV} build stays on the device (npm run device:flash restores the product build).`);
    return true;
  }
  log(`\nrestoring the product firmware (${PRODUCT_ENV}) to ${COM_PORT}…`);
  const result = await flash(['run', '-e', PRODUCT_ENV, '--target', 'upload', '--upload-port', COM_PORT]);
  if (result.ok) {
    log(`restore: SUCCESS (${PRODUCT_ENV} is on ${COM_PORT})`);
    return true;
  }
  error(`restore: FAIL (${result.how ?? 'failed'}): the device may still run the ${HIL_ENV} build. Run npm run device:flash${runDir ? `; see ${resolve(runDir, 'flash.log')}` : ''}`);
  return false;
}

let serverSpec = null;  // what startServer was given, for restartServer.
let hilDatabase = null;  // { name, run } once acquireHilDatabase succeeded.

/** tsx's CLI, resolved rather than joined onto ROOT: a git worktree finds tsx
 *  in a parent checkout's node_modules. */
function tsxCli() {
  return fileURLToPath(import.meta.resolve('tsx/cli'));
}

/** Runs hil-db.ts; stdout (the URL) is captured, its errors reach the console. */
function runHilDb(args) {
  return spawnSync(process.execPath, [tsxCli(), resolve(import.meta.dirname, 'hil-db.ts'), ...args], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** The run's database name: bob_hil_<run id>, a Postgres-safe identifier
 *  that the tests' leftover cleanup (bob_test_*) never matches. */
export function hilDatabaseName(runId) {
  return `bob_hil_${String(runId).toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}

/**
 * Creates the run's own database on the local Supabase stack (hil-db.ts: a copy
 * of the migration-complete test template, with the dev account seeded) and
 * returns its loopback URL, or null when it could not (the stack is down).
 * cleanup() drops it, on every exit path. `run` is injectable for tests.
 */
export function acquireHilDatabase(runId, { run = runHilDb } = {}) {
  const name = hilDatabaseName(runId);
  const result = run(['acquire', name]);
  const url = result.status === 0 ? String(result.stdout ?? '').trim() : '';
  if (!url) return null;
  hilDatabase = { name, run };
  return url;
}

/** Drops the run's database; idempotent, and a no-op before one was acquired. */
export function releaseHilDatabase() {
  if (!hilDatabase) return;
  const { name, run } = hilDatabase;
  hilDatabase = null;
  run(['release', name]);
}

/** Kills one child and its tree by PID, never by process name (OpenCode
 *  Desktop shares node's name on this PC). */
export function killChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  try { child.kill('SIGKILL'); } catch {}
}

function spawnHarness({ runDir, port, databaseUrl, env, journalPath }) {
  const child = spawn(process.execPath, [tsxCli(), resolve(import.meta.dirname, 'server-harness.ts')], {
    cwd: ROOT,
    // stdin carries `T server …` commands (see startBridge).
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BOB_PRODUCTION: '', BOB_SYSTEM_TEST: '1', BOB_V2_JOURNAL: journalPath,
      BOB_V2_HOST: '0.0.0.0', BOB_V2_PORT: String(port), ...env,
      // Last, so nothing overrides it: the run's own database, or '' (the
      // harness refuses it) rather than whatever this shell happens to carry.
      BOB_DATABASE_URL: databaseUrl ?? '',
    },
  });
  children.push(child);
  const consoleLog = resolve(runDir, 'server-console.log');
  child.stdout.on('data', (d) => appendFileSync(consoleLog, d));
  child.stderr.on('data', (d) => appendFileSync(consoleLog, d));
  return child;
}

/**
 * `T rig server-stop` (server-down-backoff): kills the running server harness
 * by the PID it recorded (never by name), waits for it to exit and for the
 * port to free. Resolves true once nothing listens on the port; the device
 * then sees its socket drop and every reconnect refused.
 */
export async function stopServer({ kill = killChild, inUse = portInUse, pauseMs = 250 } = {}) {
  if (!serverSpec || !harness) return false;
  const old = harness;
  const exited = old.exitCode !== null || old.signalCode !== null ? Promise.resolve() : once(old, 'exit');
  kill(old);
  await exited;
  harness = null;
  for (let tries = 0; tries < 40 && (await inUse(serverSpec.port)); tries++) await new Promise((r) => setTimeout(r, pauseMs));
  return !(await inUse(serverSpec.port));
}

/**
 * `T rig server-start`: starts the harness again after server-stop, with the
 * same port, database and journal file as startServer, so the journal
 * stream keeps reading the new process's lines. Resolves true once /health
 * answers; false when no server was ever started. With the harness still
 * running it spawns nothing and only checks health, so a scenario's `finally`
 * can always bring the server back.
 */
export async function startServerAgain({ spawnChild = spawnHarness, healthy = waitHealthy } = {}) {
  if (!serverSpec) return false;
  const running = harness && harness.exitCode === null && harness.signalCode === null;
  if (!running) harness = spawnChild(serverSpec);
  return healthy(serverSpec.port);
}

/**
 * `T rig server-restart` (server-restart-reconnect): stopServer, then
 * startServerAgain. Resolves true once /health answers again.
 */
export async function restartServer({ kill = killChild, inUse = portInUse, healthy = waitHealthy, spawnChild = spawnHarness } = {}) {
  if (!serverSpec || !harness) return false;
  await stopServer({ kill, inUse });
  return startServerAgain({ spawnChild, healthy });
}

/** Starts server-harness.ts on `databaseUrl` (acquireHilDatabase); returns
 *  the server journal as a line stream. `spawnChild` is injectable for tests. */
export function startServer({ runDir, databaseUrl, port = SERVER_PORT, env = {}, spawnChild = spawnHarness }) {
  const journalPath = resolve(runDir, 'server-journal.log');
  serverSpec = { runDir, port, databaseUrl, env, journalPath };
  const child = spawnChild(serverSpec);
  harness = child;
  const stream = createLineStream();
  let offset = 0;
  let partial = '';
  const timer = setInterval(() => {
    if (!existsSync(journalPath) || statSync(journalPath).size <= offset) return;
    const fd = openSync(journalPath, 'r');
    const buffer = Buffer.alloc(statSync(journalPath).size - offset);
    offset += readSync(fd, buffer, 0, buffer.length, offset);
    closeSync(fd);
    const text = partial + buffer.toString('utf8');
    const cut = text.lastIndexOf('\n');
    partial = text.slice(cut + 1);
    if (cut >= 0) stream.push(text.slice(0, cut));
  }, 150);
  timer.unref();
  return { child, stream };
}

export async function waitHealthy(port = SERVER_PORT, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** The PowerShell command that plays a WAV through the PC's default speaker
 *  and returns when it has finished (System.Media.SoundPlayer.PlaySync). */
export function soundPlayerCommand(absPath) {
  const quoted = `'${absPath.replace(/'/g, "''")}'`;
  return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer ${quoted}).PlaySync()`]];
}

/** `T rig speak <volume> <tries> <words>` -> { text, volume, tries }, or null when it is not
 *  one: letters and spaces only, volume 1..30 (people sleep; never louder), 1..3 tries. */
export function parseSpeak(command) {
  const m = /^T rig speak (\d{1,3}) ([1-3]) ([A-Za-z][A-Za-z ]{0,63})$/.exec(command);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 30) return null;
  return { volume: Number(m[1]), tries: Number(m[2]), text: m[3] };
}

/** The PowerShell command that speaks `text` through the PC's default speaker (System.Speech) at `volume`. */
export function speechCommand(text, volume) {
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Volume = ${volume}; $s.Speak('${text.replace(/'/g, "''")}')`;
  return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]];
}

function speak({ text, volume }) {
  const [cmd, args] = speechCommand(text, volume);
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'ignore' });
    children.push(child);
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`powershell exited ${code}`))));
  });
}

/** Runs `T rig speak …`: speaks, and up to `tries` times until the device journals v2.barge_in
 *  (2.5 s after each). Answers `T> ok rig` on the first barge_in, else `T> err no_barge_in`.
 *  False: not a speak command. */
export function speakRigCommand(command, device, serialLog) {
  const spec = parseSpeak(command);
  if (!spec) return false;
  appendFileSync(serialLog, `>> ${command}  (the rig speaks through the PC speaker, volume ${spec.volume})\n`);
  return (async () => {
    for (let i = 0; i < spec.tries; i++) {
      const from = device.length;
      await speak(spec);
      if (await device.waitFor(/INFO v2\.barge_in /, from, 2500) !== null) return 'T> ok rig';
    }
    return 'T> err no_barge_in';
  })().catch(() => 'T> err speak').then((answer) => { device.push(answer); return true; });
}

/** True when a repo-relative file exists (scenario requiresFiles). */
export function repoFileExists(path) {
  return existsSync(resolve(ROOT, path));
}

/** Plays a repo-relative WAV through the PC speaker; resolves when it ends,
 *  rejects when PowerShell fails (no audio device, unreadable file). */
export function playAudio(path) {
  const [cmd, args] = soundPlayerCommand(resolve(ROOT, path));
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'ignore' });
    children.push(child);
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`powershell exited ${code}`))));
  });
}

/** The `T rig server-…` commands: what runs, the serial.log note, and the
 *  error answered when it resolves false or throws. */
export const SERVER_RIG_COMMANDS = {
  'T rig server-restart': { run: () => restartServer(), note: 'the rig stops the server harness by PID and starts it again', notOk: 'server_not_healthy', thrown: 'server_restart' },
  'T rig server-stop': { run: () => stopServer(), note: 'the rig stops the server harness by PID; the port stays closed', notOk: 'server_port_busy', thrown: 'server_stop' },
  'T rig server-start': { run: () => startServerAgain(), note: 'the rig starts the server harness again: same port, database and journal', notOk: 'server_not_healthy', thrown: 'server_start' },
};

/** Runs a `T rig server-…` command; answered on the device stream once it is
 *  done (`T> ok rig` or `T> err <why>`). False: not one of them. */
export function serverRigCommand(command, device, serialLog, commands = SERVER_RIG_COMMANDS) {
  const spec = commands[command];
  if (!spec) return false;
  appendFileSync(serialLog, `>> ${command}  (${spec.note})\n`);
  return Promise.resolve()
    .then(spec.run)
    .then(
      (ok) => device.push(ok ? 'T> ok rig' : `T> err ${spec.notOk}`),
      () => device.push(`T> err ${spec.thrown}`),
    )
    .then(() => true);
}

/** Opens the serial bridge; device lines go to the stream and serial.log,
 *  console commands are logged there too (prefixed `>> `).
 *
 *  `T server <command>` never reaches the device: it goes to the server
 *  harness's stdin (`announce ring`, `control mode=ptt dnd=0`, see
 *  server-harness.ts) and the rig answers `T> ok server` itself, so a
 *  scenario's `send` step can drive the server side. The evidence is still a
 *  journal line: the server's `v2.hil_command` and what follows it.
 *
 *  `T bridge reset` also stays off the device: the bridge pulses RTS to reset
 *  it (serial-bridge.py), and the rig answers `T> ok bridge`. So does
 *  `T bridge pause <ms>`: the bridge closes the port for <ms> (no reset).
 *  `T rig server-restart` restarts the server harness (restartServer); the
 *  rig answers `T> ok rig` once /health answers again. `T rig server-stop`
 *  and `T rig server-start` are its two halves (stopServer, startServerAgain),
 *  for a scenario that keeps the server down in between. */
export function startBridge({ runDir, port = COM_PORT }) {
  const serialLog = resolve(runDir, 'serial.log');
  const child = spawn(PY[0], [...PY.slice(1), resolve(import.meta.dirname, 'serial-bridge.py'), port, '115200'], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const device = createLineStream();
  let partial = '';
  child.stdout.on('data', (d) => {
    appendFileSync(serialLog, d);
    const text = partial + d.toString('utf8');
    const cut = text.lastIndexOf('\n');
    partial = text.slice(cut + 1);
    if (cut >= 0) device.push(text.slice(0, cut));
  });
  child.stderr.on('data', (d) => appendFileSync(serialLog, `[bridge] ${d}`));
  /** `T bridge …` and `T rig …`: answered here, never sent to the device. */
  const rigCommand = (command) => {
    if (command === 'T bridge reset') {
      appendFileSync(serialLog, `>> ${command}  (RTS reset pulse from the serial bridge)\n`);
      child.stdin.write('@bridge reset\n');
      device.push('T> ok bridge');
      return true;
    }
    const pause = /^T bridge pause (\d+)$/.exec(command);
    if (pause) {
      appendFileSync(serialLog, `>> ${command}  (the bridge closes the port; the host stops reading)\n`);
      child.stdin.write(`@bridge pause ${pause[1]}\n`);
      device.push('T> ok bridge');
      return true;
    }
    // A Promise (truthy) when it is a server command; the answer follows.
    return Boolean(serverRigCommand(command, device, serialLog) || speakRigCommand(command, device, serialLog));
  };
  const send = (command) => {
    if (rigCommand(command)) return;
    if (command.startsWith('T server ')) {
      const routed = Boolean(harness?.stdin?.writable);
      appendFileSync(serialLog, `>> ${command}  (to the server harness${routed ? '' : ': not running'})\n`);
      if (routed) harness.stdin.write(`${command.slice('T server '.length)}\n`);
      device.push(routed ? 'T> ok server' : 'T> err no_server');
      return;
    }
    appendFileSync(serialLog, `>> ${command}\n`);
    child.stdin.write(`${command}\n`);
  };
  return { child, device, send };
}
