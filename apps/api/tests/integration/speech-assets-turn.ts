/** The speech-asset device turn shared by the directory and hosted-pack integration suites (#1003). */
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { BOB_TTS_MODEL, BOB_TTS_VOICE } from '@bob/ai';
import type { AudioFrameDto } from '../../src/voice/protocol.ts';
import { audioStartOffset, parseMp3Frame } from '../../src/voice/audio/mp3.ts';
import { connectDevice, control, events, waitUntil, type IntegrationServer } from '../integration-helpers.ts';

export const SENTENCE = 'integration assets what time is it';
export const REPLY = `System test response: ${SENTENCE}`;
export const BUILD = 'integration-1';
export const CLIP_MS = 600;

/** A one-response pack whose only clip is `clip`, in the effective identity. */
export function packManifest(clip: Buffer): string {
  return JSON.stringify({
    schemaVersion: 2, buildVersion: BUILD, model: BOB_TTS_MODEL, voice: BOB_TTS_VOICE, locale: 'en-US',
    clips: [{ id: 'reply', path: 'reply.pcm', sha256: createHash('sha256').update(clip).digest('hex'), bytes: clip.length, durationMs: CLIP_MS, sampleRateHz: 16_000 }],
    templates: [{ id: 'timer', segments: [{ type: 'literal', text: REPLY, clipId: 'reply' }] }],
  });
}

/** A 330 Hz tone: audibly unlike the stub TTS silence, so the frames tell the arms apart. */
export function toneClip(ms: number): Buffer {
  const out = Buffer.alloc(ms * 32);
  for (let i = 0; i < ms * 16; i++) out.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 330 * i) / 16_000)), i * 2);
  return out;
}

function voicedFrames(count: number): AudioFrameDto[] {
  return Array.from({ length: count }, (_unused, index) => {
    const payload = Buffer.alloc(320);
    for (let sample = 0; sample < 160; sample += 1) {
      payload.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * (index * 160 + sample)) / 16_000)), sample * 2);
    }
    return {
      header: { magic: 'OLX2', version: 1, kind: 'audio_up', formatId: 1, channels: 1, turnHandle: 1, sequence: index, payloadBytes: 320 },
      payload,
    };
  });
}

/** Playback length of an MP3 byte stream, from its frame headers. */
function mp3Ms(mp3: Buffer): number {
  let offset = audioStartOffset(mp3);
  let samples = 0;
  for (let frame = parseMp3Frame(mp3, offset); frame !== null; frame = parseMp3Frame(mp3, offset)) {
    samples += frame.samplesPerFrame;
    offset += frame.frameLengthBytes;
  }
  expect(offset).toBe(mp3.length);
  return Math.round((samples / 16_000) * 1000);
}

export interface TurnOutcome { reply: unknown; playbackStarts: number; playbackEnds: number; audioMs: number; agentRuns: number; hits: number }

/** One MP3 voice turn; every MP3 reply streams. `_legacy` is ignored (speech-assets-url.integration.ts still passes it). */
export async function voiceTurn(server: IntegrationServer, _legacy?: boolean): Promise<TurnOutcome> {
  const device = await connectDevice(server);
  device.reset();
  const before = server.journal.length;
  const turnRef = control('turn').id;
  device.sendControl(control('turn_start', {}, { turn_ref: turnRef }));
  const frames = voicedFrames(32);
  for (const frame of frames) device.sendAudioFrame(frame);
  device.sendControl(control('turn_end', {}, { turn_ref: turnRef, seq: frames.length - 1 }));
  await device.waitFor('playback_end', 30_000);
  await waitUntil(() => events(server.journal, 'v2.turn_completed', before).length === 1, 'v2.turn_completed');
  const controls = device.controlEvents();
  const outcome: TurnOutcome = {
    reply: controls.find((dto) => dto.type === 'reply_text')?.payload.reply,
    playbackStarts: controls.filter((dto) => dto.type === 'playback_start').length,
    playbackEnds: controls.filter((dto) => dto.type === 'playback_end').length,
    audioMs: mp3Ms(Buffer.concat(device.audioEvents().map((frame) => frame.payload))),
    agentRuns: events(server.journal, 'v2.turn_stage_agent_completed', before).length,
    hits: events(server.journal, 'v2.speech_asset_hit', before).length,
  };
  device.close();
  await device.waitForClose();
  return outcome;
}
