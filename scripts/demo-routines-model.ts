// Local demonstration model only. The SDK executes the real offered routine
// tool; this deterministic sentence matcher is never a production agent.
import { stepCountIs, ToolLoopAgent } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createScriptedAgent } from '../apps/api/src/voice/agent-adapters.ts';
import type { AgentImpl, AgentPort } from '../apps/api/src/voice/agent-port.ts';

type Options = MockLanguageModelV4['doStreamCalls'][number];
type Part = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0, text: 0, reasoning: 0 }, totalTokens: 0 };

function response(prompt: Options['prompt'], accountId: string): Part[] {
  const last = prompt.at(-1);
  const user = prompt.findLast((message) => message.role === 'user');
  const content = user?.content;
  const text = typeof content === 'string' ? content : content?.map((part) => part.type === 'text' ? part.text : '').join('') ?? '';
  const match = /^Demo: create my daily email summary at ([0-2]\d:[0-5]\d) UTC using morning@example.test\. I authorize scheduled email reads\.$/.exec(text.trim());
  const call = last?.role !== 'tool' && match?.[1];
  const retrieve = text.trim() === 'Demo: show my saved email summaries.';
  const searchMail = text.includes('Demo: check job updates') && /@\{integration:Gmail(?:\.search)?:morning@example\.test\}/.test(text);
  if (searchMail && last?.role !== 'tool') return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'demo-mention-search', toolName: 'google_gmail_search', input: JSON.stringify({ query: 'interview', maxResults: 10 }) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ];
  if (retrieve && last?.role !== 'tool') return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'demo-read-insights', toolName: 'get_routine_timeline', input: JSON.stringify({ limit: 5 }) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ];
  if (call) return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'demo-create-routine', toolName: 'create_routine', input: JSON.stringify({ googleAccountId: accountId, localTime: call, timeZone: 'UTC', scheduledReadConsent: true }) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ];
  const answer = text.trim() === 'Demo: help me create a daily Gmail summary.'
    ? 'What time and time zone should I use? Please confirm morning@example.test and scheduled email reads.'
    : searchMail && last?.role === 'tool'
      ? `Mention search result from the real Gmail tool: ${JSON.stringify(last.content)}`
      : demoAnswer(last, retrieve);
  return [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'demo' },
    { type: 'text-delta', id: 'demo', delta: answer }, { type: 'text-end', id: 'demo' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }];
}

function demoAnswer(last: Options['prompt'][number] | undefined, retrieve: boolean): string {
  if (last?.role !== 'tool') return 'This local demo uses a scripted model. Use the exact consent sentence documented in the demo guide.';
  if (retrieve) return `Saved demo results from the real get_routine_timeline tool: ${JSON.stringify(last.content)}`;
  return 'Demo model: the routine tool finished. Open Routines to inspect the saved schedule.';
}

export function createRoutineDemoAgent(accountId: string): AgentPort {
  return createScriptedAgent((tools) => {
    const model = new MockLanguageModelV4({ modelId: 'bob-routines-synthetic-demo', doStream: async (options) => ({
      stream: new ReadableStream<Part>({ start(controller): void {
        for (const part of response(options.prompt, accountId)) controller.enqueue(part);
        controller.close();
      } }),
    }) });
    return new ToolLoopAgent({ model, tools, stopWhen: stepCountIs(3) }) as unknown as AgentImpl;
  });
}
