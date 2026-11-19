/**
 * TG-FRESH-E2E global setup: every run signs in as a brand-new account of its
 * own, so no run can see another run's data or the developer's
 * (dev@bob.local is never used). The account is made the way the dev stack
 * makes its dev user: scripts/dev-offline.mjs ensureDevUser on the LOCAL auth
 * admin API (loopback only). Its email goes to RUN_ACCOUNT_FILE, which
 * auth.setup.ts and mintSignInCode() read.
 *
 * At teardown the account is left behind, isolated: nothing else ever signs in
 * as it, and auth.users rows with tasks or notes cannot be deleted (their
 * foreign keys do not cascade).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, RUN_ACCOUNT_FILE, newRunEmail } from './stack.ts';

interface DevOffline {
  parseSupabaseEnv: (text: string) => Record<string, string>;
  isLoopbackUrl: (value: string | undefined) => boolean;
  ensureDevUser: (apiUrl: string, serviceRoleKey: string, email: string) => Promise<void>;
}

function supabase(args: string[]): { status: number | null; out: string } {
  const result = spawnSync('npx', ['supabase', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 240_000,
  });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** `supabase status -o env`, starting the local stack first if it is not up yet. */
function localStatus(): string {
  let status = supabase(['status', '-o', 'env']);
  if (status.status !== 0) {
    if (supabase(['start']).status !== 0) throw new Error('`npx supabase start` failed; is Docker running?');
    status = supabase(['status', '-o', 'env']);
  }
  if (status.status !== 0) throw new Error(`\`npx supabase status -o env\` failed:\n${status.out}`);
  return status.out;
}

export default async function globalSetup(): Promise<void> {
  const devOffline = (await import(pathToFileURL(join(REPO_ROOT, 'scripts/dev-offline.mjs')).href)) as DevOffline;
  const env = devOffline.parseSupabaseEnv(localStatus());
  if (!devOffline.isLoopbackUrl(env.API_URL)) {
    throw new Error(`REFUSING: Supabase must be on loopback (got ${env.API_URL}); the suite never touches a hosted project.`);
  }
  const email = newRunEmail();
  await devOffline.ensureDevUser(env.API_URL ?? '', env.SERVICE_ROLE_KEY ?? '', email);
  mkdirSync(dirname(RUN_ACCOUNT_FILE), { recursive: true });
  writeFileSync(RUN_ACCOUNT_FILE, `${JSON.stringify({ email }, null, 2)}\n`, 'utf8');
  console.log(`[e2e] this run signs in as ${email}`);
}
