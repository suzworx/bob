// test:db suite (010, T014c): the real store-backed callback bag from
// apps/api/src/memory/callbacks.ts against seeded action items on the
// LOCAL Supabase stack (db-harness brings it up, applies migrations, creates
// two throwaway accounts). Each test resets the account it seeds so the suite
// is order- and re-run-independent. The disabled path (T-10) is covered in
// memory-tools.test.ts with fakes; here memory IS available, so callbacks hit
// the store under withUser and a foreign user sees nothing (FR-008).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { createMemoryCallbacks } from '../../src/memory/callbacks.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { createMemoryExtractionWorker } from '../../src/memory/extract.ts';
import { memoryAvailable } from '../../src/memory/available.ts';
import { listAccountsWithUnextracted, listUnextracted } from '../../src/memory/extract-queue.ts';
import { applyExtractionOps, matchMemories } from '../../src/memory/store.ts';
import { listActionItems } from '../../src/tasks/action-items-store.ts';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

function ms(date: string): number {
  return Date.parse(date);
}

/** One fixed 1536-dim vector: every text is equally near, as a real embedder
 *  puts these near-identical sentences. */
function unitVector(): number[] {
  return new Array<number>(1536).fill(1 / Math.sqrt(1536));
}

async function insertMemory(db: Db, userId: string, id: string, content: string): Promise<void> {
  await db.query(
    `INSERT INTO bob.memories (id, user_id, kind, content, confidence)
     VALUES ($1, $2, 'action_item', $3, 0.9)`,
    [id, userId, content],
  );
}

async function resetAccount(db: Db, userId: string): Promise<void> {
  await db.query(`DELETE FROM bob.memories WHERE user_id = $1`, [userId]);
}

async function seed(db: Db, userId: string): Promise<void> {
  await withUser(db, userId, async (tx) => {
    await resetAccount(tx, userId);
    await insertMemory(tx, userId, 'mem_seed_a', 'call daniel about the lawn');
    await insertMemory(tx, userId, 'mem_seed_b', 'email dana by friday');
    await insertMemory(tx, userId, 'mem_seed_c', 'buy milk');
    await tx.query(
      `INSERT INTO bob.action_items (id, memory_id, user_id, due_at, status, created_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), 'open', to_timestamp($5 / 1000.0))`,
      ['act_seed_a', 'mem_seed_a', userId, ms('2026-09-18T00:00:00Z'), ms('2026-09-15T00:00:00Z')],
    );
    await tx.query(
      `INSERT INTO bob.action_items (id, memory_id, user_id, due_at, status, created_at)
       VALUES ($1, $2, $3, NULL, 'open', to_timestamp($4 / 1000.0))`,
      ['act_seed_b', 'mem_seed_b', userId, ms('2026-09-15T02:00:00Z')],
    );
    await tx.query(
      `INSERT INTO bob.action_items (id, memory_id, user_id, due_at, status, created_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), 'done', to_timestamp($5 / 1000.0))`,
      ['act_seed_c', 'mem_seed_c', userId, ms('2026-09-17T00:00:00Z'), ms('2026-09-15T01:00:00Z')],
    );
  });
}

describe('memory callbacks on the local stack (T014c)', () => {
  let env: MemoryTestDb;

  beforeAll(async () => {
    env = await setupMemoryTestDb();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('listActions returns open items due-ascending (nulls last) with ISO due_at (T-08)', async () => {
    await seed(env.db, env.a.userId);
    const callbacks = createMemoryCallbacks(env.db, env.a.userId);
    const open = await callbacks.listActions({});
    expect(open).not.toHaveProperty('disabled');
    const views = open as Awaited<ReturnType<typeof callbacks.listActions>>;
    if ('disabled' in views) throw new Error('expected views');
    expect(views.map((v) => v.id)).toEqual(['act_seed_a', 'act_seed_b']);
    expect(views[0]?.due_at).toBe('2026-09-18T00:00:00.000Z');
    expect(views[1]?.due_at).toBeNull();
    expect(views[0]?.content).toBe('call daniel about the lawn');

    const all = await callbacks.listActions({ status: 'done' });
    const done = all as Extract<typeof all, unknown[]>;
    expect(done.map((v) => v.id)).toEqual(['act_seed_c']);
  });

  it('completeAction by id marks the item done and it leaves the open list (T-09)', async () => {
    await seed(env.db, env.a.userId);
    const callbacks = createMemoryCallbacks(env.db, env.a.userId);
    const result = await callbacks.completeAction({ id: 'act_seed_a' });
    expect(result).toEqual({ completed: true, action_item_id: 'act_seed_a' });

    const open = await listActionItems(env.db, env.a.userId, { status: 'open' });
    expect(open.map((item) => item.id)).not.toContain('act_seed_a');
    expect(open.map((item) => item.id)).toEqual(['act_seed_b']);
  });

  it('completeAction by query completes the best match above the floor (T-09)', async () => {
    await seed(env.db, env.a.userId);
    const callbacks = createMemoryCallbacks(env.db, env.a.userId, { matchFloor: 0.01 });
    const result = await callbacks.completeAction({ query: 'call daniel about the lawn' });
    expect(result).toEqual({ completed: true, action_item_id: null });
    const open = await listActionItems(env.db, env.a.userId, { status: 'open' });
    expect(open.map((item) => item.id)).not.toContain('act_seed_a');
  });

  it('a below-threshold query changes nothing and returns candidates (T-15)', async () => {
    await seed(env.db, env.a.userId);
    const callbacks = createMemoryCallbacks(env.db, env.a.userId, { matchFloor: 0.999 });
    const result = await callbacks.completeAction({ query: 'email dana by friday' });
    expect('disabled' in result).toBe(false);
    expect(result).not.toEqual({ disabled: true });
    if ('candidates' in result) {
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({ id: 'act_seed_b', content: 'email dana by friday' });
    } else {
      throw new Error('expected candidates');
    }

    const open = await listActionItems(env.db, env.a.userId, { status: 'open' });
    expect(open.map((item) => item.id)).toContain('act_seed_b');
  });

  it("a foreign user's callback bag sees nothing (FR-008)", async () => {
    await seed(env.db, env.a.userId);
    const foreign = createMemoryCallbacks(env.db, env.b.userId);
    const views = (await foreign.listActions({})) as Awaited<ReturnType<typeof foreign.listActions>>;
    if ('disabled' in views) throw new Error('expected views');
    expect(views).toEqual([]);

    const result = await foreign.completeAction({ id: 'act_seed_a' });
    expect(result).toEqual({ completed: false, candidates: [] });
    const stillOpen = await listActionItems(env.db, env.a.userId, { status: 'open' });
    expect(stillOpen.map((item) => item.id)).toContain('act_seed_a');
  });

  it('remember stores a real memory and forget by query deletes it (round-trip)', async () => {
    await withUser(env.db, env.a.userId, (tx) => resetAccount(tx, env.a.userId));
    const callbacks = createMemoryCallbacks(env.db, env.a.userId, {
      turn: { conversationId: null, messageId: null, surface: 'device' },
    });
    const content = 'prefers chai over coffee';
    const r = await callbacks.remember({ content });
    if ('disabled' in r) throw new Error('expected stored');
    expect(r.stored).toBe(true);
    expect(r.memory_id).not.toBeNull();

    const rows = await withUser(env.db, env.a.userId, (tx) =>
      tx.query(`SELECT content, surface FROM bob.memories WHERE id = $1`, [r.memory_id]),
    );
    expect(rows[0]).toMatchObject({ content, surface: 'device' });

    const f = await callbacks.forget({ query: content });
    if ('candidates' in f) throw new Error('expected a delete');
    expect(f).toMatchObject({ deleted: 1, memory_id: r.memory_id });
    const after = await withUser(env.db, env.a.userId, (tx) =>
      tx.query(`SELECT id FROM bob.memories WHERE id = $1`, [r.memory_id]),
    );
    expect(after).toHaveLength(0);
  });

  // The production duplicate rule, no ceiling override: a lowered ceiling hid
  // that an identical row's score never reaches the default one.
  it.each(['buy oat milk', "My wife's name is Maia"])('a duplicate remember is a noop and returns the existing id (%s)', async (content) => {
    await withUser(env.db, env.a.userId, (tx) => resetAccount(tx, env.a.userId));
    const callbacks = createMemoryCallbacks(env.db, env.a.userId);
    const first = await callbacks.remember({ content });
    if ('disabled' in first) throw new Error('expected stored');
    expect(first.stored).toBe(true);

    const second = await callbacks.remember({ content });
    if ('disabled' in second) throw new Error('expected stored');
    expect(second.stored).toBe(false);
    expect(second.memory_id).toBe(first.memory_id);

    // The account was reset above, so every current row is this fact (stored
    // in the canonical voice, not necessarily as typed).
    const rows = await withUser(env.db, env.a.userId, (tx) =>
      tx.query(`SELECT id FROM bob.memories WHERE superseded_by IS NULL`),
    );
    expect(rows).toHaveLength(1);
  });

  // The prod sequence of 2026-10-01: two remembers, the extractor's supersede of
  // the misspelling, then the same remember again. The name is stored once.
  it('remember and the extractor together keep one current copy of a fact', async () => {
    await withUser(env.db, env.a.userId, (tx) => resetAccount(tx, env.a.userId));
    const callbacks = createMemoryCallbacks(env.db, env.a.userId);
    const misspelt = await callbacks.remember({ content: "My wife's name is Maya" });
    if ('disabled' in misspelt) throw new Error('expected stored');
    await callbacks.remember({ content: "My wife's name is Maia" });

    const conversation = await createConversation(env.db, env.a.userId, 'dedupe source');
    await appendMessage(env.db, env.a.userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: "It's Maia, not Maya" }],
    });
    await appendMessage(env.db, env.a.userId, conversation.id, {
      role: 'assistant',
      parts: [{ type: 'text', text: 'Got it.' }],
    });
    const worker = createMemoryExtractionWorker({
      db: env.db,
      extractor: (async () => ({
        ops: [{ op: 'supersede', id: misspelt.memory_id, content: "My wife's name is Maia", confidence: 1 }],
        dropped: { secret: 0, sensitive: 0 },
      })) as never,
      embedder: { modelId: 'text-embedding-3-small', dim: 1536, embed: async () => unitVector(), embedMany: async (texts: string[]) => texts.map(unitVector) },
      listUnextracted,
      listAccounts: listAccountsWithUnextracted,
      matchMemories,
      applyExtractionOps,
      memoryAvailable,
      journal: () => undefined,
      clock: () => Date.now(),
      debounceMs: 0,
    });
    worker.enqueue(env.a.userId);
    await worker.idle();

    await callbacks.remember({ content: "My wife's name is Maia" });

    const rows = await withUser(env.db, env.a.userId, (tx) =>
      tx.query(`SELECT id FROM bob.memories WHERE content = $1 AND superseded_by IS NULL`, ["User's wife's name is Maia"]),
    );
    expect(rows).toHaveLength(1);
  });

  // One canonical voice: remember stored the model's first-person echo while
  // the extractor writes "User ...", so one fact in two voices never matched.
  it('remember stores the canonical voice, so first and third person are one row', async () => {
    await withUser(env.db, env.a.userId, (tx) => resetAccount(tx, env.a.userId));
    const callbacks = createMemoryCallbacks(env.db, env.a.userId);
    const first = await callbacks.remember({ content: "My wife's name is Maya" });
    if ('disabled' in first) throw new Error('expected stored');
    const second = await callbacks.remember({ content: "User's wife's name is Maya." });
    if ('disabled' in second) throw new Error('expected stored');
    expect(second).toMatchObject({ stored: false, memory_id: first.memory_id });

    const rows = await withUser(env.db, env.a.userId, (tx) =>
      tx.query<{ content: string }>(`SELECT content FROM bob.memories WHERE superseded_by IS NULL`),
    );
    expect(rows.map((row) => row.content)).toEqual(["User's wife's name is Maya"]);
  });

  // The prod case after the canonical voice: "User has a wife named Maya."
  // (extractor) and "User's wife's name is Maya" (remember) are one fact in
  // words the lexical check cannot match. The judge sees the nearest rows.
  describe('the memory judge on remember', () => {
    const embedding = { values: unitVector(), model: 'text-embedding-3-small', dim: 1536 };
    const embedder = async (): Promise<typeof embedding> => embedding;

    async function seedWife(): Promise<string> {
      await withUser(env.db, env.a.userId, (tx) => resetAccount(tx, env.a.userId));
      const [seeded] = await applyExtractionOps(env.db, env.a.userId, [
        { op: 'add', kind: 'fact', content: 'User has a wife named Maya.', confidence: 0.96, embedding },
      ], { source: { conversationId: null, messageId: null, surface: 'web_text' } });
      if (!seeded?.memoryId) throw new Error('seed failed');
      return seeded.memoryId;
    }

    async function currentContents(): Promise<string[]> {
      const rows = await withUser(env.db, env.a.userId, (tx) =>
        tx.query<{ content: string }>(`SELECT content FROM bob.memories WHERE superseded_by IS NULL ORDER BY content`),
      );
      return rows.map((row) => row.content);
    }

    it('"same": a paraphrase is a noop on the held row, journaled as judged', async () => {
      const held = await seedWife();
      const events: Array<[string, Record<string, unknown>]> = [];
      const callbacks = createMemoryCallbacks(env.db, env.a.userId, {
        embedder,
        journal: (event, fields) => events.push([event, fields]),
        judge: async ({ candidates }) => ({ relation: 'same', id: candidates[0]?.id ?? null }),
      });
      const result = await callbacks.remember({ content: "My wife's name is Maya" });
      expect(result).toMatchObject({ stored: false, memory_id: held });
      expect(await currentContents()).toEqual(['User has a wife named Maya.']);
      expect(events.find(([event]) => event === 'v2.memory_judged')?.[1]).toMatchObject({ verdict: 'same', memory_id: held, candidates: 1 });
      expect(events.find(([event]) => event === 'v2.memory_remembered')?.[1]).toMatchObject({ outcome: 'noop', reason: 'judge_same' });
    });

    it('"updates": a correction supersedes the held row', async () => {
      const held = await seedWife();
      const callbacks = createMemoryCallbacks(env.db, env.a.userId, {
        embedder,
        judge: async ({ candidates }) => ({ relation: 'updates', id: candidates[0]?.id ?? null }),
      });
      const result = await callbacks.remember({ content: "My wife's name is Maia" });
      if ('disabled' in result) throw new Error('expected stored');
      expect(result.stored).toBe(true);
      expect(result.memory_id).not.toBe(held);
      expect(await currentContents()).toEqual(["User's wife's name is Maia"]);
    });

    it('a failing judge adds the memory, as before the judge existed', async () => {
      await seedWife();
      const events: string[] = [];
      const callbacks = createMemoryCallbacks(env.db, env.a.userId, {
        embedder,
        journal: (event) => events.push(event),
        judge: async () => { throw new Error('provider down'); },
      });
      const result = await callbacks.remember({ content: "My wife's name is Maya" });
      expect(result).toMatchObject({ stored: true });
      expect(await currentContents()).toHaveLength(2);
      expect(events).toContain('v2.memory_judge_failed');
    });

    it('an action item is never judged', async () => {
      await seedWife();
      let calls = 0;
      const callbacks = createMemoryCallbacks(env.db, env.a.userId, {
        embedder,
        judge: async () => { calls += 1; return { relation: 'same', id: null }; },
      });
      await callbacks.remember({ content: 'email dana by friday', kind: 'action_item' });
      expect(calls).toBe(0);
    });
  });

  it('remember of an action item creates its action_items row (T-04)', async () => {
    await withUser(env.db, env.a.userId, (tx) => resetAccount(tx, env.a.userId));
    const callbacks = createMemoryCallbacks(env.db, env.a.userId);
    const r = await callbacks.remember({
      content: 'email dana by friday',
      kind: 'action_item',
      due: '2026-09-18T00:00:00Z',
    });
    if ('disabled' in r) throw new Error('expected stored');
    expect(r.stored).toBe(true);
    expect(r.memory_id).not.toBeNull();
    const items = await withUser(env.db, env.a.userId, (tx) =>
      tx.query(`SELECT memory_id FROM bob.action_items WHERE memory_id = $1`, [r.memory_id]),
    );
    expect(items).toHaveLength(1);
  });

  it("a foreign user's memory id forgets 0, never an oracle (T-07)", async () => {
    await seed(env.db, env.a.userId);
    const foreign = createMemoryCallbacks(env.db, env.b.userId);
    const r = await foreign.forget({ id: 'mem_seed_a' });
    expect(r).toEqual({ deleted: 0, memory_id: null });
    const still = await withUser(env.db, env.a.userId, (tx) =>
      tx.query(`SELECT id FROM bob.memories WHERE id = $1`, ['mem_seed_a']),
    );
    expect(still).toHaveLength(1);
  });

  it('equal-rank matches are never acted on: forget and completeAction return candidates (#401)', async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    await withUser(env.db, env.a.userId, async (tx) => {
      await resetAccount(tx, env.a.userId);
      await insertMemory(tx, env.a.userId, 'mem_tie_a', 'book the trip to Goa');
      await insertMemory(tx, env.a.userId, 'mem_tie_b', 'share the trip photos');
      await tx.query(
        `UPDATE bob.memories SET created_at = now() - interval '20 days' WHERE id = 'mem_tie_a'`,
      );
      for (const [id, memoryId] of [['act_tie_a', 'mem_tie_a'], ['act_tie_b', 'mem_tie_b']]) {
        await tx.query(
          `INSERT INTO bob.action_items (id, memory_id, user_id, due_at, status)
           VALUES ($1, $2, $3, NULL, 'open')`,
          [id, memoryId, env.a.userId],
        );
      }
    });
    const callbacks = createMemoryCallbacks(env.db, env.a.userId, {
      journal: (event, fields) => events.push({ event, fields }),
    });

    const done = await callbacks.completeAction({ query: 'trip' });
    expect(done).toMatchObject({ completed: false });
    if ('candidates' in done) {
      expect(done.candidates.map((c) => c.id).sort()).toEqual(['act_tie_a', 'act_tie_b']);
    }

    const forgot = await callbacks.forget({ query: 'trip' });
    expect(forgot).toMatchObject({ deleted: 0, memory_id: null });
    if ('candidates' in forgot) {
      expect(forgot.candidates!.map((c) => c.id).sort()).toEqual(['mem_tie_a', 'mem_tie_b']);
    }
    expect(events).toContainEqual({
      event: 'v2.memory_forget_candidates',
      fields: { count: 2, reason: 'ambiguous' },
    });

    const left = await withUser(env.db, env.a.userId, (tx) =>
      tx.query<{ id: string }>(
        `SELECT ai.id FROM bob.action_items ai WHERE ai.user_id = $1 AND ai.status = 'open'`,
        [env.a.userId],
      ),
    );
    expect(left.map((row) => row.id).sort()).toEqual(['act_tie_a', 'act_tie_b']);

    // A single-hit query acts on exactly the intended row.
    expect(await callbacks.forget({ query: 'Goa trip' })).toMatchObject({ deleted: 1, memory_id: 'mem_tie_a' });
  });
});