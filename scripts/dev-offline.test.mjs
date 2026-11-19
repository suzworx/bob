import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDbUrl,
  buildEnvOverrides,
  buildLocalMigrationUpArgs,
  createSignInCode,
  emailSignInEnabled,
  ensureDevUser,
  ensureOfflineSecret,
  findLanIpv4,
  generateDevPassword,
  isLoopbackUrl,
  lanSupabaseUrl,
  outOfOrderPending,
  overwriteOfflineSecret,
  parseArgs,
  parseMigrationList,
  parseSupabaseEnv,
  readOfflineSecret,
  readSignInCode,
} from './dev-offline.mjs';

describe('isLoopbackUrl', () => {
  it('accepts 127.0.0.1, localhost and [::1]', () => {
    expect(isLoopbackUrl('http://127.0.0.1:54321')).toBe(true);
    expect(isLoopbackUrl('http://localhost:54321')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:54321')).toBe(true);
  });

  it('rejects hosted and LAN URLs', () => {
    expect(isLoopbackUrl('https://abcdefghijklmnopqrst.supabase.co')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.23:54321')).toBe(false);
    expect(isLoopbackUrl('http://10.0.0.5:54321')).toBe(false);
  });

  it('rejects garbage and missing values', () => {
    expect(isLoopbackUrl('not a url')).toBe(false);
    expect(isLoopbackUrl('')).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });
});

describe('parseSupabaseEnv', () => {
  it('parses KEY="value" lines from `supabase status -o env`', () => {
    const text = [
      'Stopped services: [supabase_pooler_Bob]',
      'API_URL="http://127.0.0.1:54321"',
      'DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
      'PUBLISHABLE_KEY="sb_publishable_abc"',
    ].join('\n');
    const env = parseSupabaseEnv(text);
    expect(env.API_URL).toBe('http://127.0.0.1:54321');
    expect(env.DB_URL).toBe('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
    expect(env.PUBLISHABLE_KEY).toBe('sb_publishable_abc');
    expect(env.SERVICE_ROLE_KEY).toBeUndefined();
  });
});

describe('buildDbUrl', () => {
  it('swaps credentials for bob_server while keeping host and port', () => {
    expect(buildDbUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres', 'abc-123'))
      .toBe('postgresql://bob_server:abc-123@127.0.0.1:54322/postgres');
  });
});

describe('buildEnvOverrides', () => {
  const statusEnv = {
    API_URL: 'http://127.0.0.1:54321',
    PUBLISHABLE_KEY: 'sb_publishable_local',
    ANON_KEY: 'anon-should-not-win',
    DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  };

  it('builds the full override set for a stub run', () => {
    const env = buildEnvOverrides(statusEnv, { password: 'pw', lanIp: '192.168.1.7', stubAi: true });
    expect(env).toEqual({
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local',
      BOB_DATABASE_URL: 'postgresql://bob_server:pw@127.0.0.1:54322/postgres',
      BOB_PUBLIC_SUPABASE_URL: 'http://192.168.1.7:54321',
      BOB_PAIRING_URL: 'http://192.168.1.7:5173/pair',
      BOB_AI_STUB: '1',
    });
  });

  it('omits BOB_AI_STUB when --stub-ai is not passed', () => {
    const env = buildEnvOverrides(statusEnv, { password: 'pw', lanIp: '127.0.0.1', stubAi: false });
    expect(env.BOB_AI_STUB).toBeUndefined();
  });

  it('falls back to ANON_KEY when PUBLISHABLE_KEY is absent', () => {
    const { PUBLISHABLE_KEY: _drop, ...withoutPub } = statusEnv;
    const env = buildEnvOverrides(withoutPub, { password: 'pw', lanIp: '127.0.0.1', stubAi: false });
    expect(env.SUPABASE_PUBLISHABLE_KEY).toBe('anon-should-not-win');
  });

  it('exports BOB_DEV_PASSWORD so processes under dev:all can sign in with it', () => {
    const env = buildEnvOverrides(statusEnv, {
      password: 'pw',
      devPassword: 'aA1dev-secret',
      lanIp: '127.0.0.1',
      stubAi: false,
    });
    expect(env.BOB_DEV_PASSWORD).toBe('aA1dev-secret');
  });

  it('omits BOB_DEV_PASSWORD when no dev password is passed', () => {
    const env = buildEnvOverrides(statusEnv, { password: 'pw', lanIp: '127.0.0.1', stubAi: false });
    expect('BOB_DEV_PASSWORD' in env).toBe(false);
  });
});

describe('lanSupabaseUrl', () => {
  it('swaps loopback for the LAN address and keeps the port', () => {
    expect(lanSupabaseUrl('http://127.0.0.1:54321', '192.168.1.29')).toBe('http://192.168.1.29:54321');
  });
});

describe('readSignInCode', () => {
  it('reads the code from a top-level or nested generate_link response', () => {
    expect(readSignInCode({ email_otp: '123456', action_link: 'x' })).toBe('123456');
    expect(readSignInCode({ properties: { email_otp: '654321' } })).toBe('654321');
  });

  it('is null when there is no code', () => {
    expect(readSignInCode({})).toBeNull();
    expect(readSignInCode({ email_otp: '' })).toBeNull();
    expect(readSignInCode(null)).toBeNull();
  });
});

describe('parseArgs', () => {
  it('defaults to a normal run', () => {
    expect(parseArgs([])).toEqual({ stop: false, status: false, stubAi: false, code: false, regenPassword: false });
  });

  it('parses each flag', () => {
    expect(parseArgs(['--stop'])).toMatchObject({ stop: true });
    expect(parseArgs(['--status'])).toMatchObject({ status: true });
    expect(parseArgs(['--stub-ai'])).toMatchObject({ stubAi: true });
    expect(parseArgs(['--code'])).toMatchObject({ code: true });
    expect(parseArgs(['--regen-password'])).toMatchObject({ regenPassword: true });
  });

  it('combines flags', () => {
    expect(parseArgs(['--stop', '--stub-ai'])).toEqual({
      stop: true,
      status: false,
      stubAi: true,
      code: false,
      regenPassword: false,
    });
    expect(parseArgs(['--regen-password', '--stub-ai'])).toMatchObject({ regenPassword: true, stubAi: true });
  });
});

describe('findLanIpv4', () => {
  const v4 = (address, internal = false) => ({ family: 'IPv4', address, internal });

  it('returns a reachable IPv4 address or null, never throwing', () => {
    const ip = findLanIpv4();
    expect(ip === null || /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)).toBe(true);
  });

  it('prefers the home network over WSL, Docker and Tailscale adapters listed first', () => {
    expect(findLanIpv4({
      wsl: [v4('172.17.0.1')],
      tailscale: [v4('100.117.6.42')],
      lan: [v4('192.168.1.29')],
    })).toBe('192.168.1.29');
  });

  it('ranks 10.x above 172.16-31.x and skips loopback', () => {
    expect(findLanIpv4({ lo: [v4('127.0.0.1', true)], a: [v4('172.20.80.1')], b: [v4('10.0.0.5')] })).toBe('10.0.0.5');
  });

  it('falls back to a non-private address, then null', () => {
    expect(findLanIpv4({ tailscale: [v4('100.117.6.42')] })).toBe('100.117.6.42');
    expect(findLanIpv4({ lo: [v4('127.0.0.1', true)] })).toBeNull();
  });
});

describe('emailSignInEnabled', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when the settings endpoint reports external.email = true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ external: { email: true } }),
      }),
    );
    await expect(emailSignInEnabled('http://127.0.0.1:54321', 'pub-key')).resolves.toBe(true);
  });

  it('returns false when the settings endpoint reports external.email = false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ external: { email: false } }),
      }),
    );
    await expect(emailSignInEnabled('http://127.0.0.1:54321', 'pub-key')).resolves.toBe(false);
  });

  it('resolves false without throwing when the endpoint is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    await expect(emailSignInEnabled('http://127.0.0.1:54321', 'pub-key')).resolves.toBe(false);
  });
});

describe('generateDevPassword', () => {
  it('always passes the local Auth password policy and differs per call', () => {
    for (let i = 0; i < 25; i += 1) {
      expect(generateDevPassword()).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/);
    }
    expect(generateDevPassword()).not.toBe(generateDevPassword());
  });
});

describe('readOfflineSecret', () => {
  it('reads a KEY=value line among others', () => {
    expect(readOfflineSecret('BOB_SERVER_PASSWORD=srv\nBOB_DEV_PASSWORD=dev\n', 'BOB_DEV_PASSWORD')).toBe('dev');
  });

  it('is null when the key is absent or the inputs are unusable', () => {
    expect(readOfflineSecret('BOB_SERVER_PASSWORD=srv\n', 'BOB_DEV_PASSWORD')).toBeNull();
    expect(readOfflineSecret(null, 'BOB_DEV_PASSWORD')).toBeNull();
    expect(readOfflineSecret('BOB_DEV_PASSWORD=dev\n', '')).toBeNull();
  });
});

describe('ensureOfflineSecret', () => {
  it('keeps the stored value and leaves the text untouched', () => {
    const text = 'BOB_SERVER_PASSWORD=srv\nBOB_DEV_PASSWORD=dev\n';
    expect(ensureOfflineSecret(text, 'BOB_DEV_PASSWORD', 'fresh')).toEqual({ value: 'dev', text, dirty: false });
  });

  it('appends a new secret, preserving existing lines', () => {
    expect(ensureOfflineSecret('BOB_SERVER_PASSWORD=srv\n', 'BOB_DEV_PASSWORD', 'fresh')).toEqual({
      value: 'fresh',
      text: 'BOB_SERVER_PASSWORD=srv\nBOB_DEV_PASSWORD=fresh\n',
      dirty: true,
    });
  });

  it('starts a fresh file on first run and tolerates a missing trailing newline', () => {
    expect(ensureOfflineSecret(null, 'BOB_DEV_PASSWORD', 'fresh')).toEqual({
      value: 'fresh',
      text: 'BOB_DEV_PASSWORD=fresh\n',
      dirty: true,
    });
    expect(ensureOfflineSecret('BOB_SERVER_PASSWORD=srv', 'BOB_DEV_PASSWORD', 'fresh')).toEqual({
      value: 'fresh',
      text: 'BOB_SERVER_PASSWORD=srv\nBOB_DEV_PASSWORD=fresh\n',
      dirty: true,
    });
  });
});

describe('overwriteOfflineSecret', () => {
  it('replaces the stored value while preserving every other line', () => {
    expect(
      overwriteOfflineSecret('BOB_SERVER_PASSWORD=srv\nBOB_DEV_PASSWORD=old\n', 'BOB_DEV_PASSWORD', 'fresh'),
    ).toEqual({
      value: 'fresh',
      text: 'BOB_SERVER_PASSWORD=srv\nBOB_DEV_PASSWORD=fresh\n',
      dirty: true,
    });
  });

  it('appends when the key is absent and starts a fresh file on first run', () => {
    expect(overwriteOfflineSecret('BOB_SERVER_PASSWORD=srv\n', 'BOB_DEV_PASSWORD', 'fresh')).toEqual({
      value: 'fresh',
      text: 'BOB_SERVER_PASSWORD=srv\nBOB_DEV_PASSWORD=fresh\n',
      dirty: true,
    });
    expect(overwriteOfflineSecret(null, 'BOB_DEV_PASSWORD', 'fresh')).toEqual({
      value: 'fresh',
      text: 'BOB_DEV_PASSWORD=fresh\n',
      dirty: true,
    });
  });

  it('tolerates a missing trailing newline', () => {
    expect(
      overwriteOfflineSecret('BOB_SERVER_PASSWORD=srv\nBOB_DEV_PASSWORD=old', 'BOB_DEV_PASSWORD', 'fresh'),
    ).toEqual({
      value: 'fresh',
      text: 'BOB_SERVER_PASSWORD=srv\nBOB_DEV_PASSWORD=fresh\n',
      dirty: true,
    });
  });
});

describe('ensureDevUser', () => {
  const API = 'http://127.0.0.1:54321';
  const EMAIL = 'dev@bob.local';
  const PASSWORD = 'aA1stable-dev-password';
  const devRow = (id) => ({ id, email: EMAIL });
  const others = (n, from) => Array.from({ length: n }, (_, i) => ({ email: `user${from + i}@test.local` }));

  /**
   * A fake auth admin API: `pages` answer the list calls, `create` the POST,
   * `update` the PUT. Lists default to short pages, so pagination stops.
   */
  function fakeAuth(pages, create = { status: 201, body: '{}' }, update = { status: 200, body: '{}' }) {
    const fetchMock = vi.fn(async (url, init = {}) => {
      if (init.method === 'POST') return { status: create.status, text: async () => create.body };
      if (init.method === 'PUT') return { status: update.status, text: async () => update.body };
      const page = Number(new URL(url).searchParams.get('page'));
      return { status: 200, json: async () => ({ users: pages[page - 1] ?? [] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const posts = (fetchMock) => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
  const puts = (fetchMock) => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
  const listedPages = (fetchMock) =>
    fetchMock.mock.calls.filter(([, init]) => init?.method === undefined).map(([url]) => new URL(url).searchParams.get('page'));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finds the dev user on page 2 and re-applies the password instead of creating', async () => {
    const fetchMock = fakeAuth([others(100, 0), [...others(10, 100), devRow('dev-id')]]);
    await ensureDevUser(API, 'service-key', EMAIL, PASSWORD);
    expect(posts(fetchMock)).toHaveLength(0);
    expect(listedPages(fetchMock)).toEqual(['1', '2']);
    expect(puts(fetchMock)).toHaveLength(1);
    const [[url, init]] = puts(fetchMock);
    expect(url).toBe(`${API}/auth/v1/admin/users/dev-id`);
    expect(JSON.parse(init.body)).toEqual({ password: PASSWORD, email_confirm: true });
  });

  it('rotation (--regen-password) overwrites the stored password and re-applies it to the dev user', async () => {
    const stored = 'BOB_SERVER_PASSWORD=srv\nBOB_DEV_PASSWORD=old\n';
    const fresh = generateDevPassword();
    expect(fresh).not.toBe('old');
    const rotated = overwriteOfflineSecret(stored, 'BOB_DEV_PASSWORD', fresh);
    expect(rotated.text).toContain('BOB_SERVER_PASSWORD=srv\n');
    expect(rotated.text).toContain(`BOB_DEV_PASSWORD=${fresh}\n`);
    const fetchMock = fakeAuth([[devRow('dev-id'), ...others(1, 0)]]);
    await ensureDevUser(API, 'service-key', EMAIL, rotated.value);
    expect(posts(fetchMock)).toHaveLength(0);
    expect(puts(fetchMock)).toHaveLength(1);
    const [[url, init]] = puts(fetchMock);
    expect(url).toBe(`${API}/auth/v1/admin/users/dev-id`);
    expect(JSON.parse(init.body)).toEqual({ password: fresh, email_confirm: true });
  });

  it('creates a confirmed dev user with the given password when no page has it', async () => {
    const fetchMock = fakeAuth([others(100, 0), others(3, 100)]);
    await ensureDevUser(API, 'service-key', EMAIL, PASSWORD);
    expect(puts(fetchMock)).toHaveLength(0);
    const [[, init]] = posts(fetchMock);
    expect(JSON.parse(init.body)).toMatchObject({ email: EMAIL, password: PASSWORD, email_confirm: true });
  });

  it('re-lists and updates after a 422 email_exists on create', async () => {
    let lists = 0;
    const calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        calls.push([url, init]);
        if (init.method === 'POST') return { status: 422, text: async () => '{"error_code":"email_exists"}' };
        if (init.method === 'PUT') return { status: 200, text: async () => '{}' };
        lists += 1;
        return { status: 200, json: async () => ({ users: lists === 1 ? [] : [devRow('dev-id')] }) };
      }),
    );
    await ensureDevUser(API, 'service-key', EMAIL, PASSWORD);
    const put = calls.find(([, init]) => init?.method === 'PUT');
    expect(put[0]).toBe(`${API}/auth/v1/admin/users/dev-id`);
    expect(JSON.parse(put[1].body)).toMatchObject({ password: PASSWORD });
  });

  it('still reports email_exists when the re-list finds nobody', async () => {
    fakeAuth([others(5, 0)], { status: 422, body: '{"code":422,"error_code":"email_exists","msg":"exists"}' });
    await expect(ensureDevUser(API, 'service-key', EMAIL, PASSWORD)).rejects.toThrow('admin user create failed (422)');
  });

  it('fails loudly when the password update is rejected', async () => {
    fakeAuth([[devRow('dev-id')]], undefined, { status: 400, body: '{"error_code":"weak_password"}' });
    await expect(ensureDevUser(API, 'service-key', EMAIL, PASSWORD)).rejects.toThrow(
      'admin user password update failed (400): {"error_code":"weak_password"}',
    );
  });

  it('refuses a provided-but-empty password instead of writing a weak one', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(ensureDevUser(API, 'service-key', EMAIL, '')).rejects.toThrow(
      'ensureDevUser requires a non-empty dev password',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves an existing user untouched without a password (e2e code sign-in)', async () => {
    const fetchMock = fakeAuth([[devRow('dev-id')]]);
    await ensureDevUser(API, 'service-key', EMAIL);
    expect(posts(fetchMock)).toHaveLength(0);
    expect(puts(fetchMock)).toHaveLength(0);
  });

  it('treats a 422 email_exists without a password as success (e2e code sign-in)', async () => {
    fakeAuth([others(5, 0)], { status: 422, body: '{"code":422,"error_code":"email_exists","msg":"exists"}' });
    await expect(ensureDevUser(API, 'service-key', EMAIL)).resolves.toBeUndefined();
  });

  it('still fails on other create errors with the status and body', async () => {
    fakeAuth([[]], { status: 422, body: '{"error_code":"weak_password"}' });
    await expect(ensureDevUser(API, 'service-key', EMAIL, PASSWORD)).rejects.toThrow(
      'admin user create failed (422): {"error_code":"weak_password"}',
    );
    fakeAuth([[]], { status: 500, body: 'boom' });
    await expect(ensureDevUser(API, 'service-key', EMAIL, PASSWORD)).rejects.toThrow('admin user create failed (500): boom');
  });

  it('fails when the lookup itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, json: async () => ({}) }));
    await expect(ensureDevUser(API, 'service-key', EMAIL, PASSWORD)).rejects.toThrow('auth admin lookup failed (401)');
  });
});

describe('createSignInCode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks generate_link by email, so it works wherever the user sits in the list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ email_otp: '424242' }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(createSignInCode('http://127.0.0.1:54321', 'service-key', 'dev@bob.local')).resolves.toBe('424242');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:54321/auth/v1/admin/generate_link');
    expect(JSON.parse(init.body)).toEqual({ type: 'magiclink', email: 'dev@bob.local' });
  });
});

describe('buildLocalMigrationUpArgs', () => {
  it('always targets the LOCAL stack, so --include-all never reaches a remote project', () => {
    const args = buildLocalMigrationUpArgs();
    expect(args.includes('--local')).toBe(true);
    expect(args.includes('--include-all')).toBe(true);
    expect(args.some((a) => /^--(linked|db-url|project-ref)/.test(a))).toBe(false);
  });
});

describe('parseMigrationList', () => {
  it('reads local and applied versions from the JSON line, ignoring CLI chatter', () => {
    const text = [
      'Connecting to local database...',
      '{"migrations":[{"local":"20260926150000","remote":"","time":""},{"local":"20260927010000","remote":"20260927010000","time":"x"}],"message":"Migrations listed"}',
      'A new version of Supabase CLI is available',
    ].join('\n');
    expect(parseMigrationList(text)).toEqual({ local: ['20260926150000', '20260927010000'], applied: ['20260927010000'] });
  });

  it('is null for output with no migration list', () => {
    expect(parseMigrationList('')).toBeNull();
    expect(parseMigrationList('{not json')).toBeNull();
    expect(parseMigrationList('{"message":"x"}')).toBeNull();
  });
});

describe('outOfOrderPending', () => {
  it('names pending migrations that sort before the newest applied one (#558)', () => {
    const list = { local: ['20260926150000', '20260927010000', '20260928000000'], applied: ['20260927010000'] };
    expect(outOfOrderPending(list)).toEqual(['20260926150000']);
  });

  it('is empty when pending migrations only come after, or nothing is applied', () => {
    expect(outOfOrderPending({ local: ['1', '2', '3'], applied: ['1', '2'] })).toEqual([]);
    expect(outOfOrderPending({ local: ['1'], applied: [] })).toEqual([]);
    expect(outOfOrderPending(null)).toEqual([]);
  });
});
