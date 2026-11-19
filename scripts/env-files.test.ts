// Env-file guard: each platform Bob deploys to has a committed .env.<platform>.example that lists
// exactly the names that platform needs. The names are DERIVED from the sources that read them
// (workflows, the Supabase functions and config.toml), not hard-coded
// here: a new secret fails this test until the matching example lists it, and a removed one fails
// it until the example drops it. Values stay empty, because the filled copies (.env.<platform>)
// are git-ignored. Text parsing only, no dependencies.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const uniq = (list: string[]): string[] => [...new Set(list)].sort();
const captures = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1] ?? '');
const codeDefaults = (text: string, re: RegExp): Map<string, string> =>
  new Map([...text.matchAll(re)].map((m): [string, string] => [m[1] ?? '', m[2] ?? '']));

// Non-test sources under dir, joined; Deno tests are *.test.ts or *_test.ts.
function sources(dir: string): string {
  return (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts') && !/[._]test\.ts$/.test(f))
    .map((f) => read(join(dir, f)))
    .join('\n');
}

interface Example { text: string; lines: string[]; active: Map<string, string>; commented: Map<string, string> }

// `NAME=value` lines are live; `# NAME=value` lines are options left off. Prose comments never
// have `=` straight after an upper-case name, so they match neither.
function parseExample(file: string): Example {
  const text = read(file);
  const lines = text.split(/\r?\n/); // a Windows checkout (core.autocrlf) has CRLF
  const active = new Map<string, string>();
  const commented = new Map<string, string>();
  for (const line of lines) {
    const live = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    const off = /^#\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (live) active.set(live[1] ?? '', live[2] ?? '');
    else if (off) commented.set(off[1] ?? '', off[2] ?? '');
  }
  return { text, lines, active, commented };
}
const names = (m: Map<string, string>): string[] => [...m.keys()].sort();

const github = parseExample('.env.github.example');
const supabase = parseExample('.env.supabase.example');

// GitHub: `${{ secrets.X }}` / `${{ vars.X }}` reads. Comment lines may mention a name; only
// real reads count. GITHUB_TOKEN is minted for every run, so there is nothing to store.
const workflows = readdirSync(join(ROOT, '.github/workflows'))
  .filter((f) => /\.ya?ml$/.test(f))
  .flatMap((f) => read(`.github/workflows/${f}`).split('\n'))
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');
const workflowNames = (kind: 'secrets' | 'vars'): string[] =>
  uniq(captures(workflows, new RegExp(`\\b${kind}\\.([A-Z][A-Z0-9_]*)`, 'g'))).filter((n) => n !== 'GITHUB_TOKEN');

// Supabase: what the functions read, plus the env(...) refs `config push` resolves.
const INJECTED = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL']; // Supabase sets these itself
// env(...) refs in config.toml that sit only in commented-out or disabled sections (Studio's
// OpenAI key, Twilio, Apple, S3 storage, the SECRET_VALUE placeholder); config push never reads them.
const CONFIG_UNUSED = [
  'OPENAI_API_KEY', 'S3_ACCESS_KEY', 'S3_HOST', 'S3_REGION', 'S3_SECRET_KEY', 'SECRET_VALUE',
  'SUPABASE_AUTH_EXTERNAL_APPLE_SECRET', 'SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN',
];
const functionSources = sources('supabase/functions');
const requiredNames = captures(functionSources, /\brequired\("([A-Z][A-Z0-9_]*)"\)/g);
const configNames = captures(read('supabase/config.toml'), /env\(([A-Z][A-Z0-9_]*)\)/g).filter(
  (n) => !CONFIG_UNUSED.includes(n),
);
const supabaseNames = uniq([
  ...requiredNames, ...configNames, ...captures(functionSources, /Deno\.env\.get\("([A-Z][A-Z0-9_]*)"\)/g),
]).filter((n) => !INJECTED.includes(n));
const supabaseDefaults = codeDefaults(functionSources, /Deno\.env\.get\("([A-Z][A-Z0-9_]*)"\)\s*\?\?\s*"([^"]*)"/g);
const PLATFORMS: [string, Example, Map<string, string>][] = [
  ['github', github, new Map()],
  ['supabase', supabase, supabaseDefaults],
];

describe.each(PLATFORMS)('.env.%s.example', (platform, example, defaults) => {
  it('keeps every value empty', () => {
    expect([...example.active].filter(([, value]) => value !== '')).toEqual([]);
  });

  it('comments out an option only empty or with the default the code uses', () => {
    for (const [name, value] of example.commented) {
      expect(value === '' || value === defaults.get(name), `${name}=${value}`).toBe(true);
    }
  });

  it('explains every variable on the line above it', () => {
    example.lines.forEach((line, i) => {
      if (/^[A-Z][A-Z0-9_]*=/.test(line)) expect(example.lines[i - 1]?.startsWith('#'), line).toBe(true);
    });
  });

  it('opens with the copy-and-apply instructions', () => {
    expect(example.text).toMatch(/^# Apply:/m);
    expect(example.text).toContain(`cp .env.${platform}.example .env.${platform}`);
  });
});

describe('.env.github.example', () => {
  it('lists exactly the secrets the workflows read', () => {
    expect(names(github.active)).toEqual(workflowNames('secrets'));
  });

  it('gives each repository variable its own gh command, not a secret line', () => {
    const comments = github.lines.filter((line) => line.startsWith('#')).join('\n');
    expect(uniq(captures(comments, /gh variable set ([A-Z][A-Z0-9_]*)/g))).toEqual(workflowNames('vars'));
    expect(names(github.active).filter((n) => workflowNames('vars').includes(n))).toEqual([]);
  });
});

describe('.env.supabase.example', () => {
  it('covers every secret the functions and config.toml require', () => {
    const needed = uniq([...requiredNames, ...configNames]).filter((n) => !INJECTED.includes(n));
    expect(names(supabase.active)).toEqual(expect.arrayContaining(needed));
  });

  it('comments out every other name a function reads', () => {
    expect(names(supabase.commented)).toEqual(supabaseNames.filter((n) => !supabase.active.has(n)));
  });

  it('says not to set the names Supabase injects', () => {
    for (const name of INJECTED) {
      expect(supabase.text).toContain(name);
      expect(supabase.active.has(name) || supabase.commented.has(name), name).toBe(false);
    }
  });

});

describe('.gitignore', () => {
  const lines = read('.gitignore').split('\n').map((line) => line.trim());

  it('ignores each filled platform file and never its template', () => {
    for (const [platform] of PLATFORMS) {
      expect(lines, platform).toContain(`.env.${platform}`);
      expect(lines, platform).not.toContain(`.env.${platform}.example`);
    }
    expect(lines.filter((line) => line.startsWith('.env') && line.includes('*'))).toEqual([]);
  });
});
