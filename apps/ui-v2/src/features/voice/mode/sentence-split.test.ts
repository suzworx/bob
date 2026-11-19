import { describe, expect, it } from 'vitest';
import { createSentenceSplitter } from './sentence-split';

interface PushCase {
  name: string;
  chunks: string[];
  expected: string[];
  expectedFlush: string;
}

const PUSH_CASES: PushCase[] = [
  {
    name: 'one completed sentence and a partial remainder',
    chunks: ['Hello world. This is a'],
    expected: ['Hello world.'],
    expectedFlush: 'This is a',
  },
  {
    name: 'chunk boundary splits mid-word',
    chunks: ['Hello wor', 'ld. Then'],
    expected: ['Hello world.'],
    expectedFlush: 'Then',
  },
  {
    name: 'chunk boundary splits mid-number keeps decimal intact',
    chunks: ['Pi is 3.', '14 approx. Then'],
    expected: ['Pi is 3.14 approx.'],
    expectedFlush: 'Then',
  },
  {
    name: 'decimal between digits is not a sentence end',
    chunks: ['The value is 3.5 and done. Then'],
    expected: ['The value is 3.5 and done.'],
    expectedFlush: 'Then',
  },
  {
    name: 'exclamation ends a sentence',
    chunks: ['Wow! Next one.'],
    expected: ['Wow!'],
    expectedFlush: 'Next one.',
  },
  {
    name: 'question ends a sentence',
    chunks: ['Really? Then go.'],
    expected: ['Really?'],
    expectedFlush: 'Then go.',
  },
  {
    name: 'abbreviation is not a sentence end',
    chunks: ['Dr Smith arrived. Then left.'],
    expected: ['Dr Smith arrived.'],
    expectedFlush: 'Then left.',
  },
  {
    name: 'e.g and i.e are not sentence ends',
    chunks: ['Use e.g. this and i.e. that. Stop.'],
    expected: ['Use e.g. this and i.e. that.'],
    expectedFlush: 'Stop.',
  },
  {
    name: 'blank line splits regardless of punctuation',
    chunks: ['Line one\n\nLine two. Then'],
    expected: ['Line one', 'Line two.'],
    expectedFlush: 'Then',
  },
  {
    name: 'bold markdown is stripped',
    chunks: ['This is **bold**. Nice.'],
    expected: ['This is bold.'],
    expectedFlush: 'Nice.',
  },
  {
    name: 'inline code and links are stripped',
    chunks: ['See [docs](https://x.io). Done.'],
    expected: ['See docs.'],
    expectedFlush: 'Done.',
  },
  {
    name: 'heading and list bullets are stripped',
    chunks: ['# Heading here.\n- item one. Then'],
    expected: ['Heading here.', 'item one.'],
    expectedFlush: 'Then',
  },
  {
    name: 'flush returns the partial remainder',
    chunks: ['Partial '],
    expected: [],
    expectedFlush: 'Partial',
  },
  {
    name: 'empty push emits nothing',
    chunks: [''],
    expected: [],
    expectedFlush: '',
  },
  {
    name: 'multiple sentences across pushes accumulate',
    chunks: ['First. Second', '. Third. Then'],
    expected: ['First.', 'Second.', 'Third.'],
    expectedFlush: 'Then',
  },
];

describe('createSentenceSplitter push', () => {
  it.each(PUSH_CASES)('$name', ({ chunks, expected, expectedFlush }) => {
    const splitter = createSentenceSplitter();
    const got: string[] = [];
    for (const chunk of chunks) {
      got.push(...splitter.push(chunk));
    }
    expect(got).toEqual(expected);
    expect(splitter.flush()).toEqual(expectedFlush === '' ? [] : [expectedFlush]);
  });
});

describe('createSentenceSplitter cap', () => {
  it('cuts long text at the last space before the cap and never emits empty', () => {
    const splitter = createSentenceSplitter({ maxChars: 20 });
    const out = splitter.push('a b c d e f g h i j k l m n o p');
    expect(out.length).toBeGreaterThanOrEqual(1);
    for (const s of out) {
      expect(s.length).toBeGreaterThan(0);
      expect(s.length).toBeLessThanOrEqual(20);
    }
    expect(splitter.flush().every((s) => s.length > 0)).toBe(true);
  });

  it('carries the uncapped remainder across pushes', () => {
    const splitter = createSentenceSplitter({ maxChars: 10 });
    splitter.push('one two three four five six seven. Then');
    expect(splitter.flush()).toEqual(['Then']);
  });

  it('flush yields nothing after a complete flush', () => {
    const splitter = createSentenceSplitter();
    splitter.push('Done. ');
    expect(splitter.flush()).toEqual([]);
  });
});