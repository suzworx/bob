/**
 * Agent step cap (#397): every Bob agent stops its tool loop after
 * BOB_MAX_AGENT_STEPS model calls. A runaway model that answers every step
 * with a tool call is cut off at the cap; a normal tool-then-text turn is
 * untouched. Mock model only: no network.
 */
import { describe, expect, it, vi } from 'vitest';
import { ToolLoopAgent, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

/** Settings passed to every ToolLoopAgent constructed in this file. */
const constructed = vi.hoisted((): Record<string, unknown>[] => []);

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  const RecordingToolLoopAgent = new Proxy(actual.ToolLoopAgent, {
    construct(target, args, newTarget): object {
      constructed.push(args[0] as Record<string, unknown>);
      return Reflect.construct(target, args, newTarget) as object;
    },
  });
  return { ...actual, ToolLoopAgent: RecordingToolLoopAgent };
});

const { BOB_MAX_AGENT_STEPS, agentStopWhen } = await import('@bob/ai/testing');
const { createBobAgent, bobAgent } = await import('@bob/ai');

const USAGE = {
  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0, text: 2, reasoning: 0 },
  totalTokens: 6,
};

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

/** One model step that calls the echo tool. */
function toolCallStep(n: number): GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId: `call-${n}`, toolName: 'echo', input: JSON.stringify({ text: `ping ${n}` }) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: USAGE,
    warnings: [],
  };
}

/** One model step that answers in text. */
function textStep(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: USAGE,
    warnings: [],
  };
}

const echo = tool({
  description: 'Echoes its input back.',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }: { text: string }): Promise<string> => text,
});

describe('agent step cap', () => {
  it('caps the loop at 6 steps', () => {
    expect(BOB_MAX_AGENT_STEPS).toBe(6);
  });

  it('runaway: a model that always calls a tool stops after exactly 6 model calls', async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => toolCallStep(++calls),
    });
    const agent = new ToolLoopAgent({ model, tools: { echo }, stopWhen: agentStopWhen });
    const result = await agent.generate({ prompt: 'loop forever' });
    expect(result.steps.length).toBe(BOB_MAX_AGENT_STEPS);
    expect(model.doGenerateCalls.length).toBe(BOB_MAX_AGENT_STEPS);
    expect(calls).toBe(6);
  });

  it('normal: one tool call then text is a 2-step turn, unaffected by the cap', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallStep(1), textStep('It is sunny.')],
    });
    const agent = new ToolLoopAgent({ model, tools: { echo }, stopWhen: agentStopWhen });
    const result = await agent.generate({ prompt: 'what is the weather' });
    expect(result.steps.length).toBe(2);
    expect(model.doGenerateCalls.length).toBe(2);
    expect(result.text).toBe('It is sunny.');
  });

  it('wired: the singleton and the per-turn factory both receive agentStopWhen', () => {
    const singleton = constructed.find((settings) => settings.tools === (bobAgent as unknown as { settings: Record<string, unknown> }).settings.tools);
    expect(singleton?.stopWhen).toBe(agentStopWhen);
    const before = constructed.length;
    createBobAgent({ timeZone: 'Europe/London' });
    expect(constructed.length).toBe(before + 1);
    expect(constructed[before]?.stopWhen).toBe(agentStopWhen);
  });
});
