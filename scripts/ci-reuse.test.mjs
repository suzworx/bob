import { describe, expect, it } from 'vitest';

import { decide, STATUS_CONTEXT } from './ci-reuse.mjs';
import { attestedTree } from './validate-attested.mjs';

const TREE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const MAIN = { event: 'push', ref: 'refs/heads/main' };

describe('ci reuse', () => {
  it('reuses the PR run on a main push whose tree it passed', () => {
    expect(decide({ ...MAIN, passedTree: TREE, currentTree: TREE })).toBe(true);
  });

  it('runs everything when the trees differ (rebased, base moved, conflict resolved)', () => {
    expect(decide({ ...MAIN, passedTree: TREE, currentTree: OTHER })).toBe(false);
  });

  it('fails closed without a pass or a tree', () => {
    expect(decide({ ...MAIN, passedTree: null, currentTree: TREE })).toBe(false);
    expect(decide({ ...MAIN, passedTree: TREE, currentTree: '' })).toBe(false);
    expect(decide({ ...MAIN, passedTree: '', currentTree: '' })).toBe(false);
  });

  it('never reuses outside a main push', () => {
    expect(decide({ event: 'pull_request', ref: 'refs/pull/1/merge', passedTree: TREE, currentTree: TREE })).toBe(false);
    expect(decide({ event: 'push', ref: 'refs/heads/feature', passedTree: TREE, currentTree: TREE })).toBe(false);
    expect(decide({ event: 'workflow_dispatch', ref: 'refs/heads/main', passedTree: TREE, currentTree: TREE })).toBe(false);
  });

  it('reads only successful ci/tree-pass statuses, newest first', () => {
    const statuses = [
      { context: STATUS_CONTEXT, state: 'success', description: `tree=${OTHER}`, created_at: '2026-10-01T00:00:00Z' },
      { context: STATUS_CONTEXT, state: 'success', description: `tree=${TREE}`, created_at: '2026-10-02T00:00:00Z' },
      { context: STATUS_CONTEXT, state: 'failure', description: `tree=${OTHER}`, created_at: '2026-10-03T00:00:00Z' },
      { context: 'local/validate', state: 'success', description: `tree=${OTHER}`, created_at: '2026-10-04T00:00:00Z' },
    ];
    expect(attestedTree(statuses, STATUS_CONTEXT)).toBe(TREE);
    expect(attestedTree([{ context: 'local/validate', state: 'success', description: `tree=${TREE}` }], STATUS_CONTEXT)).toBeNull();
  });
});
