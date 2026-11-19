// Candidate renders for the Waveshare flash gate: every case in cases.json drawn by the firmware sources of a
// checkout, through bob-sim (gcc + LovyanGFX in Docker; no hardware).
//   node tools/visual-gate/candidate.mjs --out <dir> [--fw <checkout>] [--rig on|off]
// <checkout> defaults to this repo. It must carry tools/bob-sim (the simulator) and apps/cardputer; the gate's own
// driver (sim/main.cpp) replaces bob-sim's CLI so every checkout renders the same states the same way.
// The rig variant is explicit: --rig, else what the device build would do (BOB_RIG=1 in the environment, as
// scripts/bob_rig_flag.py reads it). The build gets -DBOBSIM_RIG and -DGATE_RIG, and `bob-sim --info` must report
// that variant. Any case without a render is a hard error that carries the simulator's own message.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deviceRig, variantCases } from './flash-guard.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const IMAGE_NAME = 'bob-sim';
const CACHE = 'bob-visual-gate-cache'; // docker volume: LovyanGFX download + per-checkout build dirs
const { cases, frameMs } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'cases.json'), 'utf8'));

// Every docker call has a deadline, so a hung engine fails fast with one clear message instead of piling up processes.
export const DOCKER_TIMEOUT_MS = { probe: 20_000, inspect: 30_000, build: 15 * 60_000, run: 20 * 60_000, cleanup: 20_000 };

/** Null when a docker call finished (whatever its exit code), else why it did not. */
export function dockerProblem(result, what, ms) {
  if (result.error?.code === 'ETIMEDOUT' || (result.signal && result.status === null)) {
    return `docker ${what} did not finish within ${Math.round(ms / 1000)} s: the Docker engine looks hung (restart Docker Desktop and retry); no pass was written`;
  }
  if (result.error) return `docker ${what} could not start: ${result.error.message}`;
  return null;
}

function docker(args, what, { inherit = true } = {}) {
  const ms = DOCKER_TIMEOUT_MS[what];
  const result = spawnSync('docker', args, {
    stdio: inherit ? 'inherit' : 'pipe', encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL', env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  const problem = dockerProblem(result, what, ms);
  if (problem) throw new Error(problem);
  return result;
}

/** bob-sim arguments for one case: the frame count puts the capture at case.atMs after the state starts. */
export function simArgs(c) {
  if (c.move && !(c.t >= 0 && c.t <= 1)) throw new Error(`case ${c.id}: a move needs its key pose t in [0, 1]`);
  const args = ['--state', c.state, '--frames', String(Math.max(1, Math.round(c.atMs / frameMs))), '--freeze'];
  if (c.emotion) args.push('--emotion', c.emotion);
  if (c.move) args.push('--move', c.move, '--pose-t', String(c.t));
  return args;
}

/** The configure flags: the rig variant is passed both to the checkout's own option and to the gate's overlay. */
export function cmakeArgs(build, rig) {
  const v = rig ? 'ON' : 'OFF';
  return ['-S', '/work/sim', '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DBOBSIM_RIG=${v}`, `-DGATE_RIG=${v}`,
    '-DGATE_FW=/src/apps/cardputer', '-DFETCHCONTENT_BASE_DIR=/cache/deps'];
}

/** Null when `bob-sim --info` reports the requested variant and the REST-mode hooks, else why not. */
export function infoProblem(info, rig) {
  const m = /rig=([01])/.exec(info ?? '');
  if (!m) return `bob-sim --info printed no variant (${JSON.stringify(String(info ?? '').trim())})`;
  if ((m[1] === '1') !== rig) return `bob-sim was compiled with rig=${m[1]} but the gate asked for rig=${rig ? 1 : 0}`;
  if (!/freeze=1/.test(info)) {
    return 'the firmware has no BOBSIM_FREEZE hooks (bobMotionFreeze, bobMotionPoseAt in bob_motion.h); REST mode cannot hold Bob still';
  }
  return null;
}

/** The cases a variant is judged on (rig-only moves are left out of the whole-pose Bob). */
export const casesFor = (rig) => variantCases(cases, rig);

/** Every case of a variant is rendered a second time STILL_EARLIER_MS earlier: REST mode must draw the same bytes, or Bob
 *  is moving (the firmware freezes breath, gesture, blink and gaze under -DBOBSIM_FREEZE, in both renderers; a regression
 *  fails here by name). 891 ms is 27 frames, a quarter of a breath, and keeps both captures inside the same pairing-countdown second. */
export const STILL_EARLIER_MS = 891;

/** Null when each id's render matches its earlier twin byte for byte, else which one moved. */
export function stillnessProblem(outDir, ids) {
  const moved = [];
  for (const id of ids) {
    const dir = join(outDir, `_still-${id}`);
    const twin = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.png')) : null;
    const main = join(outDir, `${id}.png`);
    if (!twin || !existsSync(main)) { moved.push(`${id}: no earlier render`); continue; }
    if (!readFileSync(main).equals(readFileSync(join(dir, twin)))) moved.push(`${id}: the render ${STILL_EARLIER_MS} ms earlier differs`);
    rmSync(dir, { recursive: true, force: true });
  }
  return moved.length ? `Bob is not held still in REST mode (${moved.join('; ')})` : null;
}

/** Moves each case's PNG to <id>.png; throws, naming every missing case and the simulator's message for it. */
export function collectRenders(outDir, list) {
  const missing = [];
  for (const c of list) {
    const dir = join(outDir, c.id);
    const png = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.png')) : null;
    if (!png) {
      const errFile = join(outDir, `${c.id}.err`);
      const why = existsSync(errFile) ? readFileSync(errFile, 'utf8').trim().split('\n').pop() : '';
      missing.push(`${c.id}: ${why || 'bob-sim wrote no PNG'}`);
      continue;
    }
    renameSync(join(dir, png), join(outDir, `${c.id}.png`));
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(outDir, `${c.id}.err`), { force: true });
  }
  if (missing.length) throw new Error(`no candidate render for ${missing.length}/${list.length} case(s):\n  ${missing.join('\n  ')}`);
}

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const onFail = '|| { grep -E "error|FAILED|undefined reference" /tmp/build.log | sed "s/.*undefined reference to/undef/" | sort -u | head -30; exit 1; }';

/** The checkout's bob-sim image (built when missing), after checking the engine answers. */
function simImage(fw) {
  if (!existsSync(join(fw, 'tools/bob-sim/CMakeLists.txt'))) {
    throw new Error(`${fw} has no tools/bob-sim; the gate renders firmware through the simulator`);
  }
  // Tagged by the checkout's Dockerfile, so a changed toolchain pin builds a new image instead of reusing an old one.
  const IMAGE = `${IMAGE_NAME}:${createHash('sha256').update(readFileSync(join(fw, 'tools/bob-sim/Dockerfile'))).digest('hex').slice(0, 12)}`;
  if (docker(['version', '--format', '{{.Server.Version}}'], 'probe', { inherit: false }).status !== 0) {
    throw new Error('the Docker engine is not reachable (start Docker Desktop); no pass was written');
  }
  if (docker(['image', 'inspect', IMAGE], 'inspect', { inherit: false }).status !== 0) {
    const built = docker(['build', '-t', IMAGE, join(fw, 'tools/bob-sim')], 'build');
    if (built.status !== 0) throw new Error('cannot build the bob-sim image');
  }
  return IMAGE;
}

/** Runs `script` in the sim image with the checkout at /src, the gate at /gate and `outDir` at /out, under a deadline. */
function runInSim(fw, IMAGE, outDir, script, extraMounts = []) {
  const name = `bob-visual-gate-${process.pid}-${Date.now()}`;
  try {
    return docker(['run', '--rm', '--name', name, '-v', `${fw}:/src:ro`, '-v', `${resolve(import.meta.dirname, 'sim')}:/gate:ro`,
      '-v', `${resolve(outDir)}:/out`, '-v', `${CACHE}:/cache`, ...extraMounts, IMAGE, 'bash', '-c', script], 'run');
  } catch (e) {
    // Killing the CLI leaves the container running; remove it (best effort, also bounded).
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: DOCKER_TIMEOUT_MS.cleanup, killSignal: 'SIGKILL' });
    throw e;
  }
}

/**
 * Draws text lines the way the device does (sim/textprobe.cpp: the firmware's Nunito VLW fonts through LovyanGFX's
 * smooth-font path, middle_center datum), one coverage PNG per line: <outDir>/text-NNN.png. `jobs` is a list of
 * { role, x, y, text }. Used by faithful.py to measure what device text can score.
 */
export function renderDeviceText(fw, jobs, outDir) {
  fw = resolve(fw);
  const IMAGE = simImage(fw);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'jobs.tsv'), jobs.map((j) => [j.role, Math.round(j.x), Math.round(j.y), j.text.replace(/[\t\n]/g, ' ')].join('\t')).join('\n') + '\n');
  const build = `/cache/build-${createHash('sha256').update(`${fw}|rig=false`).digest('hex').slice(0, 12)}`;
  const script = [
    'set -e',
    'bash /gate/prepare.sh',
    `cmake ${cmakeArgs(build, false).join(' ')} >/tmp/build.log 2>&1 ${onFail}`,
    `cmake --build ${build} --target gate-text >/tmp/build.log 2>&1 ${onFail}`,
    `${build}/gate-text /src/apps/cardputer/lib/fonts /out/jobs.tsv /out`,
  ].join('\n');
  const run = runInSim(fw, IMAGE, outDir, script);
  if (run.status !== 0) throw new Error(`the device text probe failed (exit ${run.status})`);
  const missing = jobs.map((_, i) => `text-${String(i).padStart(3, '0')}.png`).filter((f) => !existsSync(join(outDir, f)));
  if (missing.length) throw new Error(`the device text probe wrote no ${missing.join(', ')}`);
}

export function renderCandidates(fw, outDir, { rig = deviceRig() } = {}) {
  fw = resolve(fw);
  const IMAGE = simImage(fw);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const build = `/cache/build-${createHash('sha256').update(`${fw}|rig=${rig}`).digest('hex').slice(0, 12)}`;
  const list = casesFor(rig);
  const renders = list.map((c) => `${build}/bob-sim ${simArgs(c).map(q).join(' ')} --out /out/${c.id} >/dev/null 2>/out/${c.id}.err`);
  const halves = list.map((c) =>
    `${build}/bob-sim ${simArgs({ ...c, atMs: c.atMs - STILL_EARLIER_MS }).map(q).join(' ')} --out /out/_still-${c.id} >/dev/null 2>&1`);
  const script = [
    'set -e',
    'bash /gate/prepare.sh',
    `cmake ${cmakeArgs(build, rig).join(' ')} >/tmp/build.log 2>&1 ${onFail}`,
    'grep -h "visual-gate:" /tmp/build.log || true',
    `cmake --build ${build} --target bob-sim >/tmp/build.log 2>&1 ${onFail}`,
    `${build}/bob-sim --info > /out/info.txt`,
    'set +e',
    ...renders,
    ...halves,
    'true',
  ].join('\n');
  const run = runInSim(fw, IMAGE, outDir, script);
  if (run.status !== 0) throw new Error(`bob-sim build failed (exit ${run.status})`);
  const info = existsSync(join(outDir, 'info.txt')) ? readFileSync(join(outDir, 'info.txt'), 'utf8') : '';
  const problem = infoProblem(info, rig);
  if (problem) throw new Error(problem);
  collectRenders(outDir, list);
  const still = stillnessProblem(outDir, list.map((c) => c.id));
  if (still) throw new Error(still);
  rmSync(join(outDir, 'info.txt'), { force: true });
  return { rig };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const out = arg('--out');
  const rigArg = arg('--rig');
  if (arg('--text-jobs')) {
    // faithful.py: --text-jobs <jobs.json> --out <dir> [--fw <checkout>]
    try {
      renderDeviceText(arg('--fw') ?? ROOT, JSON.parse(readFileSync(arg('--text-jobs'), 'utf8')), out);
      process.exit(0);
    } catch (e) {
      console.error(`candidate: ${e.message}`);
      process.exit(1);
    }
  }
  if (!out || (rigArg && !['on', 'off'].includes(rigArg))) { console.error('usage: candidate.mjs --out <dir> [--fw <checkout>] [--rig on|off]'); process.exit(2); }
  try {
    const { rig } = renderCandidates(arg('--fw') ?? ROOT, out, { rig: rigArg ? rigArg === 'on' : deviceRig() });
    console.log(`rendered ${casesFor(rig).length}/${casesFor(rig).length} candidates (rig=${rig ? 'on' : 'off'}) into ${out}`);
  } catch (e) {
    console.error(`candidate: ${e.message}`);
    process.exit(1);
  }
}
