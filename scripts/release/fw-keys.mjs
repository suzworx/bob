import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/*
 * fw-keys.mjs — OTA signing key tooling. `gen` writes an ECDSA P-256 keypair
 * (the private key mode 0600, never printed); `header` renders the public keys
 * the device trusts as a C++ header.
 */

export function renderHeader(keys) {
  const entries = keys.map(
    ({ id, pem }) => `  { "${id}", "${pem.trim().replace(/\r?\n/g, '\\n')}\\n" },`,
  );
  return [
    '#pragma once',
    '#include <stddef.h>',
    '',
    'struct FwKey { const char* id; const char* pem; };',
    'static const FwKey kFwKeys[] = {',
    ...entries,
    '};',
    `static const size_t kFwKeyCount = ${keys.length};`,
    '',
  ].join('\n');
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const { values: v } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      'out-dir': { type: 'string' },
      out: { type: 'string' },
      pub: { type: 'string', multiple: true },
    },
  });
  if (cmd === 'gen') {
    if (!v.id || !v['out-dir']) throw new Error('gen needs --id and --out-dir');
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    mkdirSync(v['out-dir'], { recursive: true });
    writeFileSync(
      join(v['out-dir'], `${v.id}.key.pem`),
      privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(v['out-dir'], `${v.id}.pub.pem`),
      publicKey.export({ type: 'spki', format: 'pem' }),
    );
    console.log(`fw-keys: wrote ${v.id}.key.pem and ${v.id}.pub.pem`);
  } else if (cmd === 'header') {
    if (!v.pub?.length || !v.out) throw new Error('header needs --pub ID=PEMFILE and --out');
    const keys = v.pub.map((spec) => {
      const [id, file] = spec.split('=');
      if (!id || !file) throw new Error('--pub must be ID=PEMFILE');
      return { id, pem: readFileSync(file, 'utf8') };
    });
    writeFileSync(v.out, renderHeader(keys));
    console.log(`fw-keys: wrote ${keys.length} key(s) to ${v.out}`);
  } else {
    throw new Error('usage: fw-keys.mjs gen|header [options]');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
