/**
 * A hosted speech pack on the real device turn (#1000/#1003). The server boots
 * with BOB_SPEECH_ASSETS_URL pointing at a loopback pack host, downloads the
 * pack once, journals v2.speech_assets_loaded, and the matching voice turn
 * plays the clip with no further request to the host.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRANSCRIPT, bootIntegrationServer, events, waitUntil, type IntegrationServer } from '../integration-helpers.ts';
import { BUILD, CLIP_MS, REPLY, SENTENCE, packManifest, toneClip, voiceTurn } from './speech-assets-turn.ts';

let server: IntegrationServer;
let host: Server;
const requests: string[] = [];

beforeAll(async () => {
  const clip = toneClip(CLIP_MS);
  const files: Record<string, Buffer> = { 'manifest.json': Buffer.from(packManifest(clip)), 'reply.pcm': clip };
  host = createServer((req, res) => {
    const name = (req.url ?? '').replace(`/speech-packs/${BUILD}/`, '');
    requests.push(name);
    const body = files[name];
    res.statusCode = body === undefined ? 404 : 200;
    res.end(body ?? '');
  });
  await new Promise<void>((done) => host.listen(0, '127.0.0.1', done));
  process.env.BOB_SPEECH_ASSETS_URL = `http://127.0.0.1:${(host.address() as AddressInfo).port}/speech-packs/${BUILD}/`;
  process.env.BOB_SPEECH_ASSETS_BUILD = BUILD;
  process.env.BOB_SYSTEM_TEST_TRANSCRIPT = SENTENCE;
  server = await bootIntegrationServer();
});

afterAll(async () => {
  delete process.env.BOB_STREAMING_REPLY;
  delete process.env.BOB_SPEECH_ASSETS_URL;
  delete process.env.BOB_SPEECH_ASSETS_BUILD;
  process.env.BOB_SYSTEM_TEST_TRANSCRIPT = TRANSCRIPT;
  await server?.close();
  await new Promise((done) => host?.close(done));
});

describe('hosted speech pack on the device turn', () => {
  it('downloads the pack once at boot and speaks the matching reply from it', async () => {
    await waitUntil(() => events(server.journal, 'v2.speech_assets_loaded').length === 1, 'v2.speech_assets_loaded');
    expect(requests.sort()).toEqual(['manifest.json', 'reply.pcm']);
    const turn = await voiceTurn(server, false);
    expect(turn).toMatchObject({ reply: REPLY, agentRuns: 1, playbackStarts: 1, playbackEnds: 1, hits: 1 });
    expect(turn.audioMs).toBeGreaterThanOrEqual(CLIP_MS);
    expect(turn.audioMs).toBeLessThan(CLIP_MS + 100);
    expect(requests).toHaveLength(2);
  });
});
