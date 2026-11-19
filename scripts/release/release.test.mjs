import { describe, expect, it } from 'vitest';
import { parseCommit, computeBump, applyBump, computeNext, resolveRange } from './next-version.mjs';
import { buildNotes, isSecretLine } from './release-notes.mjs';
import { devBaseVersion, fwBuildFlags } from './fw-version.mjs';

const commit = (subject, body = '') => parseCommit({ sha: 'a'.repeat(40), subject, body });

describe('next-version bump rules', () => {
  it('feat gives a minor bump', () => {
    expect(computeBump([commit('feat(api): add devices')], '1.2.3')).toBe('minor');
  });

  it('fix gives a patch bump', () => {
    expect(computeBump([commit('fix(db): bare server')], '1.2.3')).toBe('patch');
  });

  it('chore only gives no release', () => {
    expect(computeBump([commit('chore: tidy'), commit('test: cover')], '1.2.3')).toBe('none');
  });

  it('breaking while major is 0 gives a minor bump', () => {
    expect(computeBump([commit('feat!: drop legacy')], '0.3.1')).toBe('minor');
  });

  it('breaking while major is > 0 gives a major bump', () => {
    expect(computeBump([commit('feat!: drop legacy')], '1.3.1')).toBe('major');
  });

  it('BREAKING CHANGE body gives a major bump', () => {
    expect(computeBump([commit('feat: x', 'BREAKING CHANGE: y')], '1.3.1')).toBe('major');
  });
});

describe('applyBump', () => {
  it('computes versions', () => {
    expect(applyBump('1.2.3', 'patch')).toBe('1.2.4');
    expect(applyBump('1.2.3', 'minor')).toBe('1.3.0');
    expect(applyBump('1.2.3', 'major')).toBe('2.0.0');
    expect(applyBump('1.2.3', 'none')).toBe(null);
  });
});

describe('resolveRange', () => {
  it('uses tag..HEAD when a tag exists', () => {
    expect(resolveRange('v0.1.0')).toBe('v0.1.0..HEAD');
  });

  it('uses HEAD when there is no tag', () => {
    expect(resolveRange(null)).toBe('HEAD');
  });

  it('preview and CI build the same range', () => {
    expect(resolveRange('v0.1.0')).toBe('v0.1.0..HEAD');
    expect(resolveRange('v0.1.0')).toBe(resolveRange('v0.1.0'));
  });
});

describe('computeNext', () => {
  it('first release is always 0.1.0', () => {
    const decision = computeNext({ current: '0.0.0', first: true, commits: [commit('feat: x')] });
    expect(decision.next).toBe('0.1.0');
    expect(decision.current).toBe(null);
  });
});

describe('merge commits', () => {
  it('are skipped but keep their PR number and title', () => {
    const merge = parseCommit({
      sha: 'b'.repeat(40),
      subject: 'Merge pull request #93 from example-user/claude/x',
      body: 'Consolidate UI and API\n\nmore',
    });
    expect(merge.type).toBe('merge');
    expect(merge.pr).toBe(93);
    expect(merge.title).toBe('Consolidate UI and API');
    expect(computeBump([merge], '1.0.0')).toBe('none');
  });

  it('PR number is extracted from a subject suffix', () => {
    expect(commit('feat(api): thing (#42)').pr).toBe(42);
  });
});

describe('release notes', () => {
  it('group features, fixes and collapse chores', () => {
    const commits = [
      parseCommit({ sha: 'c'.repeat(40), subject: 'feat(api): devices', body: '' }),
      parseCommit({ sha: 'd'.repeat(40), subject: 'fix(db): bare server', body: '' }),
      parseCommit({ sha: 'e'.repeat(40), subject: 'chore(flywheel): ledger', body: '' }),
    ];
    const notes = buildNotes(commits);
    expect(notes).toContain('## Highlights');
    expect(notes).toContain('**api**: devices');
    expect(notes).toContain('## Fixes');
    expect(notes).toContain('<details><summary>Chores</summary>');
  });

  it('chore(flywheel) is hidden from Highlights but kept under Chores', () => {
    const notes = buildNotes([parseCommit({ sha: 'f'.repeat(40), subject: 'chore(flywheel): ledger', body: '' })]);
    const highlights = notes.split('## Highlights')[1].split('<details>')[0];
    expect(highlights).not.toContain('ledger');
    expect(notes).toContain('ledger');
  });

  it('secret-shaped lines are dropped', () => {
    const fakeKey = 'sk' + '-or-v1-' + 'A'.repeat(20);
    expect(isSecretLine('key = ' + fakeKey)).toBe(true);
    const notes = buildNotes([parseCommit({ sha: 'g'.repeat(40), subject: 'feat(api): ok', body: '' })]);
    expect(notes.includes('sk-or-v1-')).toBe(false);
  });
});

describe('fw-version build flags (#345)', () => {
  it('a release build gets BOB_FW_VERSION and the sha', () => {
    expect(fwBuildFlags({ release: '1.4.0', sha: 'df5874b' })).toBe('-DBOB_FW_VERSION=1.4.0 -DBOB_FW_BUILD=df5874b');
  });

  it('a local build gets the dev base version, reported as <x.y.z>-dev+<sha>', () => {
    expect(fwBuildFlags({ release: '', base: '0.57.0', sha: 'df5874b' }))
      .toBe('-DBOB_FW_DEV_VERSION=0.57.0 -DBOB_FW_BUILD=df5874b');
  });

  it('no git: no build flag, and a sha that is not hex is dropped', () => {
    expect(fwBuildFlags({ release: '', base: '0.1.0', sha: '' })).toBe('-DBOB_FW_DEV_VERSION=0.1.0');
    expect(fwBuildFlags({ release: '0.1.0', sha: 'x; rm -rf' })).toBe('-DBOB_FW_VERSION=0.1.0');
  });

  it('a malformed version never builds', () => {
    expect(() => fwBuildFlags({ release: '1.4', sha: 'df5874b' })).toThrow(/x\.y\.z/);
    expect(() => fwBuildFlags({ release: '1.4.0-rc.1', sha: 'df5874b' })).toThrow(/x\.y\.z/);
    expect(() => fwBuildFlags({ release: '', base: 'latest', sha: 'df5874b' })).toThrow(/x\.y\.z/);
  });

  it('the dev base is the next release, else the last tag', () => {
    expect(devBaseVersion({ current: '0.56.0', next: '0.57.0' })).toBe('0.57.0');
    expect(devBaseVersion({ current: '0.56.0', next: null })).toBe('0.56.0');
  });
});