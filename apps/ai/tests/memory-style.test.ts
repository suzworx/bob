/**
 * One canonical voice for stored memories (follow-up to #758): the extractor
 * wrote "User has a wife named Maya." while `remember` stored "My wife's name
 * is Maya", and the two never matched as duplicates. Both writers now carry
 * MEMORY_CONTENT_STYLE, and canonicalMemoryVoice rewrites a leading first
 * person deterministically.
 */
import { describe, expect, it } from 'vitest';
import { MEMORY_EXTRACT_SYSTEM_PROMPT } from '../src/memory-extractor.ts';
import { createMemoryTools } from '../src/memory-tools.ts';
import { MEMORY_CONTENT_STYLE, canonicalMemoryVoice } from '../src/memory-style.ts';

describe('canonicalMemoryVoice', () => {
  it.each([
    ["My wife's name is Maya", "User's wife's name is Maya"],
    ['my favourite tea is masala chai.', "User's favourite tea is masala chai."],
    ['I am vegetarian', 'User is vegetarian'],
    ["I'm allergic to peanuts", 'User is allergic to peanuts'],
    ['I’m allergic to peanuts', 'User is allergic to peanuts'],
    ['I have two cats', 'User has two cats'],
    ["I've lived in Toronto", 'User has lived in Toronto'],
    ['I was born in Pune', 'User was born in Pune'],
    ['I like masala chai', 'User likes masala chai'],
    ['i prefer tea over coffee', 'User prefers tea over coffee'],
    ['  I live in Vancouver  ', 'User lives in Vancouver'],
  ])('rewrites the leading first person: %s', (input, expected) => {
    expect(canonicalMemoryVoice(input)).toBe(expected);
  });

  it.each([
    ["User's wife's name is Maya.", "User's wife's name is Maya."],
    ['User is vegetarian.', 'User is vegetarian.'],
    ['user prefers tea.', 'user prefers tea.'],
    ['Italian food is the favourite of the user.', 'Italian food is the favourite of the user.'],
    ['Its battery lasts a day.', 'Its battery lasts a day.'],
  ])('leaves a third-person or non-pronoun opening alone: %s', (input, expected) => {
    expect(canonicalMemoryVoice(input)).toBe(expected);
  });

  it('does not guess a verb form it does not know', () => {
    expect(canonicalMemoryVoice('I go to the gym daily')).toBe('I go to the gym daily');
  });
});

describe('both memory writers carry the canonical style', () => {
  it('the extraction system prompt', () => {
    expect(MEMORY_EXTRACT_SYSTEM_PROMPT).toContain(MEMORY_CONTENT_STYLE);
  });

  it('the remember tool description', () => {
    const tools = createMemoryTools({} as never) as unknown as { remember: { description: string } };
    // Either description set (standard or compact) carries the rule.
    expect(tools.remember.description).toContain('third-person sentence');
  });
});
