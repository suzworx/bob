import { describe, expect, it } from 'vitest';
import { formatCodeInput, formatRetryAfter, isNormalizable, normalizeCode } from './pair-code';

describe('normalizeCode', () => {
  it('uppercases and removes non-alphanumeric characters', () => {
    expect(normalizeCode('k7qx-4tzp')).toBe('K7QX4TZP');
    expect(normalizeCode('ABCD1234')).toBe('ABCD1234');
    expect(normalizeCode('a-b-c-d')).toBe('ABCD');
  });
});

describe('isNormalizable', () => {
  it('returns true for 8-character alphanumeric codes', () => {
    expect(isNormalizable('K7QX4TZP')).toBe(true);
    expect(isNormalizable('ABCD1234')).toBe(true);
  });

  it('returns false for non-8-character codes', () => {
    expect(isNormalizable('SHORT')).toBe(false);
    expect(isNormalizable('VERYLONGCODE')).toBe(false);
  });

  it('returns false for non-alphanumeric characters', () => {
    expect(isNormalizable('XXXX-XXXX')).toBe(false);
  });
});

describe('formatCodeInput', () => {
  it('formats code with hyphen after 4 characters', () => {
    expect(formatCodeInput('K7QX4TZP')).toBe('K7QX-4TZP');
  });

  it('handles lowercase input', () => {
    expect(formatCodeInput('k7qx4tzp')).toBe('K7QX-4TZP');
  });

  it('removes special characters before formatting', () => {
    expect(formatCodeInput('k7-qx-4-t-zp')).toBe('K7QX-4TZP');
  });

  it('limits to 8 characters', () => {
    expect(formatCodeInput('ABCDEFGHIJ')).toBe('ABCD-EFGH');
  });

  it('returns partial code without hyphen when less than 5 chars', () => {
    expect(formatCodeInput('ABC')).toBe('ABC');
    expect(formatCodeInput('ABCD')).toBe('ABCD');
  });
});

describe('formatRetryAfter', () => {
  it('formats seconds', () => {
    expect(formatRetryAfter(1)).toBe('1 second');
    expect(formatRetryAfter(45)).toBe('45 seconds');
  });

  it('formats minutes', () => {
    expect(formatRetryAfter(60)).toBe('1 minute');
    expect(formatRetryAfter(90)).toBe('2 minutes');
    expect(formatRetryAfter(150)).toBe('3 minutes');
  });

  it('formats hours', () => {
    expect(formatRetryAfter(3600)).toBe('1 hour');
    expect(formatRetryAfter(7200)).toBe('2 hours');
    expect(formatRetryAfter(3900)).toBe('2 hours');
  });

  it('defaults to 900 seconds (15 minutes) concept', () => {
    expect(formatRetryAfter(900)).toBe('15 minutes');
  });
});
