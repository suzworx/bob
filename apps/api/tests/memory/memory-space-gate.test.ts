/**
 * #756 PR4 (memory half): personal memory is extracted only from private-space
 * conversations, and new memories carry space_id when the column exists.
 * Default suite: injected fakes, no model, no network.
 */
import { describe, expect, it, vi } from 'vitest';
import { allowsPersonalMemory } from '../../src/memory/extract.ts';
import { memorySpaceColumn, resetMemorySpaceColumn } from '../../src/memory/space-column.ts';
import { createMemoryExtractionWorker } from '../../src/memory/extract.ts';
import { applyExtractionOps } from '../../src/memory/store.ts';
import type { Db } from '../../src/platform/db/db.ts';

const TURN = { messageId: 'msg_1', conversationId: 'conv_1', surface: 'web_text' as const, userText: 'I like tea', assistantText: 'Noted.' };

function worker(kind: string | null, spaceId: string | null) {
  const extractor = vi.fn(async () => ({ ops: [], dropped: { secret: 0, sensitive: 0 } }));
  const applyExtractionOps = vi.fn(async () => undefined);
  const journal = vi.fn();
  const w = createMemoryExtractionWorker({
    db: {} as Db,
    extractor: extractor as never,
    embedder: { modelId: 'e', dim: 2, embed: async () => [0, 1], embedMany: async (t: string[]) => t.map(() => [0, 1]) } as never,
    listUnextracted: async () => [TURN],
    listAccounts: async () => [],
    matchMemories: async () => [],
    applyExtractionOps,
    memoryAvailable: async () => true,
    journal,
    clock: () => 0,
    isGameTurn: async () => false,
    turnSpace: async () => ({ id: spaceId, kind }),
    debounceMs: 0,
  });
  return { w, extractor, applyExtractionOps, journal };
}

describe('allowsPersonalMemory', () => {
  it.each([
    ['private', true],
    [null, true],
    [undefined, true],
    ['pair', false],
    ['group', false],
    ['unknown', false],
  ])('%s -> %s', (kind, expected) => {
    expect(allowsPersonalMemory(kind)).toBe(expected);
  });
});

describe('extraction space gate', () => {
  it('skips a shared-space turn: marks it, no extractor call, reason shared_space', async () => {
    const { w, extractor, applyExtractionOps, journal } = worker('group', 'space_g');
    w.enqueue('11111111-1111-4111-8111-111111111111');
    await w.idle();
    expect(extractor).not.toHaveBeenCalled();
    expect(applyExtractionOps).toHaveBeenCalledWith(expect.anything(), expect.any(String), [], expect.objectContaining({ markMessageId: 'msg_1' }));
    expect(journal).toHaveBeenCalledWith('v2.memory_skipped', { reason: 'shared_space' });
    expect(JSON.stringify(journal.mock.calls)).not.toContain('tea');
  });

  it('extracts a private turn and stamps its space on the source', async () => {
    const { w, extractor, applyExtractionOps } = worker('private', 'space_p');
    w.enqueue('11111111-1111-4111-8111-111111111111');
    await w.idle();
    expect(extractor).toHaveBeenCalledTimes(1);
    const options = (applyExtractionOps.mock.calls[0] as unknown[])[3] as { source: { spaceId?: string }; path?: string };
    expect(options.source.spaceId).toBe('space_p');
    expect(options.path).toBe('extract');
  });
});

/** A fake Db that answers the space-column probe and records every SQL text. */
function fakeDb(hasColumn: boolean | 'throw') {
  const sql: string[] = [];
  const db: Db = {
    async query(text: string) {
      sql.push(text);
      if (text.includes('has_space_id')) {
        if (hasColumn === 'throw') throw new Error('boom');
        return [{ has_space_id: hasColumn }];
      }
      if (text.includes('INSERT INTO bob.memories')) return [{ id: 'mem_1' }];
      return [];
    },
    async tx(fn: (tx: Db) => Promise<unknown>) {
      return fn(db);
    },
  } as unknown as Db;
  return { db, sql };
}

describe('memories.space_id hosted-lag probe', () => {
  it.each([[true, true], [false, false], ['throw', false]] as const)('column %s -> %s', async (has, expected) => {
    resetMemorySpaceColumn();
    expect(await memorySpaceColumn(fakeDb(has).db)).toBe(expected);
  });

  it.each([[true, true], [false, false]])('insert writes space_id only when the column exists (%s)', async (has, writes) => {
    resetMemorySpaceColumn();
    const { db, sql } = fakeDb(has);
    const [decision] = await applyExtractionOps(db, '11111111-1111-4111-8111-111111111111', [{ op: 'add', kind: 'fact', content: 'likes tea', confidence: 0.9 }], {
      source: { conversationId: 'conv_1', messageId: 'msg_1', surface: 'web_text', spaceId: 'space_p' },
      journal: () => undefined,
    });
    const insert = sql.find((text) => text.includes('INSERT INTO bob.memories'))!;
    expect(insert.includes('space_id')).toBe(writes);
    // #758's duplicate check and unique-index backstop still run around it.
    expect(sql.some((text) => text.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(insert).toContain('ON CONFLICT (user_id, content_key)');
    expect(decision).toEqual({ op: 'add', memoryId: 'mem_1', targetId: null, dupOf: null, guard: 'none' });
  });
});
