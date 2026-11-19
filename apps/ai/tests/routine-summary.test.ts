import { MockLanguageModelV4 } from 'ai/test';
import { expect, it } from 'vitest';
import { createRoutineSummary } from '../src/routine-summary.ts';

function model(messageIds: string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doGenerate: {
    content: [{ type: 'text', text: JSON.stringify({ summary: 'Your delivery arrives tomorrow.', messageIds }) }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
    warnings: [],
  } });
}
const input = { messages: [{ threadId: 'thread1', messageId: 'message1', subject: 'Delivery', from: 'Shop', text: 'Delivery tomorrow' }], partial: false };
it('summarizes only supplied evidence with a bounded tool-free model call', async () => {
  const llm = model(['message1']);
  await expect(createRoutineSummary(llm)(input, new AbortController().signal)).resolves.toMatchObject({ messageIds: ['message1'] });
  expect(llm.doGenerateCalls[0]?.tools).toBeUndefined();
});
it('rejects invented source references', async () => {
  await expect(createRoutineSummary(model(['invented']))(input, new AbortController().signal)).rejects.toThrow('routine_summary_invalid_sources');
});
it('refuses oversized provider text before model invocation', async () => {
  const llm = model(['message1']);
  await expect(createRoutineSummary(llm)({ ...input, messages: [{ threadId: 't', messageId: 'm', subject: '', from: '', text: 'x'.repeat(50_001) }] }, new AbortController().signal)).rejects.toThrow();
  expect(llm.doGenerateCalls).toHaveLength(0);
});
