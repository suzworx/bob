/**
 * Device WebSocket flow (#551): a simulated Cardputer (tests/helpers/sim-device.ts,
 * the in-process form of scripts/simulate-device.mjs) against the real server.
 * hello/welcome, a voice turn the web then reads back, timers_state pushed on
 * change and on welcome, and active_conversation after the web activates a
 * conversation.
 */
import type { Tool } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AudioFrameDto } from '../../src/voice/protocol.ts';
import {
  TRANSCRIPT, bootIntegrationServer, connectDevice, control, events, waitUntil, type IntegrationServer,
} from '../integration-helpers.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
let server: IntegrationServer;
let timerTools: Record<string, Tool>;

/** A 440 Hz PCM16 uplink, enough voiced audio for the turn to be accepted. */
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

beforeAll(async () => {
  server = await bootIntegrationServer();
  const { webTurnTools } = await import('../../src/conversations/chat-tools.ts');
  timerTools = webTurnTools(appDeps, server.db, server.userId, 'UTC', null);
});

afterAll(async () => {
  await server?.close();
});

describe('device WebSocket', () => {
  it('a voice turn streams a reply and the web reads the stored conversation back', async () => {
    const device = await connectDevice(server);
    const before = server.journal.length;
    const turnRef = control('turn').id;
    device.sendControl(control('turn_start', {}, { turn_ref: turnRef }));
    const frames = voicedFrames(32);
    for (const frame of frames) device.sendAudioFrame(frame);
    device.sendControl(control('turn_end', {}, { turn_ref: turnRef, seq: frames.length - 1 }));
    await Promise.all([device.waitFor('playback_start', 30_000), device.waitFor('playback_end', 30_000)]);
    await waitUntil(() => events(server.journal, 'v2.turn_completed', before).length === 1, 'v2.turn_completed');
    expect(device.audioEvents().length).toBeGreaterThan(0);
    expect(events(server.journal, 'v2.turn_completed', before)[0]!.down_frames).toBe(device.audioEvents().length);

    const listed = await server.api<{ conversations: Array<{ id: string; title: string }> }>('/api/conversations');
    const conversation = listed.body.conversations.find((candidate) => candidate.title === TRANSCRIPT);
    expect(conversation).toBeDefined();
    const detail = await server.api<{ messages: Array<{ role: string }> }>(`/api/conversations/${conversation!.id}`);
    expect(detail.body.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    device.close();
  });

  it('pushes timers_state when a timer is set, and again at the next welcome', async () => {
    const device = await connectDevice(server);
    device.reset();
    const before = server.journal.length;
    const output = (await timerTools.set_timer!.execute!(
      { duration: 'PT15M', label: 'integration tea' } as never,
      { toolCallId: 'call_timer', messages: [], context: {} },
    )) as { ok: boolean; id: string };
    expect(output.ok).toBe(true);

    const pushed = await device.waitFor('timers_state', 10_000);
    const ids = (pushed.payload.timers as Array<{ id: string }>).map((timer) => timer.id);
    expect(ids).toContain(output.id);
    const changed = events(server.journal, 'v2.timers_state', before).filter((entry) => entry.reason === 'changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.count).toBe(ids.length);
    device.close();
    await device.waitForClose();

    const again = await connectDevice(server);
    const onWelcome = await again.waitFor('timers_state', 10_000);
    expect((onWelcome.payload.timers as Array<{ id: string }>).map((timer) => timer.id)).toContain(output.id);
    expect(events(server.journal, 'v2.timers_state', before).filter((entry) => entry.reason === 'welcome')).toHaveLength(1);
    again.close();
  });

  it('pushes active_conversation when the web activates a conversation', async () => {
    const { createConversation } = await import('../../src/conversations/store.ts');
    const created = await createConversation(server.db, server.userId, 'Integration picked on the web');
    const device = await connectDevice(server);
    device.reset();
    const before = server.journal.length;

    const activated = await server.api<{ conversation_id: string }>(`/api/conversations/${created.id}/activate`, { method: 'POST' });
    expect(activated.status).toBe(200);
    const pushed = await device.waitFor('active_conversation', 10_000);
    expect(pushed.payload).toEqual({ id: created.id, title: 'Integration picked on the web' });
    expect(events(server.journal, 'v2.active_changed', before).map((entry) => entry.surface)).toEqual(['activate']);
    device.close();
  });
});
