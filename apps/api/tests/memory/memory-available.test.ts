// Runtime memory guard (010, plan A.3): memoryAvailable() is true only when
// the `vector` extension and `bob.memories` both exist, is cached per Db
// instance, never throws, and degrades to false on a query error. The first
// case uses a real Postgres database migrated only up to the first memory
// migration, which has neither, so it is false; the rest exercise the cache
// and the error path with a fake Db.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import { memoryAvailable, resetMemoryAvailability } from '../../src/memory/available.ts';
import { createMigratedDb } from '../support/pg-template.ts';
import { asDb, closeTestDb, type TestDb } from '../support/test-db.ts';

/** A fresh database migrated only up to the first memory migration (the one
 *  that creates `vector` and `bob.memories`) -- a partially migrated
 *  database, so memory is absent. Skipping just the vector-marked files does
 *  not work: reminders_init (unmarked) depends on notes_init (marked). */
async function freshDb(): Promise<{ pg: TestDb; db: Db }> {
  const pg = await createMigratedDb({ before: '20260915200000_memory_init.sql' });
  return { pg, db: asDb(pg) };
}

/** A fake Db that records query calls and returns a caller-supplied result. */
function fakeDb(result: () => unknown[] | Promise<unknown[]>): Db & { queryCalls: () => number } {
  let calls = 0;
  const db: Db = {
    async query<T>(_sql: string): Promise<T[]> {
      calls += 1;
      return (await result()) as T[];
    },
    async tx<T>(fn: (txDb: Db) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  return Object.assign(db, { queryCalls: () => calls });
}

/** The positive availability shape: both probes true. */
const POSITIVE = [{ has_vector: true, has_memories: true }];
/** The negative availability shape: both probes false. */
const NEGATIVE = [{ has_vector: false, has_memories: false }];

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  const built = await freshDb();
  pg = built.pg;
  db = built.db;
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

describe('memoryAvailable', () => {
  it('a real db without the vector-marked migrations returns false: no vector, no memories', async () => {
    await expect(memoryAvailable(db)).resolves.toBe(false);
  });

  it('a fake Db returning the positive shape returns true', async () => {
    const fake = fakeDb(() => POSITIVE);
    await expect(memoryAvailable(fake)).resolves.toBe(true);
  });

  it('queries once across 5 calls, and again after a reset', async () => {
    const fake = fakeDb(() => POSITIVE);
    for (let i = 0; i < 5; i += 1) {
      await expect(memoryAvailable(fake)).resolves.toBe(true);
    }
    expect(fake.queryCalls()).toBe(1);

    resetMemoryAvailability(fake);
    await expect(memoryAvailable(fake)).resolves.toBe(true);
    expect(fake.queryCalls()).toBe(2);
  });

  it('a throwing fake returns false and does not throw', async () => {
    const fake = fakeDb(() => {
      throw new Error('boom');
    });
    await expect(memoryAvailable(fake)).resolves.toBe(false);
  });
});