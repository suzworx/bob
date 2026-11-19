/**
 * Live smoke (#758, was apps/ai/src/test.ts): a short three-turn session with
 * the default agent on the configured chat model (BOB_CHAT_MODEL in the root
 * .env) through the AI Gateway. It asserts the shape of what came back -- a
 * reply on every turn, well-formed tool calls each answered by a result --
 * never the prose.
 */
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { bobAgent } from '@bob/ai';
import { liveRun } from './support/live-env.ts';

const PROMPTS = [
  'Hello, who are you?',
  'What is the current date and time in America/Los_Angeles?',
  'When is the next Sunday, and what date will it be?',
];

describe.skipIf(!liveRun)('live smoke: the default agent answers on the configured model', () => {
  it('replies on every turn, and every tool call is well-formed and answered', async () => {
    const messages: ModelMessage[] = [];
    for (const prompt of PROMPTS) {
      messages.push({ role: 'user', content: prompt });
      const result = await bobAgent.generate({ messages, timeout: { totalMs: 60_000 } });

      expect(result.text.trim().length, `no reply to turn ${messages.length}`).toBeGreaterThan(0);
      expect(result.response.modelId.length).toBeGreaterThan(0);
      const calls = result.steps.flatMap((step) => step.toolCalls);
      const results = result.steps.flatMap((step) => step.toolResults);
      for (const call of calls) {
        expect(call.toolCallId).toMatch(/\S/);
        expect(call.toolName).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
        expect(typeof call.input).toBe('object');
        expect(results.map((r) => r.toolCallId), `tool ${call.toolName} got no result`).toContain(call.toolCallId);
      }
      console.log(`[live:smoke] turn ${messages.length}: model=${result.response.modelId} steps=${result.steps.length} tools=${calls.map((c) => c.toolName).join(',') || 'none'}`);
      messages.push(...result.response.messages);
    }
  });
});
