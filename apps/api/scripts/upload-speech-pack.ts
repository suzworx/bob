/**
 * Uploads a recorded speech pack (#1000/#1003) to the production Supabase
 * Storage bucket `speech-packs`, under its immutable build path:
 *
 *   npx tsx apps/api/scripts/upload-speech-pack.ts --dir data/voice-assets/<build> [--env <file>]
 *
 * Only `manifest.json` and the clips it lists go up (never audition.wav,
 * spec.json or pack.json), the manifest last so a half-uploaded build is never
 * loadable. The bucket is created PUBLIC when absent: packs hold public
 * phrases from a committed spec only, never user content. An existing build is
 * refused, never overwritten: an upload that stops partway leaves a build
 * with no manifest (never loadable); re-record for a fresh build id. Each clip is checked against the manifest first,
 * with the same limits the server's boot download applies.
 *
 * Key: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY, else the project's
 * secret key read in memory through the Management API with
 * SUPABASE_ACCESS_TOKEN. The key is never printed. Prints the
 * BOB_SPEECH_ASSETS_URL / BOB_SPEECH_ASSETS_BUILD lines.
 */
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostedPackClips } from '../src/voice/speech-assets-remote.ts';

const BUCKET = 'speech-packs';
const IMMUTABLE_CACHE = 'max-age=31536000';

export interface UploadOptions { dir: string; supabaseUrl: string; key: string }

function storageHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function storageCall(options: UploadOptions, method: string, path: string, body?: Buffer | string, extra?: Record<string, string>): Promise<Response> {
  return fetch(`${options.supabaseUrl}/storage/v1/${path}`, { method, body: typeof body === 'string' || body === undefined ? body : new Uint8Array(body), headers: storageHeaders(options.key, extra) });
}

async function ensurePublicBucket(options: UploadOptions): Promise<void> {
  const existing = await storageCall(options, 'GET', `bucket/${BUCKET}`);
  if (existing.ok) {
    const bucket = await existing.json() as { public?: boolean };
    if (bucket.public !== true) throw new Error(`bucket ${BUCKET} exists but is not public`);
    return;
  }
  const created = await storageCall(options, 'POST', 'bucket', JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
    { 'content-type': 'application/json' });
  if (!created.ok) throw new Error(`creating bucket ${BUCKET} failed: HTTP ${created.status}`);
}

async function refuseExistingBuild(options: UploadOptions, build: string): Promise<void> {
  const listed = await storageCall(options, 'POST', `object/list/${BUCKET}`, JSON.stringify({ prefix: build, limit: 1, offset: 0 }),
    { 'content-type': 'application/json' });
  if (!listed.ok) throw new Error(`listing ${BUCKET}/${build} failed: HTTP ${listed.status}`);
  if ((await listed.json() as unknown[]).length > 0) throw new Error(`build ${build} already exists; builds are immutable`);
}

async function putObject(options: UploadOptions, name: string, bytes: Buffer, contentType: string): Promise<void> {
  const path = name.split('/').map(encodeURIComponent).join('/');
  const response = await storageCall(options, 'POST', `object/${BUCKET}/${path}`, bytes,
    { 'content-type': contentType, 'x-upsert': 'false', 'cache-control': IMMUTABLE_CACHE });
  if (!response.ok) throw new Error(`uploading ${name} failed: HTTP ${response.status}`);
}

/** Returns the public pack URL for BOB_SPEECH_ASSETS_URL and the build id. */
export async function uploadSpeechPack(options: UploadOptions): Promise<{ url: string; build: string }> {
  const raw = await fs.readFile(join(options.dir, 'manifest.json'));
  const { buildVersion } = JSON.parse(raw.toString('utf8')) as { buildVersion: string };
  const clips = hostedPackClips(raw, buildVersion);
  const files = await Promise.all(clips.map(async (clip) => {
    const bytes = await fs.readFile(join(options.dir, ...clip.path.split('/')));
    if (bytes.length !== clip.bytes || createHash('sha256').update(bytes).digest('hex') !== clip.sha256) {
      throw new Error(`clip ${clip.id} does not match the manifest`);
    }
    return { name: `${buildVersion}/${clip.path}`, bytes };
  }));
  await ensurePublicBucket(options);
  await refuseExistingBuild(options, buildVersion);
  for (const file of files) await putObject(options, file.name, file.bytes, 'application/octet-stream');
  await putObject(options, `${buildVersion}/manifest.json`, raw, 'application/json');
  return { url: `${options.supabaseUrl}/storage/v1/object/public/${BUCKET}/${buildVersion}/`, build: buildVersion };
}

/** The project's secret (service role) key, in memory only. */
async function managementKey(supabaseUrl: string, accessToken: string): Promise<string> {
  const ref = new URL(supabaseUrl).hostname.split('.')[0] ?? '';
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`reading the project keys failed: HTTP ${response.status}`);
  const keys = await response.json() as Array<{ name?: string; type?: string; api_key?: string }>;
  const key = keys.find((entry) => entry.type === 'secret') ?? keys.find((entry) => entry.name === 'service_role');
  if (key?.api_key === undefined) throw new Error('no secret key on the project');
  return key.api_key;
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const dir = arg('dir');
  if (dir === undefined) throw new Error('usage: upload-speech-pack.ts --dir <packDir> [--env <file>]');
  const envFile = resolve(arg('env') ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  if (supabaseUrl === '') throw new Error('SUPABASE_URL is not set');
  const direct = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? '';
  const token = process.env.SUPABASE_ACCESS_TOKEN ?? '';
  if (direct === '' && token === '') throw new Error('set SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SECRET_KEY or SUPABASE_ACCESS_TOKEN');
  const key = direct !== '' ? direct : await managementKey(supabaseUrl, token);
  const { url, build } = await uploadSpeechPack({ dir: resolve(dir), supabaseUrl, key });
  console.log(`BOB_SPEECH_ASSETS_URL=${url}\nBOB_SPEECH_ASSETS_BUILD=${build}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'upload failed');
    process.exitCode = 1;
  });
}
