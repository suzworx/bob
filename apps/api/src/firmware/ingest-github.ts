import { firmwareGithubConfig, type FirmwareGithubConfig } from './github-config.ts';
import type { Db } from '../platform/db/db.ts';
import { ingestRelease, type IngestResult } from './store.ts';

type IngestSourceCode = 'bad_tag' | 'release_not_found' | 'asset_missing' | 'too_large' | 'fetch_failed';

/** A release that could not be fetched; the code is a reason, never a URL or a response body. */
export class IngestSourceError extends Error {
  constructor(readonly code: IngestSourceCode) {
    super(`firmware release not fetched: ${code}`);
    this.name = 'IngestSourceError';
  }
}

export interface IngestDeps {
  fetch?: typeof fetch;
  config?: FirmwareGithubConfig;
  keys?: Readonly<Record<string, string>>;
}

const TAG_RE = /^v\d+\.\d+\.\d+$/;
const releaseAssets = (json: unknown): Map<string, { url: string; size: number }> => {
  const assets = new Map<string, { url: string; size: number }>();
  const list = (json as { assets?: unknown } | null)?.assets;
  for (const asset of Array.isArray(list) ? list : []) {
    const { name, url, size } = asset as { name?: unknown; url?: unknown; size?: unknown };
    if (typeof name === 'string' && typeof url === 'string' && typeof size === 'number') assets.set(name, { url, size });
  }
  return assets;
};

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader === undefined) throw new IngestSourceError('fetch_failed');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new IngestSourceError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Fetches the bin, manifest.json and manifest.sig of release `tag` (vX.Y.Z) and hands them to ingestRelease. */
export async function ingestFromGithub(db: Db, { tag }: { tag: string }, deps: IngestDeps = {}): Promise<IngestResult> {
  if (!TAG_RE.test(tag)) throw new IngestSourceError('bad_tag');
  const config = deps.config ?? firmwareGithubConfig();
  const doFetch = deps.fetch ?? fetch;
  const headers = (accept: string): Record<string, string> => ({
    Accept: accept,
    'User-Agent': 'bob-api',
    ...(config.token === undefined ? {} : { Authorization: `Bearer ${config.token}` }),
  });
  const get = async (url: string, accept: string): Promise<Response> => {
    try {
      return await doFetch(url, { headers: headers(accept), signal: AbortSignal.timeout(config.timeoutMs) });
    } catch {
      throw new IngestSourceError('fetch_failed');
    }
  };

  const release = await get(`https://api.github.com/repos/${config.repo}/releases/tags/${tag}`, 'application/vnd.github+json');
  if (release.status === 404) throw new IngestSourceError('release_not_found');
  if (!release.ok) throw new IngestSourceError('fetch_failed');
  const assets = releaseAssets(await release.json().catch(() => null));

  const download = async (name: string): Promise<Buffer> => {
    const asset = assets.get(name);
    if (asset === undefined) throw new IngestSourceError('asset_missing');
    if (asset.size > config.maxBytes) throw new IngestSourceError('too_large');
    const response = await get(asset.url, 'application/octet-stream');
    if (!response.ok) throw new IngestSourceError('fetch_failed');
    return readCapped(response, config.maxBytes);
  };

  const [image, manifestBytes, sig] = await Promise.all([
    download(`bob-cardputer-${tag}.bin`),
    download('manifest.json'),
    download('manifest.sig'),
  ]);
  return ingestRelease(db, { manifestBytes, sigB64: sig.toString('utf8').trim(), image }, deps.keys);
}
