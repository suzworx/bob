// Invite-only guard: fails if Bob ever stops being invite-only. Protects: accounts exist only by
// invitation; invites come from the admin API (auth.admin.*), which ignores the sign-up switches
// checked here. Pinned: (1) supabase/config.toml `[auth]` and `[auth.sms]` enable_signup stay false,
// (2) no web UI calls signUp(), (3) every web UI signInWithOtp() passes `shouldCreateUser: false`,
// (4) `[remotes.production.auth.email]` enable_signup stays true: it is the email PROVIDER switch.
// The hosted value was verified with: npx supabase config diff --project-ref <project-ref>
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_ROOTS = ['apps/ui-v2/src'];
// [auth.email] enable_signup switches the email PROVIDER (sign-in), not sign-up, so it is not closed;
// production must keep it true (PROVIDER_TABLE), or every hosted sign-in fails while the UI says "Check your email".
const CLOSED_TABLES = ['auth', 'auth.sms'];
const PROVIDER_TABLE = 'remotes.production.auth.email';

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;
const expectNone = (v: string[]): void => void expect(v, v.join('\n')).toEqual([]);

// First enable_signup value (and its line) per toml table, ignoring comments.
function signupSwitches(toml: string): Map<string, { value: string; line: number }> {
  const found = new Map<string, { value: string; line: number }>();
  let table = '';
  toml.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('#')) return;
    const header = /^\[\[?([^[\]]+)\]\]?\s*(#.*)?$/.exec(line);
    const setting = /^enable_signup\s*=\s*([^\s#]+)/.exec(line);
    if (header) table = (header[1] ?? '').trim();
    else if (setting && !found.has(table)) found.set(table, { value: setting[1] ?? '', line: i + 1 });
  });
  return found;
}

function signupSwitchViolations(toml: string): string[] {
  const found = signupSwitches(toml);
  return CLOSED_TABLES.flatMap((name) => {
    const entry = found.get(name);
    if (!entry) return [`[${name}] enable_signup is missing (Supabase defaults to true)`];
    return entry.value === 'false' ? [] : [`[${name}] enable_signup = ${entry.value} at line ${entry.line}`];
  });
}

function emailProviderViolations(toml: string): string[] {
  const entry = signupSwitches(toml).get(PROVIDER_TABLE);
  if (entry?.value === 'true') return [];
  const found = entry ? `= ${entry.value} at line ${entry.line}` : 'is missing';
  return [
    `[${PROVIDER_TABLE}] enable_signup ${found}; it must be true: it is the email provider switch ` +
      '(GOTRUE_EXTERNAL_EMAIL_ENABLED), and false breaks all production sign-in',
  ];
}

// Blank comments (keeping length and newlines) so commented-out code is not scanned.
const blankComments = (text: string): string =>
  text
    .replace(/(?<=^|\s)\/\*[\s\S]*?\*\//gm, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(?<=^|\s)\/\/.*$/gm, (c) => ' '.repeat(c.length));

// Index of the `)` matching the `(` at `open`; falls back to 400 characters if unbalanced.
function callEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return Math.min(text.length - 1, open + 400);
}

function sourceViolations(file: string, source: string): string[] {
  const text = blankComments(source);
  const out: string[] = [];
  for (const m of text.matchAll(/\bsignUp\s*\(/g))
    out.push(`${file}:${lineOf(text, m.index ?? 0)} calls signUp(); accounts are created by invite only`);
  for (const m of text.matchAll(/\bsignInWithOtp\s*\(/g)) {
    const start = m.index ?? 0;
    const open = start + m[0].length - 1;
    const call = text.slice(open, callEnd(text, open) + 1);
    if (!/\bshouldCreateUser\s*:\s*false\b/.test(call))
      out.push(`${file}:${lineOf(text, start)} signInWithOtp() without shouldCreateUser: false`);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

describe('invite-only: supabase/config.toml', () => {
  it('keeps [auth] and [auth.sms] enable_signup = false', () => {
    expectNone(signupSwitchViolations(readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8')));
  });
  it('keeps the production email provider on: [remotes.production.auth.email] enable_signup = true', () => {
    expectNone(emailProviderViolations(readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8')));
  });
});

describe('invite-only: web UI sources', () => {
  it('never calls signUp() and always passes shouldCreateUser: false to signInWithOtp()', () => {
    for (const root of UI_ROOTS) expect(sourceFiles(join(ROOT, root)).length).toBeGreaterThan(0);
    const files = UI_ROOTS.flatMap((root) => sourceFiles(join(ROOT, root)));
    expectNone(files.flatMap((f) => sourceViolations(relative(ROOT, f), readFileSync(f, 'utf8'))));
  });
});

describe('invite-only: the checkers can fail', () => {
  const toml = (auth: string, sms: string, email = 'false'): string =>
    `[auth]\nenable_signup = ${auth}\n[auth.email]\nenable_signup = ${email}\n[auth.sms]\nenable_signup = ${sms}\n`;
  const commented = '[auth]\n# enable_signup = true\nenable_signup = false\n[auth.sms]\nenable_signup = false # ok';

  it('accepts closed switches, ignores commented lines, and does not police [auth.email]', () => {
    expect(signupSwitchViolations(toml('false', 'false', 'true'))).toEqual([]);
    expect(signupSwitchViolations(commented)).toEqual([]);
  });
  it('reports an open [auth] or [auth.sms] switch and a missing one', () => {
    expect(signupSwitchViolations(toml('true', 'false'))).toEqual(['[auth] enable_signup = true at line 2']);
    expect(signupSwitchViolations(toml('false', 'true'))).toEqual(['[auth.sms] enable_signup = true at line 6']);
    expect(signupSwitchViolations('[auth]\nenable_signup = false\n')).toEqual([
      expect.stringContaining('[auth.sms] enable_signup is missing'),
    ]);
  });
  it('reports a production email provider that is off or missing', () => {
    const prod = (v: string): string => `[remotes.production.auth.email]\nenable_signup = ${v}\n`;
    expect(emailProviderViolations(prod('true'))).toEqual([]);
    expect(emailProviderViolations(prod('false'))).toEqual([
      expect.stringMatching(/^\[remotes\.production\.auth\.email\] enable_signup = false at line 2; .*breaks all/),
    ]);
    expect(emailProviderViolations(toml('false', 'false', 'true'))).toEqual([expect.stringContaining('is missing')]);
  });
  it('reports signUp() calls with file:line, including destructured ones', () => {
    const call = 'const x = 1;\nawait client.auth.signUp({ email });';
    expect(sourceViolations('a.ts', call)).toEqual([expect.stringMatching(/^a\.ts:2 calls signUp/)]);
    expect(sourceViolations('a.ts', 'const { signUp } = client.auth;\nsignUp({});')).toHaveLength(1);
    expect(sourceViolations('a.ts', '// client.auth.signUp({})\n/* signUp() */')).toEqual([]);
  });
  it('reports signInWithOtp() calls that do not pin shouldCreateUser: false to that call', () => {
    const good = 'auth.signInWithOtp({\n  email,\n  options: { shouldCreateUser: false },\n});';
    const bad = 'auth.signInWithOtp({ email });';
    expect(sourceViolations('b.tsx', good)).toEqual([]);
    expect(sourceViolations('b.tsx', bad)).toEqual([expect.stringMatching(/^b\.tsx:1 signInWithOtp/)]);
    expect(sourceViolations('b.tsx', 'auth.signInWithOtp({ options: { shouldCreateUser: true } });')).toHaveLength(1);
    expect(sourceViolations('b.tsx', `${bad}\n${good}`)).toEqual([expect.stringMatching(/^b\.tsx:1 /)]);
  });
});
