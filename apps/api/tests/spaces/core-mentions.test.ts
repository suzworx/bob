/**
 * Unit tests for the deterministic mention parser (014, FR-008,
 * specs/014-family-collaboration/contracts/tools-and-events.md "Agent
 * capabilities", issues #117 and #120). Pure logic, no store, no network, no
 * model: whether Bob was addressed is decided here, never by asking a model.
 *
 * Pins the seven rules that break naive regex parsers, plus the summary cases.
 * Offsets are UTF-16 code units; the offset-invariant property check proves
 * `body.slice(m.start, m.end) === m.raw` on generated inputs.
 *
 * resolveMentions (S14-MEMBER-HANDLES) is tested here too. The round-trip case
 * imports deriveMemberHandles from the store (the only store import in this
 * file) so the handles this suite resolves are exactly the ones listMembers
 * produces -- the grammar contract is pinned end to end.
 */
import { describe, expect, it } from 'vitest';
import { parseMentions, resolveMentions } from '../../src/spaces/mentions.ts';
import { deriveMemberHandles } from '../../src/spaces/store.ts';

function shapes(parsed: ReturnType<typeof parseMentions>) {
  return parsed.mentions.map((m) => ({ kind: m.kind, handle: m.handle, resourceType: m.resourceType, raw: m.raw }));
}

describe('parseMentions (014 FR-008)', () => {
  it('rule 1: email addresses are not mentions', () => {
    const parsed = parseMentions('mail priya@example.com');
    expect(parsed.mentions).toEqual([]);
    expect(parsed.addressesAssistant).toBe(false);
  });

  it('rule 1: an @ preceded by a word character is never a mention start', () => {
    const parsed = parseMentions('reach a@b and @bob');
    // a@b is mid-token; the standalone @bob still parses.
    expect(shapes(parsed)).toEqual([
      { kind: 'assistant', handle: 'bob', resourceType: undefined, raw: '@bob' },
    ]);
    expect(parsed.addressesAssistant).toBe(true);
  });

  it('rule 2: single-backtick code spans yield no mentions', () => {
    const parsed = parseMentions('see `@media (max-width: 600px)` then @priya');
    expect(shapes(parsed)).toEqual([
      { kind: 'person', handle: 'priya', resourceType: undefined, raw: '@priya' },
    ]);
  });

  it('rule 2: triple-backtick fenced blocks yield no mentions', () => {
    const body = [
      'before @priya',
      '```',
      '@bob inside the fence',
      '@priya also inside',
      '```',
      'after @mom',
    ].join('\n');
    const parsed = parseMentions(body);
    expect(shapes(parsed)).toEqual([
      { kind: 'person', handle: 'priya', resourceType: undefined, raw: '@priya' },
      { kind: 'person', handle: 'mom', resourceType: undefined, raw: '@mom' },
    ]);
  });

  it('rule 2: an unclosed fence skips everything after it', () => {
    const parsed = parseMentions('```\n@bob never seen');
    expect(parsed.mentions).toEqual([]);
    expect(parsed.addressesAssistant).toBe(false);
  });

  it('rule 3: \\@ and \\# escape the sigil and yield no mention', () => {
    const parsed = parseMentions('write \\@bob here, \\#task/1 done, @priya and #task/2');
    expect(shapes(parsed)).toEqual([
      { kind: 'person', handle: 'priya', resourceType: undefined, raw: '@priya' },
      { kind: 'resource', handle: '2', resourceType: 'task', raw: '#task/2' },
    ]);
  });

  it('rule 4: duplicate mentions are preserved as separate spans with offsets', () => {
    const parsed = parseMentions('@priya @priya');
    expect(parsed.mentions).toHaveLength(2);
    expect(parsed.mentions[0]).toEqual({ kind: 'person', handle: 'priya', start: 0, end: 6, raw: '@priya' });
    expect(parsed.mentions[1]).toEqual({ kind: 'person', handle: 'priya', start: 7, end: 13, raw: '@priya' });
  });

  it('rule 5: non-ASCII text before a mention does not shift offsets', () => {
    const bodies = ['नमस्ते @priya!', '😀 @bob', 'héllo @mom 🙌 #task/1'];
    for (const body of bodies) {
      const parsed = parseMentions(body);
      for (const m of parsed.mentions) {
        expect(body.slice(m.start, m.end)).toBe(m.raw);
      }
    }
    const devanagari = parseMentions('नमस्ते @priya!');
    expect(devanagari.mentions[0]).toEqual({ kind: 'person', handle: 'priya', start: 7, end: 13, raw: '@priya' });
    const emoji = parseMentions('😀 @bob');
    expect(emoji.mentions[0]).toEqual({ kind: 'assistant', handle: 'bob', start: 3, end: 7, raw: '@bob' });
  });

  it('rule 5: the offset invariant holds across generated strings', () => {
    const handles = ['priya', 'mom', 'a1', 'x_y', 'bob', 'BOB'];
    const sigils = ['@', '#task/', '#event/', '#note/'];
    const prefixes = ['', 'नमस्ते ', '😀 ', 'a', 'x1', '  '];
    const bodies: string[] = [];
    for (const handle of handles) {
      for (const sigil of sigils) {
        for (const prefix of prefixes) {
          bodies.push(`${prefix}${sigil}${handle} more text`);
        }
      }
    }
    for (const body of bodies) {
      const parsed = parseMentions(body);
      for (const m of parsed.mentions) {
        expect(m.start).toBeGreaterThanOrEqual(0);
        expect(m.start).toBeLessThanOrEqual(m.end);
        expect(m.end).toBeLessThanOrEqual(body.length);
        expect(body.slice(m.start, m.end)).toBe(m.raw);
      }
    }
  });

  it('rule 6: mentions come back in source order', () => {
    const parsed = parseMentions('#task/9 @mom @priya #note/1 @bob @dad');
    expect(parsed.mentions.map((m) => m.raw)).toEqual([
      '#task/9',
      '@mom',
      '@priya',
      '#note/1',
      '@bob',
      '@dad',
    ]);
    const starts = parsed.mentions.map((m) => m.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('rule 7: an 8000+ char body parses correctly', () => {
    const filler = 'some ordinary prose without mentions. ';
    let body = '';
    while (body.length < 9000) body += filler;
    body += ' @priya @bob #task/42';
    const parsed = parseMentions(body);
    expect(parsed.mentions.map((m) => m.raw)).toEqual(['@priya', '@bob', '#task/42']);
    expect(parsed.addressesAssistant).toBe(true);
  });

  it('rule 7: many invalid @-tokens do not cause backtracking blowup', () => {
    const invalid = '@' + 'a'.repeat(50);
    const parsed = parseMentions((invalid + ' ').repeat(200) + '@priya');
    expect(parsed.mentions.map((m) => m.raw)).toEqual(['@priya']);
  });

  it('summary: a message with no mentions is empty and does not address the assistant', () => {
    const parsed = parseMentions('just a normal message, nothing special here');
    expect(parsed.mentions).toEqual([]);
    expect(parsed.addressesAssistant).toBe(false);
  });

  it('summary: a person mention plus addressing the assistant returns both', () => {
    const parsed = parseMentions('@priya can you check, @bob?');
    expect(shapes(parsed)).toEqual([
      { kind: 'person', handle: 'priya', resourceType: undefined, raw: '@priya' },
      { kind: 'assistant', handle: 'bob', resourceType: undefined, raw: '@bob' },
    ]);
    expect(parsed.addressesAssistant).toBe(true);
  });

  it('summary: a resource mention of each of the three types', () => {
    const parsed = parseMentions('#task/t-1 and #event/e-2 and #note/n-3');
    expect(shapes(parsed)).toEqual([
      { kind: 'resource', handle: 't-1', resourceType: 'task', raw: '#task/t-1' },
      { kind: 'resource', handle: 'e-2', resourceType: 'event', raw: '#event/e-2' },
      { kind: 'resource', handle: 'n-3', resourceType: 'note', raw: '#note/n-3' },
    ]);
    expect(parsed.addressesAssistant).toBe(false);
  });

  it('grammar: @bob with trailing punctuation keeps the mention, punct excluded', () => {
    const body = '@bob, please; and @bob: thanks.';
    const parsed = parseMentions(body);
    expect(shapes(parsed)).toEqual([
      { kind: 'assistant', handle: 'bob', resourceType: undefined, raw: '@bob' },
      { kind: 'assistant', handle: 'bob', resourceType: undefined, raw: '@bob' },
    ]);
    expect(parsed.mentions.map((m) => [m.start, m.end])).toEqual([[0, 4], [18, 22]]);
    for (const m of parsed.mentions) {
      expect(body.slice(m.start, m.end)).toBe('@bob');
    }
  });
});

describe('resolveMentions (S14 member handles)', () => {
  const members = [
    { user_id: 'u-priya', handle: 'priya' },
    { user_id: 'u-mom', handle: 'mom' },
    { user_id: 'u-bob', handle: 'bob.1' },
  ];

  it('resolves person handles to members and reports assistant addressing', () => {
    const result = resolveMentions('@priya can you and @bob look at #task/1', members);
    expect(result).toEqual({
      addressesAssistant: true,
      people: [{ handle: 'priya', user_id: 'u-priya' }],
      unresolved: [],
    });
  });

  it('matches handles case-insensitively', () => {
    const result = resolveMentions('Ask @PRIYA and @Mom', members);
    expect(result.people).toEqual([
      { handle: 'priya', user_id: 'u-priya' },
      { handle: 'mom', user_id: 'u-mom' },
    ]);
    expect(result.addressesAssistant).toBe(false);
    expect(result.unresolved).toEqual([]);
  });

  it('duplicates in the body resolve to one entry per distinct user', () => {
    const result = resolveMentions('@priya @priya @mom @priya', members);
    expect(result.people).toEqual([
      { handle: 'priya', user_id: 'u-priya' },
      { handle: 'mom', user_id: 'u-mom' },
    ]);
  });

  it('an unknown handle goes to unresolved and is never guessed at', () => {
    const result = resolveMentions('@priya and @nobody', members);
    expect(result.people).toEqual([{ handle: 'priya', user_id: 'u-priya' }]);
    expect(result.unresolved).toEqual(['nobody']);
  });

  it('@bob never resolves to a person, even when a member could claim the handle', () => {
    const result = resolveMentions('@bob, please check', members);
    expect(result.addressesAssistant).toBe(true);
    expect(result.people).toEqual([]);
    expect(result.unresolved).toEqual([]);

    // Defensive: a caller passing a member whose handle is literally 'bob'
    // (derivation prevents it, but resolution must not depend on that) still
    // sees the assistant mention, never a person.
    const rogue = [{ user_id: 'u-x', handle: 'bob' }];
    const rogueResult = resolveMentions('@bob', rogue);
    expect(rogueResult.addressesAssistant).toBe(true);
    expect(rogueResult.people).toEqual([]);
    expect(rogueResult.unresolved).toEqual([]);
  });

  it('round-trip: every derived member handle parses as exactly one person mention', () => {
    const profiles = [
      { userId: 'u-ada', displayName: 'Ada Lovelace', email: 'ada@example.com' },
      { userId: 'u-grace', displayName: 'Grace Hopper', email: 'grace@example.com' },
      { userId: 'u-von', displayName: 'John von Neumann!!!', email: 'john@example.com' },
      { userId: 'u-emoji', displayName: '😀 Nikola', email: 'nikola@example.com' },
      { userId: 'u-null', displayName: null, email: null },
      { userId: 'u-sym', displayName: '!!!', email: 'sym@example.com' },
      { userId: 'u-bob', displayName: 'Bob', email: 'o@example.com' },
      { userId: 'u-twin', displayName: 'Ada Lovelace', email: 'twin@example.com' },
      { userId: 'u-long', displayName: 'a'.repeat(60), email: 'long@example.com' },
    ];
    const handles = deriveMemberHandles(profiles);
    expect(new Set(handles.map((entry) => entry.handle)).size).toBe(handles.length);
    for (const { handle } of handles) {
      expect(handle.length).toBeGreaterThanOrEqual(1);
      expect(handle.length).toBeLessThanOrEqual(40);
      const parsed = parseMentions('@' + handle);
      expect(parsed.addressesAssistant).toBe(false);
      expect(parsed.mentions).toHaveLength(1);
      expect(parsed.mentions[0]!.kind).toBe('person');
      expect(parsed.mentions[0]!.handle).toBe(handle);
      expect(parsed.mentions[0]!.raw).toBe('@' + handle);
    }
  });
});