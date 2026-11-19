import { describe, expect, it } from 'vitest';

import { isCleanTree, isFresh, recordTree, statusArgs, STATUS_CONTEXT } from './validate-attest.mjs';
import { attestedTree, decide, treeFromDescription } from './validate-attested.mjs';

const TREE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('validate attestation record', () => {
  it('accepts a record that vouches for the current tree', () => {
    expect(isFresh({ tree: TREE, at: '2026-09-22T00:00:00Z' }, TREE)).toBe(true);
  });

  it('rejects a record for other content, a malformed tree, or no record', () => {
    expect(isFresh({ tree: OTHER }, TREE)).toBe(false);
    expect(isFresh({ tree: 'nope' }, 'nope')).toBe(false);
    expect(recordTree({ tree: 'nope' })).toBeNull();
    expect(isFresh(null, TREE)).toBe(false);
    expect(isFresh({}, TREE)).toBe(false);
  });

  it('records a pass only from a clean working tree', () => {
    expect(isCleanTree('')).toBe(true);
    expect(isCleanTree('\n')).toBe(true);
    expect(isCleanTree(undefined)).toBe(true);
    expect(isCleanTree(' M scripts/validate.mjs\n')).toBe(false);
    expect(isCleanTree('?? data/new.json\n')).toBe(false);
  });

  it('posts the tree in the status description so CI can match content', () => {
    const args = statusArgs('suzworx/Bob', 'c'.repeat(40), TREE);
    expect(args).toContain(`repos/suzworx/Bob/statuses/${'c'.repeat(40)}`);
    expect(args).toContain(`context=${STATUS_CONTEXT}`);
    expect(args).toContain(`description=tree=${TREE}`);
    expect(args).toContain('state=success');
  });
});

describe('validate attestation gate', () => {
  it('reads the tree out of a status description', () => {
    expect(treeFromDescription(`tree=${TREE}`)).toBe(TREE);
    expect(treeFromDescription(' tree=' + TREE + ' ')).toBe(TREE);
    expect(treeFromDescription('validated locally')).toBeNull();
    expect(treeFromDescription(undefined)).toBeNull();
  });

  it('takes the newest successful local/validate status', () => {
    const statuses = [
      { context: STATUS_CONTEXT, state: 'success', description: `tree=${OTHER}`, created_at: '2026-09-22T10:00:00Z' },
      { context: STATUS_CONTEXT, state: 'success', description: `tree=${TREE}`, created_at: '2026-09-22T12:00:00Z' },
      { context: 'other/check', state: 'success', description: `tree=${'c'.repeat(40)}`, created_at: '2026-09-22T13:00:00Z' },
    ];
    expect(attestedTree(statuses)).toBe(TREE);
  });

  it('ignores failed, foreign, empty and malformed status lists', () => {
    expect(attestedTree([{ context: STATUS_CONTEXT, state: 'failure', description: `tree=${TREE}` }])).toBeNull();
    expect(attestedTree([{ context: 'ci/other', state: 'success', description: `tree=${TREE}` }])).toBeNull();
    expect(attestedTree([])).toBeNull();
    expect(attestedTree(null)).toBeNull();
  });

  it('skips a pull request whose head commit carries the status', () => {
    expect(decide({ event: 'pull_request', attested: TREE, headTree: TREE, currentTree: OTHER })).toBe(true);
  });

  it('runs the suite when the pull request head moved on', () => {
    expect(decide({ event: 'pull_request', attested: TREE, headTree: OTHER, currentTree: TREE })).toBe(false);
  });

  it('skips a main commit whose tree matches the attested content', () => {
    expect(decide({ event: 'push', attested: TREE, headTree: OTHER, currentTree: TREE })).toBe(true);
  });

  it('runs the suite when a merge changed the content, or nothing is attested', () => {
    expect(decide({ event: 'push', attested: TREE, headTree: TREE, currentTree: OTHER })).toBe(false);
    expect(decide({ event: 'push', attested: null, headTree: TREE, currentTree: TREE })).toBe(false);
    expect(decide({ event: 'pull_request', attested: null, headTree: TREE, currentTree: TREE })).toBe(false);
    expect(decide({ event: 'push', attested: TREE, headTree: TREE, currentTree: '' })).toBe(false);
  });
});
