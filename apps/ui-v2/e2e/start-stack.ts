/**
 * #550: starts the e2e suite's own API against the local dev:offline stack,
 * the way scripts/dev-offline.mjs does and with its own exported helpers, on
 * the suite's port (BOB_E2E_API_PORT, never 7444). Run by Playwright as a
 * webServer; the suite's web server (vite.e2e.config.ts) proxies to it.
 *
 * Differences from dev:offline, both deliberate:
 *  - no second web server: the suite starts its own, pointed at this API;
 *  - a local database AHEAD of this checkout (a migration applied from another
 *    worktree) is a warning, not a stop: one Supabase stack serves every
 *    worktree, and the suite must not rewrite another checkout's history.
 * It refuses anything but a loopback Supabase, exactly like dev:offline.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { E2E_API_PORT, REPO_ROOT, isLive, runLocalSql, sqlText } from './stack.ts';

interface DevOffline {
  parseSupabaseEnv: (text: string) => Record<string, string>;
  isLoopbackUrl: (value: string | undefined) => boolean;
  buildEnvOverrides: (status: Record<string, string>, options: { password: string; lanIp: string; stubAi: boolean }) => Record<string, string>;
  ensureDevUser: (apiUrl: string, serviceRoleKey: string, email: string) => Promise<void>;
}

interface OfflineEnv {
  offlineEnvPath: (root: string) => string;
}

const shell = process.platform === 'win32';

function supabase(args: string[]): { status: number | null; out: string } {
  const result = spawnSync('npx', ['supabase', ...args], { cwd: REPO_ROOT, encoding: 'utf8', shell });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function fail(message: string): never {
  console.error(`[e2e-stack] ${message}`);
  process.exit(1);
}

/** The per-machine bob_server password dev:offline keeps, generated the same way on first use (CI). */
function serverPassword(path: string): string {
  try {
    const match = readFileSync(path, 'utf8').match(/^BOB_SERVER_PASSWORD=(\S+)$/m);
    if (match?.[1]) return match[1];
  } catch {
    // first run on this machine; generate below
  }
  const password = randomBytes(24).toString('base64url');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `BOB_SERVER_PASSWORD=${password}
`, { mode: 0o600 });
  return password;
}

async function main(): Promise<void> {
  const devOffline = (await import(pathToFileURL(join(REPO_ROOT, 'scripts/dev-offline.mjs')).href)) as DevOffline;
  const offlineEnv = (await import(pathToFileURL(join(REPO_ROOT, 'scripts/offline-env.mjs')).href)) as OfflineEnv;

  if (supabase(['start']).status !== 0) fail('`npx supabase start` failed; is Docker running?');
  const status = supabase(['status', '-o', 'env']);
  if (status.status !== 0) fail('`npx supabase status -o env` failed.');
  const env = devOffline.parseSupabaseEnv(status.out);
  if (!devOffline.isLoopbackUrl(env.API_URL) || !devOffline.isLoopbackUrl(env.DB_URL)) {
    fail(`REFUSING: Supabase must be on loopback (got ${env.API_URL}); the suite never touches a hosted project.`);
  }

  const migrate = supabase(['migration', 'up', '--local']);
  if (migrate.status !== 0) {
    if (!migrate.out.includes('LegacyMigrationMissingLocalError')) fail(`migration up failed:\n${migrate.out}`);
    console.warn('[e2e-stack] the local database is ahead of this checkout (another worktree migrated it); continuing.');
  }

  const password = serverPassword(offlineEnv.offlineEnvPath(REPO_ROOT));
  runLocalSql(`alter role bob_server with password ${sqlText(password)};\n`);

  const email = process.env.BOB_DEV_EMAIL ?? 'dev@bob.local';
  await devOffline.ensureDevUser(env.API_URL ?? '', env.SERVICE_ROLE_KEY ?? '', email);

  const overrides = devOffline.buildEnvOverrides(env, { password, lanIp: 'localhost', stubAi: !isLive() });
  console.log(`[e2e-stack] API on :${E2E_API_PORT}, AI ${isLive() ? 'LIVE (real gateway)' : 'stubbed'}`);
  const api = spawn('npm', ['run', 'dev:api'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell,
    // Every page and API call of the run comes from one loopback IP; the
    // per-IP limit is meant for the internet, not for this test-only server.
    env: {
      ...process.env,
      ...overrides,
      BOB_V2_PORT: String(E2E_API_PORT),
      BOB_V2_HOST: '127.0.0.1',
      BOB_RATE_LIMIT_API_RPM: process.env.BOB_RATE_LIMIT_API_RPM ?? '6000',
      // Stub mode answers from the scripted stub agent (apps/ai/src/stub-agent.ts):
      // real tool calls, real store, no provider. Refused under BOB_PRODUCTION=1.
      ...(isLive() ? {} : { BOB_AI_STUB: 'scripted' }),
    },
  });
  api.on('exit', (code) => process.exit(code ?? 0));
  const stop = (): void => {
    api.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
