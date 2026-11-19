import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

import { offlineEnvPath } from './offline-env.mjs';

/*
 * dev-offline.mjs — run the whole Bob app with no internet, except the AI.
 *
 * Everything the app needs is local: the Supabase stack in Docker (API 54321,
 * DB 54322, Studio 54323, Mailpit 54324), a per-machine `bob_server`
 * password in data/offline.env (gitignored) re-applied to the role on EVERY
 * start so a reset database heals itself, a confirmed dev user (normally from
 * supabase/seed.sql, otherwise created here through the LOCAL auth admin API),
 * and the dev servers spawned with env overrides that beat the root .env
 * (dotenv never overrides existing vars).
 *
 * Sign-in is by an admin-generated code the script prints (`--code` prints a
 * fresh one): the local email provider is off, so both the OTP and password
 * flows return email_provider_disabled. See "Signing in locally" in
 * docs/deploy.md. The script still keeps a STABLE dev-user password
 * (`BOB_DEV_PASSWORD` in data/offline.env, re-applied to the dev user on
 * every start), so password sign-in starts working as soon as the local
 * email provider is ever enabled; until then the password is maintained but
 * unused, and sign-in stays code-based.
 *
 * Every start also heals a stale local stack: pending migrations are applied
 * and auth.users rows with NULL token columns are repaired, both idempotent.
 *
 * SAFETY: the script refuses to run unless the Supabase API and DB URLs point
 * at 127.0.0.1 / localhost / [::1]. It must never touch a hosted project.
 *
 * Pure helpers (parseArgs, isLoopbackUrl, parseSupabaseEnv, buildDbUrl,
 * buildEnvOverrides, devPairingUrl, findLanIpv4, generateDevPassword,
 * readOfflineSecret, ensureOfflineSecret, overwriteOfflineSecret) plus the
 * async emailSignInEnabled, createSignInCode and ensureDevUser auth calls are
 * exported for the Vitest suite in dev-offline.test.mjs; the main flow only
 * runs when this file is the entry point. The service role key is held in
 * memory only, never written anywhere, and secret values are never printed:
 * the startup log names the offline.env entry that holds the dev password,
 * not the password.
 *
 * `--regen-password` rotates the dev-user password instead of keeping the
 * stored one: a fresh generateDevPassword() overwrites BOB_DEV_PASSWORD in
 * data/offline.env (other lines preserved) and the normal start re-applies
 * it to the dev user through the same ensureDevUser update path. Rotation
 * happens after the loopback check, so it refuses non-loopback Supabase like
 * every other path, and it prints only the secret's location, never the
 * value.
 */

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));
const OFFLINE_ENV = offlineEnvPath(ROOT);
const DEFAULT_DEV_EMAIL = 'dev@bob.local';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const shell = process.platform === 'win32';

// --- pure helpers (tested in dev-offline.test.mjs) -------------------------

/** Parses CLI args: --stop, --status, --stub-ai, --code, --regen-password. */
export function parseArgs(args) {
  return {
    stop: args.includes('--stop'),
    status: args.includes('--status'),
    stubAi: args.includes('--stub-ai'),
    code: args.includes('--code'),
    regenPassword: args.includes('--regen-password'),
  };
}

/** True only for loopback Supabase URLs; refuses anything else (hosted). */
export function isLoopbackUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const host = new URL(value).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/** Parses `npx supabase status -o env` output: `KEY="value"` lines only. */
export function parseSupabaseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)="([^"]*)"$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/** Replaces the DB URL credentials with bob_server + the generated password. */
export function buildDbUrl(dbUrl, password) {
  const url = new URL(dbUrl);
  url.username = 'bob_server';
  url.password = password;
  return url.toString();
}

/**
 * The env overrides handed to dev:all; the publishable key falls back to
 * ANON_KEY. BOB_DEV_PASSWORD is exported so processes under dev:all can
 * sign in with the dev-user password; its value is never logged.
 */
export function buildEnvOverrides(statusEnv, { password, devPassword, lanIp, stubAi }) {
  const env = {
    SUPABASE_URL: statusEnv.API_URL,
    SUPABASE_PUBLISHABLE_KEY: statusEnv.PUBLISHABLE_KEY ?? statusEnv.ANON_KEY,
    BOB_DATABASE_URL: buildDbUrl(statusEnv.DB_URL, password),
    BOB_PUBLIC_SUPABASE_URL: lanSupabaseUrl(statusEnv.API_URL, lanIp),
    BOB_PAIRING_URL: devPairingUrl(lanIp),
  };
  if (devPassword !== undefined) env.BOB_DEV_PASSWORD = devPassword;
  if (stubAi) env.BOB_AI_STUB = '1';
  return env;
}

/**
 * The local Supabase API as a browser on the LAN reaches it: same port, this
 * machine's LAN address instead of loopback. The server keeps the loopback
 * SUPABASE_URL, because that is the issuer local Auth stamps into every token.
 */
export function lanSupabaseUrl(apiUrl, lanIp) {
  const url = new URL(apiUrl);
  url.hostname = lanIp;
  return url.toString().replace(/\/$/, '');
}

/**
 * The 6-digit code from an admin `generate_link` response. GoTrue returns the
 * link properties at the top level; older versions nest them under
 * `properties`. Null when neither carries a code.
 */
export function readSignInCode(body) {
  const code = body?.email_otp ?? body?.properties?.email_otp;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * Makes every GoTrue-scanned token column on auth.users '' where it is NULL.
 * One such row -- an older seed.sql, a test fixture, a hand insert -- fails
 * GET /auth/v1/admin/users for the whole project with "converting NULL to
 * string is unsupported". Same repair as migration 20260917010000, re-run on
 * every start because that migration only fixed the rows present when it ran.
 */
export const AUTH_TOKEN_REPAIR_SQL = `do $$
declare
  col text;
begin
  foreach col in array array[
    'confirmation_token', 'recovery_token', 'email_change',
    'email_change_token_new', 'email_change_token_current',
    'phone_change', 'phone_change_token', 'reauthentication_token'
  ]
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'auth' and table_name = 'users' and column_name = col
    ) then
      execute format('update auth.users set %I = '''' where %I is null', col, col);
    end if;
  end loop;
end;
$$;
`;

/** The pairing page on the local vite dev server, as the Cardputer shows it. */
export function devPairingUrl(lanIp) {
  return `http://${lanIp}:5173/pair`;
}

/**
 * The machine's non-internal IPv4 a phone or laptop on the same network can
 * reach, or null. 192.168.x wins over 10.x, and both over 172.16-31.x: Docker,
 * WSL and Hyper-V adapters sit in 172.x and are not reachable from the LAN.
 */
export function findLanIpv4(interfaces = os.networkInterfaces()) {
  const ranks = [/^192\.168\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./];
  let best = null;
  let bestRank = ranks.length;
  for (const list of Object.values(interfaces)) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const rank = ranks.findIndex((pattern) => pattern.test(iface.address));
      const effective = rank === -1 ? ranks.length : rank;
      if (best === null || effective < bestRank) {
        best = iface.address;
        bestRank = effective;
      }
    }
  }
  return best;
}

/**
 * Checks whether the running local Auth service actually accepts email
 * sign-in, via `GET /auth/v1/settings` (`external.email`). Never throws and
 * never blocks the stack from starting — an unreachable or malformed
 * response is treated as "not confirmed enabled" (false) rather than an
 * error, so callers can print an accurate warning instead of crashing.
 */
export async function emailSignInEnabled(apiUrl, publishableKey) {
  try {
    const res = await fetch(`${apiUrl}/auth/v1/settings`, {
      headers: { apikey: publishableKey },
    });
    if (!res.ok) return false;
    const settings = await res.json();
    return settings?.external?.email === true;
  } catch {
    return false;
  }
}

// --- flow ------------------------------------------------------------------

/** Runs a supabase CLI command and returns the spawnSync result. */
function runSupabase(args, options = {}) {
  return spawnSync(npx, ['supabase', ...args], { cwd: ROOT, encoding: 'utf8', shell, ...options });
}

function checkDocker() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore', shell });
  if (result.error) {
    console.error('[dev-offline] Docker CLI was not found. Install Docker Desktop and start it.');
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error('[dev-offline] Docker daemon is not responding. Start Docker Desktop and wait until it is ready.');
    process.exit(1);
  }
}

function startSupabase() {
  console.log('[dev-offline] starting the local Supabase stack (idempotent)...');
  const result = runSupabase(['start'], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('[dev-offline] `npx supabase start` failed.');
    process.exit(1);
  }
}

function readStatusEnv() {
  const result = runSupabase(['status', '-o', 'env']);
  if (result.status !== 0) {
    console.error('[dev-offline] `npx supabase status -o env` failed. Is the stack running?');
    process.exit(1);
  }
  return parseSupabaseEnv(result.stdout);
}

/**
 * A password the local Auth policy always accepts: at least 10 characters
 * with lower, upper and digit (`minimum_password_length = 10`,
 * `password_requirements = "lower_upper_letters_digits"` in
 * supabase/config.toml). The `aA1` prefix guarantees all three classes, so
 * generation never flakes on a weak draw; the remaining 28 characters carry
 * 168 bits of entropy.
 */
export function generateDevPassword() {
  return `aA1${randomBytes(21).toString('base64url')}`;
}

/**
 * Reads a `KEY=value` line from offline.env text. Null when the text holds
 * no such line, or when the inputs are unusable — never throws, so a first
 * run (no file yet) flows into generation.
 */
export function readOfflineSecret(text, key) {
  if (typeof text !== 'string' || typeof key !== 'string' || key.length === 0) return null;
  const match = text.match(new RegExp(`^${key}=(\\S+)$`, 'm'));
  return match ? match[1] : null;
}

/**
 * Resolves one offline.env secret without touching the disk: the stored
 * value when the file text already holds it, otherwise `password` plus the
 * file text to persist. Pure, so tests cover the read/append logic without
 * touching the real data/offline.env. Existing lines are always preserved;
 * a missing trailing newline is added, never assumed.
 */
export function ensureOfflineSecret(fileText, key, password) {
  const stored = readOfflineSecret(fileText, key);
  if (stored) return { value: stored, text: fileText, dirty: false };
  const line = `${key}=${password}\n`;
  if (typeof fileText !== 'string' || fileText.length === 0) return { value: password, text: line, dirty: true };
  return { value: password, text: fileText + (fileText.endsWith('\n') ? '' : '\n') + line, dirty: true };
}

/**
 * Overwrites one offline.env secret, preserving every other line: the stored
 * line for `key` is replaced with `password`, or appended when the file text
 * holds no such line. Pure, so rotation is tested without touching the real
 * data/offline.env. Always dirty, so callers persist unconditionally.
 */
export function overwriteOfflineSecret(fileText, key, password) {
  const line = `${key}=${password}\n`;
  if (typeof fileText !== 'string' || fileText.length === 0) return { value: password, text: line, dirty: true };
  if (!readOfflineSecret(fileText, key)) {
    return { value: password, text: fileText + (fileText.endsWith('\n') ? '' : '\n') + line, dirty: true };
  }
  const replaced = fileText.replace(new RegExp(`^${key}=\\S+$`, 'm'), `${key}=${password}`);
  return { value: password, text: replaced.endsWith('\n') ? replaced : `${replaced}\n`, dirty: true };
}

/** Loads data/offline.env, resolves `key` through ensureOfflineSecret, persists on change. */
function loadOrStoreOfflineSecret(key, generate) {
  let fileText = null;
  try {
    fileText = readFileSync(OFFLINE_ENV, 'utf8');
  } catch {
    // first run; fall through to generate
  }
  const resolved = ensureOfflineSecret(fileText, key, generate());
  if (resolved.dirty) {
    mkdirSync(dirname(OFFLINE_ENV), { recursive: true });
    writeFileSync(OFFLINE_ENV, resolved.text, { mode: 0o600 });
  }
  return resolved.value;
}

/** Reads a stored per-machine bob_server password, generating one on first run. */
function ensureServerPassword() {
  return loadOrStoreOfflineSecret('BOB_SERVER_PASSWORD', () => randomBytes(24).toString('base64url'));
}

/**
 * Reads the stored per-machine dev-user password, generating one on first
 * run. Same file and format as the server password under a different key,
 * so one secret never invalidates the other.
 */
function ensureDevPassword() {
  return loadOrStoreOfflineSecret('BOB_DEV_PASSWORD', generateDevPassword);
}

/**
 * Rotates the per-machine dev-user password: a fresh generateDevPassword()
 * overwrites BOB_DEV_PASSWORD in data/offline.env. The caller re-applies
 * the returned password through ensureDevUser; the value itself is never
 * logged, only the file that holds it.
 */
function rotateDevPassword() {
  let fileText = null;
  try {
    fileText = readFileSync(OFFLINE_ENV, 'utf8');
  } catch {
    // first run; fall through to generate
  }
  const resolved = overwriteOfflineSecret(fileText, 'BOB_DEV_PASSWORD', generateDevPassword());
  mkdirSync(dirname(OFFLINE_ENV), { recursive: true });
  writeFileSync(OFFLINE_ENV, resolved.text, { mode: 0o600 });
  return resolved.value;
}

/**
 * Applies the bob_server password on the LOCAL DB via `supabase db query
 * --local`. This MUST run on every start, not only when the password is first
 * generated: a `supabase db reset` (or stop --no-backup + start) recreates the
 * role from migration:13 with NO password, while data/offline.env still holds
 * the one the server connects with, and every request then fails `password
 * authentication failed for user "bob_server"` as a PostgresError and a 500.
 * Re-applying it unconditionally makes a wiped database heal itself.
 * The password is never logged.
 */
function setBobServerPassword(password) {
  runLocalSql('role', `alter role bob_server with password '${password}';\n`, 'set the bob_server role password');
}

/** Runs SQL on the LOCAL DB through a temp file that is always removed. */
function runLocalSql(name, sql, what) {
  const sqlFile = join(tmpdir(), `bob-offline-${name}-${process.pid}.sql`);
  writeFileSync(sqlFile, sql, 'utf8');
  try {
    const result = runSupabase(['db', 'query', '--local', '--file', sqlFile], { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(`[dev-offline] failed to ${what}.`);
      process.exit(1);
    }
  } finally {
    rmSync(sqlFile, { force: true });
  }
}

/**
 * Applies migrations added since the local volume was created. `supabase
 * start` only migrates a FRESH volume, so after a pull the server otherwise
 * runs against a stale schema (e.g. `function public.waitlist_begin does not
 * exist`). Already-applied migrations are skipped, so this is a no-op when
 * the database is current.
 *
 * Parallel units apply their own migrations to this shared stack, so a merged
 * migration can sort before one already applied here; plain `migration up`
 * then fails with LegacyMigrationMissingRemoteError (#558). `--include-all`
 * applies those too. It is only ever sent with `--local`: production runs
 * `supabase db push` without it, and `npm run check:migration-order` catches
 * the same ordering before a release.
 */
function applyPendingMigrations() {
  const list = runSupabase(['migration', 'list', '--local', '--output-format', 'json']);
  const late = list.status === 0 ? outOfOrderPending(parseMigrationList(list.stdout)) : [];
  if (late.length > 0) {
    console.log(`[dev-offline] applying out of order on the LOCAL stack: ${late.join(', ')}`);
  }
  const args = buildLocalMigrationUpArgs();
  const result = runSupabase(args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[dev-offline] \`npx supabase ${args.join(' ')}\` failed.`);
    process.exit(1);
  }
}

/** `migration up` args for the LOCAL stack; --include-all is never sent without --local. */
export function buildLocalMigrationUpArgs() {
  return ['migration', 'up', '--local', '--include-all'];
}

/**
 * Reads `supabase migration list --local --output-format json` into the local
 * migration versions and the ones applied to the database. Null when the
 * output holds no migration list.
 */
export function parseMigrationList(text) {
  const line = String(text ?? '').split(/\r?\n/).find((l) => l.trim().startsWith('{'));
  if (!line) return null;
  try {
    const { migrations } = JSON.parse(line);
    if (!Array.isArray(migrations)) return null;
    return {
      local: migrations.map((m) => m.local).filter(Boolean),
      applied: migrations.map((m) => m.remote).filter(Boolean),
    };
  } catch {
    return null;
  }
}

/** Pending local migrations that sort before the newest applied one, oldest first. */
export function outOfOrderPending(list) {
  if (!list || list.applied.length === 0) return [];
  const newest = [...list.applied].sort().at(-1);
  const applied = new Set(list.applied);
  return list.local.filter((v) => !applied.has(v) && v < newest).sort();
}

/**
 * A fresh 6-digit sign-in code for `email` from the LOCAL auth admin API. The
 * email provider is off locally, so this is how the dev account signs in:
 * "I already have a code" on the sign-in page. No email is sent, and no
 * redirect is involved, so it works from any device on the LAN.
 */
export async function createSignInCode(apiUrl, serviceRoleKey, email) {
  const response = await fetch(`${apiUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  if (!response.ok) throw new Error(`generate_link failed (${response.status})`);
  const code = readSignInCode(await response.json());
  if (!code) throw new Error('generate_link returned no code');
  return code;
}

async function printSignInCode(apiUrl, serviceRoleKey, email, uiUrl) {
  try {
    const code = await createSignInCode(apiUrl, serviceRoleKey, email);
    console.log(
      `[dev-offline] sign in at ${uiUrl}: choose "I already have a code", then ${email} and code ${code} ` +
        '(single use, expires in an hour; `npm run dev:offline -- --code` prints a new one).',
    );
  } catch (err) {
    console.error(`[dev-offline] could not create a sign-in code: ${err.message}`);
  }
}

const ADMIN_USERS_PER_PAGE = 100;
const ADMIN_USERS_MAX_PAGES = 1000;

/**
 * The auth user with `email`, or null. GoTrue ignores an `?email=` filter
 * and returns one page, so this walks every page until it finds the email or
 * a short page says there are no more.
 */
async function findDevUser(apiUrl, headers, email) {
  for (let page = 1; page <= ADMIN_USERS_MAX_PAGES; page += 1) {
    const lookup = await fetch(`${apiUrl}/auth/v1/admin/users?page=${page}&per_page=${ADMIN_USERS_PER_PAGE}`, {
      headers,
    });
    if (lookup.status !== 200) throw new Error(`auth admin lookup failed (${lookup.status})`);
    const list = await lookup.json();
    const users = Array.isArray(list?.users) ? list.users : [];
    const found = users.find((user) => user?.email === email);
    if (found) return found;
    if (users.length < ADMIN_USERS_PER_PAGE) return null;
  }
  return null;
}

/**
 * Applies `password` to the auth user through the LOCAL admin update API,
 * keeping it confirmed. Anything but a 200 carries the status and body, so
 * a policy rejection (e.g. weak_password) stays diagnosable.
 */
async function setDevPassword(apiUrl, headers, userId, password) {
  const updated = await fetch(`${apiUrl}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ password, email_confirm: true }),
  });
  if (updated.status !== 200) {
    const body = await updated.text();
    throw new Error(`admin user password update failed (${updated.status}): ${body}`);
  }
}

/**
 * Ensures the dev user exists as a confirmed account through the LOCAL auth
 * admin API. With `password`, that password is the account's password: a new
 * user is created with it, and an existing one (from seed.sql, which stores
 * none, or from an older run, which stored a discarded random one) gets it
 * re-applied, so a reset database heals itself the same way the
 * bob_server role does. A create that reports email_exists is re-listed
 * and updated instead of failing. Without `password` (the e2e suite, which
 * signs its throwaway accounts in by admin code), an existing user is left
 * untouched and a missing one is created with a random password.
 */
export async function ensureDevUser(apiUrl, serviceRoleKey, email, password) {
  if (password !== undefined && (typeof password !== 'string' || password.length === 0)) {
    throw new Error('ensureDevUser requires a non-empty dev password');
  }
  const headers = { Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' };
  const existing = await findDevUser(apiUrl, headers, email);
  if (existing) {
    if (password !== undefined) await setDevPassword(apiUrl, headers, existing.id, password);
    return;
  }
  const createPassword = password === undefined ? randomBytes(18).toString('base64url') : password;
  const created = await fetch(`${apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password: createPassword, email_confirm: true }),
  });
  if (created.status === 201 || created.status === 200) return;
  const body = await created.text();
  if (created.status === 422 && readErrorCode(body) === 'email_exists') {
    if (password === undefined) return;
    const raced = await findDevUser(apiUrl, headers, email);
    if (!raced) throw new Error(`admin user create failed (${created.status}): ${body}`);
    await setDevPassword(apiUrl, headers, raced.id, password);
    return;
  }
  throw new Error(`admin user create failed (${created.status}): ${body}`);
}

function readErrorCode(body) {
  try {
    return JSON.parse(body)?.error_code ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the dev-user password -- rotating it when `regenPassword` (a
 * fresh generateDevPassword() overwriting BOB_DEV_PASSWORD in
 * data/offline.env) -- and applies it to the dev user through the LOCAL
 * auth admin API. Returns the password so the caller can export it to the
 * dev servers. The value itself is never logged.
 */
async function setupDevUser(apiUrl, serviceRoleKey, devEmail, regenPassword) {
  const devPassword = regenPassword ? rotateDevPassword() : ensureDevPassword();
  try {
    await ensureDevUser(apiUrl, serviceRoleKey, devEmail, devPassword);
  } catch (err) {
    console.error(`[dev-offline] dev user setup failed: ${err.message}`);
    process.exit(1);
  }
  if (regenPassword) {
    console.log(
      `[dev-offline] rotated the dev password for ${devEmail} (stored as BOB_DEV_PASSWORD in ${OFFLINE_ENV}).`,
    );
  }
  return devPassword;
}

/** Spawns dev:all with the env overrides; forwards signals; exits with the child. */
function spawnDevAll(envOverrides) {
  const child = spawn(npm, ['run', 'dev:all'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...envOverrides },
    shell,
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  const stop = () => child.kill();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.stop) {
    const result = runSupabase(['stop'], { stdio: 'inherit' });
    process.exit(result.status ?? 0);
  }
  if (args.status) {
    const result = runSupabase(['status'], { stdio: 'inherit' });
    process.exit(result.status ?? 0);
  }

  checkDocker();
  if (!args.code) startSupabase();

  const statusEnv = readStatusEnv();
  const apiUrl = statusEnv.API_URL;
  const dbUrl = statusEnv.DB_URL;
  if (!isLoopbackUrl(apiUrl) || !isLoopbackUrl(dbUrl)) {
    console.error(
      '[dev-offline] REFUSING to continue: Supabase must run on 127.0.0.1/localhost ' +
        `(got API_URL=${apiUrl}, DB_URL=${dbUrl}). This script never touches a hosted project.`,
    );
    process.exit(1);
  }
  console.log('[dev-offline] local Supabase confirmed on the loopback interface.');

  const devEmail = process.env.BOB_DEV_EMAIL ?? DEFAULT_DEV_EMAIL;
  const lanIp = findLanIpv4() ?? 'localhost';
  const uiUrl = `http://${lanIp}:5173`;
  if (args.code) {
    await printSignInCode(apiUrl, statusEnv.SERVICE_ROLE_KEY, devEmail, uiUrl);
    return;
  }

  applyPendingMigrations();
  const password = ensureServerPassword();
  setBobServerPassword(password);
  runLocalSql('auth-repair', AUTH_TOKEN_REPAIR_SQL, 'repair NULL auth.users token columns');

  const devPassword = await setupDevUser(apiUrl, statusEnv.SERVICE_ROLE_KEY, devEmail, args.regenPassword);

  const overrides = buildEnvOverrides(statusEnv, { password, devPassword, lanIp, stubAi: args.stubAi });

  const canSignIn = await emailSignInEnabled(apiUrl, overrides.SUPABASE_PUBLISHABLE_KEY);
  if (canSignIn) {
    console.log(`Sign in at ${uiUrl} with ${devEmail}; read the code at http://${lanIp}:54324 (Mailpit)`);
  } else {
    await printSignInCode(apiUrl, statusEnv.SERVICE_ROLE_KEY, devEmail, uiUrl);
  }
  console.log(
    `[dev-offline] password sign-in for ${devEmail} uses BOB_DEV_PASSWORD from ${OFFLINE_ENV} ` +
      '(password sign-in needs the local email provider, which is currently off: see "Signing in locally" in docs/deploy.md).',
  );
  console.log(
    '[dev-offline] dev data comes from supabase/seed.sql; browse it in Studio at http://localhost:54323 ' +
      'under the `bob` schema.',
  );
  console.log(`[dev-offline] pairing URL for the Cardputer: ${overrides.BOB_PAIRING_URL}`);
  console.log(`[dev-offline] AI: ${args.stubAi ? 'stubbed (--stub-ai)' : 'real AI Gateway (AI_GATEWAY_API_KEY from .env)'}`);
  console.log('[dev-offline] starting dev:all (Ctrl+C stops the dev servers; the Supabase stack stays up unless --stop)');
  spawnDevAll(overrides);
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) main();