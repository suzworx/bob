/**
 * Hosted speech packs (#1000/#1003): with BOB_SPEECH_ASSETS_URL the server
 * downloads one immutable pack at boot into a fresh temp directory, then the
 * ordinary directory loader verifies it. Any download failure is one bounded
 * journal line and ordinary TTS; nothing is fetched again during turns.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchSpeechPack, SpeechPackFetchError } from '../../src/voice/speech-assets-remote.ts';
import { withSpeechAssetsFromEnv } from '../../src/voice/speech-assets.ts';
import type { SpeechPort } from '../../src/voice/speech-port.ts';
import { setJournalSink } from '../../src/platform/logger.ts';

const BUILD = 'hosted-1';
const identity = { buildVersion: BUILD, model: 'model-1', voice: 'voice-1', locale: 'en-US' };
const lead = Buffer.alloc(3_200, 3);
const five = Buffer.alloc(6_400, 5);
const PHRASE = 'Timer set for five minutes.';

interface Route { status?: number; body?: Buffer; delayMs?: number }

function clipEntry(id: string, bytes: Buffer, path = `${id}.pcm`): Record<string, unknown> {
  return { id, path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    durationMs: Math.round(bytes.length / 32), sampleRateHz: 16_000 };
}

function manifest(changes: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 2, ...identity,
    clips: [clipEntry('lead', lead), clipEntry('five', five)],
    templates: [{ id: 'timer', segments: [
      { type: 'literal', text: 'Timer set for ', clipId: 'lead' },
      { type: 'slot', values: [{ text: 'five minutes.', clipId: 'five' }] },
    ] }],
    ...changes,
  }));
}

const servers: Server[] = [];
const dirs: string[] = [];

/** A static pack host on loopback; `requests` lists every path asked for. */
async function host(routes: Record<string, Route>): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '').replace(`/speech-packs/${BUILD}/`, '');
    requests.push(path);
    const route = routes[path] ?? { status: 404 };
    setTimeout(() => {
      res.statusCode = route.status ?? 200;
      res.end(route.body ?? '');
    }, route.delayMs ?? 0);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/speech-packs/${BUILD}/`, requests };
}

function validRoutes(): Record<string, Route> {
  return { 'manifest.json': { body: manifest() }, 'lead.pcm': { body: lead }, 'five.pcm': { body: five } };
}

function fake(calls: string[]): SpeechPort {
  return {
    transcribe: async () => ({ text: 'heard' }),
    transcribeEncoded: async () => ({ text: 'heard', model: 'fake' }),
    synthesizeEncoded: async () => ({ audio: 'AA==', format: 'mp3', contentType: 'audio/mpeg' }),
    synthesizePcm: async (text) => { calls.push(`pcm:${text}`); return { pcm: Buffer.from([8, 8]), sourceRateHz: 16_000 }; },
    synthesizeMp3: async (text) => { calls.push(`mp3:${text}`); return { mp3: Buffer.from([1, 2, 3]) }; },
  };
}

function env(url: string): NodeJS.ProcessEnv {
  return { BOB_SPEECH_ASSETS_URL: url, BOB_SPEECH_ASSETS_BUILD: BUILD, BOB_TTS_MODEL: identity.model,
    BOB_TTS_VOICE: identity.voice, BOB_SPEECH_ASSETS_LOCALE: identity.locale };
}

/** Collects journal lines; `outcome()` waits for the one load-outcome line. */
function capture(): { outcome: () => Promise<Record<string, unknown>>; lines: string[] } {
  const lines: string[] = [];
  setJournalSink((line) => lines.push(line));
  const find = (): Record<string, unknown> | undefined => lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.event === 'v2.speech_assets_loaded' || entry.event === 'v2.speech_assets_load_failed');
  return {
    lines,
    outcome: async () => {
      for (let tries = 0; tries < 200; tries++) {
        const hit = find();
        if (hit !== undefined) return hit;
        await new Promise((done) => setTimeout(done, 10));
      }
      throw new Error('no load outcome journalled');
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(SpeechPackFetchError);
  return (error as SpeechPackFetchError).reason;
}

afterEach(async () => {
  setJournalSink(null);
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  // Env-driven loads keep their temp dir for the process; this suite's build prefix is its own.
  const parent = join(tmpdir(), 'bob-speech-assets');
  const leftovers = await fs.readdir(parent).catch((): string[] => []);
  await Promise.all(leftovers.filter((name) => name.startsWith(`${BUILD}-`))
    .map((name) => fs.rm(join(parent, name), { recursive: true, force: true })));
});

describe('hosted speech packs', () => {
  it('downloads a valid pack once at boot and serves the hit with no provider call', async () => {
    const { url, requests } = await host(validRoutes());
    const log = capture();
    const calls: string[] = [];
    const port = withSpeechAssetsFromEnv(fake(calls), env(url));
    const loaded = await log.outcome();
    expect(loaded).toMatchObject({ event: 'v2.speech_assets_loaded', pack_source: 'url', build: BUILD, responses: 1, clips: 2,
      pack_bytes: lead.length + five.length });
    expect(typeof loaded.duration_ms).toBe('number');
    expect(JSON.stringify(loaded)).not.toContain('127.0.0.1');
    expect((await port.synthesizePcm(PHRASE)).pcm).toEqual(Buffer.concat([lead, five]));
    expect(calls).toEqual([]);
    expect(requests.sort()).toEqual(['five.pcm', 'lead.pcm', 'manifest.json']);
  });

  it('falls back to ordinary TTS and journals the reason for a corrupted clip', async () => {
    const { url } = await host({ ...validRoutes(), 'five.pcm': { body: Buffer.alloc(five.length, 9) } });
    const log = capture();
    const calls: string[] = [];
    const port = withSpeechAssetsFromEnv(fake(calls), env(url));
    expect(await log.outcome()).toMatchObject({ event: 'v2.speech_assets_load_failed', pack_source: 'url', reason: 'checksum' });
    await port.synthesizePcm(PHRASE);
    expect(calls).toEqual([`pcm:${PHRASE}`]);
  });

  it('refuses an oversized manifest, a missing pack and a slow host', async () => {
    const big = await host({ 'manifest.json': { body: Buffer.alloc(64 * 1024 + 1, 32) } });
    expect(await failure(fetchSpeechPack(big.url, BUILD))).toBe('too_large');
    const missing = await host({});
    expect(await failure(fetchSpeechPack(missing.url, BUILD))).toBe('http');
    const slow = await host({ ...validRoutes(), 'manifest.json': { body: manifest(), delayMs: 500 } });
    expect(await failure(fetchSpeechPack(slow.url, BUILD, { timeoutMs: 50 }))).toBe('timeout');
    const other = await host(validRoutes());
    expect(await failure(fetchSpeechPack(other.url, 'other-build'))).toBe('invalid_manifest');
  });

  it('refuses a clip path that leaves the pack without requesting it', async () => {
    const { url, requests } = await host({ ...validRoutes(),
      'manifest.json': { body: manifest({ clips: [clipEntry('lead', lead, '../lead.pcm'), clipEntry('five', five)] }) } });
    expect(await failure(fetchSpeechPack(url, BUILD))).toBe('unsafe_path');
    expect(requests).toEqual(['manifest.json']);
  });

  it('gives every load its own fresh temp directory', async () => {
    const { url } = await host(validRoutes());
    const first = await fetchSpeechPack(url, BUILD);
    const second = await fetchSpeechPack(url, BUILD);
    dirs.push(first.directory, second.directory);
    expect(first.directory).not.toBe(second.directory);
    expect(await fs.readFile(`${second.directory}/five.pcm`)).toEqual(five);
    expect(await fs.readFile(`${first.directory}/manifest.json`)).toEqual(manifest());
  });

  it('never fetches again during turns after a failed boot load', async () => {
    const { url, requests } = await host({});
    const log = capture();
    const calls: string[] = [];
    const port = withSpeechAssetsFromEnv(fake(calls), env(url));
    expect(await log.outcome()).toMatchObject({ event: 'v2.speech_assets_load_failed', reason: 'http' });
    const seen = requests.length;
    for (let turn = 0; turn < 3; turn++) await port.synthesizeMp3(PHRASE);
    expect(requests).toHaveLength(seen);
    expect(calls).toHaveLength(3);
  });
});
