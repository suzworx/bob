import { describe, expect, it } from 'vitest';
import { compareRatchet, evaluate, groupDiagnostics, importCycles, oversizedFiles } from './check-quality.mjs';

const diag = (rule, file, line = 1) => ({ category: `lint/x/${rule}`, location: { path: file, start: { line } } });

describe('groupDiagnostics', () => {
  it('counts ratchet rules per file and lists zero-tolerance hits with their line', () => {
    const { counts, zero } = groupDiagnostics([
      diag('noExcessiveCognitiveComplexity', 'a.ts'),
      diag('noExcessiveCognitiveComplexity', 'a.ts'),
      diag('noNonNullAssertion', 'b.ts'),
      diag('noExplicitAny', 'c.ts', 7),
      diag('someOtherRule', 'd.ts'),
    ]);
    expect(counts).toEqual({ noExcessiveCognitiveComplexity: { 'a.ts': 2 }, noNonNullAssertion: { 'b.ts': 1 } });
    expect(zero).toEqual(['c.ts:7: noExplicitAny']);
  });

  it('keys Windows backslash paths by their POSIX form, as the baseline is', () => {
    const { counts, zero } = groupDiagnostics([
      diag('noNonNullAssertion', 'apps\\api\\src\\a.ts'),
      diag('noExplicitAny', 'apps\\api\\src\\b.ts', 3),
    ]);
    expect(counts).toEqual({ noNonNullAssertion: { 'apps/api/src/a.ts': 1 } });
    expect(zero).toEqual(['apps/api/src/b.ts:3: noExplicitAny']);
  });
});

describe('compareRatchet', () => {
  it('flags a rise or a new file as worse and a fall or a vanished file as better', () => {
    const { worse, better } = compareRatchet({ 'a.ts': 3, 'b.ts': 1, 'new.ts': 1 }, { 'a.ts': 2, 'b.ts': 2, 'gone.ts': 4 });
    expect(worse).toEqual(['a.ts: 3 (baseline 2)', 'new.ts: 1 (baseline 0)']);
    expect(better).toEqual(['b.ts: 1 (baseline 2)', 'gone.ts: 0 (baseline 4)']);
  });

  it('is quiet when nothing changed', () => {
    expect(compareRatchet({ 'a.ts': 2 }, { 'a.ts': 2 })).toEqual({ worse: [], better: [] });
  });
});

describe('oversizedFiles', () => {
  const lines = (n) => `${'x\n'.repeat(n)}`;
  it('reports source files over the limit and exempts schema files and tests', () => {
    const files = [
      { path: 'apps/api/src/big.ts', text: lines(1001) },
      { path: 'apps/api/src/ok.ts', text: lines(1000) },
      { path: 'apps/api/src/web-schemas.ts', text: lines(2000) },
      { path: 'apps/api/src/schemas.ts', text: lines(2000) },
      { path: 'apps/ui-v2/src/a.test.tsx', text: lines(2000) },
    ];
    expect(oversizedFiles(files)).toEqual({ 'apps/api/src/big.ts': 1001 });
  });
});

describe('importCycles', () => {
  const file = (path, ...imports) => ({ path, text: imports.map((i) => `import x from '${i}';`).join('\n') });
  it('finds a two-file cycle and a longer one, and ignores a chain', () => {
    const files = [
      file('apps/api/src/a.ts', './b.ts'), file('apps/api/src/b.ts', './a.ts'),
      file('apps/api/src/c.ts', './d.ts'), file('apps/api/src/d.ts', './e.ts'), file('apps/api/src/e.ts', './c.ts'),
      file('apps/api/src/f.ts', './g.ts'), file('apps/api/src/g.ts'),
    ];
    expect(importCycles(files)).toEqual([
      'apps/api/src/a.ts > apps/api/src/b.ts',
      'apps/api/src/c.ts > apps/api/src/d.ts > apps/api/src/e.ts',
    ]);
  });

  it('resolves extension-less and index imports and ignores packages', () => {
    const files = [file('apps/ui-v2/src/a.tsx', './b', 'react'), file('apps/ui-v2/src/b.tsx', './a')];
    expect(importCycles(files)).toEqual(['apps/ui-v2/src/a.tsx > apps/ui-v2/src/b.tsx']);
  });
});

describe('evaluate', () => {
  const measured = { biome: { noNonNullAssertion: { 'a.ts': 2 } }, size: {}, cycles: [] };
  it('passes at the baseline and fails a zero-tolerance hit', () => {
    const baseline = { biome: { noNonNullAssertion: { 'a.ts': 2 } }, size: {}, cycles: [] };
    expect(evaluate([], measured, baseline)).toEqual({ failures: [], stale: [] });
    expect(evaluate(['x.ts:1: noExplicitAny'], measured, baseline).failures).toEqual(['zero-tolerance rule: x.ts:1: noExplicitAny']);
  });

  it('fails a rise, a new cycle and a new oversized file; reports a fall as a stale baseline', () => {
    const baseline = { biome: { noNonNullAssertion: { 'a.ts': 3 } }, size: {}, cycles: ['old > cycle'] };
    const now = { biome: { noNonNullAssertion: { 'a.ts': 2, 'b.ts': 1 } }, size: { 'big.ts': 1100 }, cycles: ['new > cycle'] };
    const { failures, stale } = evaluate([], now, baseline);
    expect(failures).toEqual([
      'noNonNullAssertion rose: b.ts: 1 (baseline 0)',
      'file over 1000 lines rose: big.ts: 1100 (baseline 0)',
      'new import cycle: new > cycle',
    ]);
    expect(stale).toEqual(['noNonNullAssertion fell: a.ts: 2 (baseline 3)', 'import cycle gone: old > cycle']);
  });
});
