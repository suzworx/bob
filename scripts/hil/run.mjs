import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

import { makePassRecord, PASS_RECORD } from '../device-attest.mjs';
import { runScenario } from './engine.mjs';
import { formatFindings, scanJournalFile } from './journal-privacy.mjs';
import { rssiVerdict, transportWatch } from './preflight.mjs';
import { firmwareHashAt, firmwareHashOnDisk } from './firmware-hash.mjs';
import { counts, newRunId, recordable, renderReport, scenarioTable } from './report.mjs';
import { acquireHilDatabase, cleanup, COM_PORT, freeSerialPort, HIL_ENV, pio, playAudio, portInUse, PRODUCT_ENV, repoFileExists, restoreProduct, ROOT, SERVER_PORT, startBridge, startServer, waitHealthy } from './rig.mjs';
import { missingFeatures, missingFiles, validateScenario, wrongBoard } from './schema.mjs';
import { buildOtaBundle, otaKeysPresent, otaPubkeysEnv, OTA_VARIANTS } from './ota-bundle.mjs';
import { OTA_SCENARIOS } from './scenarios/ota.mjs';
import { scenariosFor } from './scenarios/index.mjs';
import { guardFlash } from '../../tools/visual-gate/flash-guard.mjs';

/*
 * run.mjs — hardware-in-the-loop tests over the USB cable (docs/cardputer/hil.md).
 *
 *   node scripts/hil/run.mjs                 build + flash the hil env, run every scenario
 *   node scripts/hil/run.mjs --no-flash      reuse the firmware already on the device
 *   node scripts/hil/run.mjs --scenario a,b    run named scenarios, in run order, boot-ready always first (never recorded as the pass)
 *   node scripts/hil/run.mjs --dry-run       validate scenarios and print the plan; no hardware
 *   node scripts/hil/run.mjs --keep-hil      leave the hil build on the device afterwards
 *   node scripts/hil/run.mjs --ota           build and sign the OTA test releases, then run the OTA scenarios
 *                                            (they replace the firmware; never recorded as the pass)
 *   node scripts/hil/run.mjs --force-unsafe  flash a Waveshare build the visual gate did not pass (logged)
 *
 * A full run with no failure, on the firmware HEAD builds, writes
 * data/hil-pass.json — what the pre-push hook and scripts/device-attest.mjs read.
 *
 * Every run that flashed the device or ran scenarios ends by flashing the
 * product env back, so the device is never left on the hil build, paired to
 * a test server that is gone. --keep-hil skips that (e.g. before --no-flash
 * reruns).
 */

export const RUNNER_VERSION = '1';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noFlash = args.includes('--no-flash');
const keepHil = args.includes('--keep-hil');
const ota = args.includes('--ota');
const only = args.includes('--scenario') ? args[args.indexOf('--scenario') + 1] : null;
const git = (a) => (spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim();
const SCENARIOS = scenariosFor(HIL_ENV);  // a Waveshare run adds its speaker loopback (#1063)
const firmwareSource = ['src', 'include']
  .flatMap((dir) => readdirSync(resolve(ROOT, 'apps/cardputer', dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile()).map((e) => readFileSync(resolve(e.parentPath, e.name), 'utf8')))
  .join('\n');

const invalid = SCENARIOS.flatMap((s) => validateScenario(s).map((e) => `${s.name ?? '?'}: ${e}`));
const onlyNames = only ? only.split(',') : null;
const pool = ota ? OTA_SCENARIOS : SCENARIOS;
const named = onlyNames ? pool.filter((s) => onlyNames.includes(s.name)) : pool;
if (invalid.length || named.length === 0) {
  console.error(invalid.length ? `invalid scenarios:\n  ${invalid.join('\n  ')}` : `no scenario named "${only}" (have: ${pool.map((s) => s.name).join(', ')})`);
  process.exit(1);
}
// Opening the serial port resets the device. A subset without boot-ready sent
// its first command into the reboot, and the server delivered it to the dead
// session from before the reset (docs/investigations/hil-wake-followup-2026-09-25.md).
const bootAdded = (onlyNames !== null || ota) && !(onlyNames ?? []).includes('boot-ready');
const selected = bootAdded ? [SCENARIOS.find((s) => s.name === 'boot-ready'), ...named] : named;
if (bootAdded) console.log('boot-ready added first: a subset run must wait for the device to reboot and rejoin the server');
const hasHilEnv = readFileSync(resolve(ROOT, 'apps/cardputer/platformio.ini'), 'utf8').includes(`[env:${HIL_ENV}]`);
console.log(`HIL plan: port ${COM_PORT}, server 0.0.0.0:${SERVER_PORT} (system test, a fresh per-run database on the local Supabase stack), ${noFlash ? 'no flash' : `flash env ${HIL_ENV}`}, ${keepHil ? `then keep ${HIL_ENV}` : `then flash ${PRODUCT_ENV} back`}`);
if (!hasHilEnv) console.log(`  note: platformio.ini has no [env:${HIL_ENV}] yet; a real run cannot flash until it lands.`);
for (const s of selected) {
  const missing = missingFeatures(s, firmwareSource);
  const absent = missingFiles(s, repoFileExists);
  const board = wrongBoard(s, HIL_ENV);
  const skip = board ? `SKIP (${board})` : missing.length ? `SKIP (firmware lacks: ${missing.join(', ')})` : absent.length ? `SKIP (missing on this PC: ${absent.join(', ')})` : null;
  console.log(`  ${s.name.padEnd(18)} ${s.issue.padEnd(10)} ${String(s.steps.length).padStart(3)} steps  ${skip ?? s.title}`);
}
if (dryRun) {
  console.log(`dry run: ${selected.length} scenario(s) valid.`);
  process.exit(0);
}
// A Waveshare build reaches the screen only with a visual-gate pass (--force-unsafe overrides): the hil upload,
// and the product build every run flashes back at the end (also after --no-flash).
if (!noFlash || ota) guardFlash(HIL_ENV);  // --ota installs HIL_ENV images over the air
if (!keepHil) guardFlash(PRODUCT_ENV);

/** Stops the rig (the bridge lets go of the port), then awaits the product
 *  flash (rig.mjs restoreProduct). False when that flash failed. */
async function restore(runDir) {
  cleanup();
  return restoreProduct({ keepHil, runDir });
}

const runId = newRunId();
const runDir = resolve(ROOT, 'data', 'hil', runId);
mkdirSync(runDir, { recursive: true });
console.log(`run ${runId} → ${runDir}`);
if (await portInUse(SERVER_PORT)) {
  console.error(`port ${SERVER_PORT} is busy (a dev server?). The device only reaches this PC on ${SERVER_PORT}; stop it (npm run cleanup) and re-run.`);
  process.exit(1);
}
freeSerialPort();
const HIL_TRANSCRIPT = 'hardware in the loop test';
if (ota && !otaKeysPresent()) {
  console.error('--ota needs the fw-hil key pair in data/ota-keys/ (git-ignored).');
  process.exit(1);
}
// The run's own database on the local stack; cleanup() drops it on any exit.
const databaseUrl = acquireHilDatabase(runId);
if (!databaseUrl) {
  console.error('could not create the HIL database: HIL needs the local Supabase stack (npm run dev:offline, or npx supabase start).');
  process.exit(1);
}
const server = startServer({
  runDir,
  databaseUrl,
  env: {
    BOB_SYSTEM_TEST_TTS_SECONDS: '4', BOB_SYSTEM_TEST_TRANSCRIPT: HIL_TRANSCRIPT,
    ...(ota ? { BOB_OTA_DIR: resolve(runDir, 'ota'), BOB_FW_PUBKEYS: otaPubkeysEnv() } : {}),
  },
});
if (!(await waitHealthy())) {
  console.error(`the HIL server did not become healthy; see ${resolve(runDir, 'server-console.log')}`);
  process.exit(1);
}
if (ota) {
  for (const name of Object.keys(OTA_VARIANTS)) {
    console.log(`building and signing the ${name} OTA release (${OTA_VARIANTS[name].version})…`);
    if (!(await buildOtaBundle(name, runDir))) {
      console.error(`the ${name} OTA release failed to build; see ${runDir}`);
      cleanup();
      process.exit(1);
    }
  }
}
if (!noFlash) {
  if (!hasHilEnv) {
    console.error(`cannot flash: platformio.ini has no [env:${HIL_ENV}]. Use --no-flash with a hil build already on the device.`);
    process.exit(1);
  }
  // The product build is compiled now, before the device is touched, so the
  // restore at the end is an upload (seconds), not a full compile.
  if (!keepHil) {
    console.log(`building ${PRODUCT_ENV} for the restore at the end…`);
    const build = await pio(['run', '-e', PRODUCT_ENV], resolve(runDir, 'flash.log'));
    if (!build.ok) {
      console.error(`\nthe product build failed (${build.how}); nothing was flashed, so the device keeps what it had. See ${resolve(runDir, 'flash.log')}`);
      process.exit(1);
    }
  }
  console.log(`flashing ${HIL_ENV} to ${COM_PORT}…`);
  const flash = await pio(['run', '-e', HIL_ENV, '--target', 'upload', '--upload-port', COM_PORT], resolve(runDir, 'flash.log'));
  if (!flash.ok) {
    console.error(`\nbuild/flash failed (${flash.how}); see ${resolve(runDir, 'flash.log')}`);
    await restore(runDir);  // a half-written hil image must not stay behind.
    process.exit(1);
  }
}

const bridge = startBridge({ runDir });
const rig = { device: bridge.device, server: server.stream, send: bridge.send, firmwareSource, fileExists: repoFileExists, playAudio };
let ping = null;
for (let tries = 0; tries < 20 && !ping; tries++) {
  const from = rig.device.length;
  rig.send('T ping');
  ping = ((await rig.device.waitFor(/^T> pong /, from, 3000)) ?? '').slice(3).trim() || null;
}
// The device reports its own id (a hash of its MAC); the MAC itself is never read.
const deviceId = (/\bid=([0-9a-f]{12})\b/.exec(ping ?? '') ?? [])[1] ?? null;
console.log(ping ? `device: ${ping}` : 'device: no answer to `T ping` in 60 s (is the hil env on the device?)');

/** Runs a scenario while watching the device's session id (preflight.mjs
 *  transportWatch). On a reconnect every pending and later wait gives up at
 *  once, so the scenario fails within moments, and its reason starts with
 *  `transport: reconnect`: weak WiFi is never reported as a product bug. */
async function runWatched(scenario) {
  const watch = transportWatch();
  let seen = rig.device.length;
  let giveUp;
  const reconnected = new Promise((done) => { giveUp = done; });
  const timer = setInterval(() => {
    for (; seen < rig.device.length; seen++) if (watch.see(rig.device.lines[seen])) giveUp(null);
  }, 100);
  const guarded = (stream) => Object.assign(Object.create(stream), {
    waitFor: (re, from, ms) => Promise.race([stream.waitFor(re, from, ms), reconnected]),
  });
  const result = await runScenario(scenario, { ...rig, device: guarded(rig.device), server: guarded(rig.server) });
  clearInterval(timer);
  for (; seen < rig.device.length; seen++) watch.see(rig.device.lines[seen]);
  if (!watch.fault) return result;
  return { ...result, status: 'fail', reason: `${watch.fault}; ${result.reason ?? 'the steps after it passed'}` };
}

// The Waveshare product firmware talks to Production; a run points the device at this PC's throwaway server (this PC's LAN address, plain
// ws://) and back at Production before the product firmware is flashed again. Never printed.
const waveshareRun = HIL_ENV.startsWith('waveshare-');
function lanHost() {
  // BOB_HIL_HOST wins. Else this PC's own LAN address (192.168.x.x, then 10.x.x.x; virtual-switch and VPN addresses are skipped),
  // which is the one the device can reach; the secrets file's V2_HOST names the developer's regular server and may be another machine.
  if (process.env.BOB_HIL_HOST) return process.env.BOB_HIL_HOST;
  const addresses = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  return addresses.find((ip) => ip.startsWith('192.168.')) ?? addresses.find((ip) => ip.startsWith('10.')) ?? null;
}
async function consoleOk(command) {
  const from = rig.device.length;
  rig.send(command);
  return Boolean(await rig.device.waitFor(/^T> ok srv/, from, 5000));
}
if (waveshareRun && ping) {
  const host = lanHost();
  if (!host || !(await consoleOk(`T srv set dev ${host} ${SERVER_PORT}`))) {
    console.error('could not point the Waveshare at the HIL server (the PC LAN address, then `T srv set dev`; BOB_HIL_HOST overrides it); not running.');
    await consoleOk('T srv set prod');
    await restore(runDir);
    process.exit(1);
  }
  console.log('device: pointed at the HIL server for this run');
}
// The guard: no scenario runs unless the device reports the dev profile over plain ws:// (the throwaway server), never Production. A device
// on Production would pair, talk and create turns on the real account.
if (waveshareRun && !ping) {
  console.error('REFUSING TO RUN: the device did not answer `T ping`, so its server profile is unknown (it may be on Production). Nothing was run.');
  await restore(runDir);
  process.exit(1);
}
if (ping) {
  const from = rig.device.length;
  rig.send('T srv dump');
  const dump = ((await rig.device.waitFor(/^T> srv profile=/, from, 5000)) ?? '').slice(3).trim();
  const profile = (/\bprofile=(\w+)/.exec(dump) ?? [])[1];
  const plain = /\btls=0\b/.test(dump);
  if (profile !== 'dev' || !plain) {
    console.error(`REFUSING TO RUN: the device reports ${dump || 'no answer to `T srv dump`'}, not the dev profile over plain ws://. Its turns would reach the real server. Nothing was run.`);
    if (waveshareRun) await consoleOk('T srv set prod');
    await restore(runDir);
    process.exit(1);
  }
}

const results = [];
// Pre-flight (preflight.mjs): once boot-ready passes, a weak WiFi link stops
// the run as an environment problem; the rest are not run, not FAILed.
let environment = null;
for (const scenario of selected) {
  if (environment) {
    results.push({ name: scenario.name, issue: scenario.issue, status: 'skip', reason: `not run: ${environment}`, evidence: [], ms: 0 });
    continue;
  }
  const board = wrongBoard(scenario, HIL_ENV);
  if (board) {
    results.push({ name: scenario.name, issue: scenario.issue, status: 'skip', reason: board, evidence: [], ms: 0 });
    console.log(`SKIP ${scenario.name} — ${board}`);
    continue;
  }
  const blocked = results.find((r) => r.name === 'boot-ready' && r.status === 'fail');
  const missing = missingFeatures(scenario, firmwareSource);
  const result = blocked && !missing.length
    ? { name: scenario.name, issue: scenario.issue, status: 'fail', reason: 'not run: boot-ready failed', evidence: [], ms: 0 }
    // boot-ready and expectsReconnect scenarios reconnect on purpose (schema.mjs).
    : scenario.name === 'boot-ready' || scenario.expectsReconnect ? await runScenario(scenario, rig) : await runWatched(scenario);
  results.push(result);
  console.log(`${result.status.toUpperCase().padEnd(4)} ${scenario.name}${result.reason ? ` — ${result.reason}` : ''}`);
  if (scenario.name === 'boot-ready' && result.status === 'pass') {
    const from = rig.device.length;
    rig.send('T state');
    const reply = ((await rig.device.waitFor(/^T> state=/, from, 3000)) ?? '').slice(3).trim() || null;
    const verdict = rssiVerdict(reply);
    result.evidence.push(`pre-flight: WiFi RSSI ${verdict.rssi ?? 'unknown'} dBm${verdict.note ? ` (${verdict.note})` : ''}`);
    console.log(`pre-flight: WiFi RSSI ${verdict.rssi ?? 'unknown'} dBm${verdict.ok ? '' : ` — ${verdict.reason}`}`);
    if (!verdict.ok) environment = verdict.reason;
  }
}

// Journal privacy (spec 002 V12, journal-privacy.mjs): the server journal of
// these real device turns carries no audio, transcript, agent text, prompt or
// credential. A finding fails the run; it names the line and rule, never the text.
const leaks = scanJournalFile(resolve(runDir, 'server-journal.log'), { extra: [{ name: 'hil-transcript', term: HIL_TRANSCRIPT }] });
const privacy = leaks.length
  ? `journal privacy: ${leaks.length} finding(s) in server-journal.log (${formatFindings(leaks.slice(0, 5)).replaceAll('\n', '; ')}${leaks.length > 5 ? '; …' : ''})`
  : null;
console.log(privacy ? `FAIL ${privacy}\n${formatFindings(leaks)}` : 'journal privacy: server-journal.log is clean');

const head = git(['rev-parse', 'HEAD']);
const headHash = firmwareHashAt('HEAD');
const recordVerdict = recordable({
  results, fullSet: !only && !ota, diskHash: firmwareHashOnDisk(), headHash, flashed: !noFlash,
  pingBuild: (/build=(\S+)/.exec(ping ?? '') ?? [])[1], headSha: head,
});
// An environment stop or a journal leak is never a pass.
const verdict = environment ? { ok: false, reason: environment } : privacy ? { ok: false, reason: privacy } : recordVerdict;
if (verdict.ok) {
  const record = makePassRecord({
    firmwareHash: headHash, tree: git(['rev-parse', 'HEAD^{tree}']), runId, deviceId, ts: new Date().toISOString(),
    runnerVersion: RUNNER_VERSION, scenarios: results.map(({ name, issue, status, reason }) => ({ name, issue, status, ...(reason ? { reason } : {}) })),
  });
  writeFileSync(resolve(ROOT, PASS_RECORD), `${JSON.stringify(record, null, 2)}\n`);
}
const report = renderReport({ runId, firmwareHash: headHash, head, flashed: !noFlash, hilEnv: HIL_ENV, ping, results, attested: verdict.ok, notAttestedReason: verdict.reason });
writeFileSync(resolve(runDir, 'report.md'), report);
writeFileSync(resolve(runDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
const { pass, fail, skip } = counts(results);
console.log(`\n${scenarioTable(results)}\n\nHIL ${runId}: ${pass} passed, ${fail} failed, ${skip} skipped. Report: ${resolve(runDir, 'report.md')}`);
console.log(verdict.ok ? `recorded ${PASS_RECORD}; after pushing run: node scripts/device-attest.mjs` : `not recorded as a pass: ${verdict.reason}`);
// Scenarios set the wake word to alexa; this board is Bob's, so leave the word as Hey Bob (it is stored in NVS and survives the reflash).
if (waveshareRun && ping) {
  const from = rig.device.length;
  rig.send('T wake bob');
  await rig.device.waitFor(/^T> ok$/, from, 5000);
  // The owner runs this board in Always awake; the baseline leaves it in push-to-talk. Put the mode back through the server (the device
  // is still on the HIL server here), and the mode is stored in NVS, so it survives the profile and product restore (#1235).
  const modeFrom = rig.device.length;
  rig.send('T server control mode=wake');
  await rig.device.waitFor(/INFO v2\.mode_changed .*mode=wake/, modeFrom, 8000);
}
if (waveshareRun && ping && !(await consoleOk('T srv set prod'))) console.error('warning: the Waveshare may still point at the HIL server; run `T srv set prod` on the hil build.');
const restored = await restore(runDir);
if (environment) console.log(`
stopped: ${environment}`);
if (privacy) console.log(`\nfailed: ${privacy}`);
process.exit(fail === 0 && pass > 0 && restored && !environment && !privacy ? 0 : 1);
