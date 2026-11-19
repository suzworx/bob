import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CARDPUTER_DIR, HIL_ENV, pio, ROOT } from './rig.mjs';
import { spawnSync } from 'node:child_process';

/*
 * ota-bundle.mjs — builds the signed OTA test releases the --ota HIL run
 * installs (docs/cardputer/ota-device.md). Both are the hil env at a version
 * above any local build, signed with the fw-hil key, which only dev builds
 * trust. Both are mandatory: a normal offer waits out a random rollout delay of up to 6 h. `crash` also defines BOB_OTA_TEST_CRASH: it aborts at boot before the
 * health gate, so the bootloader must roll back. The private key is read from
 * the git-ignored data/ota-keys/ into the child's environment and never printed.
 */
export const OTA_KEY_DIR = resolve(ROOT, 'data', 'ota-keys');
export const OTA_VARIANTS = {
  good: { version: '99.0.0', flags: '' },
  crash: { version: '99.0.1', flags: '-DBOB_OTA_TEST_CRASH=1' },
};

export function otaKeysPresent() {
  return existsSync(resolve(OTA_KEY_DIR, 'fw-hil.key.pem')) && existsSync(resolve(OTA_KEY_DIR, 'fw-hil.pub.pem'));
}

/** The BOB_FW_PUBKEYS value for the HIL server: the fw-hil public key. */
export function otaPubkeysEnv() {
  return JSON.stringify({ 'fw-hil': readFileSync(resolve(OTA_KEY_DIR, 'fw-hil.pub.pem'), 'utf8') });
}

/** Builds and signs one variant into `<runDir>/ota/<name>`. Resolves the bundle directory, or null on failure. */
export async function buildOtaBundle(name, runDir) {
  const { version, flags } = OTA_VARIANTS[name];
  const out = resolve(runDir, 'ota', name);
  mkdirSync(out, { recursive: true });
  const saved = { fw: process.env.BOB_FW_VERSION, flags: process.env.PLATFORMIO_BUILD_FLAGS };
  process.env.BOB_FW_VERSION = version;
  process.env.PLATFORMIO_BUILD_FLAGS = flags;
  const build = await pio(['run', '-e', HIL_ENV], resolve(runDir, `ota-${name}-build.log`));
  for (const [key, value] of [['BOB_FW_VERSION', saved.fw], ['PLATFORMIO_BUILD_FLAGS', saved.flags]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (!build.ok) return null;

  const dir = resolve(CARDPUTER_DIR, '.pio', 'build', HIL_ENV);
  const bin = resolve(out, `bob-cardputer-v${version}.bin`);
  const elf = resolve(out, `bob-cardputer-v${version}.elf`);
  copyFileSync(resolve(dir, 'firmware.bin'), bin);
  copyFileSync(resolve(dir, 'firmware.elf'), elf);
  const sha = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const signed = spawnSync(process.execPath, [
    resolve(ROOT, 'scripts', 'release', 'fw-manifest.mjs'), 'build', '--bin', bin, '--elf', elf, '--version', version,
    '--git-sha', sha, '--notes', `HIL ${name}`, '--out', out, '--key-id', 'fw-hil', '--mandatory',
  ], { encoding: 'utf8', env: { ...process.env, BOB_FW_SIGNING_KEY: readFileSync(resolve(OTA_KEY_DIR, 'fw-hil.key.pem'), 'utf8') } });
  if (signed.status !== 0) {
    console.error(`ota bundle ${name}: signing failed: ${signed.stderr.trim().split('\n').pop()}`);
    return null;
  }
  return out;
}
