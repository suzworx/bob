/**
 * apps/api/scripts/upload-speech-pack.ts against a fake Supabase Storage on
 * loopback: creates the public bucket, uploads only the manifest's clips with
 * the manifest last, refuses an existing build, and the uploaded pack is what
 * the server's boot download accepts.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { uploadSpeechPack } from '../../scripts/upload-speech-pack.ts';
import { fetchSpeechPack } from '../../src/voice/speech-assets-remote.ts';

const BUILD = 'upload-1';
const KEY = 'test-service-key';
const lead = Buffer.alloc(3_200, 3);

interface Storage { url: string; objects: Map<string, Buffer>; order: string[]; buckets: Map<string, boolean>; auth: string[] }

const servers: Server[] = [];
const dirs: string[] = [];

/** Just enough of the Storage REST API: bucket get/create, list by prefix, upload without upsert, public read. */
async function storage(): Promise<Storage> {
  const state: Omit<Storage, 'url'> = { objects: new Map(), order: [], buckets: new Map(), auth: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
      const send = (status: number, json: unknown): void => { res.statusCode = status; res.end(JSON.stringify(json)); };
      const publicRead = path.match(/^\/storage\/v1\/object\/public\/speech-packs\/(.+)$/);
      if (publicRead?.[1] !== undefined) {
        const object = state.objects.get(publicRead[1]);
        if (object === undefined || state.buckets.get('speech-packs') !== true) return send(400, { error: 'not_found' });
        res.statusCode = 200;
        return res.end(object);
      }
      state.auth.push(String(req.headers.apikey ?? ''));
      if (req.headers.apikey !== KEY) return send(401, { error: 'unauthorized' });
      if (req.method === 'GET' && path === '/storage/v1/bucket/speech-packs') {
        return state.buckets.has('speech-packs') ? send(200, { id: 'speech-packs', public: state.buckets.get('speech-packs') }) : send(400, { error: 'Bucket not found' });
      }
      if (req.method === 'POST' && path === '/storage/v1/bucket') {
        const parsed = JSON.parse(body.toString()) as { id: string; public: boolean };
        state.buckets.set(parsed.id, parsed.public);
        return send(200, { name: parsed.id });
      }
      if (req.method === 'POST' && path === '/storage/v1/object/list/speech-packs') {
        const { prefix } = JSON.parse(body.toString()) as { prefix: string };
        const names = [...state.objects.keys()].filter((name) => name.startsWith(`${prefix}/`));
        return send(200, names.map((name) => ({ name })));
      }
      const upload = path.match(/^\/storage\/v1\/object\/speech-packs\/(.+)$/);
      if (req.method === 'POST' && upload?.[1] !== undefined) {
        if (state.objects.has(upload[1])) return send(400, { error: 'Duplicate' });
        state.objects.set(upload[1], body);
        state.order.push(upload[1]);
        return send(200, { Key: upload[1] });
      }
      return send(404, { error: 'route' });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return { ...state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function packDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'bob-upload-'));
  dirs.push(dir);
  await fs.mkdir(join(dir, 'clips'));
  await fs.writeFile(join(dir, 'clips', 'lead.pcm'), lead);
  await fs.writeFile(join(dir, 'audition.wav'), Buffer.alloc(44));
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2, buildVersion: BUILD, model: 'model-1', voice: 'voice-1', locale: 'en-US',
    clips: [{ id: 'lead', path: 'clips/lead.pcm', sha256: createHash('sha256').update(lead).digest('hex'), bytes: lead.length, durationMs: 100, sampleRateHz: 16_000 }],
    templates: [{ id: 'hi', segments: [{ type: 'literal', text: 'Hi.', clipId: 'lead' }] }],
  }));
  return dir;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('upload-speech-pack', () => {
  it('uploads the listed clips then the manifest to a new public bucket, and the server can fetch it', async () => {
    const host = await storage();
    const dir = await packDir();
    const { url, build } = await uploadSpeechPack({ dir, supabaseUrl: host.url, key: KEY });
    expect(build).toBe(BUILD);
    expect(url).toBe(`${host.url}/storage/v1/object/public/speech-packs/${BUILD}/`);
    expect(host.buckets.get('speech-packs')).toBe(true);
    expect(host.order).toEqual([`${BUILD}/clips/lead.pcm`, `${BUILD}/manifest.json`]);
    const fetched = await fetchSpeechPack(url, BUILD);
    dirs.push(fetched.directory);
    expect(await fs.readFile(join(fetched.directory, 'clips', 'lead.pcm'))).toEqual(lead);
  });

  it('refuses to overwrite an existing build and a clip that does not match its manifest', async () => {
    const host = await storage();
    const dir = await packDir();
    await uploadSpeechPack({ dir, supabaseUrl: host.url, key: KEY });
    await expect(uploadSpeechPack({ dir, supabaseUrl: host.url, key: KEY })).rejects.toThrow(/already exists/);
    expect(host.order).toHaveLength(2);

    const other = await storage();
    await fs.writeFile(join(dir, 'clips', 'lead.pcm'), Buffer.alloc(lead.length, 7));
    await expect(uploadSpeechPack({ dir, supabaseUrl: other.url, key: KEY })).rejects.toThrow(/does not match/);
    expect(other.order).toEqual([]);
  });
});
