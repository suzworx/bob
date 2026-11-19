// test:db suite (010, T007): store/action-items.ts against the LOCAL Supabase
// stack (db-harness brings it up and creates two throwaway accounts), the same
// pattern as isolation-memory.db.test.ts. Memories are seeded via raw SQL
// under withUser (store/memories.ts is T006, owned elsewhere). Every test
// resets the account it seeds so the suite is order- and re-run- independent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TARGET_FLOOR } from '../../src/memory/callbacks.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import {
  completeBestMatch,
  createActionItem,
  listActionItems,
  listDueSoon,
  setActionItemStatus,
  type ActionItemStatus,
} from '../../src/tasks/action-items-store.ts';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

function ms(date: string): number {
  return Date.parse(date);
}

async function insertMemory(db: Db, userId: string, id: string, content: string): Promise<void> {
  await db.query(
    `INSERT INTO bob.memories (id, user_id, kind, content, confidence)
     VALUES ($1, $2, 'action_item', $3, 0.9)`,
    [id, userId, content],
  );
}

/** Clears every memory the account owns (action items cascade), so each test
 *  starts clean even when the local stack persisted rows from an earlier run. */
async function resetAccount(db: Db, userId: string): Promise<void> {
  await db.query(`DELETE FROM bob.memories WHERE user_id = $1`, [userId]);
}

async function insertItem(
  db: Db,
  userId: string,
  id: string,
  memoryId: string,
  options: { dueAt?: number | null; status?: ActionItemStatus; createdAt?: number } = {},
): Promise<void> {
  const dueAt = options.dueAt === undefined ? null : options.dueAt;
  const status = options.status ?? 'open';
  const createdAt = options.createdAt ?? ms('2026-09-15T00:00:00Z');
  await db.query(
    `INSERT INTO bob.action_items (id, memory_id, user_id, due_at, status, created_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))`,
    [id, memoryId, userId, dueAt, status, createdAt],
  );
}

async function seedOrdering(db: Db, userId: string): Promise<void> {
  await resetAccount(db, userId);
  await insertMemory(db, userId, 'mem_ord_a', 'call daniel about the lawn');
  await insertMemory(db, userId, 'mem_ord_b', 'email dana by friday');
  await insertMemory(db, userId, 'mem_ord_c', 'buy milk');
  await insertMemory(db, userId, 'mem_ord_d', 'book the dentist');
  await insertMemory(db, userId, 'mem_ord_e', 'water the plants');
  await insertItem(db, userId, 'act_ord_done1', 'mem_ord_a', { status: 'done', createdAt: ms('2026-09-15T00:00:00Z') });
  await insertItem(db, userId, 'act_ord_open_null', 'mem_ord_b', { dueAt: null, createdAt: ms('2026-09-15T03:00:00Z') });
  await insertItem(db, userId, 'act_ord_open_late', 'mem_ord_c', { dueAt: ms('2026-09-20T00:00:00Z'), createdAt: ms('2026-09-15T01:00:00Z') });
  await insertItem(db, userId, 'act_ord_open_early', 'mem_ord_d', { dueAt: ms('2026-09-17T00:00:00Z'), createdAt: ms('2026-09-15T04:00:00Z') });
  await insertItem(db, userId, 'act_ord_done2', 'mem_ord_e', { status: 'done', createdAt: ms('2026-09-15T02:00:00Z') });
}

describe('action-items store on the local stack (T007)', () => {
  let env: MemoryTestDb;

  beforeAll(async () => {
    env = await setupMemoryTestDb();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('lists in the contract order: open first, due_at asc (nulls last), created_at desc', async () => {
    await withUser(env.db, env.a.userId, (db) => seedOrdering(db, env.a.userId));
    const items = await listActionItems(env.db, env.a.userId);
    // done items fall behind every open item; open items order due_at asc
    // (nulls last), then created_at desc.
    expect(items.filter((item) => item.id.startsWith('act_ord_')).map((item) => item.id)).toEqual([
      'act_ord_open_early', // due 09-17, earliest
      'act_ord_open_late', // due 09-20
      'act_ord_open_null', // no due date, nulls last
      'act_ord_done2', // created 09-15T02, later of the two done
      'act_ord_done1', // created 09-15T00
    ]);
    expect(items[0]).toMatchObject({ memory_id: 'mem_ord_d', content: 'book the dentist', confidence: 0.9, status: 'open', due_at: ms('2026-09-17T00:00:00Z') });
    expect(items[2]?.due_at).toBeNull();
  });

  it('filters by status and due_before, limits, and maps timestamps to epoch ms', async () => {
    await withUser(env.db, env.a.userId, (db) => seedOrdering(db, env.a.userId));
    const open = await listActionItems(env.db, env.a.userId, { status: 'open' });
    expect(open.filter((item) => item.id.startsWith('act_ord_')).map((item) => item.id)).toEqual([
      'act_ord_open_early',
      'act_ord_open_late',
      'act_ord_open_null',
    ]);
    const due = await listActionItems(env.db, env.a.userId, {
      dueBefore: ms('2026-09-18T00:00:00Z'),
    });
    expect(due.filter((item) => item.id.startsWith('act_ord_')).map((item) => item.id)).toEqual(['act_ord_open_early']);
    const limited = await listActionItems(env.db, env.a.userId, { limit: 2 });
    expect(limited.map((item) => item.id)).toEqual(['act_ord_open_early', 'act_ord_open_late']);
    expect(typeof open[0]?.created_at).toBe('number');
    expect(typeof open[0]?.updated_at).toBe('number');
  });

  it('status transitions: done and dropped leave the open list, and a reopen works', async () => {
    const created = await withUser(env.db, env.a.userId, async (db) => {
      await resetAccount(db, env.a.userId);
      await insertMemory(db, env.a.userId, 'mem_tr_a', 'return the library books');
      // db is the transaction-bound view; a nested withUser reuses the same
      // transaction, so the just-inserted memory is visible to the FK.
      return createActionItem(db, env.a.userId, { memoryId: 'mem_tr_a' });
    });
    expect(created.memory_id).toBe('mem_tr_a');
    expect(created.status).toBe('open');
    expect(created.due_at).toBeNull();

    const done = (await setActionItemStatus(env.db, env.a.userId, created.id, 'done'))!;
    expect(done.status).toBe('done');
    expect(
      (await listActionItems(env.db, env.a.userId, { status: 'open' })).map((item) => item.id),
    ).not.toContain(created.id);
    expect((await listActionItems(env.db, env.a.userId)).map((item) => item.id)).toContain(created.id);

    const dropped = (await setActionItemStatus(env.db, env.a.userId, created.id, 'dropped'))!;
    expect(dropped.status).toBe('dropped');
    expect(
      (await listActionItems(env.db, env.a.userId, { status: 'open' })).map((item) => item.id),
    ).not.toContain(created.id);

    const reopened = (await setActionItemStatus(env.db, env.a.userId, created.id, 'open'))!;
    expect(reopened.status).toBe('open');
    expect(
      (await listActionItems(env.db, env.a.userId, { status: 'open' })).map((item) => item.id),
    ).toContain(created.id);
  });

  it('due-soon honours the horizon and the limit', async () => {
    const nowMs = ms('2026-09-15T12:00:00Z');
    await withUser(env.db, env.a.userId, async (db) => {
      await resetAccount(db, env.a.userId);
      await insertMemory(db, env.a.userId, 'mem_ds_a', 'call daniel about the lawn');
      await insertMemory(db, env.a.userId, 'mem_ds_b', 'email dana by friday');
      await insertMemory(db, env.a.userId, 'mem_ds_c', 'buy milk');
      await insertMemory(db, env.a.userId, 'mem_ds_d', 'book the dentist');
      await insertMemory(db, env.a.userId, 'mem_ds_e', 'water the plants');
      await insertMemory(db, env.a.userId, 'mem_ds_f', 'pay the gas bill');

      await insertItem(db, env.a.userId, 'act_ds_soon1', 'mem_ds_a', { dueAt: ms('2026-09-15T14:00:00Z') }); // in 2 h
      await insertItem(db, env.a.userId, 'act_ds_soon2', 'mem_ds_b', { dueAt: ms('2026-09-17T11:00:00Z') }); // in 47 h
      await insertItem(db, env.a.userId, 'act_ds_far', 'mem_ds_c', { dueAt: ms('2026-09-20T00:00:00Z') }); // beyond 48 h
      await insertItem(db, env.a.userId, 'act_ds_null', 'mem_ds_d', { dueAt: null });
      await insertItem(db, env.a.userId, 'act_ds_done', 'mem_ds_e', { dueAt: ms('2026-09-15T13:00:00Z'), status: 'done' }); // due but not open
      await insertItem(db, env.a.userId, 'act_ds_soon3', 'mem_ds_f', { dueAt: ms('2026-09-16T00:00:00Z') }); // in 12 h
    });

    const soon = await listDueSoon(env.db, env.a.userId, nowMs);
    expect(soon.map((item) => item.id)).toEqual(['act_ds_soon1', 'act_ds_soon3', 'act_ds_soon2']);
    expect(soon[0]).toMatchObject({ status: 'open', content: 'call daniel about the lawn' });

    const capped = await listDueSoon(env.db, env.a.userId, nowMs, 48 * 60 * 60 * 1000, 2);
    expect(capped.map((item) => item.id)).toEqual(['act_ds_soon1', 'act_ds_soon3']);
  });

  it('deleting the parent memory cascades the action item', async () => {
    await withUser(env.db, env.a.userId, async (db) => {
      await resetAccount(db, env.a.userId);
      await insertMemory(db, env.a.userId, 'mem_cas_a', 'clean the gutters');
      await insertItem(db, env.a.userId, 'act_cas_a', 'mem_cas_a');
      await db.query(`DELETE FROM bob.memories WHERE id = $1`, ['mem_cas_a']);
    });
    const items = await listActionItems(env.db, env.a.userId);
    expect(items.map((item) => item.id)).not.toContain('act_cas_a');
  });

  it("a foreign user's id returns null and changes nothing", async () => {
    await withUser(env.db, env.a.userId, async (db) => {
      await resetAccount(db, env.a.userId);
      await insertMemory(db, env.a.userId, 'mem_fgn_a', 'mow the lawn');
      await insertItem(db, env.a.userId, 'act_fgn_a', 'mem_fgn_a');
    });
    expect(await setActionItemStatus(env.db, env.b.userId, 'act_fgn_a', 'done')).toBeNull();
    expect(await listActionItems(env.db, env.b.userId)).toEqual([]);
    const a = (await listActionItems(env.db, env.a.userId, { status: 'open' })).find(
      (item) => item.id === 'act_fgn_a',
    );
    expect(a?.status).toBe('open');
  });

  it('completeBestMatch completes above the floor and returns candidates below it', async () => {
    await withUser(env.db, env.a.userId, async (db) => {
      await resetAccount(db, env.a.userId);
      await insertMemory(db, env.a.userId, 'mem_cbm_a', 'call daniel about the lawn');
      await insertMemory(db, env.a.userId, 'mem_cbm_b', 'email dana by friday');
      await insertItem(db, env.a.userId, 'act_cbm_a', 'mem_cbm_a');
      await insertItem(db, env.a.userId, 'act_cbm_b', 'mem_cbm_b');
    });

    const completed = await completeBestMatch(env.db, env.a.userId, 'call daniel about the lawn', 0.01);
    expect(completed).toEqual({ completed: true });
    // act_cbm_a left the open list; act_cbm_b is still open.
    expect(
      (await listActionItems(env.db, env.a.userId, { status: 'open' })).map((item) => item.id),
    ).not.toContain('act_cbm_a');
    expect(
      (await listActionItems(env.db, env.a.userId, { status: 'open' })).map((item) => item.id),
    ).toContain('act_cbm_b');

    const noMatch = await completeBestMatch(env.db, env.a.userId, 'zzz nothing matches zzz', 0.01);
    expect(noMatch).toEqual({ completed: false, candidates: [] });

    const below = await completeBestMatch(env.db, env.a.userId, 'email dana by friday', 0.999);
    expect(below.completed).toBe(false);
    if ('candidates' in below) {
      expect(below.candidates).toHaveLength(1);
      expect(below.candidates[0]).toMatchObject({ id: 'act_cbm_b', content: 'email dana by friday' });
    } else {
      throw new Error('expected candidates');
    }
    // The below-floor call changed nothing.
    expect(
      (await listActionItems(env.db, env.a.userId, { status: 'open' })).map((item) => item.id),
    ).toContain('act_cbm_b');
  });

  it('completeBestMatch completes neither of two equal-rank open items (#401)', async () => {
    await withUser(env.db, env.a.userId, async (db) => {
      await resetAccount(db, env.a.userId);
      await insertMemory(db, env.a.userId, 'mem_tie_a', 'book the trip to Goa');
      await insertMemory(db, env.a.userId, 'mem_tie_b', 'share the trip photos');
      await insertItem(db, env.a.userId, 'act_tie_a', 'mem_tie_a');
      await insertItem(db, env.a.userId, 'act_tie_b', 'mem_tie_b');
    });

    const tie = await completeBestMatch(env.db, env.a.userId, 'trip', DEFAULT_TARGET_FLOOR);
    expect(tie.completed).toBe(false);
    if ('candidates' in tie) {
      expect(tie.candidates.map((c) => c.id).sort()).toEqual(['act_tie_a', 'act_tie_b']);
    } else {
      throw new Error('expected candidates');
    }
    expect(
      (await listActionItems(env.db, env.a.userId, { status: 'open' })).map((item) => item.id).sort(),
    ).toEqual(['act_tie_a', 'act_tie_b']);

    // An unambiguous query still completes only the intended item.
    expect(await completeBestMatch(env.db, env.a.userId, 'Goa trip', DEFAULT_TARGET_FLOOR)).toEqual({ completed: true });
    expect(
      (await listActionItems(env.db, env.a.userId, { status: 'open' })).map((item) => item.id),
    ).toEqual(['act_tie_b']);
  });
});