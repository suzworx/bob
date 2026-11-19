// Supabase config guard: every hosted setting is declared in supabase/config.toml. Pinned: the
// production remote sends through the Bob SMTP mailbox as "Bob", runs the Send Email Hook and every
// security notification; the base (local/CI) stack keeps both off so `supabase start` needs no
// secrets; every template file exists; every function has a [functions.<name>] block; and no
// secret is written inline. Key names were checked against Supabase CLI 2.117 with `supabase status`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROD = 'remotes.production';
const PROJECT_REF = 'abcdefghijklmnopqrst';
const NOTIFICATIONS = [
  'password_changed', 'email_changed', 'phone_changed', 'identity_linked',
  'identity_unlinked', 'mfa_factor_enrolled', 'mfa_factor_unenrolled',
];
// Wave 2 (CATALOG) generates supabase/templates/* from the email catalog.
const CATALOG_LANDED = existsSync(join(ROOT, 'supabase/functions/_shared/email/catalog.ts'));

type Value = string | number | boolean;
type Tables = Map<string, Map<string, Value>>;

// Just enough TOML for this file: [tables], and one-line `key = value` with strings, numbers,
// booleans (arrays are kept as raw text). Comments outside strings are dropped.
function parseToml(text: string): Tables {
  const tables: Tables = new Map([['', new Map()]]);
  let current = tables.get('') as Map<string, Value>;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/("(?:[^"\\]|\\.)*")|#.*$/g, (m, str: string | undefined) => str ?? '').trim();
    const header = /^\[([^[\]]+)\]$/.exec(line);
    const setting = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (header) {
      const name = (header[1] ?? '').trim();
      current = tables.get(name) ?? new Map();
      tables.set(name, current);
    } else if (setting) {
      const value = (setting[2] ?? '').trim();
      const str = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
      if (str) current.set(setting[1] ?? '', JSON.parse(`"${str[1] ?? ''}"`) as string);
      else if (value === 'true' || value === 'false') current.set(setting[1] ?? '', value === 'true');
      else if (/^-?\d+$/.test(value)) current.set(setting[1] ?? '', Number(value));
      else current.set(setting[1] ?? '', value);
    }
  }
  return tables;
}

const SECRET_KEY = /(^|_)(pass|password|secret|secrets|token|api_key|secret_key|access_key|auth_token)$/;
const isEnvRef = (v: Value): boolean => typeof v === 'string' && /^env\([A-Z0-9_]+\)$/.test(v);

function inlineSecrets(tables: Tables): string[] {
  const out: string[] = [];
  for (const [table, entries] of tables)
    for (const [key, value] of entries)
      if (SECRET_KEY.test(key) && value !== '' && !isEnvRef(value)) out.push(`[${table}] ${key} is inline`);
  return out;
}

const contentPaths = (tables: Tables): string[] =>
  [...tables.values()].flatMap((t) => (typeof t.get('content_path') === 'string' ? [t.get('content_path') as string] : []));

const config = parseToml(readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8'));
const table = (name: string): Map<string, Value> => config.get(name) ?? new Map();

describe('supabase config: production remote', () => {
  it('targets the hosted project and stays invite-only', () => {
    expect(table(PROD).get('project_id')).toBe(PROJECT_REF);
    expect(table(`${PROD}.auth`).get('enable_signup')).toBe(false);
  });
  it('sends auth mail through the one Bob SMTP mailbox, as "Bob"', () => {
    const smtp = table(`${PROD}.auth.email.smtp`);
    expect(Object.fromEntries(smtp)).toMatchObject({
      enabled: true, host: 'smtp.purelymail.com', port: 465, sender_name: 'Bob',
      user: 'env(BOB_SMTP_USERNAME)', pass: 'env(BOB_SMTP_PASSWORD)', admin_email: 'env(BOB_SMTP_FROM)',
    });
  });
  it('enables the Send Email Hook on the production send-email function', () => {
    const hook = table(`${PROD}.auth.hook.send_email`);
    expect(hook.get('enabled')).toBe(true);
    expect(hook.get('uri')).toBe(`https://${PROJECT_REF}.supabase.co/functions/v1/send-email`);
    expect(hook.get('secrets')).toBe('env(SEND_EMAIL_HOOK_SECRET)');
  });
  it('enables every security notification', () => {
    for (const type of NOTIFICATIONS)
      expect(table(`${PROD}.auth.email.notification.${type}`).get('enabled'), type).toBe(true);
  });
});

describe('supabase config: local stack', () => {
  it('keeps SMTP and the hook off so `supabase start` needs no secrets, and names Mailpit mail "Bob"', () => {
    expect(table('auth.email.smtp').get('enabled') ?? false).toBe(false);
    expect(table('auth.hook.send_email').get('enabled') ?? false).toBe(false);
    expect(table('local_smtp').get('sender_name')).toBe('Bob');
  });
});

describe('supabase config: templates', () => {
  const expected = [
    'invite', 'confirmation', 'magic_link', 'recovery', 'email_change', 'reauthentication',
    ...NOTIFICATIONS.map((type) => `${type}_notification`),
  ].map((name) => `./supabase/templates/${name}.html`);

  it('points every content_path at a file under supabase/templates/', () => {
    expect(contentPaths(config).sort()).toEqual([...expected].sort());
  });
  it.skipIf(!CATALOG_LANDED)('has every content_path file on disk (skipped until CATALOG generates them)', () => {
    expect(expected.filter((path) => !existsSync(join(ROOT, path)))).toEqual([]);
  });
});

describe('supabase config: functions and secrets', () => {
  it('declares a [functions.<name>] block for every edge function', () => {
    const dir = join(ROOT, 'supabase/functions');
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '_shared')
      .map((e) => e.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !config.has(`functions.${name}`))).toEqual([]);
  });
  it('writes no secret inline', () => {
    expect(inlineSecrets(config)).toEqual([]);
    expect(readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8')).not.toMatch(/whsec_[A-Za-z0-9+/=]{8,}/);
  });
});

describe('supabase config: the checkers can fail', () => {
  it('parses tables, values and trailing comments, ignoring # inside strings', () => {
    const t = parseToml('a = 1\n[x.y]\nb = "p#q" # c\nc = true\n# d = 2\n');
    expect(Object.fromEntries(t.get('') ?? [])).toEqual({ a: 1 });
    expect(Object.fromEntries(t.get('x.y') ?? [])).toEqual({ b: 'p#q', c: true });
  });
  it('reports inline secrets but accepts env(...) and empty values', () => {
    const t = parseToml('[s]\npass = "hunter2"\nsecrets = "env(X)"\nsecret = ""\nauth_token = "abc"\n');
    expect(inlineSecrets(t)).toEqual(['[s] pass is inline', '[s] auth_token is inline']);
  });
});
