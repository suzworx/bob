// db-harness.test.ts — the data/offline.env password read/create is race-free
// (#482) and teardown tolerates a setup that never created its pool. Temp dirs
// only; no database, no Docker.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeIfOpen, serverPasswordAt, teardownMemoryTestDb } from './db-harness.ts';
import { serverPassword as pgTemplateServerPassword } from './support/pg-template.ts';

const LINE = /^BOB_SERVER_PASSWORD=(\S+)\n$/;

describe('serverPasswordAt (data/offline.env)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bob-db-harness-'));
    file = join(dir, 'data', 'offline.env');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file once when many workers start together, and all get its password', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => serverPasswordAt(file, { attempts: 20, delayMs: 5 })),
    );
    const onDisk = readFileSync(file, 'utf8').match(LINE)?.[1];
    expect(onDisk).toBeTruthy();
    expect(new Set(results)).toEqual(new Set([onDisk]));
    expect(readdirSync(join(dir, 'data'))).toEqual(['offline.env']);
  });

  it('readers wait out a writer that truncated the file and has not written yet', async () => {
    const seed = serverPasswordAt(join(dir, 'seed.env'));
    const expected = await seed;
    await serverPasswordAt(file);
    writeFileSync(file, '');
    const readers = Array.from({ length: 10 }, () => serverPasswordAt(file, { attempts: 100, delayMs: 5 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    writeFileSync(file, `BOB_SERVER_PASSWORD=${expected}\n`);
    for (const password of await Promise.all(readers)) expect(password).toBe(expected);
  });

  it('never returns a password cut off mid-write', async () => {
    const full = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
    await serverPasswordAt(file);
    writeFileSync(file, `BOB_SERVER_PASSWORD=${full.slice(0, 10)}`);
    const readers = Array.from({ length: 10 }, () => serverPasswordAt(file, { attempts: 100, delayMs: 5 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    writeFileSync(file, `BOB_SERVER_PASSWORD=${full}\n`);
    for (const password of await Promise.all(readers)) expect(password).toBe(full);
  });

  it('keeps an existing password (CRLF too) and does not rewrite the file', async () => {
    await serverPasswordAt(file);
    writeFileSync(file, 'OTHER=1\r\nBOB_SERVER_PASSWORD=kept-value\r\n');
    await expect(serverPasswordAt(file)).resolves.toBe('kept-value');
    expect(readFileSync(file, 'utf8')).toBe('OTHER=1\r\nBOB_SERVER_PASSWORD=kept-value\r\n');
  });

  it('pg-template and db-harness workers racing on a fresh file all get one password', async () => {
    const callers = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? pgTemplateServerPassword(file) : serverPasswordAt(file, { attempts: 20, delayMs: 5 }),
    );
    const results = await Promise.all(callers);
    const onDisk = readFileSync(file, 'utf8').match(LINE)?.[1];
    expect(onDisk).toBeTruthy();
    expect(new Set(results)).toEqual(new Set([onDisk]));
    expect(readdirSync(join(dir, 'data'))).toEqual(['offline.env']);
  });

  it('pg-template readers wait out an empty file instead of failing (#482)', async () => {
    await serverPasswordAt(file);
    writeFileSync(file, '');
    const readers = Array.from({ length: 10 }, () => pgTemplateServerPassword(file));
    await new Promise((resolve) => setTimeout(resolve, 40));
    writeFileSync(file, 'BOB_SERVER_PASSWORD=late-writer\n');
    for (const password of await Promise.all(readers)) expect(password).toBe('late-writer');
  });

  it('fails with a message naming the file and how to create it when the line never appears', async () => {
    await serverPasswordAt(file);
    writeFileSync(file, 'OTHER=1\n');
    const error = await serverPasswordAt(file, { attempts: 3, delayMs: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(file);
    expect(message).toContain('no complete BOB_SERVER_PASSWORD line');
    expect(message).toContain('npm run dev:offline');
  });
});

describe('teardown', () => {
  it('is a no-op when setup never created the test db or its pool', async () => {
    await expect(teardownMemoryTestDb(undefined)).resolves.toBeUndefined();
    await expect(closeIfOpen(undefined)).resolves.toBeUndefined();
  });

  it('runs cleanup and close when they exist', async () => {
    const cleanup = vi.fn(async (): Promise<void> => {});
    const close = vi.fn(async (): Promise<void> => {});
    await teardownMemoryTestDb({ cleanup });
    await closeIfOpen({ close });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
