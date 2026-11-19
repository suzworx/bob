import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/*
 * fw-manifest.mjs — build and verify the signed OTA manifest of a firmware
 * release. The signature is ECDSA P-256 / SHA-256 (DER, base64) over the exact
 * manifest.json bytes. The private key comes from BOB_FW_SIGNING_KEY only;
 * no key, hash or token is ever printed.
 */

const STATIC = JSON.parse(readFileSync(new URL('./fw-release.json', import.meta.url), 'utf8'));
const SEMVER = /^\d+\.\d+\.\d+$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function die(message) {
  console.error(`fw-manifest: ${message}`);
  process.exit(1);
}

export function buildManifest(o) {
  if (!SEMVER.test(o.version)) throw new Error('version must be X.Y.Z');
  if (!/^[0-9a-f]{7,40}$/.test(o.gitSha)) throw new Error('git sha must be hex');
  const bin = readFileSync(o.bin);
  const notes = (o.notes.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 80);
  return {
    schema: 1,
    product: STATIC.product,
    version: o.version,
    boards: STATIC.boards,
    image: { file: `bob-cardputer-v${o.version}.bin`, size: bin.length, sha256: sha256(bin) },
    min_from: STATIC.min_from,
    allow_downgrade: STATIC.allow_downgrade,
    rollback_safe: STATIC.rollback_safe,
    settings_schema: STATIC.settings_schema,
    requires_bootloader: STATIC.requires_bootloader,
    mandatory: o.mandatory,
    security_fix: o.securityFix,
    key_id: o.keyId,
    git_sha: o.gitSha,
    built_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    notes,
  };
}

// Checks a signature over the exact manifest bytes; with a bin, also its size and sha256.
export function verifyBundle({ manifest, sig, pubPem, bin }) {
  const signature = Buffer.from(sig.toString('utf8').trim(), 'base64');
  if (!verify('sha256', manifest, createPublicKey(pubPem), signature)) return 'bad signature';
  if (bin) {
    const { image } = JSON.parse(manifest.toString('utf8'));
    if (bin.length !== image.size) return 'bin size does not match the manifest';
    if (sha256(bin) !== image.sha256) return 'bin sha256 does not match the manifest';
  }
  return null;
}

function build(v) {
  const keyPem = process.env.BOB_FW_SIGNING_KEY;
  if (!keyPem) die('BOB_FW_SIGNING_KEY is not set');
  for (const k of ['bin', 'elf', 'version', 'git-sha', 'notes', 'out']) {
    if (v[k] === undefined) die(`--${k} is required`);
  }
  const manifest = buildManifest({
    bin: v.bin,
    version: v.version,
    gitSha: v['git-sha'],
    notes: v.notes,
    keyId: v['key-id'],
    mandatory: v.mandatory,
    securityFix: v['security-fix'],
  });
  const elfName = `bob-cardputer-v${v.version}.elf`;
  if (basename(v.bin) !== manifest.image.file) die(`--bin must be named ${manifest.image.file}`);
  if (basename(v.elf) !== elfName) die(`--elf must be named ${elfName}`);

  const privateKey = createPrivateKey(keyPem);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const sig = `${sign('sha256', manifestBytes, privateKey).toString('base64')}\n`;
  const err = verifyBundle({
    manifest: manifestBytes,
    sig,
    pubPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }),
    bin: readFileSync(v.bin),
  });
  if (err) die(`self-verify failed: ${err}`);

  mkdirSync(v.out, { recursive: true });
  writeFileSync(join(v.out, 'manifest.json'), manifestBytes);
  writeFileSync(join(v.out, 'manifest.sig'), sig);
  const sums = [
    [manifest.image.file, readFileSync(v.bin)],
    [elfName, readFileSync(v.elf)],
    ['manifest.json', manifestBytes],
    ['manifest.sig', Buffer.from(sig)],
  ];
  writeFileSync(join(v.out, 'SHA256SUMS'), sums.map(([n, b]) => `${sha256(b)}  ${n}\n`).join(''));
  console.log(`fw-manifest: built and verified the v${v.version} bundle in ${v.out}`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const { values: v } = parseArgs({
    args: rest,
    options: {
      bin: { type: 'string' },
      elf: { type: 'string' },
      version: { type: 'string' },
      'git-sha': { type: 'string' },
      notes: { type: 'string' },
      out: { type: 'string' },
      'key-id': { type: 'string', default: 'fw-2026a' },
      mandatory: { type: 'boolean', default: false },
      'security-fix': { type: 'boolean', default: false },
      manifest: { type: 'string' },
      sig: { type: 'string' },
      pub: { type: 'string' },
    },
  });
  if (cmd === 'build') return build(v);
  if (cmd === 'verify') {
    if (!v.manifest || !v.sig || !v.pub) die('verify needs --manifest, --sig and --pub');
    const err = verifyBundle({
      manifest: readFileSync(v.manifest),
      sig: readFileSync(v.sig),
      pubPem: readFileSync(v.pub),
      bin: v.bin ? readFileSync(v.bin) : undefined,
    });
    if (err) die(err);
    return console.log('fw-manifest: verified');
  }
  return die('usage: fw-manifest.mjs build|verify [options]');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
