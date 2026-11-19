import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Host unit tests for the Cardputer firmware's pure logic (npm run
// test:firmware). Compiles the REAL src/protocol.cpp and src/types.cpp against
// the Arduino shim in test/host/shim, links the doctest suites in test/host,
// and runs them under AddressSanitizer + UBSan from apps/cardputer, so the
// suites read test/fixtures/wire by relative path. Every test/host/*.cpp is a
// suite; header-only logic (e.g. test_quiet.cpp: the gain table and the idle
// speaker rule) needs no extra source here.
//
// Compiler: $CXX, else g++ or clang++ on PATH. Windows has no ASan-capable
// g++ (MinGW lacks the runtime), so there -- or with --docker, or when no
// compiler is found -- the identical command runs in the pinned gcc image.
//
// --emit (npm run wire:emit) sets BOB_WIRE_EMIT=1, so test_builders.cpp
// rewrites test/fixtures/wire/emitted/ instead of failing on a stale file.

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The repo root: Bob's portable core (libs/bob-device) sits beside apps/, so Docker mounts the whole checkout.
const REPO_DIR = resolve(APP_DIR, '..', '..');
// gcc:14.2.0, pinned by digest so a retagged image cannot change the compiler.
const IMAGE = 'gcc:14.2.0@sha256:b99b86a28812b1e6453a231a947dc43d76fe192788a12f344a9b568bf9f5d24c';
const OUT = 'test/host/build/host-tests';

const tests = readdirSync(resolve(APP_DIR, 'test/host'))
  .filter((name) => name.endsWith('.cpp'))
  .map((name) => `test/host/${name}`);
// The #675 settings store is pure over KvStore (include/kv_store.h), so its
// real sources run here against the in-memory fake in test/host/fake_kv.h.
const settingsSources = [
  'src/kv_store.cpp', 'src/net_store.cpp', 'src/server_profile.cpp',
  'src/device_token.cpp', 'src/settings_migration.cpp', 'src/wifi_join.cpp',
  'src/text_field.cpp', 'src/reset_actions.cpp', 'src/ota_manifest.cpp', 'src/ota_verify.cpp',
];
// src/ota_verify.cpp calls mbedTLS; on the host test/host/shim/mbedtls maps
// that slice onto OpenSSL libcrypto (libssl-dev; in the gcc image and on CI).
const libs = ['-lcrypto'];
const sources = ['src/protocol.cpp', 'src/types.cpp', 'test/host/shim/board_model.cpp', 'src/earcons.cpp', ...settingsSources, ...tests];
const flags = [
  '-std=c++17', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
  '-fno-omit-frame-pointer', '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
  '-Itest/host/shim', '-Itest/host/vendor', '-Iinclude', '-I../../libs/bob-device/src', '-Itest/host/build',
];
const OWN_FLAGS = new Set(['--docker', '--emit']);
const extraArgs = process.argv.slice(2).filter((arg) => !OWN_FLAGS.has(arg));
const emitEnv = process.argv.includes('--emit') ? { BOB_WIRE_EMIT: '1' } : {};

// True when `command --version` runs, i.e. the compiler exists on PATH.
function works(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore', shell: false }).status === 0;
}

function localCompiler() {
  if (process.argv.includes('--docker') || process.platform === 'win32') return null;
  if (process.env.CXX && works(process.env.CXX)) return process.env.CXX;
  return ['g++', 'clang++'].find(works) ?? null;
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: APP_DIR, stdio: 'inherit', shell: false, env });
  if (result.error) console.error(`[host-tests] ${command}: ${result.error.message}`);
  return result.status ?? 1;
}

mkdirSync(resolve(APP_DIR, 'test/host/build'), { recursive: true });
const python = process.platform === 'win32' ? 'py' : 'python3';
const pythonArgs = process.platform === 'win32' ? ['-3.11'] : [];
const generated = run(python, [...pythonArgs, 'scripts/earcons_wave.py', 'test/host/build/earcons_pcm.h']);
if (generated !== 0) process.exit(generated);
const compiler = localCompiler();
let status;
if (compiler) {
  console.log(`[host-tests] ${compiler}, ${sources.length} translation units, ASan+UBSan`);
  status = run(compiler, [...flags, ...sources, '-o', OUT, ...libs]);
  if (status === 0) {
    status = run(`./${OUT}`, extraArgs, { ...process.env, ...emitEnv, ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=0' });
  }
} else {
  console.log(`[host-tests] no local ASan-capable compiler; using ${IMAGE.split('@')[0]} in Docker`);
  const script = [
    ['g++', ...flags, ...sources, '-o', OUT, ...libs].join(' '),
    [`./${OUT}`, ...extraArgs].join(' '),
  ].join(' && ');
  status = run('docker', [
    'run', '--rm', '-v', `${REPO_DIR}:/work`, '-w', '/work/apps/cardputer',
    // LeakSanitizer needs ptrace, which Docker's default seccomp profile denies.
    '--cap-add', 'SYS_PTRACE', '-e', 'ASAN_OPTIONS=detect_leaks=1',
    ...Object.entries(emitEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    IMAGE, 'sh', '-c', script,
  ]);
}
process.exit(status);
