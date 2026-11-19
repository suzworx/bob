/**
 * listConversations' 42703 fallback (CU-CHAT-1, G21), against a FAKE Db --
 * no Docker, no local stack. Exercises the exact failure the hosted store hits
 * before the pin/archive migration is pushed: pinned_at/archived_at referenced
 * in the SELECT throw undefined_column, and the store must fall back to the
 * pre-migration query rather than 500ing the whole conversation list.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { listConversations } from '../../src/conversations/store.ts';
import type { Db } from '../../src/platform/db/db.ts';

const FIXED_ROWS = [{ id: 'cnv_1', title: 'Trip notes', createdAt: 1000, updatedAt: 2000 }];

/** A fake Db: throws 42703 for any SQL mentioning pinned_at, answers fixed
 *  conversation rows for any other bob.conversations SELECT, and [] for
 *  anything else (the withUser setup queries: set_config, set local role). */
function makeFakeDb(): Db {
  const db: Db = {
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes('pinned_at')) {
        throw Object.assign(new Error('column "pinned_at" does not exist'), { code: '42703' });
      }
      if (sql.includes('FROM bob.conversations')) {
        return FIXED_ROWS as unknown as T[];
      }
      return [] as T[];
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  return db;
}

/** A fake Db whose pinned_at query throws a non-42703 error, so the fallback
 *  must not swallow it. */
function makeErroringDb(code: string): Db {
  const db: Db = {
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes('pinned_at')) {
        throw Object.assign(new Error('connection exception'), { code });
      }
      return [] as T[];
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  return db;
}

describe('listConversations 42703 fallback (no Docker)', () => {
  it('the default list falls back to the pre-migration rows with pinned/archived false', async () => {
    const userId = randomUUID();
    const list = await listConversations(makeFakeDb(), userId);
    expect(list).toEqual([{ id: 'cnv_1', title: 'Trip notes', createdAt: 1000, updatedAt: 2000, pinned: false, archived: false }]);
  });

  it('archived:true falls back to [] -- no pre-migration answer exists for it', async () => {
    const userId = randomUUID();
    const list = await listConversations(makeFakeDb(), userId, { archived: true });
    expect(list).toEqual([]);
  });

  it('a non-42703 error rethrows instead of falling back', async () => {
    const userId = randomUUID();
    await expect(listConversations(makeErroringDb('08006'), userId)).rejects.toMatchObject({ code: '08006' });
  });
});
