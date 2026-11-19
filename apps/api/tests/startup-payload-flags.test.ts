// #1039: BOB_TRACE_PAYLOAD and BOB_DEBUG_PAYLOAD send prompts, replies and
// transcripts off the box. The real entry point refuses to boot with either one
// under BOB_PRODUCTION=1, journals which flag (never a value), and leaves both
// honoured outside production.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { keyFingerprint } from '@bob/ai';

const SERVER = resolve(import.meta.dirname, '../src/server.ts');
// The logger's own envelope (journalEntry in apps/ai/src/journal.ts); everything else on a line is a caller field.
const ENVELOPE = new Set(['ts', 'level', 'event', 'message', 'source', 'module', 'user_id', 'conversation_id', 'conversation_source', 'session_id', 'trace_id', 'span_id']);

interface BootResult {
  status: number | null;
  stderr: string;
  stdout: string;
  debugLogCreated: boolean;
  debugLog: string;
  events: Array<{ event: string; [field: string]: unknown }>;
}

function boot(env: Record<string, string>): BootResult {
  const dir = mkdtempSync(join(tmpdir(), 'bob-boot-'));
  const journalPath = join(dir, 'journal.log');
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  try {
  const result = spawnSync(process.execPath, [tsxCli, SERVER], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      // Empty, not deleted: dotenv never overrides a variable that is set.
      BOB_DATABASE_URL: '',
      BOB_PRODUCTION: '',
      BOB_TRACE_PAYLOAD: '',
      BOB_DEBUG: '',
      BOB_DEBUG_PAYLOAD: '',
      // #1041 key guards off unless a case sets them.
      BOB_PROD_KEY_FINGERPRINT: '',
      BOB_DEV_KEY_FINGERPRINT: '',
      BOB_ALLOW_PROD_KEY: '',
      BOB_V2_PORT: '0',
      BOB_V2_JOURNAL: journalPath,
      BOB_DEBUG_LOG: join(dir, 'debug.log'),
      ...env,
    },
  });
  const events = readFileSync(journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as BootResult['events'][number]);
  const debugPath = join(dir, 'debug.log');
  const debugLogCreated = existsSync(debugPath);
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, debugLogCreated, debugLog: debugLogCreated ? readFileSync(debugPath, 'utf8') : '', events };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What a refused production boot must never emit: the effective-config entry carries the system instructions and gateway URL.
const CONFIG_LEAKS = [/ai\.agent_configured/, /instructions/i, /https?:\/\//];

describe('payload flags at boot (#1039)', () => {
  it.each([
    [['BOB_TRACE_PAYLOAD']],
    [['BOB_DEBUG_PAYLOAD']],
    [['BOB_TRACE_PAYLOAD', 'BOB_DEBUG_PAYLOAD']],
  ])('refuses %j=1 under BOB_PRODUCTION=1 and journals only the flag names', (set) => {
    const { status, stderr, stdout, debugLogCreated, debugLog, events } = boot({ BOB_PRODUCTION: '1', BOB_DEBUG: '1', ...Object.fromEntries(set.map((name) => [name, '1'])) });
    expect(status).toBe(1);
    expect(stderr).toContain(`${set.join(', ')} must be unset when BOB_PRODUCTION=1`);
    const refused = events.filter((entry) => entry.event === 'v2.payload_flag_error');
    expect(refused.map((entry) => entry.flag)).toEqual(set);
    for (const entry of refused) {
      expect(entry).toMatchObject({ level: 'error' });
      // Nothing beyond the logger's envelope and the flag name: never a value.
      expect(Object.keys(entry).filter((key) => !ENVELOPE.has(key))).toEqual(['flag']);
    }
    expect(events.map((entry) => entry.event)).not.toContain('v2.listening');
    // The refusal precedes the debug sink and the config log: no config entry anywhere, no debug file.
    expect(debugLogCreated).toBe(false);
    for (const leak of CONFIG_LEAKS) {
      expect(stdout).not.toMatch(leak);
      expect(stderr).not.toMatch(leak);
      expect(debugLog).not.toMatch(leak);
      expect(JSON.stringify(events)).not.toMatch(leak);
    }
  }, 90_000);

  it('does not refuse the flags outside production', () => {
    const { events } = boot({ BOB_TRACE_PAYLOAD: '1', BOB_DEBUG: '1', BOB_DEBUG_PAYLOAD: '1' });
    const names = events.map((entry) => entry.event);
    expect(names).not.toContain('v2.payload_flag_error');
    // It gets past the payload gate to the next refusal: no database URL.
    expect(names).toContain('v2.database_url_missing');
  }, 90_000);
});

// #1041: test traffic spent the production key's budget. A local server (what
// live probes, e2e:live and accept:replay spend through) refuses the production
// key, and a production server refuses the dev/test key, by fingerprint only.
describe('AI key guards at boot (#1041)', () => {
  const KEY = 'boot-test-key-not-real';
  // Unstubbed, whatever the shell or .env says: a stubbed server is not guarded.
  const LIVE = { BOB_AI_STUB: '', BOB_SYSTEM_TEST: '' };
  const refusedWith = (result: BootResult, production: boolean, variable: string): void => {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(variable);
    expect(result.events.filter((entry) => entry.event === 'v2.ai_key_error')).toEqual([expect.objectContaining({ level: 'error', production })]);
    expect(result.events.map((entry) => entry.event)).not.toContain('v2.listening');
    for (const output of [result.stderr, result.stdout, JSON.stringify(result.events)]) expect(output).not.toContain(KEY);
  };

  it('a non-production server refuses the production key', () => {
    refusedWith(boot({ ...LIVE, AI_GATEWAY_API_KEY: KEY, BOB_PROD_KEY_FINGERPRINT: keyFingerprint(KEY) }), false, 'BOB_PROD_KEY_FINGERPRINT');
  }, 90_000);

  it('BOB_ALLOW_PROD_KEY=1 lets a deliberate local run past the guard', () => {
    const { events } = boot({ ...LIVE, AI_GATEWAY_API_KEY: KEY, BOB_PROD_KEY_FINGERPRINT: keyFingerprint(KEY), BOB_ALLOW_PROD_KEY: '1' });
    const names = events.map((entry) => entry.event);
    expect(names).not.toContain('v2.ai_key_error');
    expect(names).toContain('v2.database_url_missing');
  }, 90_000);

  it('a stubbed local server spends nothing, so it is not refused', () => {
    const { events } = boot({ AI_GATEWAY_API_KEY: KEY, BOB_PROD_KEY_FINGERPRINT: keyFingerprint(KEY), BOB_AI_STUB: '1', BOB_SYSTEM_TEST_REAL_TTS: '' });
    const names = events.map((entry) => entry.event);
    expect(names).not.toContain('v2.ai_key_error');
    expect(names).toContain('v2.database_url_missing');
  }, 90_000);

  it('a production server refuses the dev/test key', () => {
    refusedWith(boot({ ...LIVE, BOB_PRODUCTION: '1', AI_GATEWAY_API_KEY: KEY, BOB_DEV_KEY_FINGERPRINT: keyFingerprint(KEY) }), true, 'BOB_DEV_KEY_FINGERPRINT');
  }, 90_000);
});
