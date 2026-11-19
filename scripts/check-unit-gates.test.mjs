import { describe, expect, it } from 'vitest';

import { runGates, STEPS } from './check-unit-gates.mjs';

describe('check-unit-gates step list', () => {
  it('runs, in order, boundaries, quality, agents manifest, dead code, no-agent-doubles, typecheck', () => {
    expect(STEPS.map((step) => step.label)).toEqual([
      'import boundaries',
      'code quality (complexity, typing, size, cycles)',
      'domain agents manifest',
      'dead code (knip)',
      'no agent doubles',
      'typecheck',
    ]);
  });

  it('reuses the existing npm scripts and vitest run instead of reimplementing checks', () => {
    const scriptArgs = STEPS.filter((step) => step.args[0] === 'run').map((step) => step.args[1]);
    expect(scriptArgs).toEqual(['check:boundaries', 'check:quality', 'check:agents', 'lint:dead', 'typecheck']);

    const vitestStep = STEPS.find((step) => step.label === 'no agent doubles');
    expect(vitestStep.args).toEqual(['vitest', 'run', 'scripts/no-agent-doubles.test.mjs']);
  });
});

describe('check-unit-gates runGates', () => {
  it('runs every step and reports a 0 status for each on an all-pass run', () => {
    const calls = [];
    const results = runGates(STEPS, (step) => {
      calls.push(step.label);
      return 0;
    });

    expect(calls).toEqual(STEPS.map((step) => step.label));
    expect(results).toHaveLength(STEPS.length);
    expect(results.every((result) => result.status === 0)).toBe(true);
  });

  it('stops at the first failure and never runs the remaining steps', () => {
    const calls = [];
    const results = runGates(STEPS, (step) => {
      calls.push(step.label);
      return step.label === 'domain agents manifest' ? 1 : 0;
    });

    expect(calls).toEqual(['import boundaries', 'code quality (complexity, typing, size, cycles)', 'domain agents manifest']);
    expect(results).toHaveLength(3);
    expect(results.at(-1)).toMatchObject({ label: 'domain agents manifest', status: 1 });
  });

  it('fails fast on the very first step without touching the rest', () => {
    const calls = [];
    runGates(STEPS, (step) => {
      calls.push(step.label);
      return step.label === 'import boundaries' ? 1 : 0;
    });

    expect(calls).toEqual(['import boundaries']);
  });

  it('records a status and an elapsed time per step', () => {
    const results = runGates(STEPS, () => 0);
    for (const result of results) {
      expect(result).toHaveProperty('status', 0);
      expect(result.ms).toBeGreaterThanOrEqual(0);
    }
  });
});
