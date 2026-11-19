import { describe, expect, it } from 'vitest';

import { firmwareHash, isFirmwareInput } from './firmware-hash.mjs';

const files = () => [
  { path: 'apps/cardputer/src/main.cpp', content: Buffer.from('int main() {\n  return 0;\n}\n') },
  { path: 'apps/cardputer/include/config.h', content: Buffer.from('#pragma once\n') },
  { path: 'apps/cardputer/platformio.ini', content: Buffer.from('[env:x]\nboard = y\n') },
];

describe('firmware hash inputs', () => {
  it('covers the firmware sources, headers, libraries and platformio.ini', () => {
    expect(isFirmwareInput('apps/cardputer/src/network.cpp')).toBe(true);
    expect(isFirmwareInput('apps/cardputer/include/protocol.h')).toBe(true);
    expect(isFirmwareInput('apps/cardputer/lib/wake/wake.cpp')).toBe(true);
    expect(isFirmwareInput('apps/cardputer/platformio.ini')).toBe(true);
    expect(isFirmwareInput('libs/bob-device/src/bob_rig.cpp')).toBe(true);
  });

  it('ignores scripts, docs, the harness and other apps', () => {
    expect(isFirmwareInput('apps/cardputer/scripts/run-pio.mjs')).toBe(false);
    expect(isFirmwareInput('apps/cardputer/package.json')).toBe(false);
    expect(isFirmwareInput('apps/cardputer/hil/README.md')).toBe(false);
    expect(isFirmwareInput('apps/api/src/server.ts')).toBe(false);
    expect(isFirmwareInput('docs/cardputer/hil.md')).toBe(false);
    expect(isFirmwareInput('apps/cardputer/srcx/a.cpp')).toBe(false);
  });

  it('accepts Windows separators', () => {
    expect(isFirmwareInput('apps\\cardputer\\src\\main.cpp')).toBe(true);
  });

  it('invalidates device proof when either PCM build generator changes', () => {
    for (const name of ['earcons_wave.py', 'earcons_build.py']) {
      const path = `apps/cardputer/scripts/${name}`;
      expect(isFirmwareInput(path)).toBe(true);
      const before = [...files(), { path, content: Buffer.from('old recipe') }];
      const after = [...files(), { path, content: Buffer.from('new recipe') }];
      expect(firmwareHash(before)).not.toBe(firmwareHash(after));
    }
  });
});

describe('firmwareHash', () => {
  it('is a 64-hex sha256 and stable for the same content', () => {
    const hash = firmwareHash(files());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(firmwareHash(files())).toBe(hash);
  });

  it('does not depend on the order files are listed in', () => {
    expect(firmwareHash(files().reverse())).toBe(firmwareHash(files()));
  });

  it('treats CRLF and LF checkouts as the same firmware', () => {
    const crlf = files().map((f) => ({ ...f, content: Buffer.from(f.content.toString().replace(/\n/g, '\r\n')) }));
    expect(firmwareHash(crlf)).toBe(firmwareHash(files()));
  });

  it('changes when any input changes content', () => {
    const base = firmwareHash(files());
    for (let i = 0; i < files().length; i++) {
      const changed = files();
      changed[i] = { ...changed[i], content: Buffer.concat([changed[i].content, Buffer.from(' ')]) };
      expect(firmwareHash(changed)).not.toBe(base);
    }
  });

  it('changes when a file is added, removed or renamed', () => {
    const base = firmwareHash(files());
    expect(firmwareHash([...files(), { path: 'apps/cardputer/src/new.cpp', content: Buffer.from('') }])).not.toBe(base);
    expect(firmwareHash(files().slice(1))).not.toBe(base);
    const renamed = files();
    renamed[0] = { ...renamed[0], path: 'apps/cardputer/src/app.cpp' };
    expect(firmwareHash(renamed)).not.toBe(base);
  });

  it('cannot be forged by moving bytes between a path and its content', () => {
    const a = [{ path: 'apps/cardputer/src/ab', content: Buffer.from('c') }];
    const b = [{ path: 'apps/cardputer/src/a', content: Buffer.from('bc') }];
    expect(firmwareHash(a)).not.toBe(firmwareHash(b));
  });

  it('ignores listed files that are not firmware inputs', () => {
    const noise = [...files(), { path: 'apps/cardputer/scripts/x.mjs', content: Buffer.from('x') }];
    expect(firmwareHash(noise)).toBe(firmwareHash(files()));
  });
});
