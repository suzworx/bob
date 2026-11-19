import { describe, expect, it } from 'vitest';
import { checkRepo, checkSkill } from './check-skills.mjs';

const PATH = '.claude/skills/bob-test/SKILL.md';
const skill = (frontMatter, body = '# Heading\n\nBody.\n') => `---\n${frontMatter}\n---\n\n${body}`;

describe('checkSkill', () => {
  it('passes a quoted description that contains ": "', () => {
    const text = skill('name: bob-test\ndescription: "Bob: test. Use when writing tests: unit, e2e."');
    expect(checkSkill(PATH, text)).toEqual([]);
  });

  it('fails an unquoted description that contains ": "', () => {
    const text = skill('name: bob-test\ndescription: Bob: test. Use when writing tests: unit, e2e.');
    const problems = checkSkill(PATH, text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/front matter does not parse/);
  });

  it('fails CRLF line endings', () => {
    const text = skill('name: bob-test\ndescription: Writes tests.').replace(/\n/g, '\r\n');
    expect(checkSkill(PATH, text)).toContain('contains CR characters (use LF line endings)');
  });

  it('fails a name that does not match the folder', () => {
    const text = skill('name: bob-tests\ndescription: Writes tests.');
    expect(checkSkill(PATH, text)).toEqual(['name "bob-tests" does not match folder "bob-test"']);
  });

  it('fails a file with no front matter block', () => {
    expect(checkSkill(PATH, '# Bob: test\n\nname: bob-test\n')).toEqual(['does not start with a --- front matter block']);
  });

  it('fails an unterminated front matter block', () => {
    expect(checkSkill(PATH, '---\nname: bob-test\ndescription: Writes tests.\n')).toEqual(['does not start with a --- front matter block']);
  });

  it('fails a missing or non-string name and description', () => {
    expect(checkSkill(PATH, skill('name: bob-test'))).toEqual(['description is missing or not a string']);
    expect(checkSkill(PATH, skill('name: [bob-test]\ndescription: Writes tests.'))).toEqual(['name is missing or not a string']);
  });

  it('fails a description of 1024 characters or more', () => {
    const long = skill(`name: bob-test\ndescription: ${'a'.repeat(1024)}`);
    expect(checkSkill(PATH, long)).toEqual(['description is 1024 characters (must be under 1024)']);
    expect(checkSkill(PATH, skill(`name: bob-test\ndescription: ${'a'.repeat(1023)}`))).toEqual([]);
  });
});

describe('checkRepo', () => {
  it('passes every tracked skill in this repo', () => {
    const { count, failures } = checkRepo();
    expect(failures).toEqual([]);
    expect(count).toBeGreaterThan(0);
  });
});
