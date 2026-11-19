import { describe, expect, it } from 'vitest';
import { isAboutPeople, memoryForReader, memoryForStorage } from './memory-voice';

describe('memoryForReader', () => {
  it.each([
    ['User is vegetarian.', "You're vegetarian."],
    ["User's wife is Sam Example.", 'Your wife is Sam Example.'],
    ["User's wife's name is Alex Example.", "Your wife's name is Alex Example."],
    ['User prefers tea over coffee.', 'You prefer tea over coffee.'],
    ['User has two kids.', 'You have two kids.'],
    ['User watches cricket.', 'You watch cricket.'],
    ['User studies Spanish.', 'You study Spanish.'],
    ['User was born in Exampleville.', 'You were born in Exampleville.'],
    ["I'm allergic to nuts", "You're allergic to nuts"],
    ['My dog is Rex Example', 'Your dog is Rex Example'],
    ['Likes oat milk', 'Likes oat milk'],
    ['The user group meets on Fridays.', 'The user group meets on Fridays.'],
  ])('%s -> %s', (stored, shown) => {
    expect(memoryForReader(stored)).toBe(shown);
  });
});

describe('memoryForStorage', () => {
  it.each([
    ["You're vegan.", 'User is vegan.'],
    ['Your wife is Sam Example.', "User's wife is Sam Example."],
    ['You prefer tea.', 'User prefers tea.'],
    ['You have two kids.', 'User has two kids.'],
    ['Likes oat milk', 'Likes oat milk'],
  ])('%s -> %s', (typed, stored) => {
    expect(memoryForStorage(typed)).toBe(stored);
  });

  it('round-trips the canonical voice', () => {
    for (const stored of ['User is vegetarian.', "User's wife is Sam Example.", 'User prefers tea.']) {
      expect(memoryForStorage(memoryForReader(stored))).toBe(stored);
    }
  });
});

describe('isAboutPeople', () => {
  it('spots people in the person’s life, not ordinary facts', () => {
    expect(isAboutPeople("User's wife is Sam Example.")).toBe(true);
    expect(isAboutPeople("User's sister is Alex Example.")).toBe(true);
    expect(isAboutPeople('User is vegetarian.')).toBe(false);
  });
});
