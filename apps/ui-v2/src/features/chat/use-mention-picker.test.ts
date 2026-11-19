import { describe, expect, it } from 'vitest';
import {
  buildMentionSections,
  findMentionTrigger,
  insertMention,
  moveIndex,
  type MentionMember,
} from './use-mention-picker';

const PRIYA: MentionMember = {
  user_id: 'u-priya',
  role: 'admin',
  display_name: 'Priya Sharma',
  handle: 'priya',
  email: 'priya@example.com',
};

const TOM: MentionMember = {
  user_id: 'u-tom',
  role: 'member',
  display_name: 'Tom',
  handle: 'tom',
  email: null,
};

describe('findMentionTrigger', () => {
  it('opens on @ after a space, and not on x@, name@example.com or \\@', () => {
    expect(findMentionTrigger('hi @', 4)).toEqual({ query: '', start: 3 });
    expect(findMentionTrigger('x@', 2)).toBeNull();
    expect(findMentionTrigger('name@example.com', 16)).toBeNull();
    expect(findMentionTrigger('\\@', 2)).toBeNull();
  });

  it('extracts the query as the caret moves, and closes on a space', () => {
    expect(findMentionTrigger('hi @pri', 7)).toEqual({ query: 'pri', start: 3 });
    expect(findMentionTrigger('hi @pri', 6)).toEqual({ query: 'pr', start: 3 });
    expect(findMentionTrigger('hi @', 4)).toEqual({ query: '', start: 3 });
    expect(findMentionTrigger('hi @pri n', 9)).toBeNull();
  });

  it('never opens while the caret sits inside a backtick code span', () => {
    expect(findMentionTrigger('`code @her', 10)).toBeNull();
    expect(findMentionTrigger('```\n@code', 9)).toBeNull();
  });
});

describe('buildMentionSections', () => {
  it('filters people by display-name substring and by handle', () => {
    const people = buildMentionSections([PRIYA, TOM], 'sharma').people;
    expect(people.map((option) => option.id)).toEqual([PRIYA.user_id]);
    const byHandle = buildMentionSections([PRIYA, TOM], 'tom').people;
    expect(byHandle.map((option) => option.id)).toEqual([TOM.user_id]);
  });

  it('shows Bob when the query is a prefix of bob, and not otherwise', () => {
    expect(buildMentionSections([PRIYA, TOM], 'bo').assistant.length).toBe(1);
    expect(buildMentionSections([PRIYA, TOM], '').assistant.length).toBe(1);
    expect(buildMentionSections([PRIYA, TOM], 'zzz').assistant.length).toBe(0);
  });

  it('shows the invite row only when nothing matched and the query is non-empty', () => {
    expect(buildMentionSections([PRIYA, TOM], 'nobody').invite.length).toBe(1);
    expect(buildMentionSections([PRIYA, TOM], '').invite.length).toBe(0);
    expect(buildMentionSections([PRIYA, TOM], 'priya').invite.length).toBe(0);
    expect(buildMentionSections([PRIYA, TOM], 'Bob').assistant.length).toBe(1);
    expect(buildMentionSections([PRIYA, TOM], '@Bob').assistant.length).toBe(1);
    expect(buildMentionSections([PRIYA, TOM], 'Bob').invite.length).toBe(0);
  });

  it('labels people with the display name and sub with handle + role', () => {
    const [option] = buildMentionSections([PRIYA, TOM], 'sharma').people;
    expect(option.label).toBe('Priya Sharma');
    expect(option.sub).toBe('@priya · Admin');
    expect(option.handle).toBe('@priya');
  });
});

describe('insertMention', () => {
  it('replaces the token and leaves the caret after one trailing space', () => {
    const result = insertMention('hi @pr', 6, 3, '@priya');
    expect(result.value).toBe('hi @priya ');
    expect(result.caret).toBe(10);
  });

  it('preserves a suffix after the caret', () => {
    const result = insertMention('@pr!', 3, 0, '@priya');
    expect(result.value).toBe('@priya !');
    expect(result.caret).toBe(7);
  });
});

describe('moveIndex', () => {
  it('wraps in both directions', () => {
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(1, -1, 3)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(0);
  });
});
