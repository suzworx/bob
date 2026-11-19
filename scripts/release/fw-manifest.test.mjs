import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderHeader } from './fw-keys.mjs';

const MANIFEST = join(import.meta.dirname, 'fw-manifest.mjs');
const pair = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const priv = (k) => k.privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = (k) => k.publicKey.export({ type: 'spki', format: 'pem' });

let dir;
let key;
let other;
let env;
const bin = () => join(dir, 'bob-cardputer-v1.2.3.bin');
const elf = () => join(dir, 'bob-cardputer-v1.2.3.elf');
const out = () => join(dir, 'out');
const node = (args, e = env) =>
  spawnSync(process.execPath, [MANIFEST, ...args], { encoding: 'utf8', env: e });
const verifyArgs = (extra = []) => [
  'verify',
  '--manifest', join(out(), 'manifest.json'),
  '--sig', join(out(), 'manifest.sig'),
  '--pub', join(dir, 'pub.pem'),
  ...extra,
];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fw-manifest-'));
  key = pair();
  other = pair();
  env = { ...process.env, BOB_FW_SIGNING_KEY: priv(key) };
  writeFileSync(bin(), Buffer.from('fake firmware image'));
  writeFileSync(elf(), Buffer.from('fake elf'));
  writeFileSync(join(dir, 'pub.pem'), pub(key));
  writeFileSync(join(dir, 'other.pem'), pub(other));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('fw-manifest build', () => {
  it('writes a signed bundle that verifies', () => {
    const r = node([
      'build', '--bin', bin(), '--elf', elf(), '--version', '1.2.3',
      '--git-sha', 'abc1234', '--notes', '\n  first line  \nsecond', '--out', out(),
    ]);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(join(out(), 'manifest.json'), 'utf8');
    const m = JSON.parse(text);
    expect(Object.keys(m)).toEqual([
      'schema', 'product', 'version', 'boards', 'image', 'min_from', 'allow_downgrade',
      'rollback_safe', 'settings_schema', 'requires_bootloader', 'mandatory', 'security_fix',
      'key_id', 'git_sha', 'built_at', 'notes',
    ]);
    expect(text).toBe(`${JSON.stringify(m, null, 2)}\n`);
    expect(m.image).toEqual({
      file: 'bob-cardputer-v1.2.3.bin',
      size: 19,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(m).toMatchObject({ mandatory: false, security_fix: false, key_id: 'fw-2026a', notes: 'first line' });
    expect(m.built_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    const sums = readFileSync(join(out(), 'SHA256SUMS'), 'utf8').trimEnd().split('\n');
    expect(sums.map((l) => l.split('  ')[1])).toEqual([
      'bob-cardputer-v1.2.3.bin', 'bob-cardputer-v1.2.3.elf', 'manifest.json', 'manifest.sig',
    ]);
    expect(sums[0].split('  ')[0]).toBe(m.image.sha256);
    expect(sums.every((l) => /^[0-9a-f]{64} {2}\S+$/.test(l))).toBe(true);
    expect(node(verifyArgs(['--bin', bin()])).status).toBe(0);
  });

  it('fails loudly when the env key is unset', () => {
    const { BOB_FW_SIGNING_KEY: _drop, ...bare } = env;
    const r = node([
      'build', '--bin', bin(), '--elf', elf(), '--version', '1.2.3',
      '--git-sha', 'abc1234', '--notes', 'n', '--out', join(dir, 'none'),
    ], bare);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BOB_FW_SIGNING_KEY');
  });
});

describe('fw-manifest verify', () => {
  it('fails on a flipped manifest byte', () => {
    const bytes = readFileSync(join(out(), 'manifest.json'));
    bytes[bytes.indexOf('1.2.3')] ^= 1;
    writeFileSync(join(dir, 'flipped.json'), bytes);
    const args = verifyArgs();
    args[2] = join(dir, 'flipped.json');
    expect(node(args).status).toBe(1);
  });

  it('fails with a wrong key', () => {
    const args = verifyArgs();
    args[6] = join(dir, 'other.pem');
    expect(node(args).status).toBe(1);
  });

  it('fails on a tampered bin', () => {
    writeFileSync(join(dir, 'tampered.bin'), Buffer.from('fake firmware imagE'));
    expect(node(verifyArgs(['--bin', join(dir, 'tampered.bin')])).status).toBe(1);
  });
});

describe('fw-keys header', () => {
  it('renders the key table', () => {
    const h = renderHeader([{ id: 'fw-2026a', pem: pub(key) }]);
    expect(h).toContain('struct FwKey { const char* id; const char* pem; };');
    expect(h).toContain('static const FwKey kFwKeys[] = {');
    expect(h).toContain('{ "fw-2026a", "-----BEGIN PUBLIC KEY-----\\n');
    expect(h).toContain('-----END PUBLIC KEY-----\\n" },');
    expect(h).toContain('static const size_t kFwKeyCount = 1;');
  });
});
