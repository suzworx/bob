/** ingestFromGithub with a stubbed fetch (no network) and an ephemeral signing key, on the real local Postgres. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firmwareGithubConfig, type FirmwareGithubConfig } from '../../src/firmware/github-config.ts';
import { ingestFromGithub, IngestSourceError } from '../../src/firmware/ingest-github.ts';
import { getImage } from '../../src/firmware/store.ts';
import { FirmwareVerifyError } from '../../src/firmware/verify.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { makeImage, makeKey, makeManifest, signManifest } from './fixture.ts';

const key = makeKey('k1');
const keys = { k1: key.pem };
const config: FirmwareGithubConfig = { repo: 'acme/bob', token: 'ghp_test', timeoutMs: 30_000, maxBytes: 4096 };

interface Bundle { files: Record<string, Buffer>; reported?: number }

function bundle(version: string, over: { image?: Buffer; sigKey?: typeof key } = {}): Bundle {
  const image = makeImage(5, 2048);
  const { manifestBytes, sigB64 } = signManifest(makeManifest(image, key, { version }), over.sigKey ?? key);
  return { files: { [`bob-cardputer-v${version}.bin`]: over.image ?? image, 'manifest.json': manifestBytes, 'manifest.sig': Buffer.from(sigB64) } };
}

function stub(release: Bundle | null, calls: Array<{ url: string; auth: string | null }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.includes('/releases/tags/')) {
      if (release === null) return new Response('{}', { status: 404 });
      const assets = Object.entries(release.files).map(([name, bytes]) => ({ name, url: `https://assets.test/${name}`, size: release.reported ?? bytes.length }));
      return new Response(JSON.stringify({ assets }));
    }
    const file = release?.files[url.split('/').pop() ?? ''];
    return new Response(file === undefined ? '' : new Uint8Array(file), { status: release === null ? 404 : 200 });
  }) as typeof fetch;
}

describe('ingestFromGithub', () => {
  let pg: TestDb;
  let db: Db;
  const code = (run: Promise<unknown>): Promise<string> =>
    run.then(() => 'accepted', (e: unknown) => (e instanceof IngestSourceError || e instanceof FirmwareVerifyError ? e.code : 'untyped'));

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
  }, 120_000);

  afterAll(async () => {
    await closeTestDb(pg);
  });

  it('fetches the three assets with the token and ingests the verified release', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const result = await ingestFromGithub(db, { tag: 'v2.0.0' }, { fetch: stub(bundle('2.0.0'), calls), config, keys });
    expect(result).toEqual({ version: '2.0.0', inserted: true, advanced: ['cardputer'] });
    expect((await getImage(db, '2.0.0', 'cardputer'))?.bytes.equals(makeImage(5, 2048))).toBe(true);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/bob/releases/tags/v2.0.0');
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.auth === 'Bearer ghp_test')).toBe(true);
  });

  it('sends no authorization header without a token', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    await ingestFromGithub(db, { tag: 'v2.0.1' }, { fetch: stub(bundle('2.0.1'), calls), config: { ...config, token: undefined }, keys });
    expect(calls.every((call) => call.auth === null)).toBe(true);
  });

  it('rejects a bad signature, an unknown key and an image that differs from the manifest', async () => {
    const run = (b: Bundle, k: Record<string, string> = keys) => ingestFromGithub(db, { tag: 'v2.1.0' }, { fetch: stub(b), config, keys: k });
    expect(await code(run(bundle('2.1.0', { sigKey: makeKey('k1') })))).toBe('bad_signature');
    expect(await code(run(bundle('2.1.0'), {}))).toBe('unknown_key');
    expect(await code(run(bundle('2.1.0', { image: makeImage(6, 2048) })))).toBe('image_mismatch');
    expect(await getImage(db, '2.1.0', 'cardputer')).toBeNull();
  });

  it('rejects an oversize file, whether GitHub reports its size or lies about it', async () => {
    const big = bundle('2.2.0', { image: makeImage(5, 8192) });
    expect(await code(ingestFromGithub(db, { tag: 'v2.2.0' }, { fetch: stub(big), config, keys }))).toBe('too_large');
    expect(await code(ingestFromGithub(db, { tag: 'v2.2.0' }, { fetch: stub({ ...big, reported: 100 }), config, keys }))).toBe('too_large');
  });

  it('names a missing release, a missing asset, a bad tag and a failing network', async () => {
    const run = (tag: string, fetcher: typeof fetch) => ingestFromGithub(db, { tag }, { fetch: fetcher, config, keys });
    expect(await code(run('v3.0.0', stub(null)))).toBe('release_not_found');
    const partial = bundle('3.0.1');
    delete partial.files['manifest.sig'];
    expect(await code(run('v3.0.1', stub(partial)))).toBe('asset_missing');
    expect(await code(run('latest', stub(bundle('3.0.2'))))).toBe('bad_tag');
    expect(await code(run('v3.0.3', (() => Promise.reject(new Error('down'))) as typeof fetch))).toBe('fetch_failed');
  });

  it('reads its settings from the environment, with defaults', () => {
    expect(firmwareGithubConfig({})).toMatchObject({ repo: 'suzworx/Bob', token: undefined, maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000 });
    expect(firmwareGithubConfig({ BOB_FW_GITHUB_REPO: 'a/b', BOB_FW_GITHUB_TOKEN: 't' })).toMatchObject({ repo: 'a/b', token: 't' });
    expect(() => firmwareGithubConfig({ BOB_FW_GITHUB_REPO: 'nope' })).toThrow('owner/name');
  });
});
