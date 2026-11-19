import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from 'yaml';

/*
 * check-skills.mjs — fail when a tracked repo skill (SKILL.md under
 * .claude/skills/) would not load.
 *
 * Each skill must open with a --- front matter block that parses as YAML, with
 * string name and description, name equal to its folder, a description under
 * 1024 characters, and no CR characters. An unquoted description containing
 * ': ' is invalid YAML, and a CRLF checkout copied to ~/.claude/skills shows
 * agents only the heading, so the skill silently stops triggering.
 *
 * checkSkill (path + text -> problems) is exported for the scripts Vitest suite
 * (`npm run test:scripts`); the CLI runs only when this file is the entry point.
 */

const ROOT = resolve(import.meta.dirname, '..');
const SKILL_DIRS = ['.claude/skills'];
const MAX_DESCRIPTION = 1024;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/;

// Pure checker: returns one message per problem, [] when the skill is valid.
export function checkSkill(path, text) {
  const problems = [];
  if (text.includes('\r')) problems.push('contains CR characters (use LF line endings)');
  const block = FRONT_MATTER.exec(text);
  if (!block) return [...problems, 'does not start with a --- front matter block'];
  let meta;
  try {
    meta = parse(block[1]);
  } catch (error) {
    return [...problems, `front matter does not parse: ${error.message.split('\n')[0]}`];
  }
  const { name, description } = meta && typeof meta === 'object' ? meta : {};
  const folder = basename(dirname(path));
  if (typeof name !== 'string') problems.push('name is missing or not a string');
  else if (name !== folder) problems.push(`name "${name}" does not match folder "${folder}"`);
  if (typeof description !== 'string') problems.push('description is missing or not a string');
  else if (description.length >= MAX_DESCRIPTION) {
    problems.push(`description is ${description.length} characters (must be under ${MAX_DESCRIPTION})`);
  }
  return problems;
}

// Checks every tracked SKILL.md; failures are "path: reason" lines.
export function checkRepo(root = ROOT) {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...SKILL_DIRS], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const files = listed.stdout.split('\0').filter((file) => file.endsWith('/SKILL.md'));
  const failures = files.flatMap((file) =>
    checkSkill(file, readFileSync(resolve(root, file), 'utf8')).map((problem) => `${file}: ${problem}`));
  return { count: files.length, failures };
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const { count, failures } = checkRepo();
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log(`skills: ok (${count} skills)`);
}
