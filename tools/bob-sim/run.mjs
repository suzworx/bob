// bob-sim runner: builds and runs the desktop round-UI simulator in the pinned gcc image
// (tools/bob-sim/Dockerfile: gcc 14.2 + cmake), the same compiler route as the firmware host
// tests. Needs Docker only; no serial port, no network port.
//   node tools/bob-sim/run.mjs build
//   node tools/bob-sim/run.mjs test
//   node tools/bob-sim/run.mjs render --state listening --emotion love --frames 20 --out docs/waveshare/screenshots
// A bare `--out` path is relative to the repo root.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE = 'bob-sim';
const [command = 'build', ...rest] = process.argv.slice(2);

function docker(args, inherit = true) {
  return spawnSync('docker', args, { stdio: inherit ? 'inherit' : 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
}

if (docker(['image', 'inspect', IMAGE], false).status !== 0) {
  const built = docker(['build', '-t', IMAGE, resolve(root, 'tools/bob-sim')]);
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const BUILD = 'tools/bob-sim/build';
const configure = `cmake -S tools/bob-sim -B ${BUILD} -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build ${BUILD}`;
const steps = {
  build: configure,
  test: `${configure} && ctest --test-dir ${BUILD} --output-on-failure`,
  render: `${configure} >/dev/null && ./${BUILD}/bob-sim ${rest.map((a) => `'${a}'`).join(' ')}`,
};
if (!steps[command]) {
  console.error('usage: run.mjs build | test | render <bob-sim args>');
  process.exit(2);
}
const run = docker(['run', '--rm', '-v', `${root}:/src`, '-w', '/src', IMAGE, 'bash', '-c', steps[command]]);
process.exit(run.status ?? 1);
