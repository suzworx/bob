import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/*
 * user-scope.mjs — the admin CLI for user scopes (bob.user_scopes): list, grant and revoke a
 * scope for an account by email. It runs SQL as the database admin through the Supabase CLI
 * (`npx supabase db query --linked|--local`), calling only the three fixed bob_private
 * definers with values validated first. All CLI access goes through one injected
 * runSupabase(args) so the Vitest suite never touches a database. grant and revoke need --yes.
 */

const EMAIL_RE = /^[^\s@'";\\]+@[^\s@'";\\]+$/;
const SCOPE_RE = /^[a-z][a-z0-9_.]{1,63}$/;
const USAGE = `Usage: node scripts/user-scope.mjs <list|grant|revoke> --email <email> [--scope <scope>] [--yes] (--local | --linked)
  list    --email <email>                    print the scope names the account holds
  grant   --email <email> --scope <scope>    --yes required; prints granted or already had it
  revoke  --email <email> --scope <scope>    --yes required; prints revoked or did not have it
  --local   the local Supabase stack     --linked   the linked (production) project; one is required
The operator gate scope is metrics.operator; a grant or revoke takes effect within 60 seconds.
If the Supabase CLI fails with a config error about SEND_EMAIL_HOOK_SECRET, export a throwaway
value for this command only (do not save it): SEND_EMAIL_HOOK_SECRET='v1,whsec_<base64>'`;

class UsageError extends Error {}

const quote = (text) => `'${text.replaceAll("'", "''")}'`;

export function buildSql(action, email, scope) {
  if (!EMAIL_RE.test(email ?? '')) throw new UsageError('the email is not valid');
  if (action === 'list') return `select bob_private.user_scopes_for_email(${quote(email)})`;
  if (!SCOPE_RE.test(scope ?? '')) throw new UsageError('the scope must match ^[a-z][a-z0-9_.]{1,63}$');
  if (action === 'grant') return `select bob_private.grant_user_scope_by_email(${quote(email)}, ${quote(scope)})`;
  if (action === 'revoke') return `select bob_private.revoke_user_scope_by_email(${quote(email)}, ${quote(scope)})`;
  throw new UsageError('unknown subcommand');
}

const SWITCHES = { '--yes': 'yes', '--local': 'local', '--linked': 'linked', '--help': 'help', '-h': 'help' };
const VALUES = { '--email': 'email', '--scope': 'scope' };

export function parseArgs(argv) {
  const o = { yes: false, help: false, local: false, linked: false };
  const [first, ...rest] = argv;
  if (first === '--help' || first === '-h') return { ...o, help: true };
  o.action = first;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a in SWITCHES) o[SWITCHES[a]] = true;
    else if (a in VALUES) {
      o[VALUES[a]] = rest[++i];
      if (o[VALUES[a]] === undefined) throw new UsageError(`${a} needs a value`);
    } else throw new UsageError('unknown argument');
  }
  return o;
}

export const defaultRunSupabase = (args) => {
  const r = spawnSync('npx', ['supabase', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${r.stderr ?? ''}`);
  return r.stdout;
};

function firstValue(stdout) {
  const parsed = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  const row = rows?.[0];
  if (row === undefined) throw new Error('no row');
  return Object.values(row)[0];
}

const isTrue = (v) => v === true || v === 't' || v === 'true';
const toNames = (v) => {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : null;
  if (list === null || !list.every((n) => typeof n === 'string' && SCOPE_RE.test(n))) throw new Error('bad list');
  return list;
};

function failure(error) {
  const text = error instanceof Error ? error.message : '';
  if (/SEND_EMAIL_HOOK_SECRET/.test(text)) {
    return "the Supabase CLI could not load its config: export a throwaway SEND_EMAIL_HOOK_SECRET='v1,whsec_<base64>' for this command";
  }
  if (/unknown_account/.test(text)) return 'no account has that email';
  return 'the database command failed';
}

function resolve(argv) {
  const o = parseArgs(argv);
  if (o.help) return { help: true };
  if (o.local === o.linked) throw new UsageError('exactly one of --local or --linked is required');
  if (!['list', 'grant', 'revoke'].includes(o.action)) throw new UsageError('unknown subcommand');
  if (o.action === 'list' && o.scope !== undefined) throw new UsageError('list takes no --scope');
  const sql = buildSql(o.action, o.email, o.scope);
  if (o.action !== 'list' && !o.yes) throw new UsageError(`${o.action} changes who can see operator data: add --yes to confirm`);
  return { action: o.action, target: o.local ? '--local' : '--linked', sql };
}

const PHRASES = { grant: ['granted', 'already had it'], revoke: ['revoked', 'did not have it'] };

function report({ action, value }, log) {
  if (action !== 'list') return log(PHRASES[action][isTrue(value) ? 0 : 1]);
  const names = toNames(value);
  for (const name of names.length ? names : ['none']) log(name);
}

export function run(argv, deps = {}) {
  const { runSupabase = defaultRunSupabase, log = console.log } = deps;
  let plan;
  try {
    plan = resolve(argv);
  } catch (error) {
    log(error instanceof UsageError ? `${error.message}\n${USAGE}` : 'the command failed');
    return error instanceof UsageError ? 2 : 1;
  }
  if (plan.help) return log(USAGE), 0;
  try {
    const value = firstValue(runSupabase(['db', 'query', plan.target, plan.sql]));
    if (plan.action === 'list') toNames(value);
    report({ action: plan.action, value }, log);
    return 0;
  } catch (error) {
    log(failure(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(run(process.argv.slice(2)));
