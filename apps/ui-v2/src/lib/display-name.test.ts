import { describe, expect, it } from 'vitest';
import type { User } from '@supabase/supabase-js';
import type { SpaceMember } from '../features/spaces/use-spaces';
import { accountDisplayName, memberDisplayName } from './display-name';

function userWith(metadata: Record<string, unknown>, email = 'ada@example.com'): User {
  return { email, user_metadata: metadata } as unknown as User;
}

describe('accountDisplayName', () => {
  it('prefers name over full_name', () => {
    expect(accountDisplayName(userWith({ name: 'Ada Lovelace', full_name: 'Ada L' }))).toBe('Ada Lovelace');
  });

  it('falls back to full_name when name is missing', () => {
    expect(accountDisplayName(userWith({ full_name: 'Ada L' }))).toBe('Ada L');
  });

  it('falls back to full_name when name is empty', () => {
    expect(accountDisplayName(userWith({ name: '', full_name: 'Ada L' }))).toBe('Ada L');
  });

  it('falls back to full_name when name is whitespace only', () => {
    expect(accountDisplayName(userWith({ name: '   ', full_name: 'Ada L' }))).toBe('Ada L');
  });

  it('ignores a non-string metadata value', () => {
    expect(accountDisplayName(userWith({ name: 42, full_name: 'Ada L' }))).toBe('Ada L');
  });

  it('returns null for a null user', () => {
    expect(accountDisplayName(null)).toBeNull();
  });

  it('returns null for an undefined user', () => {
    expect(accountDisplayName(undefined)).toBeNull();
  });

  it('returns null for an email-only user, never the email local part', () => {
    const result = accountDisplayName(userWith({}, 'sam.rivera@example.com'));
    expect(result).toBeNull();
    expect(result).not.toBe('sam.rivera');
  });
});

describe('memberDisplayName', () => {
  const members: SpaceMember[] = [
    { user_id: 'u1', role: 'owner', joined_at: 0, display_name: 'Ada Lovelace', handle: 'ada', email: null },
    { user_id: 'u2', role: 'member', joined_at: 0, display_name: '   ', handle: 'grace', email: null },
    { user_id: 'u3', role: 'member', joined_at: 0, display_name: null, handle: '', email: null },
  ];

  it('returns the trimmed display_name when present', () => {
    expect(memberDisplayName(members, 'u1')).toBe('Ada Lovelace');
  });

  it('falls through to the handle when display_name is whitespace', () => {
    expect(memberDisplayName(members, 'u2')).toBe('@grace');
  });

  it('returns Someone when neither display_name nor handle is usable', () => {
    expect(memberDisplayName(members, 'u3')).toBe('Someone');
  });

  it('returns Someone for a userId with no matching member', () => {
    expect(memberDisplayName(members, 'left-the-space')).toBe('Someone');
  });

  it('returns Bob for a null userId', () => {
    expect(memberDisplayName(members, null)).toBe('Bob');
  });

  it('never returns anything containing the raw user id', () => {
    for (const userId of ['u1', 'u2', 'u3', 'left-the-space']) {
      expect(memberDisplayName(members, userId)).not.toContain(userId);
    }
  });
});
