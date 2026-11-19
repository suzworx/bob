import { describe, expect, it } from 'vitest';
import { SECRET_ENV_NAMES, scanSecrets, secretPatterns } from './validate.mjs';

// The scan runs over the staged diff, so this very file is scanned when it is
// staged. Every positive fixture is therefore assembled at runtime from inert
// fragments — no literal in this file may itself match a pattern. Negative
// fixtures use the exact placeholders the 008 contracts already carry.

// Runtime-only builders — every fragment below is inert on its own.
const sbKey = 'sb' + '_secret_' + 'A'.repeat(20);
const olxdOk = 'olxd' + '_' + 'A'.repeat(43);
const olxd44 = 'olxd' + '_' + 'A'.repeat(44);
const olxd42 = 'olxd' + '_' + 'A'.repeat(42);
const olxdPlaceholder = 'olxd' + '_' + '<43 base64url chars>';
const pgOk = 'postgresql://' + 'bob_server' + ':' + 'dev-only' + '@db.example.com:5432/bob';
const pgShortPass = 'postgresql://' + 'u' + ':' + 'abcde' + '@h';
const pgYourPassword = 'postgresql://' + 'u' + ':' + 'your_password' + '@h';
const pgBracketed = 'postgresql://' + 'u' + ':' + '[YOUR-PASSWORD]' + '@h';
const pgAngled = 'postgresql://' + 'u' + ':' + '<password>' + '@h';
const dbUrlReal = 'BOB_DATABASE_URL=' + 'postgresql://' + 'bob_server' + ':' + 'realpassword' + '@db.example.com:5432/bob';
const secretKeyReal = 'SUPABASE_SECRET_KEY=' + 'sb' + '_secret_' + 'B'.repeat(20);
const dbPasswordReal = 'SUPABASE_DB_PASSWORD=' + 'p'.repeat(16);
const deviceSecretReal = 'DEVICE_SHARED_SECRET=' + 'd'.repeat(20);
const smtpPassReal = 'SMTP_PASS=' + 's'.repeat(16);
const langfuseReal = 'LANGFUSE_SECRET_KEY=' + 's'.repeat(16);

// findPattern returns the single exported pattern whose source contains the
// fragment, so the tests target each new pattern by identity, not array index.
function findPattern(fragment) {
  const found = secretPatterns.filter((p) => p.source.includes(fragment));
  if (found.length !== 1) throw new Error(`expected 1 pattern with '${fragment}', found ${found.length}`);
  return found[0];
}

describe('secret scan — Supabase secret keys', () => {
  const pattern = findPattern('sb_secret_');
  it('flags an sb_secret_ key of 20+ chars', () => {
    expect(pattern.test(sbKey)).toBe(true);
    expect(scanSecrets(sbKey).length).toBeGreaterThan(0);
  });
  it('does not flag a short or absent value', () => {
    expect(pattern.test('sb' + '_secret_' + 'A'.repeat(19))).toBe(false);
    expect(pattern.test('sb' + '_secret_' + '')).toBe(false);
  });
});

describe('secret scan — Bob device tokens', () => {
  const pattern = findPattern('olxd_');
  it('flags an olxd_ token of exactly 43 base64url chars', () => {
    expect(pattern.test(olxdOk)).toBe(true);
    expect(scanSecrets(olxdOk).length).toBeGreaterThan(0);
  });
  it('rejects 42, 44, and the <43 base64url chars> placeholder', () => {
    expect(pattern.test(olxd42)).toBe(false);
    expect(pattern.test(olxd44)).toBe(false);
    expect(pattern.test(olxdPlaceholder)).toBe(false);
  });
});

describe('secret scan — Postgres URLs with an inline password', () => {
  const pattern = findPattern('[^:\\s@\\/]+:');
  it('flags a postgresql URL that embeds a password', () => {
    expect(pattern.test(pgOk)).toBe(true);
    expect(scanSecrets(pgOk).length).toBeGreaterThan(0);
  });
  it('flags the postgres scheme without the ql suffix', () => {
    expect(pattern.test('postgres://' + 'u' + ':' + 'secret1' + '@h')).toBe(true);
  });
  it('rejects short and placeholder passwords', () => {
    expect(pattern.test(pgShortPass)).toBe(false);
    expect(pattern.test(pgYourPassword)).toBe(false);
    expect(pattern.test(pgBracketed)).toBe(false);
    expect(pattern.test(pgAngled)).toBe(false);
  });
  it('rejects loopback hosts (127.0.0.1, localhost, [::1]) even with a password', () => {
    expect(pattern.test('postgresql://' + 'u' + ':' + 'secret1' + '@127.0.0.1:5432/db')).toBe(false);
    expect(pattern.test('postgresql://' + 'u' + ':' + 'secret1' + '@localhost:5432/db')).toBe(false);
    expect(pattern.test('postgresql://' + 'u' + ':' + 'secret1' + '@[::1]:5432/db')).toBe(false);
  });
  it('still matches a pooler host with a real-looking password', () => {
    const pooler = 'postgresql://' + 'bob_server' + ':' + 'realpassword' + '@aws-0-ca-central-1.pooler.supabase.com:5432/postgres';
    expect(pattern.test(pooler)).toBe(true);
    expect(scanSecrets(pooler).length).toBeGreaterThan(0);
  });
  it('rejects the exact 008 example (bob_server user, <password> placeholder)', () => {
    const example = 'postgresql://bob_server.<project-ref>:<password>@aws-0-ca-central-1.pooler.supabase.com:5432/postgres';
    expect(pattern.test(example)).toBe(false);
    expect(scanSecrets(example)).toEqual([]);
  });
});

describe('secret scan — named env vars bound to real values', () => {
  const pattern = findPattern('BOB_DATABASE_URL');
  it('flags each new env name bound to a real-looking value', () => {
    expect(scanSecrets(dbUrlReal).some((p) => p === pattern)).toBe(true);
    expect(pattern.test(dbUrlReal)).toBe(true);
    expect(pattern.test(secretKeyReal)).toBe(true);
    expect(pattern.test(dbPasswordReal)).toBe(true);
    expect(pattern.test(deviceSecretReal)).toBe(true);
    expect(pattern.test(smtpPassReal)).toBe(true);
    expect(pattern.test(langfuseReal)).toBe(true);
  });
  it('rejects placeholder-bound values (your_, placeholder, example, leading <)', () => {
    expect(pattern.test('BOB_DATABASE_URL=' + '<your-url-here>')).toBe(false);
    expect(pattern.test('SUPABASE_SECRET_KEY=' + 'your_supabase_secret')).toBe(false);
    expect(pattern.test('DEVICE_SHARED_SECRET=' + 'placeholder_secret_value')).toBe(false);
    expect(pattern.test('SMTP_PASS=' + 'example_smtp_password')).toBe(false);
    expect(pattern.test('SUPABASE_DB_PASSWORD=' + '[YOUR-PASSWORD]')).toBe(false);
    expect(pattern.test('LANGFUSE_SECRET_KEY=' + 'your_langfuse_secret_key')).toBe(false);
    expect(pattern.test('LANGFUSE_SECRET_KEY=' + '<key>')).toBe(false);
  });
  it('does not flag an BOB_DATABASE_URL whose value is a loopback postgres URL', () => {
    expect(pattern.test('BOB_DATABASE_URL=' + 'postgresql://' + 'bob_server' + ':' + 'dev-only' + '@127.0.0.1:54322/postgres')).toBe(false);
    expect(pattern.test('BOB_DATABASE_URL=' + 'postgres://' + 'u' + ':' + 'secret1' + '@localhost:5432/db')).toBe(false);
    expect(pattern.test('BOB_DATABASE_URL=' + 'postgresql://' + 'u' + ':' + 'secret1' + '@[::1]:5432/db')).toBe(false);
  });
  it('still flags an BOB_DATABASE_URL whose value is a pooler postgres URL', () => {
    const pooler = 'BOB_DATABASE_URL=' + 'postgresql://' + 'bob_server' + ':' + 'realpassword' + '@aws-0-ca-central-1.pooler.supabase.com:5432/postgres';
    expect(pattern.test(pooler)).toBe(true);
  });
  it('rejects a value containing an angle-bracket placeholder segment', () => {
    const doc = 'BOB_DATABASE_URL=' + 'postgresql://' + 'bob_server.' + '<project-ref>' + ':' + '<your-password>' + '@' + '<host>' + ':5432/postgres';
    expect(pattern.test(doc)).toBe(false);
  });
  it('does not flag property access such as process.env.NAME = value', () => {
    const code = 'process.env.' + 'BOB_DATABASE_URL' + ' = ' + 'integrationUrl' + '!';
    expect(pattern.test(code)).toBe(false);
  });
  it('flags dotenv-style KEY=value, export KEY=value, and ENV KEY=value', () => {
    const pooler = 'BOB_DATABASE_URL=' + 'postgresql://' + 'bob_server' + ':' + 'realpassword' + '@aws-0-ca-central-1.pooler.supabase.com:5432/postgres';
    expect(pattern.test(pooler)).toBe(true);
    expect(pattern.test('export ' + 'LANGFUSE_SECRET_KEY=' + 'sklf'.repeat(8))).toBe(true);
    expect(pattern.test('ENV ' + 'DEVICE_SHARED_SECRET=' + 'd'.repeat(20))).toBe(true);
  });
  it('rejects empty or short values', () => {
    expect(pattern.test('DEVICE_SHARED_SECRET=')).toBe(false);
    expect(pattern.test('SMTP_PASS=' + 'x'.repeat(15))).toBe(false);
  });
});

describe('secret scan — Supabase personal access tokens', () => {
  const pattern = findPattern('sbp_');
  it('flags an sbp_ token of 40 hex chars', () => {
    expect(pattern.test('sb' + 'p_' + 'a1'.repeat(20))).toBe(true);
  });
  it('rejects a short or non-hex token', () => {
    expect(pattern.test('sb' + 'p_' + 'a'.repeat(39))).toBe(false);
    expect(pattern.test('sb' + 'p_' + '<your-access-token>')).toBe(false);
  });
});

describe('secret scan — Supabase publishable keys', () => {
  it('does not flag sb_publishable_ keys, which ship in the browser', () => {
    expect(scanSecrets('sb' + '_publishable_' + 'A'.repeat(30))).toEqual([]);
  });
});

describe('secret scan — dp.* service tokens', () => {
  const pattern = findPattern('dp\\.');
  it('flags service, CLI, personal and service-account tokens', () => {
    for (const kind of ['st', 'ct', 'pt', 'sa']) {
      expect(pattern.test('dp' + '.' + kind + '.' + 'prd.' + 'Z'.repeat(40))).toBe(true);
    }
  });
  it('rejects short, unknown-kind and embedded lookalikes', () => {
    expect(pattern.test('dp' + '.st.' + 'Z'.repeat(19))).toBe(false);
    expect(pattern.test('dp' + '.xx.' + 'Z'.repeat(40))).toBe(false);
    expect(pattern.test('ad' + 'p.st.' + 'Z'.repeat(40))).toBe(false);
    expect(pattern.test('dp' + '.st.' + '<token>')).toBe(false);
  });
});

describe('secret scan — every SECRET_ENV_NAMES entry', () => {
  it('has no duplicates', () => {
    expect(new Set(SECRET_ENV_NAMES).size).toBe(SECRET_ENV_NAMES.length);
  });
  it('flags each name bound to a real-looking value', () => {
    for (const name of SECRET_ENV_NAMES) {
      expect(scanSecrets(name + '=' + 'r3al'.repeat(5)).length, name).toBeGreaterThan(0);
    }
  });
  it('rejects placeholders and shell or CI references', () => {
    for (const name of SECRET_ENV_NAMES) {
      expect(scanSecrets(name + '=' + 'your_' + 'value_goes_here'), name).toEqual([]);
      expect(scanSecrets(name + '=' + '<' + 'value>'), name).toEqual([]);
      expect(scanSecrets(name + '=' + '"${' + name + '}"'), name).toEqual([]);
      expect(scanSecrets(name + '=' + '$(openssl rand -hex 32)'), name).toEqual([]);
    }
  });
});

describe('secret scan — existing patterns are unchanged', () => {
  it('still flags the legacy Gateway/OpenRouter key shape', () => {
    expect(scanSecrets('sk-or-v1-' + 'A'.repeat(20)).length).toBeGreaterThan(0);
  });
});