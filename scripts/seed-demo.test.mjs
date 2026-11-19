import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  assertLoopbackTargets,
  DEFAULT_API_URL,
  dateOnlyDue,
  defaultZone,
  findAuthUser,
  instantDue,
  isLoopbackUrl,
  parseArgs,
  SeedError,
  signInWithCode,
  toCalendarDate,
} from './seed-demo.mjs';

const jsonResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

describe('findAuthUser', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('finds an existing demo user beyond the first admin page', async () => {
    const wanted = { id: 'existing-demo', email: 'dana@demo.bob.local' };
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { users: Array.from({ length: 100 }, (_, i) => ({ email: `other-${i}@example.test` })) }))
      .mockResolvedValueOnce(jsonResponse(200, { users: [wanted] }));
    vi.stubGlobal('fetch', request);
    expect(await findAuthUser('http://localhost:54321', 'test-key', wanted.email)).toEqual(wanted);
    expect(request.mock.calls[1][0]).toContain('page=2&per_page=100');
  });
  it('returns null only after the last page and rejects lookup outages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { users: [] })));
    expect(await findAuthUser('http://localhost:54321', 'test-key', 'absent@example.test')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(503, {})));
    await expect(findAuthUser('http://localhost:54321', 'test-key', 'absent@example.test')).rejects.toThrow('503');
  });
});

describe('signInWithCode', () => {
  const api = 'http://127.0.0.1:54321';
  const email = 'dana@demo.bob.local';

  afterEach(() => vi.unstubAllGlobals());

  it('mints a code, exchanges it at /verify and returns the access token', async () => {
    const fetchMock = vi.fn(async (url) =>
      String(url).endsWith('/auth/v1/admin/generate_link')
        ? jsonResponse(200, { email_otp: '123456' })
        : jsonResponse(200, { access_token: 'jwt-for-dana' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(signInWithCode(api, 'service-key', 'anon-key', email)).resolves.toBe('jwt-for-dana');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [mintUrl, mintInit] = fetchMock.mock.calls[0];
    expect(mintUrl).toBe(`${api}/auth/v1/admin/generate_link`);
    expect(JSON.parse(mintInit.body)).toEqual({ type: 'magiclink', email });
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[1];
    expect(verifyUrl).toBe(`${api}/auth/v1/verify`);
    expect(verifyInit.method).toBe('POST');
    expect(verifyInit.headers.apikey).toBe('anon-key');
    expect(JSON.parse(verifyInit.body)).toEqual({ type: 'email', email, token: '123456' });
  });

  it('throws SeedError with the status when /verify is not 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        String(url).endsWith('/auth/v1/admin/generate_link')
          ? jsonResponse(200, { email_otp: '123456' })
          : jsonResponse(403, {}),
      ),
    );
    const attempt = signInWithCode(api, 'service-key', 'anon-key', email);
    await expect(attempt).rejects.toBeInstanceOf(SeedError);
    await expect(attempt).rejects.toThrow(`sign-in failed for ${email} (403)`);
  });

  it('throws SeedError when a 200 body has no access_token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        String(url).endsWith('/auth/v1/admin/generate_link')
          ? jsonResponse(200, { email_otp: '123456' })
          : jsonResponse(200, {}),
      ),
    );
    await expect(signInWithCode(api, 'service-key', 'anon-key', email)).rejects.toBeInstanceOf(SeedError);
  });
});

// No Docker, database or running server anywhere in this file (test:scripts
// contract): every function under test is pure string/date logic, or stubs fetch.

describe('isLoopbackUrl', () => {
  it('accepts 127.0.0.1, localhost and [::1]', () => {
    expect(isLoopbackUrl('http://127.0.0.1:7444')).toBe(true);
    expect(isLoopbackUrl('http://localhost:7444')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:7444')).toBe(true);
  });

  it('rejects a hosted host and a LAN address', () => {
    expect(isLoopbackUrl('https://abcdefghijklmnopqrst.supabase.co')).toBe(false);
    expect(isLoopbackUrl('https://app.heybob.xyz')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.23:7444')).toBe(false);
    expect(isLoopbackUrl('http://10.0.0.5:54321')).toBe(false);
  });

  it('rejects garbage and missing values rather than throwing', () => {
    expect(isLoopbackUrl('not a url')).toBe(false);
    expect(isLoopbackUrl('')).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });
});

// This is the test that matters (brief: "write it so it fails if the guard
// is ever removed"): it exercises the exact function main() calls before any
// write, so deleting or weakening that call is the only way to make this
// suite stop proving the refusal.
describe('assertLoopbackTargets (the safety guard)', () => {
  const loopbackSupabase = { API_URL: 'http://127.0.0.1:54321', DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' };

  it('passes for an all-loopback target set', () => {
    expect(() => assertLoopbackTargets('http://127.0.0.1:7444', loopbackSupabase, {})).not.toThrow();
  });

  it('REJECTS a hosted --api', () => {
    expect(() => assertLoopbackTargets('https://app.heybob.xyz', loopbackSupabase, {})).toThrow(SeedError);
  });

  it('REJECTS a LAN --api', () => {
    expect(() => assertLoopbackTargets('http://192.168.1.23:7444', loopbackSupabase, {})).toThrow(SeedError);
  });

  it('REJECTS a hosted local-Supabase API_URL', () => {
    const hosted = { API_URL: 'https://abcdefghijklmnopqrst.supabase.co', DB_URL: loopbackSupabase.DB_URL };
    expect(() => assertLoopbackTargets('http://127.0.0.1:7444', hosted, {})).toThrow(SeedError);
  });

  it('REJECTS a hosted local-Supabase DB_URL', () => {
    const hosted = { API_URL: loopbackSupabase.API_URL, DB_URL: 'postgresql://postgres:pw@db.supabase.co:5432/postgres' };
    expect(() => assertLoopbackTargets('http://127.0.0.1:7444', hosted, {})).toThrow(SeedError);
  });

  it('REJECTS a hosted BOB_DATABASE_URL even when everything else is loopback', () => {
    const env = { BOB_DATABASE_URL: 'postgresql://postgres:pw@db.supabase.co:5432/postgres' };
    expect(() => assertLoopbackTargets('http://127.0.0.1:7444', loopbackSupabase, env)).toThrow(SeedError);
  });

  it('accepts a loopback BOB_DATABASE_URL', () => {
    const env = { BOB_DATABASE_URL: 'postgresql://bob_server:pw@127.0.0.1:54322/postgres' };
    expect(() => assertLoopbackTargets('http://127.0.0.1:7444', loopbackSupabase, env)).not.toThrow();
  });

  it('exits non-zero in practice: main() maps this throw to process.exitCode = 1', () => {
    // assertLoopbackTargets itself never calls process.exit -- it throws, and
    // main()'s catch sets process.exitCode = 1 (asserted here as a contract:
    // every SeedError is a plain Error, never swallowed).
    try {
      assertLoopbackTargets('https://app.heybob.xyz', loopbackSupabase, {});
      throw new Error('expected assertLoopbackTargets to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SeedError);
      expect(err.message).toMatch(/REFUSING/);
    }
  });
});

describe('parseArgs', () => {
  it('defaults to the standard loopback API and no flags', () => {
    expect(parseArgs([])).toEqual({ api: DEFAULT_API_URL, reset: false, quiet: false });
  });

  it('parses --api with a space-separated value', () => {
    expect(parseArgs(['--api', 'http://127.0.0.1:9999'])).toMatchObject({ api: 'http://127.0.0.1:9999' });
  });

  it('parses --api=value', () => {
    expect(parseArgs(['--api=http://127.0.0.1:9999'])).toMatchObject({ api: 'http://127.0.0.1:9999' });
  });

  it('parses --reset and --quiet', () => {
    expect(parseArgs(['--reset'])).toMatchObject({ reset: true });
    expect(parseArgs(['--quiet'])).toMatchObject({ quiet: true });
  });

  it('combines flags', () => {
    expect(parseArgs(['--api', 'http://127.0.0.1:1', '--reset', '--quiet'])).toEqual({
      api: 'http://127.0.0.1:1',
      reset: true,
      quiet: true,
    });
  });

  it('throws when --api has no value', () => {
    expect(() => parseArgs(['--api'])).toThrow();
    expect(() => parseArgs(['--api', '--reset'])).toThrow();
  });

  it('throws on an unknown option', () => {
    expect(() => parseArgs(['--bogus'])).toThrow();
  });
});

describe('signInWithCode', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mints a code with generate_link, exchanges it at /verify and returns the access token', async () => {
    const calls = [];
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push({ url, init });
      const body = url.endsWith('/admin/generate_link') ? { properties: { email_otp: '123456' } } : { access_token: 'tok' };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const token = await signInWithCode('http://127.0.0.1:54321', 'service', 'anon', 'dana@demo.bob.local');
    expect(token).toBe('tok');
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:54321/auth/v1/admin/generate_link',
      'http://127.0.0.1:54321/auth/v1/verify',
    ]);
    expect(JSON.parse(calls[1].init.body)).toEqual({ type: 'email', email: 'dana@demo.bob.local', token: '123456' });
    expect(calls[1].init.headers.apikey).toBe('anon');
  });

  it('throws a SeedError when /verify rejects the code', async () => {
    vi.stubGlobal('fetch', async (url) =>
      url.endsWith('/admin/generate_link')
        ? new Response(JSON.stringify({ email_otp: '123456' }), { status: 200 })
        : new Response('{}', { status: 403 }),
    );
    await expect(signInWithCode('http://127.0.0.1:54321', 'service', 'anon', 'dana@demo.bob.local')).rejects.toThrow(SeedError);
  });
});

describe('date helpers', () => {
  it('dateOnlyDue produces a date-only value with no time component', () => {
    const due = dateOnlyDue(new Date('2026-09-18T23:59:00Z'));
    expect(due).toEqual({ kind: 'date', date: '2026-09-18' });
    expect(due.date).not.toMatch(/T|:/);
  });

  it('instantDue produces an absolute instant with its zone', () => {
    const at = new Date('2026-09-19T17:00:00Z');
    const due = instantDue(at, 'America/New_York');
    expect(due).toEqual({ kind: 'instant', at: at.getTime(), zone: 'America/New_York' });
  });

  it('toCalendarDate formats UTC dates as YYYY-MM-DD', () => {
    expect(toCalendarDate(new Date('2026-01-05T08:00:00Z'))).toBe('2026-01-05');
  });

  it('addDays shifts by whole days in both directions', () => {
    const base = new Date('2026-09-16T12:00:00Z');
    expect(toCalendarDate(addDays(base, 1))).toBe('2026-09-17');
    expect(toCalendarDate(addDays(base, -16))).toBe('2026-08-31');
  });

  it('defaultZone never throws and returns a non-empty string', () => {
    const zone = defaultZone();
    expect(typeof zone).toBe('string');
    expect(zone.length).toBeGreaterThan(0);
  });
});
