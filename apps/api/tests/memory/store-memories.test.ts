// Pure-helper unit tests for store/memories.ts (010, T006). These run in the
// default vitest suite with no DB: the cursor codec, the row→DTO mappings, the
// content guard, and op validation are all side-effect free. The SQL-backed
// behaviour lives in store-memories.db.test.ts under `npm run test:db`.
import { describe, expect, it } from 'vitest';
import { DEFAULT_MATCH_MARGIN, pickUnambiguous } from '../../src/platform/unambiguous-match.ts';
import { DEFAULT_TARGET_FLOOR } from '../../src/memory/callbacks.ts';
import {
  decodeCursor,
  encodeCursor,
  isMemoryContent,
  rowToMatch,
  rowToMemory,
  validateExtractionOps,
  vectorLiteral,
  type ExtractionOp,
  type MatchRow,
  type MemoryRow,
} from '../../src/memory/store.ts';

describe('pickUnambiguous (#401 targeting margin, 05 X5)', () => {
  const FLOOR = 0.1;
  const hit = (id: string, score: number): { id: string; score: number } => ({ id, score });

  it('defaults the margin to 1.5', () => {
    expect(DEFAULT_MATCH_MARGIN).toBe(1.5);
  });

  it('returns empty candidates for no hits', () => {
    expect(pickUnambiguous([], FLOOR, DEFAULT_MATCH_MARGIN)).toEqual({ candidates: [] });
  });

  it('a single hit at or below the floor is a candidate, strictly above it is the match', () => {
    expect(pickUnambiguous([hit('a', 0.05)], FLOOR, DEFAULT_MATCH_MARGIN)).toEqual({
      candidates: [hit('a', 0.05)],
    });
    expect(pickUnambiguous([hit('a', 0.1)], FLOOR, DEFAULT_MATCH_MARGIN)).toEqual({
      candidates: [hit('a', 0.1)],
    });
    expect(pickUnambiguous([hit('a', 0.11)], FLOOR, DEFAULT_MATCH_MARGIN)).toEqual({
      match: hit('a', 0.11),
    });
  });

  it('a tie returns both rows as candidates (T2: "trip")', () => {
    const matches = [hit('new', 0.1), hit('old', 0.1)];
    expect(pickUnambiguous(matches, FLOOR, DEFAULT_MATCH_MARGIN)).toEqual({ candidates: matches });
  });

  it('1.2x the runner-up is ambiguous', () => {
    const matches = [hit('a', 0.12), hit('b', 0.1)];
    expect(pickUnambiguous(matches, FLOOR, DEFAULT_MATCH_MARGIN)).toEqual({ candidates: matches });
  });

  it('1.5x and 2x the runner-up act on the best row', () => {
    expect(pickUnambiguous([hit('a', 0.15), hit('b', 0.1)], FLOOR, DEFAULT_MATCH_MARGIN)).toEqual({
      match: hit('a', 0.15),
    });
    expect(pickUnambiguous([hit('a', 0.2), hit('b', 0.1)], FLOOR, DEFAULT_MATCH_MARGIN)).toEqual({
      match: hit('a', 0.2),
    });
  });

  it('a clear winner below the floor is still only a candidate', () => {
    const matches = [hit('a', 0.08), hit('b', 0.01)];
    expect(pickUnambiguous(matches, FLOOR, DEFAULT_MATCH_MARGIN)).toEqual({ candidates: matches });
  });

  it('margin = 1 takes the top row on a tie', () => {
    expect(pickUnambiguous([hit('a', 0.2), hit('b', 0.2)], FLOOR, 1)).toEqual({ match: hit('a', 0.2) });
  });

  it('caps candidates at the top 3', () => {
    const matches = [hit('a', 0.2), hit('b', 0.2), hit('c', 0.2), hit('d', 0.2)];
    const picked = pickUnambiguous(matches, FLOOR, DEFAULT_MATCH_MARGIN);
    expect('candidates' in picked && picked.candidates.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('DEFAULT_TARGET_FLOOR (forget / complete_action query targeting, #401)', () => {
  const hit = (id: string, score: number): { id: string; score: number } => ({ id, score });
  const pick = (matches: Array<{ id: string; score: number }>): ReturnType<typeof pickUnambiguous> =>
    pickUnambiguous(matches, DEFAULT_TARGET_FLOOR, DEFAULT_MATCH_MARGIN);

  it('is 0, so any text-rank hit qualifies', () => {
    expect(DEFAULT_TARGET_FLOOR).toBe(0);
  });

  it('no hits is nothing to act on', () => {
    expect(pick([])).toEqual({ candidates: [] });
  });

  it('a score-0 hit is only a candidate, never acted on', () => {
    expect(pick([hit('a', 0)])).toEqual({ candidates: [hit('a', 0)] });
  });

  it('any positive single hit is acted on, however small', () => {
    expect(pick([hit('a', 0.01)])).toEqual({ match: hit('a', 0.01) });
    expect(pick([hit('a', 0.1)])).toEqual({ match: hit('a', 0.1) });
  });

  it('a tie is candidates at any score', () => {
    expect(pick([hit('a', 0.01), hit('b', 0.01)])).toEqual({ candidates: [hit('a', 0.01), hit('b', 0.01)] });
    expect(pick([hit('a', 0.5), hit('b', 0.5)])).toEqual({ candidates: [hit('a', 0.5), hit('b', 0.5)] });
  });
});

describe('keyset cursor codec', () => {
  it('round-trips a cursor and stays within the OpaqueId bound', () => {
    const createdUs = 1_700_000_000_123_456;
    const cursor = encodeCursor(createdUs, 'mem_ab_cdef');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(decodeCursor(cursor)).toEqual({ createdUs, id: 'mem_ab_cdef' });
  });

  it('returns null for malformed cursors', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('-mem')).toBeNull();
    expect(decodeCursor('abc-')).toBeNull();
    expect(decodeCursor('0-mem')).toBeNull(); // createdUs must be positive
    expect(decodeCursor('zzz-mem')).toBeNull(); // invalid hex
    expect(decodeCursor('not-a-cursor-format')).toBeNull();
  });
});

describe('rowToMemory', () => {
  it('maps every field with epoch-ms stamps and nulls intact', () => {
    const row: MemoryRow = {
      id: 'mem_one',
      kind: 'preference',
      content: 'Prefers chai over coffee.',
      confidence: 0.88,
      sensitive: true,
      conversationId: null,
      messageId: 'msg_one',
      surface: 'device',
      supersededBy: null,
      embeddingModel: 'text-embedding-3-small',
      embeddingDim: 1536,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_500,
      createdUs: 1_700_000_000_000_000,
    };
    expect(rowToMemory(row)).toEqual({
      id: 'mem_one',
      kind: 'preference',
      content: 'Prefers chai over coffee.',
      confidence: 0.88,
      sensitive: true,
      conversationId: null,
      messageId: 'msg_one',
      surface: 'device',
      supersededBy: null,
      embeddingModel: 'text-embedding-3-small',
      embeddingDim: 1536,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_500,
    });
  });

  it('falls back to fact/web_text for unknown enum values (never invented)', () => {
    const row: MemoryRow = {
      id: 'mem_two',
      kind: 'opinion',
      content: 'x',
      confidence: 0.5,
      sensitive: false,
      conversationId: 'cnv_one',
      messageId: null,
      surface: 'carrier-pigeon',
      supersededBy: 'mem_one',
      embeddingModel: null,
      embeddingDim: null,
      createdAt: 1,
      updatedAt: 1,
      createdUs: 1000,
    };
    const memory = rowToMemory(row);
    expect(memory.kind).toBe('fact');
    expect(memory.surface).toBe('web_text');
    expect(memory.supersededBy).toBe('mem_one');
    expect(memory.embeddingModel).toBeNull();
    expect(memory.embeddingDim).toBeNull();
  });
});

describe('rowToMatch', () => {
  it('maps a match row and falls back to full_text source', () => {
    const row: MatchRow = {
      id: 'mem_three',
      kind: 'fact',
      content: 'Allergic to peanuts.',
      confidence: 0.9,
      sensitive: false,
      conversationId: null,
      messageId: null,
      surface: 'web_text',
      createdAt: 1_700_000_000_000,
      matchSource: 'both',
      score: 0.045,
    };
    expect(rowToMatch(row)).toEqual({
      id: 'mem_three',
      kind: 'fact',
      content: 'Allergic to peanuts.',
      confidence: 0.9,
      sensitive: false,
      conversationId: null,
      messageId: null,
      surface: 'web_text',
      createdAt: 1_700_000_000_000,
      matchSource: 'both',
      score: 0.045,
    });
    expect(rowToMatch({ ...row, matchSource: 'unexpected' }).matchSource).toBe('full_text');
  });
});

describe('vectorLiteral and content guard', () => {
  it('serializes vectors at full precision and no rounding', () => {
    expect(vectorLiteral([0.1, -0.25])).toBe('[0.1,-0.25]');
  });

  it('bounds content to 1-2000 chars after trim', () => {
    expect(isMemoryContent('hello')).toBe(true);
    expect(isMemoryContent('  padded  ')).toBe(true);
    expect(isMemoryContent('')).toBe(false);
    expect(isMemoryContent('   ')).toBe(false);
    expect(isMemoryContent('a'.repeat(2000))).toBe(true);
    expect(isMemoryContent('a'.repeat(2001))).toBe(false);
  });
});

describe('validateExtractionOps', () => {
  it('accepts well-formed ops of every kind', () => {
    const ops: ExtractionOp[] = [
      { op: 'add', kind: 'fact', content: 'Works from home on Fridays.', confidence: 0.88 },
      {
        op: 'add',
        kind: 'action_item',
        content: 'Email Dana.',
        confidence: 0.95,
        dueAt: 1_700_000_000_000,
        embedding: { values: [0.5, -0.5], model: 'text-embedding-3-small', dim: 2 },
      },
      { op: 'update', id: 'mem_one', content: 'Prefers chai.', confidence: 0.8 },
      { op: 'supersede', id: 'mem_two', content: 'Loves steak.', confidence: 0.85 },
      { op: 'noop', id: 'mem_three' },
    ];
    expect(() => validateExtractionOps(ops)).not.toThrow();
    expect(() => validateExtractionOps([])).not.toThrow();
  });

  it('rejects a bad kind, empty content, and out-of-range confidence', () => {
    expect(() =>
      validateExtractionOps([
        { op: 'add', kind: 'opinion' as never, content: 'x', confidence: 0.5 },
      ]),
    ).toThrow(/add kind/);
    expect(() =>
      validateExtractionOps([{ op: 'add', kind: 'fact', content: '   ', confidence: 0.5 }]),
    ).toThrow(/add content/);
    expect(() =>
      validateExtractionOps([{ op: 'add', kind: 'fact', content: 'x', confidence: 1.2 }]),
    ).toThrow(/add confidence/);
  });

  it('rejects dueAt on a non-action add and a malformed embedding', () => {
    expect(() =>
      validateExtractionOps([
        { op: 'add', kind: 'fact', content: 'x', confidence: 0.5, dueAt: 1 },
      ]),
    ).toThrow(/due_at/);
    expect(() =>
      validateExtractionOps([
        {
          op: 'add',
          kind: 'action_item',
          content: 'x',
          confidence: 0.5,
          embedding: { values: ['nope'], model: 'm', dim: 1 },
        } as unknown as ExtractionOp,
      ]),
    ).toThrow(/add embedding/);
  });

  it('rejects an unknown op tag, an empty id, and a missing object', () => {
    expect(() =>
      validateExtractionOps([{ op: 'forget', id: 'mem_one' } as unknown as ExtractionOp]),
    ).toThrow(/unknown op/);
    expect(() => validateExtractionOps([{ op: 'noop', id: '' }])).toThrow(/noop id/);
    expect(() => validateExtractionOps([null as unknown as ExtractionOp])).toThrow(/expected an object/);
  });
});