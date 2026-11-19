/**
 * Downloads one hosted, immutable speech pack into a fresh temp
 * directory, so the ordinary directory loader in speech-assets.ts can verify
 * and serve it. Production has no persistent disk: the pack is fetched once per
 * process at boot. Bounded: manifest 64 KiB, pack 8 MiB, per-request timeout,
 * limited concurrency, clip paths checked before any request.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SpeechAssetManifestSchema, type SpeechAssetClip } from './speech-assets-manifest.ts';

const SPEECH_PACK_MAX_MANIFEST_BYTES = 64 * 1024;
const SPEECH_PACK_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const CONCURRENCY = 4;
/** Slash-separated plain segments: no `..`, backslash, colon, query or absolute path. */
const SAFE_CLIP_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export type SpeechPackFailure = 'http' | 'timeout' | 'network' | 'too_large' | 'invalid_manifest' | 'unsafe_path' | 'checksum' | 'disk';

export class SpeechPackFetchError extends Error {
  constructor(readonly reason: SpeechPackFailure) {
    super(`Speech pack download failed: ${reason}`);
    this.name = 'SpeechPackFetchError';
  }
}

export interface FetchedSpeechPack { directory: string; clips: number; bytes: number }

function classify(error: unknown): SpeechPackFetchError {
  if (error instanceof SpeechPackFetchError) return error;
  // Node fs errors carry a string code (ENOSPC, EACCES); fetch and abort errors do not.
  if (typeof (error as { code?: unknown } | null)?.code === 'string') return new SpeechPackFetchError('disk');
  const name = error instanceof Error ? error.name : '';
  return new SpeechPackFetchError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
}

async function boundedGet(url: URL, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new SpeechPackFetchError('http');
    }
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
      await response.body.cancel();
      throw new SpeechPackFetchError('too_large');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) throw new SpeechPackFetchError('too_large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    throw classify(error);
  }
}

/** The clips a hosted manifest lists, refused unless the build, every path and the total size are fit to host. */
export function hostedPackClips(raw: Buffer, buildVersion: string): SpeechAssetClip[] {
  let clips: SpeechAssetClip[];
  try {
    const manifest = SpeechAssetManifestSchema.parse(JSON.parse(raw.toString('utf8')));
    if (manifest.buildVersion !== buildVersion) throw new Error('build mismatch');
    clips = manifest.clips;
  } catch {
    throw new SpeechPackFetchError('invalid_manifest');
  }
  if (clips.some((clip) => !SAFE_CLIP_PATH.test(clip.path))) throw new SpeechPackFetchError('unsafe_path');
  if (clips.reduce((sum, clip) => sum + clip.bytes, 0) > SPEECH_PACK_MAX_BYTES) throw new SpeechPackFetchError('too_large');
  return clips;
}

function clipUrl(base: URL, path: string): URL {
  return new URL(path.split('/').map(encodeURIComponent).join('/'), base);
}

async function downloadClips(base: URL, directory: string, clips: SpeechAssetClip[], timeoutMs: number): Promise<void> {
  const queue = [...clips];
  let failed = false;
  const worker = async (): Promise<void> => {
    for (let clip = queue.shift(); clip !== undefined && !failed; clip = queue.shift()) {
      const bytes = await boundedGet(clipUrl(base, clip.path), clip.bytes, timeoutMs);
      if (bytes.length !== clip.bytes || createHash('sha256').update(bytes).digest('hex') !== clip.sha256) {
        throw new SpeechPackFetchError('checksum');
      }
      const target = join(directory, ...clip.path.split('/'));
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, clips.length) }, async () => {
    try {
      await worker();
    } catch (error) {
      failed = true;
      throw error;
    }
  }));
  const rejected = settled.find((result) => result.status === 'rejected');
  if (rejected !== undefined) throw rejected.reason;
}

/** Throws SpeechPackFetchError; a partial download is removed. */
export async function fetchSpeechPack(
  baseUrl: string,
  buildVersion: string,
  options: { timeoutMs?: number } = {},
): Promise<FetchedSpeechPack> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let base: URL;
  try {
    base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  } catch {
    throw new SpeechPackFetchError('network');
  }
  const raw = await boundedGet(new URL('manifest.json', base), SPEECH_PACK_MAX_MANIFEST_BYTES, timeoutMs);
  const clips = hostedPackClips(raw, buildVersion);
  const parent = join(tmpdir(), 'bob-speech-assets');
  let directory: string;
  try {
    await fs.mkdir(parent, { recursive: true });
    directory = await fs.mkdtemp(join(parent, `${buildVersion}-`));
  } catch (error) {
    throw classify(error);
  }
  try {
    await downloadClips(base, directory, clips, timeoutMs);
    await fs.writeFile(join(directory, 'manifest.json'), raw);
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw classify(error);
  }
  return { directory, clips: clips.length, bytes: clips.reduce((sum, clip) => sum + clip.bytes, 0) };
}
