import { validateUIMessages } from 'ai';
import { createVoiceTools, type VoiceCallbacks } from '@bob/ai';
import { describe, expect, it } from 'vitest';

const tools = createVoiceTools({} as VoiceCallbacks);

const replay = (input: unknown): Promise<unknown> => validateUIMessages({
  messages: [
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'remind me' }] },
    { id: 'a', role: 'assistant', parts: [{ type: 'tool-create_reminder', toolCallId: 'c1', state: 'output-available', input, output: { ok: true, say: 'done' } }] },
  ] as never,
  tools: tools as never,
});

describe('stored tool calls replay', () => {
  it('re-validates the parsed create_reminder input the SDK stores on the tool part', async () => {
    // cnv_0e7df4b3: the stored input has active_hours as {from,to} and a filled-in when.
    await expect(replay({
      text: 'Drink water', repeat: 'hourly', every_hours: 5, active_hours: { from: '09:00', to: '17:00' }, when: '2026-10-05T10:00:00.000Z',
    })).resolves.toBeDefined();
  });

  it('still validates the shape the model sends', async () => {
    await expect(replay({ text: 'Drink water', repeat: 'hourly', active_hours: { start: '09:00', end: '17:00' } })).resolves.toBeDefined();
  });
});
