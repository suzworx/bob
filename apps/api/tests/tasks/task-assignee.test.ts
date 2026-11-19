// Prod 2026-10-06: "assign it to Samir number four work" never reached a member, so
// the assistant restated a made-up assignment. matchAssignee is the pure half of the
// fix: a spoken or typed name or @handle against the space's active members.
import { describe, expect, it } from 'vitest';
import { assigneeLabel, matchAssignee, type AssigneeCandidate } from '../../src/tasks/assignee.ts';

const OWNER: AssigneeCandidate = { userId: 'u-owner', displayName: 'Sameer Rivera', handle: 'sameer.rivera' };
const WORK: AssigneeCandidate = { userId: 'u-work', displayName: null, handle: 'sameer4work' };
const MAYA: AssigneeCandidate = { userId: 'u-maya', displayName: 'Maya', handle: 'maya' };
const MEMBERS = [OWNER, WORK, MAYA];

describe('matchAssignee', () => {
  it.each([
    ['sameer4work', WORK],
    ['@sameer4work', WORK],
    ['SAMEER4WORK', WORK],
    ['Samir number four work', WORK], // spoken digits, filler word, STT spelling
    ['sameer 4 work', WORK],
    ['Sameer Rivera', OWNER],
    ['sameer.rivera', OWNER],
    ['Samir', OWNER], // first-name match, STT spelling
    ['maya', MAYA],
    ['at maya', MAYA], // a spoken @
    ['Mayaa', MAYA], // sound-alike, not a typo: folds equal to "maya"
  ])('%s matches one member', (spoken, expected) => {
    expect(matchAssignee(spoken, MEMBERS)).toEqual({ kind: 'match', member: expected });
  });

  it('an exact match wins over a looser one', () => {
    const samir: AssigneeCandidate = { userId: 'u-samir', displayName: 'Samir', handle: 'samir' };
    expect(matchAssignee('Samir', [OWNER, samir])).toEqual({ kind: 'match', member: samir });
  });

  it('two equally good members are ambiguous, naming only those two', () => {
    const twin: AssigneeCandidate = { userId: 'u-twin', displayName: 'Maya', handle: 'maya.2' };
    expect(matchAssignee('maya', [MAYA, twin, OWNER])).toEqual({ kind: 'match', member: MAYA }); // exact handle
    expect(matchAssignee('Maya', [{ ...MAYA, handle: 'maya.1' }, twin, OWNER])).toEqual({
      kind: 'ambiguous',
      candidates: [{ ...MAYA, handle: 'maya.1' }, twin],
    });
  });

  it('no match returns every member as a candidate', () => {
    expect(matchAssignee('Priya', MEMBERS)).toEqual({ kind: 'none', candidates: MEMBERS });
    expect(matchAssignee('  ', MEMBERS)).toEqual({ kind: 'none', candidates: MEMBERS });
  });

  it('a short name does not fuzzy-match a different person', () => {
    expect(matchAssignee('Max', MEMBERS)).toEqual({ kind: 'none', candidates: MEMBERS });
  });

  describe('a prefix or typo hit asks instead of silently assigning', () => {
    const MARY: AssigneeCandidate = { userId: 'u-mary', displayName: 'Mary Smith', handle: 'mary.smith' };
    const JOAN: AssigneeCandidate = { userId: 'u-joan', displayName: 'Joan', handle: 'joan' };
    const ALICE: AssigneeCandidate = { userId: 'u-alice', displayName: 'Alice', handle: 'alice' };
    const FUZZY = [MARY, JOAN, ALICE, OWNER];

    it.each([
      ['Mark', { kind: 'none', candidates: FUZZY }],
      ['John', { kind: 'ambiguous', candidates: [JOAN] }],
      ['Jean', { kind: 'ambiguous', candidates: [JOAN] }],
      ['Ali', { kind: 'ambiguous', candidates: [ALICE] }],
      ['Smit', { kind: 'ambiguous', candidates: [MARY] }],
    ] as const)('%s is never a silent match', (spoken, expected) => {
      expect(matchAssignee(spoken, FUZZY)).toEqual(expected);
    });

    it('a dropped-letter typo on a handle is ambiguous, not a silent match', () => {
      expect(matchAssignee('sameer4wrk', MEMBERS)).toEqual({ kind: 'ambiguous', candidates: [WORK] });
    });

    it('a short prefix hit is ambiguous, not a silent match', () => {
      expect(matchAssignee('May', MEMBERS)).toEqual({ kind: 'ambiguous', candidates: [MAYA] });
    });
  });
});

describe('assigneeLabel', () => {
  it('names the member by display name and handle, or the handle alone when the name adds nothing', () => {
    expect(assigneeLabel(OWNER)).toBe('Sameer Rivera (@sameer.rivera)');
    expect(assigneeLabel(WORK)).toBe('@sameer4work');
    expect(assigneeLabel({ ...WORK, displayName: 'sameer4work' })).toBe('@sameer4work');
    expect(assigneeLabel(MAYA)).toBe('@maya');
  });
});
