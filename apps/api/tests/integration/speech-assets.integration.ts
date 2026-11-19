/**
 * Speech assets on the real device turn (#1003). One server boots with a pack
 * whose only response is the stub agent's reply to a fixed transcript. The
 * same voice turn runs with the clip corrupted (ordinary TTS fallback) and
 * then intact (assembled clip), each with a streamed reply. Only the
 * audio may differ: the agent runs once per turn, the reply text and the
 * stored conversation are identical, and each turn plays exactly once. The
 * device turn's stub agent makes no tool calls (the scripted model serves the
 * web chat only), so tool once-ness rests on the agent-stage count here.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRANSCRIPT, bootIntegrationServer, type IntegrationServer } from '../integration-helpers.ts';
import { BUILD, CLIP_MS, REPLY, SENTENCE, packManifest, toneClip, voiceTurn } from './speech-assets-turn.ts';

let server: IntegrationServer;
let pack: string;
let clip: Buffer;

beforeAll(async () => {
  clip = toneClip(CLIP_MS);
  pack = await fs.mkdtemp(join(tmpdir(), 'bob-assets-integration-'));
  await fs.writeFile(join(pack, 'manifest.json'), packManifest(clip));
  // Corrupt until the fallback arms have run; the catalogue never caches a failed read.
  await fs.writeFile(join(pack, 'reply.pcm'), Buffer.alloc(clip.length));
  process.env.BOB_SPEECH_ASSETS_DIR = pack;
  process.env.BOB_SPEECH_ASSETS_BUILD = BUILD;
  process.env.BOB_SYSTEM_TEST_TRANSCRIPT = SENTENCE;
  server = await bootIntegrationServer();
});

afterAll(async () => {
  delete process.env.BOB_SPEECH_ASSETS_DIR;
  delete process.env.BOB_SPEECH_ASSETS_BUILD;
  process.env.BOB_SYSTEM_TEST_TRANSCRIPT = TRANSCRIPT;
  await server?.close();
  await fs.rm(pack, { recursive: true, force: true });
});

describe('speech assets on the device turn', () => {
  it('changes only the audio: one agent run, the same reply and history, one playback per turn', async () => {
    const fallback = [await voiceTurn(server)];
    await fs.writeFile(join(pack, 'reply.pcm'), clip);
    const assembled = [await voiceTurn(server)];

    for (const turn of [...fallback, ...assembled]) {
      expect(turn.reply).toBe(REPLY);
      expect(turn.agentRuns).toBe(1);
      expect(turn.playbackStarts).toBe(1);
      expect(turn.playbackEnds).toBe(1);
    }
    // The stub TTS speaks 1 s of silence; the pack's clip is 600 ms (MP3 adds at most a frame of padding).
    for (const turn of fallback) {
      expect(turn.hits).toBe(0);
      expect(turn.audioMs).toBeGreaterThanOrEqual(1_000);
    }
    for (const turn of assembled) {
      expect(turn.hits).toBe(1);
      expect(turn.audioMs).toBeGreaterThanOrEqual(CLIP_MS);
      expect(turn.audioMs).toBeLessThan(CLIP_MS + 100);
    }

    const listed = await server.api<{ conversations: Array<{ id: string }> }>('/api/conversations');
    const texts: string[] = [];
    for (const { id } of listed.body.conversations) {
      const detail = await server.api<{ messages: Array<{ role: string; versions: Array<{ parts: Array<{ type: string; text?: string }> }> }> }>(`/api/conversations/${id}`);
      for (const message of detail.body.messages.filter((stored) => stored.role === 'assistant')) {
        texts.push(message.versions.flatMap((version) => version.parts).filter((part) => part.type === 'text').map((part) => part.text).join(''));
      }
    }
    expect(texts.filter((text) => text === REPLY)).toHaveLength(2);
  });
});
