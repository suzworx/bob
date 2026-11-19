/**
 * #550: where the e2e suite's stack lives and the node-side helpers every spec
 * shares. Two ways to run (docs/testing/e2e.md):
 *  - started: by default the suite starts its own dev:offline stack on ports
 *    that never collide with the everyday dev server (API 7454, web 5183);
 *  - found: BOB_E2E_BASE_URL points at a stack that is already running.
 * Everything here talks to the LOCAL Supabase stack only.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
export const UI_ROOT = resolve(REPO_ROOT, 'apps/ui-v2');
/** Git-ignored (data/): reports, traces, screenshots and the saved session. */
export const E2E_DATA = resolve(REPO_ROOT, 'data/e2e');
export const AUTH_FILE = join(E2E_DATA, 'auth', 'dev-user.json');
/** The run's own throwaway account, written by global-setup.ts before any spec runs. */
export const RUN_ACCOUNT_FILE = join(E2E_DATA, 'auth', 'run-account.json');

export const E2E_API_PORT = Number(process.env.BOB_E2E_API_PORT ?? '7454');
export const E2E_WEB_PORT = Number(process.env.BOB_E2E_WEB_PORT ?? '5183');

/** The already-running stack to test, or undefined to start one. */
export const FOUND_BASE_URL = process.env.BOB_E2E_BASE_URL || undefined;
export const BASE_URL = FOUND_BASE_URL ?? `http://localhost:${E2E_WEB_PORT}`;

/** Live mode: the real AI Gateway (costs money). Stub mode otherwise. */
export function isLive(): boolean {
  return process.env.BOB_E2E_LIVE === '1';
}

/** A short random tag so every fixture a run creates is recognisably its own. */
export function runTag(): string {
  return `e2e-${randomBytes(4).toString('hex')}`;
}

export interface SignInCode {
  email: string;
  code: string;
}

/** A new account address, unique to one run: no run ever sees another's (or the developer's) data. */
export function newRunEmail(): string {
  return `e2e-run-${Date.now()}-${randomBytes(3).toString('hex')}@bob.local`;
}

/** The email of this run's account (global-setup.ts made it). */
export function runAccountEmail(): string {
  const { email } = JSON.parse(readFileSync(RUN_ACCOUNT_FILE, 'utf8')) as { email?: unknown };
  if (typeof email !== 'string' || !email.startsWith('e2e-run-')) {
    throw new Error(`no run account in ${RUN_ACCOUNT_FILE}; did global-setup.ts run?`);
  }
  return email;
}

/** A fresh single-use sign-in code, by default for this run's account, minted by scripts/dev-offline.mjs --code. */
export function mintSignInCode(email: string = runAccountEmail()): SignInCode {
  const result = spawnSync(process.execPath, ['scripts/dev-offline.mjs', '--code'], {
    cwd: REPO_ROOT,
    env: { ...process.env, BOB_DEV_EMAIL: email },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const match = output.match(/then (\S+@\S+) and code (\d{6})/);
  if (result.status !== 0 || !match?.[1] || !match[2]) {
    throw new Error(`dev-offline --code did not print a code (exit ${result.status}):\n${output}`);
  }
  return { email: match[1], code: match[2] };
}

/**
 * Runs SQL on the LOCAL Supabase database (`supabase db query --local`), for
 * fixtures no API can create (a running timer, an empty conversation). The
 * temp file is always removed.
 */
export function runLocalSql(sql: string): void {
  const file = join(tmpdir(), `bob-e2e-${process.pid}-${randomBytes(4).toString('hex')}.sql`);
  writeFileSync(file, sql, 'utf8');
  try {
    const result = spawnSync('npx', ['supabase', 'db', 'query', '--local', '--file', file], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 120_000,
    });
    if (result.status !== 0) {
      throw new Error(`local SQL failed (exit ${result.status}): ${result.stderr || result.stdout}`);
    }
  } finally {
    rmSync(file, { force: true });
  }
}

/** A SQL string literal for a value the suite generated itself (uuids, tags). */
export function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
