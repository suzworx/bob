/**
 * memory:reconcile on the local stack (follow-up to #758): memories stored
 * twice before the judge existed are merged, dry run first. The judge is a
 * fake that answers from a table; distances come from real pgvector.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryJudge } from '@bob/ai';
import { withUser } from '../../src/platform/db/db.ts';
import { applyExtractionOps } from '../../src/memory/store.ts';
import { applyReconcile, planReconcile } from '../../src/memory/reconcile.ts';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

/** A one-hot 1536-dim vector: the same axis is distance 0, another axis 1. */
function axis(n: number): number[] {
  const values = new Array<number>(1536).fill(0);
  values[n] = 1;
  return values;
}

/** A judge answering from content pairs ("newer|older" -> relation). */
function tableJudge(answers: Record<string, 'same' | 'updates'>, calls: string[] = []): MemoryJudge {
  return async ({ content, candidates }) => {
    const older = candidates[0];
    calls.push(content);
    const relation = older ? answers[`${content}|${older.content}`] : undefined;
    return relation && older ? { relation, id: older.id } : { relation: 'different', id: null };
  };
}

describe('memory:reconcile (test:db)', () => {
  let env: MemoryTestDb;
  let userId: string;

  beforeAll(async () => {
    env = await setupMemoryTestDb();
    userId = env.a.userId;
  });

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await withUser(env.db, userId, (tx) => tx.query(`DELETE FROM bob.memories WHERE user_id = $1`, [userId]));
  });

  /** Adds memories in order (so created_at follows the list), each on an axis. */
  async function seed(rows: Array<[string, number]>): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    for (const [content, onAxis] of rows) {
      const [result] = await applyExtractionOps(env.db, userId, [
        { op: 'add', kind: 'fact', content, confidence: 0.9, embedding: { values: axis(onAxis), model: 'text-embedding-3-small', dim: 1536 } },
      ], { source: { conversationId: null, messageId: null, surface: 'web_text' } });
      if (!result?.memoryId) throw new Error(`seed failed: ${content}`);
      ids[content] = result.memoryId;
    }
    return ids;
  }

  async function current(): Promise<string[]> {
    const rows = await withUser(env.db, userId, (tx) =>
      tx.query<{ content: string }>(`SELECT content FROM bob.memories WHERE superseded_by IS NULL ORDER BY content`),
    );
    return rows.map((row) => row.content);
  }

  it('the prod pair: "same" keeps the older row, and the dry run changes nothing', async () => {
    const ids = await seed([['User has a wife named Maya.', 0], ["User's wife's name is Maya", 0], ['User works as a nurse.', 1]]);
    const plan = await planReconcile(env.db, userId, tableJudge({ "User's wife's name is Maya|User has a wife named Maya.": 'same' }));
    expect(plan.decisions).toMatchObject([
      { verdict: 'same', keep: ids['User has a wife named Maya.'], retire: ids["User's wife's name is Maya"] },
    ]);
    expect(await current()).toHaveLength(3);

    const events: string[] = [];
    expect(await applyReconcile(env.db, userId, plan.decisions, (event) => events.push(event))).toBe(1);
    expect(await current()).toEqual(['User has a wife named Maya.', 'User works as a nurse.']);
    expect(events).toEqual(['v2.memory_reconciled']);
  });

  it('"updates" keeps the newer row, the change', async () => {
    const ids = await seed([["User's wife's name is Maya", 0], ["User's wife's name is Maia", 0]]);
    const plan = await planReconcile(env.db, userId, tableJudge({ "User's wife's name is Maia|User's wife's name is Maya": 'updates' }));
    expect(plan.decisions).toMatchObject([{ verdict: 'updates', keep: ids["User's wife's name is Maia"] }]);
    await applyReconcile(env.db, userId, plan.decisions);
    expect(await current()).toEqual(["User's wife's name is Maia"]);
  });

  it('far rows are never judged, and "different" changes nothing', async () => {
    await seed([['User likes tea.', 0], ['User drives a Tesla.', 1], ['User lives in Berlin.', 2], ["User's brother lives in Berlin.", 2]]);
    const calls: string[] = [];
    const plan = await planReconcile(env.db, userId, tableJudge({}, calls));
    expect(calls).toEqual(["User's brother lives in Berlin."]);
    expect(plan).toMatchObject({ decisions: [], judged: 1 });
  });

  it('three copies collapse to one, and a retired row is not paired again', async () => {
    await seed([['User is vegan.', 0], ['User follows a vegan diet.', 0], ['User eats no animal products.', 0]]);
    const same = {
      'User follows a vegan diet.|User is vegan.': 'same',
      'User eats no animal products.|User is vegan.': 'same',
      'User eats no animal products.|User follows a vegan diet.': 'same',
    } as const;
    const plan = await planReconcile(env.db, userId, tableJudge(same));
    expect(plan.decisions).toHaveLength(2);
    await applyReconcile(env.db, userId, plan.decisions);
    expect(await current()).toEqual(['User is vegan.']);
  });

  it('a decision whose rows changed since the plan is skipped', async () => {
    const ids = await seed([['User has a wife named Maya.', 0], ["User's wife's name is Maya", 0]]);
    const plan = await planReconcile(env.db, userId, tableJudge({ "User's wife's name is Maya|User has a wife named Maya.": 'same' }));
    await withUser(env.db, userId, (tx) => tx.query(`DELETE FROM bob.memories WHERE id = $1`, [ids['User has a wife named Maya.']]));
    expect(await applyReconcile(env.db, userId, plan.decisions)).toBe(0);
    expect(await current()).toEqual(["User's wife's name is Maya"]);
  });
});
