import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBin, runBin } from './run-bin.mjs';

const SCRIPTS = import.meta.dirname;
const SELF = resolve(import.meta.filename);

function* mjsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') yield* mjsFiles(path); }
    else if (entry.name.endsWith('.mjs')) yield path;
  }
}

// A quoted '.bin' path segment: 'node_modules/.bin/x', '.bin\\x' or join(..., '.bin', ...).
const SHIM = /(['"`])(?:[^'"`\n]*[/\\])?\.bin(?:[/\\][^'"`\n]*)?\1/u;

describe('no node_modules/.bin shim spawns in scripts/', () => {
  it('runs every dependency CLI through run-bin.mjs, never through its .bin shim', () => {
    const hits = [];
    for (const file of mjsFiles(SCRIPTS)) {
      if (resolve(file) === SELF) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (SHIM.test(line)) hits.push(`scripts/${relative(SCRIPTS, file).replaceAll('\\', '/')}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits, 'Windows cannot spawn a .bin shim without a shell; use runBin() from scripts/run-bin.mjs').toEqual([]);
  });

  it('the pattern catches the shapes that broke Windows', () => {
    expect(SHIM.test(`const bin = join(ROOT, 'node_modules/.bin/biome');`)).toBe(true);
    expect(SHIM.test(`join(ROOT, 'node_modules', '.bin', 'vitest')`)).toBe(true);
    expect(SHIM.test(`spawnSync("node_modules\\\\.bin\\\\tsc")`)).toBe(true);
    expect(SHIM.test(`// Building .pio/build/firmware.bin`)).toBe(false);
  });
});

describe('resolveBin', () => {
  let root;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  const fakePackage = (name, bin) => {
    root ??= mkdtempSync(join(tmpdir(), 'run-bin-'));
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, bin }));
    return dir;
  };

  it('reads a string bin entry, defaulting the command to the unscoped name', () => {
    const dir = fakePackage('@scope/tool', 'cli.js');
    expect(resolveBin('@scope/tool', undefined, root)).toBe(join(dir, 'cli.js'));
  });

  it('picks the named command out of a bin map', () => {
    const dir = fakePackage('multi', { one: 'bin/one.js', two: 'bin/two.js' });
    expect(resolveBin('multi', 'two', root)).toBe(join(dir, 'bin/two.js'));
  });

  it('throws when the package has no such command', () => {
    fakePackage('multi', { one: 'bin/one.js' });
    expect(() => resolveBin('multi', 'three', root)).toThrow(/no "three" bin entry/);
  });

  it('resolves the real biome entry and runs it without a shell', () => {
    expect(existsSync(resolveBin('@biomejs/biome', 'biome'))).toBe(true);
    const result = runBin('@biomejs/biome', 'biome', ['--version'], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });
});
