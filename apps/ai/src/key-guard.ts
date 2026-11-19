/**
 * AI Gateway key guards, so test runs cannot spend the production key's budget.
 * Each side names the OTHER side's key by a non-secret fingerprint
 * (the first 8 hex characters of its SHA-256, never the key) and refuses it:
 *
 *  - live and test runs (test:live, test:scenarios, evals, pack and probe
 *    scripts, a local server) refuse a key matching BOB_PROD_KEY_FINGERPRINT,
 *    unless BOB_ALLOW_PROD_KEY=1 says the production spend is deliberate;
 *  - a production server (BOB_PRODUCTION=1) refuses a key matching
 *    BOB_DEV_KEY_FINGERPRINT.
 *
 * An unset fingerprint disables its guard. A malformed one refuses, so a typo
 * never turns a guard off silently. Messages name variables only.
 */
import { createHash } from 'node:crypto';

type Env = Record<string, string | undefined>;

const FINGERPRINT = /^[0-9a-f]{8}$/;

/** The first 8 hex characters of the key's SHA-256: safe to store and compare, never the key. */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

function compare(key: string, fingerprint: string): 'match' | 'differs' | 'malformed' {
  const expected = fingerprint.trim().toLowerCase();
  if (!FINGERPRINT.test(expected)) return 'malformed';
  return keyFingerprint(key) === expected ? 'match' : 'differs';
}

function refusal(env: Env, variable: string, whose: string, fix: string): string | undefined {
  const key = env.AI_GATEWAY_API_KEY ?? '';
  const fingerprint = env[variable] ?? '';
  if (key === '' || fingerprint.trim() === '') return undefined;
  const result = compare(key, fingerprint);
  if (result === 'differs') return undefined;
  if (result === 'malformed') return `${variable} must be 8 hex characters (the start of the key's SHA-256)`;
  return `AI_GATEWAY_API_KEY is the ${whose} key (it matches ${variable}): ${fix} (#1041)`;
}

/** Why a live or test run must not use this key, or undefined when it may. */
export function liveKeyRefusal(env: Env = process.env): string | undefined {
  if (env.BOB_ALLOW_PROD_KEY === '1') return undefined;
  return refusal(env, 'BOB_PROD_KEY_FINGERPRINT', 'production',
    'live and test runs use the dev/test key; set BOB_ALLOW_PROD_KEY=1 only for a deliberate production run');
}

/** Why a production server must not boot with this key, or undefined when it may. */
export function productionKeyRefusal(env: Env = process.env): string | undefined {
  return refusal(env, 'BOB_DEV_KEY_FINGERPRINT', 'dev/test', 'production runs on its own key');
}

/** Throws before a live or test run spends anything when its key is the production key. */
export function refuseProductionKey(env: Env = process.env): void {
  const reason = liveKeyRefusal(env);
  if (reason !== undefined) throw new Error(reason);
}
