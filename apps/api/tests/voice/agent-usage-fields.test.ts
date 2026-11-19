import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { agentSectionSizes, agentUsageFields, sincePrevTurnMs } from '../../src/voice/turn-core.ts';

function usage(input: number, output: number, cached = 0): Record<string, unknown> {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    inputTokenDetails: { noCacheTokens: input - cached, cacheReadTokens: cached, cacheWriteTokens: undefined },
    outputTokenDetails: { textTokens: output, reasoningTokens: undefined },
  };
}

const toolStep = {
  toolCalls: [{ toolName: 'currentDateTime', input: { secret: 'my private words' } }],
  finishReason: 'tool-calls',
  response: { modelId: 'openai/gpt-4o' },
  providerMetadata: undefined,
  usage: usage(1000, 20, 600),
};
const textStep = {
  toolCalls: [],
  finishReason: 'stop',
  response: { modelId: 'openai/gpt-4o' },
  providerMetadata: { gateway: { routing: { finalProvider: 'azure' } } },
  usage: usage(1040, 30, 900),
};

describe('agentUsageFields (#396)', () => {
  it('reads a one-step result: model from response, counts from totalUsage', () => {
    const fields = agentUsageFields({
      steps: [textStep],
      response: { modelId: 'openai/gpt-4o' },
      finishReason: 'stop',
      usage: usage(1, 1),
      totalUsage: usage(1040, 30, 900),
      toolCalls: [],
    });
    expect(fields).toEqual({
      model: 'openai/gpt-4o', input_tokens: 1040, output_tokens: 30, tokens: 1070, cached_input_tokens: 900,
      steps: 1, tool_calls: 0, called_tools: '', finish_reason: 'stop', provider: 'azure',
    });
  });

  it('a tool-then-text run sums tokens and tool calls over both steps', () => {
    const fields = agentUsageFields({
      steps: [toolStep, textStep],
      response: { modelId: 'openai/gpt-4o' },
      finishReason: 'stop',
      usage: usage(1040, 30),
      totalUsage: usage(2040, 50, 1500),
      toolCalls: [],
      providerMetadata: textStep.providerMetadata,
    });
    expect(fields.steps).toBe(2);
    expect(fields.input_tokens).toBe(2040);
    expect(fields.cached_input_tokens).toBe(1500);
    expect(fields.tool_calls).toBe(1);
    expect(fields.called_tools).toBe('currentDateTime');
    expect(fields.provider).toBe('azure');
    expect(JSON.stringify(fields)).not.toContain('private');
  });

  it('with steps only (web onStepEnd) sums the step usage', () => {
    const fields = agentUsageFields({ steps: [toolStep, textStep] });
    expect(fields).toMatchObject({
      model: 'openai/gpt-4o', input_tokens: 2040, output_tokens: 50, tokens: 2090, cached_input_tokens: 1500,
      steps: 2, tool_calls: 1, finish_reason: 'stop',
    });
  });

  it('omits provider when providerMetadata is missing, and a stub result has no model', () => {
    expect(agentUsageFields({ steps: [toolStep] })).not.toHaveProperty('provider');
    const stub = agentUsageFields({ toolCalls: [] });
    expect(stub).toEqual({ steps: 0, tool_calls: 0, called_tools: '' });
  });

  it('drops strings outside the allow-list (model id, tool name, finish reason, provider)', () => {
    const fields = agentUsageFields({
      steps: [{
        toolCalls: [{ toolName: 'call me at 555 1234' }],
        finishReason: 'the user said hello',
        response: { modelId: 'model with spaces and text' },
        providerMetadata: { gateway: { routing: { finalProvider: 'a b c' } } },
      }],
    });
    expect(fields).toEqual({ steps: 1, tool_calls: 1, called_tools: '' });
  });

  it('every value is a number, a boolean or an allow-listed string', () => {
    const sizes = agentSectionSizes({
      tools: { lookup: tool({ description: 'Looks things up', inputSchema: z.object({ q: z.string() }) }) },
      instructions: 'You are Bob. secret instructions',
      memory: '[BOB MEMORY] likes tea',
      context: '[Active space] "Home"',
    });
    const usageFields = agentUsageFields({ steps: [toolStep, textStep], totalUsage: usage(2040, 50, 1500) });
    for (const [key, value] of Object.entries({ ...usageFields, ...sizes })) {
      if (typeof value === 'number' || typeof value === 'boolean') continue;
      expect(['model', 'called_tools', 'finish_reason', 'provider'], key).toContain(key);
      expect(value).toMatch(/^[A-Za-z0-9._:/@,-]*$/);
    }
    expect(sizes.tool_count).toBe(1);
    expect(sizes.tools_chars).toBeGreaterThan('lookup'.length + 'Looks things up'.length);
    expect(sizes.memory_chars).toBe('[BOB MEMORY] likes tea'.length);
    expect(JSON.stringify(sizes)).not.toMatch(/tea|Home|secret/);
  });

  it('caches tool sizes per map identity', () => {
    const tools = { lookup: tool({ description: 'x', inputSchema: z.object({ q: z.string() }) }) };
    const first = agentSectionSizes({ tools, instructions: '' }).tools_chars;
    expect(agentSectionSizes({ tools, instructions: '' }).tools_chars).toBe(first);
  });
});

describe('sincePrevTurnMs (#396)', () => {
  it('is absent on the first turn and the gap afterwards, per conversation', () => {
    expect(sincePrevTurnMs('conv-gap-a', 1000)).toBeUndefined();
    expect(sincePrevTurnMs('conv-gap-b', 1500)).toBeUndefined();
    expect(sincePrevTurnMs('conv-gap-a', 4000)).toBe(3000);
    expect(sincePrevTurnMs(undefined, 5000)).toBeUndefined();
  });
});
