import { describe, expect, it } from 'vitest';
import type { MentionMember } from '@/features/chat/use-mention-picker';
import { addressesBob, mentionName, mentionToken, buildMentionTrigger, normalizeComposerText } from './mentions';

const mockMembers: MentionMember[] = [
  {
    user_id: 'u1',
    role: 'owner',
    display_name: 'Alice Smith',
    handle: 'alice',
    email: 'alice@example.com',
  },
  {
    user_id: 'u2',
    role: 'member',
    display_name: '',
    handle: 'bob',
    email: 'bob@example.com',
  },
  {
    user_id: 'u3',
    role: 'member',
    display_name: '  ',
    handle: 'charlie',
    email: null,
  },
  {
    user_id: 'u4',
    role: 'member',
    display_name: 'Diana',
    handle: 'diana',
    email: null,
  },
  {
    user_id: 'u5',
    role: 'member',
    display_name: 'Eve Johnson',
    handle: 'ann',
    email: 'eve@example.com',
  },
  {
    user_id: 'u6',
    role: 'member',
    display_name: null,
    handle: 'frank',
    email: '   ',
  },
];

describe('mentions', () => {
  describe('mentionName', () => {
    it('returns display_name when present and not whitespace-only', () => {
      expect(mentionName(mockMembers[0])).toBe('Alice Smith');
    });

    it('falls back to handle when display_name is empty', () => {
      expect(mentionName(mockMembers[1])).toBe('bob');
    });

    it('falls back to handle when display_name is whitespace-only', () => {
      expect(mentionName(mockMembers[2])).toBe('charlie');
    });

    it('falls back to handle when email is null', () => {
      expect(mentionName(mockMembers[3])).toBe('Diana');
    });

    it('falls back to handle when email is whitespace-only', () => {
      expect(mentionName(mockMembers[5])).toBe('frank');
    });

    it('never renders an email, even when display_name is empty and a real email is present', () => {
      expect(mentionName(mockMembers[1])).toBe('bob');
      expect(mentionName(mockMembers[1])).not.toContain('@example.com');
    });
  });

  describe('mentionToken', () => {
    it('returns a token with value starting with @', () => {
      const token = mentionToken(mockMembers[0]);
      expect(token.value).toBe('@alice');
    });

    it('returns label from mentionName', () => {
      const token = mentionToken(mockMembers[0]);
      if ('render' in token) throw new Error('Expected badge token');
      expect(token.label).toBe('Alice Smith');
    });

    it('returns variant blue', () => {
      const token = mentionToken(mockMembers[0]);
      if ('render' in token) throw new Error('Expected badge token');
      expect(token.variant).toBe('blue');
    });
  });

  describe('buildMentionTrigger', () => {
    it('creates a trigger with @ character', () => {
      const trigger = buildMentionTrigger(mockMembers);
      expect(trigger.character).toBe('@');
    });

    it('includes searchSource', () => {
      const trigger = buildMentionTrigger(mockMembers);
      expect(trigger.searchSource).toBeDefined();
    });

    it('includes renderItem', () => {
      const trigger = buildMentionTrigger(mockMembers);
      expect(trigger.renderItem).toBeDefined();
    });

    it('onSelect returns a token for a known member', () => {
      const trigger = buildMentionTrigger(mockMembers);
      if (!trigger.onSelect) throw new Error('onSelect not defined');
      const item = { id: 'alice', label: 'Alice Smith', auxiliaryData: { handle: 'alice' } };
      const result = trigger.onSelect(item);
      if (typeof result === 'string') throw new Error('Expected token object');
      if ('render' in result) throw new Error('Expected badge token, not custom');
      expect(result.value).toBe('@alice');
      expect(result.label).toBe('Alice Smith');
      expect(result.variant).toBe('blue');
    });

    it('deserialize returns null for non-mention strings', () => {
      const trigger = buildMentionTrigger(mockMembers);
      if (!trigger.deserialize) throw new Error('deserialize not defined');
      expect(trigger.deserialize('alice')).toBeNull();
      expect(trigger.deserialize('hello')).toBeNull();
    });

    it('deserialize returns token for exact handle match (case-insensitive)', () => {
      const trigger = buildMentionTrigger(mockMembers);
      if (!trigger.deserialize) throw new Error('deserialize not defined');
      const tokenLower = trigger.deserialize('@alice');
      const tokenUpper = trigger.deserialize('@ALICE');
      if (typeof tokenLower === 'string' || !tokenLower) throw new Error('Expected token for @alice');
      if (typeof tokenUpper === 'string' || !tokenUpper) throw new Error('Expected token for @ALICE');
      expect(tokenLower.value).toBe('@alice');
      expect(tokenUpper.value).toBe('@alice');
    });

    it('deserialize returns null for unknown handle', () => {
      const trigger = buildMentionTrigger(mockMembers);
      if (!trigger.deserialize) throw new Error('deserialize not defined');
      expect(trigger.deserialize('@nobody')).toBeNull();
    });

    it('has menuLabel Mention Bob, people or features', () => {
      const trigger = buildMentionTrigger(mockMembers);
      expect(trigger.menuLabel).toBe('Mention Bob, people or features');
    });

    it('has emptySearchResultsText No matches. Try Bob, a feature or a connected account.', () => {
      const trigger = buildMentionTrigger(mockMembers);
      expect(trigger.emptySearchResultsText).toBe('No matches. Try Bob, a feature or a connected account.');
    });

    it('searchSource finds member by name prefix', async () => {
      const trigger = buildMentionTrigger(mockMembers);
      const results = await trigger.searchSource.search('alice');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.id === 'alice')).toBe(true);
    });

    it('searchSource finds member by handle prefix', async () => {
      const trigger = buildMentionTrigger(mockMembers);
      const results = await trigger.searchSource.search('ann');
      expect(results.some((r) => r.id === 'ann')).toBe(true);
    });

    it('searchSource bootstrap returns all members', async () => {
      const trigger = buildMentionTrigger(mockMembers);
      const results = await trigger.searchSource.bootstrap();
      expect(results.length).toBe(mockMembers.length);
    });
  });

  describe('normalizeComposerText', () => {
    it('removes non-breaking spaces (U+00A0)', () => {
      const text = 'hi @ann test';
      expect(normalizeComposerText(text)).toBe('hi @ann test');
    });

    it('trims leading and trailing spaces', () => {
      expect(normalizeComposerText('  hello world  ')).toBe('hello world');
    });

    it('combines nbsp replacement and trimming', () => {
      expect(normalizeComposerText('  hi @ann  ')).toBe('hi @ann');
    });

    it('handles text without nbsp', () => {
      expect(normalizeComposerText('hello world')).toBe('hello world');
    });

    it('returns empty string for whitespace-only input', () => {
      expect(normalizeComposerText('   ')).toBe('');
    });
  });

  describe('addressesBob', () => {
    it.each([
      ['@bob add milk', true],
      ['hey @Bob, add milk', true],
      ['@bob', true],
      ['(@bob)', true],
      ['@bob.', true],
      ['@bob hi', true],
      ['me@bob', false],
      ['@bobbot hi', false],
      ['@bob_x', false],
      ['@bob.bob', false],
      ['\\@bob', false],
      ['`@bob`', false],
      ['```\n@bob\n```', false],
      ['no mention', false],
    ])('%j -> %s', (body, expected) => {
      expect(addressesBob(body)).toBe(expected);
    });
  });
});
