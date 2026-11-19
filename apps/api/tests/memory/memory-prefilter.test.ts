// Default-suite tests for the #406 memory-extraction pre-filter (shadow mode):
// the literal skip-list, its case/punctuation handling, the length buckets, and
// 0 misses over the synthetic labelled set (tests/fixtures/prefilter-labelled.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PREFILTER_VERSION, prefilter, userCharsBucket } from '../../src/memory/prefilter.ts';

const labelledSchema = z.object({
  version: z.literal(1),
  fixtures: z.array(z.object({
    id: z.string(),
    turns: z.array(z.object({ user: z.string(), assistant: z.string() })).min(1),
    productive: z.boolean(),
    kind: z.enum(['fact', 'preference', 'intent', 'action_item']).optional(),
  })),
});

const labelled = labelledSchema.parse(
  JSON.parse(readFileSync(new URL('../fixtures/prefilter-labelled.json', import.meta.url), 'utf8')),
);

describe('memory prefilter: the literal list', () => {
  it('exports a version constant', () => {
    expect(PREFILTER_VERSION).toMatch(/^[a-z0-9.-]+$/);
  });

  it.each(['thanks', 'thank you', 'ok thanks', 'got it', 'cheers', 'hello'])(
    'skips the acknowledgement %j',
    (text) => {
      expect(prefilter(text)).toEqual({ verdict: 'skip', reason: 'ack' });
    },
  );

  it.each(['stop', 'cancel', 'never mind', 'pause', 'repeat that', 'hold on'])(
    'skips the control phrase %j',
    (text) => {
      expect(prefilter(text)).toEqual({ verdict: 'skip', reason: 'control' });
    },
  );

  it.each([
    'sure', 'Sure!', 'ok', 'Okay.', '  ok  ', 'Ok...', 'k', 'yes', 'Y', 'go ahead', 'Sounds good!', 'perfect',
    'alright', 'All right', 'continue', 'go on', 'Keep going',
  ])('keeps the confirmation %j (it may accept an assistant offer)', (text) => {
    expect(prefilter(text)).toEqual({ verdict: 'keep', reason: 'confirmation' });
  });

  it.each(['Thanks!', 'THANK YOU.', 'Got it!!', 'STOP.', 'Never-mind', "That's all", 'thanks  a   lot'])(
    'matches case and punctuation variants: %j',
    (text) => {
      expect(prefilter(text).verdict).toBe('skip');
    },
  );

  it.each([
    'no, the other one',
    'thanks, and remind me to call Mum',
    'ok, I am allergic to peanuts',
    'stop suggesting gym workouts',
    'no',
    'Explain CAP theorem',
    "I'm vegan.",
    '2',
    '7!',
  ])('keeps %j (not a whole-message match)', (text) => {
    expect(prefilter(text)).toEqual({ verdict: 'keep', reason: 'none' });
  });

  it('empty and punctuation-only text is skip/empty', () => {
    expect(prefilter('')).toEqual({ verdict: 'skip', reason: 'empty' });
    expect(prefilter('   ')).toEqual({ verdict: 'skip', reason: 'empty' });
    expect(prefilter('?!')).toEqual({ verdict: 'skip', reason: 'empty' });
  });

  it('a single non-digit letter is skip/short; a lone digit is keep (it can be an answer)', () => {
    expect(prefilter('x')).toEqual({ verdict: 'skip', reason: 'short' });
    expect(prefilter('X?')).toEqual({ verdict: 'skip', reason: 'short' });
    expect(prefilter('3')).toEqual({ verdict: 'keep', reason: 'none' });
  });

  it('a non-string input leans to keep', () => {
    expect(prefilter(undefined as unknown as string)).toEqual({ verdict: 'keep', reason: 'none' });
  });
});

describe('memory prefilter: user_chars_bucket', () => {
  it.each([
    [0, '0-10'],
    [10, '0-10'],
    [11, '11-40'],
    [40, '11-40'],
    [41, '41-120'],
    [120, '41-120'],
    [121, '120+'],
  ] as const)('%i chars -> %s', (length, bucket) => {
    expect(userCharsBucket('a'.repeat(length))).toBe(bucket);
  });
});

describe('memory prefilter: offline labelled set', () => {
  const productive = labelled.fixtures.filter((f) => f.productive);
  const skipped = labelled.fixtures.filter((f) => prefilter(f.turns[0]!.user).verdict === 'skip');

  it('has at least 200 synthetic turns, about half productive, kinds on every productive turn', () => {
    expect(labelled.fixtures.length).toBeGreaterThanOrEqual(200);
    expect(productive.length / labelled.fixtures.length).toBeGreaterThan(0.4);
    expect(productive.length / labelled.fixtures.length).toBeLessThan(0.6);
    expect(productive.every((f) => f.kind !== undefined)).toBe(true);
    expect(new Set(labelled.fixtures.map((f) => f.id)).size).toBe(labelled.fixtures.length);
  });

  it('0 misses on the productive half', () => {
    const misses = productive.filter((f) => prefilter(f.turns[0]!.user).verdict === 'skip').map((f) => f.id);
    expect(misses).toEqual([]);
  });

  it('0 misses on the adversarial confirmations (the assistant reply carries the memory)', () => {
    const confirmations = productive.filter((f) => f.id.startsWith('c'));
    expect(confirmations.length).toBeGreaterThanOrEqual(6);
    expect(confirmations.some((f) => f.kind === 'action_item')).toBe(true);
    expect(confirmations.some((f) => f.kind === 'preference')).toBe(true);
    for (const f of confirmations) {
      expect(prefilter(f.turns[0]!.user), f.id).toEqual({ verdict: 'keep', reason: 'confirmation' });
    }
  });

  it('reports the skip share on the whole set', () => {
    const share = skipped.length / labelled.fixtures.length;
    console.info(
      `[prefilter ${PREFILTER_VERSION}] skip share ${skipped.length}/${labelled.fixtures.length} = ${(share * 100).toFixed(1)} %`,
    );
    expect(share).toBeGreaterThan(0.1);
  });
});
