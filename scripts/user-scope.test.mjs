import { describe, expect, it } from 'vitest';
import { buildSql, run } from './user-scope.mjs';

const EMAIL = 'someone@example.com';
const SCOPE = 'metrics.operator';

function harness(answer = '{"rows":[{"x":true}]}') {
  const calls = [];
  const lines = [];
  const runSupabase = (args) => {
    calls.push(args);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const go = (argv) => run(argv, { runSupabase, log: (l) => lines.push(l) });
  return { calls, lines, go };
}

describe('statements', () => {
  it('builds exactly the three fixed statements', () => {
    expect(buildSql('list', EMAIL)).toBe(`select bob_private.user_scopes_for_email('${EMAIL}')`);
    expect(buildSql('grant', EMAIL, SCOPE)).toBe(`select bob_private.grant_user_scope_by_email('${EMAIL}', '${SCOPE}')`);
    expect(buildSql('revoke', EMAIL, SCOPE)).toBe(`select bob_private.revoke_user_scope_by_email('${EMAIL}', '${SCOPE}')`);
  });

  it('runs each subcommand through the supabase CLI for the chosen target', () => {
    const list = harness('{"rows":[{"user_scopes_for_email":["metrics.operator","x.y"]}]}');
    expect(list.go(['list', '--email', EMAIL, '--local'])).toBe(0);
    expect(list.calls).toEqual([['db', 'query', '--local', buildSql('list', EMAIL)]]);
    expect(list.lines).toEqual(['metrics.operator', 'x.y']);

    const grant = harness('{"rows":[{"grant_user_scope_by_email":true}]}');
    expect(grant.go(['grant', '--email', EMAIL, '--scope', SCOPE, '--yes', '--linked'])).toBe(0);
    expect(grant.calls).toEqual([['db', 'query', '--linked', buildSql('grant', EMAIL, SCOPE)]]);
    expect(grant.lines).toEqual(['granted']);

    const revoke = harness('{"rows":[{"revoke_user_scope_by_email":false}]}');
    expect(revoke.go(['revoke', '--email', EMAIL, '--scope', SCOPE, '--yes', '--local'])).toBe(0);
    expect(revoke.lines).toEqual(['did not have it']);
  });

  it('prints the other two fixed phrases', () => {
    const again = harness('{"rows":[{"g":false}]}');
    again.go(['grant', '--email', EMAIL, '--scope', SCOPE, '--yes', '--local']);
    expect(again.lines).toEqual(['already had it']);
    const gone = harness('{"rows":[{"r":true}]}');
    gone.go(['revoke', '--email', EMAIL, '--scope', SCOPE, '--yes', '--local']);
    expect(gone.lines).toEqual(['revoked']);
  });
});

describe('validation before any call', () => {
  const BAD_EMAILS = ["a'b@example.com", 'a;b@example.com', 'a b@example.com', 'a\\b@example.com', 'a"b@example.com', 'plain', 'a@b@c'];
  const BAD_SCOPES = ["x'y", 'a;b', 'a b', 'a\\b', 'Upper', '1abc', 'a', ''];

  it.each(BAD_EMAILS)('rejects the email %s', (email) => {
    const h = harness();
    expect(h.go(['list', '--email', email, '--local'])).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.lines.join('\n')).not.toContain(email);
  });

  it.each(BAD_SCOPES)('rejects the scope %j', (scope) => {
    const h = harness();
    expect(h.go(['grant', '--email', EMAIL, '--scope', scope, '--yes', '--local'])).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('refuses grant and revoke without --yes', () => {
    for (const verb of ['grant', 'revoke']) {
      const h = harness();
      expect(h.go([verb, '--email', EMAIL, '--scope', SCOPE, '--local'])).toBe(2);
      expect(h.calls).toEqual([]);
    }
  });

  it('refuses without --local or --linked, with both, and on unknown input', () => {
    for (const argv of [
      ['list', '--email', EMAIL],
      ['list', '--email', EMAIL, '--local', '--linked'],
      ['list', '--email', EMAIL, '--local', '--nope'],
      ['frobnicate', '--email', EMAIL, '--local'],
      ['list', '--local'],
    ]) {
      const h = harness();
      expect(h.go(argv)).toBe(2);
      expect(h.calls).toEqual([]);
    }
  });

  it('prints help and exits 0 without a call', () => {
    const h = harness();
    expect(h.go(['--help'])).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.lines.join('\n')).toContain('SEND_EMAIL_HOOK_SECRET');
  });
});

describe('database errors', () => {
  it('never echoes the email or the raw message', () => {
    const h = harness(new Error(`ERROR: unknown_account for ${EMAIL}`));
    expect(h.go(['grant', '--email', EMAIL, '--scope', SCOPE, '--yes', '--linked'])).toBe(1);
    const out = h.lines.join('\n');
    expect(out).not.toContain(EMAIL);
    expect(out).not.toContain('someone');
  });

  it('points at the throwaway hook secret on a config error', () => {
    const h = harness(new Error('failed to load config: SEND_EMAIL_HOOK_SECRET is unset'));
    expect(h.go(['list', '--email', EMAIL, '--local'])).toBe(1);
    expect(h.lines.join('\n')).toContain('v1,whsec_');
  });

  it('exits 1 on output it cannot read, printing nothing from it', () => {
    const h = harness(`not json ${EMAIL}`);
    expect(h.go(['list', '--email', EMAIL, '--local'])).toBe(1);
    expect(h.lines.join('\n')).not.toContain(EMAIL);
  });
});
