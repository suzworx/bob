import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LOG_GENERATIONS, DEFAULT_MAX_LOG_BYTES, generationPath, openLogFile } from './log-file.mjs';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bob-log-file-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('generationPath', () => {
  // logs:clean matches on the extension, so it has to stay last or the sweep
  // would take the live file and leave every rotation behind.
  it('keeps the .log suffix last', () => {
    expect(generationPath('/tmp/data/device.log', 2)).toBe('/tmp/data/device.2.log');
  });

  it('appends the index when the file has no extension', () => {
    expect(generationPath('/tmp/data/device', 1)).toBe('/tmp/data/device.1');
  });

  // A dot in a directory name is not the file's extension.
  it('ignores a dot that belongs to a parent directory', () => {
    expect(generationPath('/tmp/v1.2/device', 1)).toBe('/tmp/v1.2/device.1');
  });
});

describe('openLogFile', () => {
  it('creates the directory and appends text verbatim', () => {
    const file = join(dir, 'nested', 'device.log');
    const append = openLogFile(file);
    append('first\n');
    append('second\n');
    expect(readFileSync(file, 'utf8')).toBe('first\nsecond\n');
  });

  // A monitor left running overnight is hours of serial output; uncapped it
  // fills the disk.
  it('rotates once a write would pass the cap', () => {
    const file = join(dir, 'device.log');
    const append = openLogFile(file, { maxBytes: 12, generations: 2 });
    append('first\n');
    append('second\n');
    expect(readFileSync(file, 'utf8')).toBe('second\n');
    expect(readFileSync(join(dir, 'device.1.log'), 'utf8')).toBe('first\n');
  });

  it('keeps only the requested number of generations', () => {
    const file = join(dir, 'device.log');
    const append = openLogFile(file, { maxBytes: 4, generations: 2 });
    for (const line of ['one\n', 'two\n', 'thr\n', 'fou\n']) append(line);
    expect(readFileSync(file, 'utf8')).toBe('fou\n');
    expect(readFileSync(join(dir, 'device.1.log'), 'utf8')).toBe('thr\n');
    expect(readFileSync(join(dir, 'device.2.log'), 'utf8')).toBe('two\n');
    expect(existsSync(join(dir, 'device.2.log'))).toBe(true);
    expect(existsSync(join(dir, 'device.3.log'))).toBe(false);
  });

  it('accepts a Buffer chunk as written by the tee', () => {
    const file = join(dir, 'device.log');
    openLogFile(file)(Buffer.from('bytes\n'));
    expect(readFileSync(file, 'utf8')).toBe('bytes\n');
  });

  it('defaults to a bounded cap and a small number of generations', () => {
    expect(DEFAULT_MAX_LOG_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_LOG_GENERATIONS).toBeGreaterThan(0);
  });
});
