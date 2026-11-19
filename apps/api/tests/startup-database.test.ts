// One engine everywhere (PGlite removal epic): there is no stand-in database,
// so the real entry point refuses to boot without BOB_DATABASE_URL, names the
// fix and journals why, before it builds or binds anything. #1306: a production
// server also refuses the IPv6-only Supabase direct host.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DATABASE_URL_DIRECT_HOST, DATABASE_URL_REQUIRED } from '../src/platform/db/db.ts';

const SERVER = resolve(import.meta.dirname, '../src/server.ts');
// The logger's own envelope (journalEntry in apps/ai/src/journal.ts); everything else on a line is a caller field.
const ENVELOPE = new Set(['ts', 'level', 'event', 'message', 'source', 'module', 'user_id', 'conversation_id', 'conversation_source', 'session_id', 'trace_id', 'span_id']);
const SECRET = 'boot-test-password-not-real';

interface Boot { status: number | null; stderr: string; stdout: string; events: Array<{ event: string; [field: string]: unknown }> }

function boot(env: Record<string, string>): Boot {
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
        BOB_DEBUG_PAYLOAD: '',
        BOB_PROD_KEY_FINGERPRINT: '',
        BOB_DEV_KEY_FINGERPRINT: '',
        BOB_V2_PORT: '0',
        BOB_V2_JOURNAL: journalPath,
        BOB_DEBUG_LOG: join(dir, 'debug.log'),
        ...env,
      },
    });
    // A refusal that journals nothing (the auth config gate) leaves no file.
    const raw = existsSync(journalPath) ? readFileSync(journalPath, 'utf8').trim() : '';
    const events = raw ? raw.split('\n').map((line) => JSON.parse(line) as Boot['events'][number]) : [];
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, events };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('server boot without BOB_DATABASE_URL', () => {
  it('exits 1, names the fix and journals v2.database_url_missing', () => {
    const { status, stderr, events } = boot({});
    expect(status).toBe(1);
    expect(stderr).toContain(DATABASE_URL_REQUIRED);
    expect(events.map((entry) => entry.event)).toContain('v2.database_url_missing');
    expect(events.map((entry) => entry.event)).not.toContain('v2.listening');
  }, 90_000);
});

describe('production boot with the Supabase direct host (#1306)', () => {
  const url = (host: string): string => `postgresql://postgres.abcdefghijklmnop:${SECRET}@${host}:5432/postgres`;

  it('exits 1, names the fix and journals only the event, never the URL', () => {
    const { status, stderr, stdout, events } = boot({ BOB_PRODUCTION: '1', BOB_DATABASE_URL: url('db.abcdefghijklmnop.supabase.co') });
    expect(status).toBe(1);
    expect(stderr).toContain(DATABASE_URL_DIRECT_HOST);
    const refused = events.filter((entry) => entry.event === 'v2.database_url_unreachable_host');
    expect(refused).toHaveLength(1);
    expect(Object.keys(refused[0] ?? {}).filter((key) => !ENVELOPE.has(key))).toEqual([]);
    expect(events.map((entry) => entry.event)).not.toContain('v2.listening');
    for (const output of [stderr, stdout, JSON.stringify(events)]) {
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain('abcdefghijklmnop');
    }
  }, 90_000);

  it('lets a production pooler URL past this guard', () => {
    // SUPABASE_URL empty stops the boot at the next refusal, the auth config, before any bind.
    const { status, stderr, events } = boot({ BOB_PRODUCTION: '1', SUPABASE_URL: '', BOB_DATABASE_URL: url('aws-0-ca-central-1.pooler.supabase.com') });
    expect(status).toBe(1);
    expect(stderr).toContain('requires SUPABASE_URL');
    expect(stderr).not.toContain(DATABASE_URL_DIRECT_HOST);
    expect(events.map((entry) => entry.event)).not.toContain('v2.database_url_unreachable_host');
  }, 90_000);

  it('does not refuse the direct host outside production', () => {
    // BOB_SYSTEM_TEST=1 with a hosted URL stops the boot at the auth gate's local-database refusal.
    const { status, stderr, events } = boot({ BOB_SYSTEM_TEST: '1', BOB_DATABASE_URL: url('db.abcdefghijklmnop.supabase.co') });
    expect(status).toBe(1);
    expect(stderr).toContain('requires a local database');
    expect(stderr).not.toContain(DATABASE_URL_DIRECT_HOST);
    expect(events.map((entry) => entry.event)).not.toContain('v2.database_url_unreachable_host');
  }, 90_000);
});
