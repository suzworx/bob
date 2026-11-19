/**
 * TG-AGENT-HARNESS: the harness itself, read through the SDK's own API
 * (agent.stream / agent.generate), so every other test can trust its shape.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from 'ai';
import { createAgentHarness, words } from './agent-harness.ts';

const PROMPT = 'what is the weather';

/** Every part type the SDK's fullStream yields, in order, and the text deltas. */
async function drain(stream: AsyncIterable<{ type: string; text?: string }>): Promise<{ types: string[]; text: string }> {
  const types: string[] = [];
  let text = '';
  for await (const part of stream) {
    types.push(part.type);
    if (part.type === 'text-delta') text += part.text ?? '';
  }
  return { types, text };
}

describe('agent harness (TG-AGENT-HARNESS)', () => {
  it('stream() is async and yields each step\'s text deltas; a tool step runs the REAL tool with its input', async () => {
    const seen: unknown[] = [];
    const lookup = tool({
      description: 'Looks the weather up.',
      inputSchema: z.object({ city: z.string() }).strict(),
      execute: async (input) => {
        seen.push(input);
        return { sky: 'sunny' };
      },
    });
    const harness = createAgentHarness([
      [...words('Let me check.'), { type: 'tool', name: 'lookup', input: { city: 'Leeds' } }],
      words('It is sunny.'),
    ], { tools: { lookup } });
    const started = harness.agent.stream({ prompt: PROMPT });
    expect(started).toBeInstanceOf(Promise);
    const result = await started;
    const { types, text } = await drain(result.fullStream);
    expect(text).toBe('Let me check.It is sunny.');
    expect(types).toContain('tool-result');
    expect(seen).toEqual([{ city: 'Leeds' }]);
    expect(harness.calls()).toBe(2);
    expect(await result.finishReason).toBe('stop');
    const secondPrompt = JSON.stringify(harness.model.doStreamCalls[1]!.prompt);
    expect(secondPrompt).toContain('sunny');
  });

  it('a scripted tool with no real tool is stubbed and answers with its `result`', async () => {
    const harness = createAgentHarness([[{ type: 'tool', name: 'ping', result: { pong: 1 } }], words('Done.')]);
    const result = await harness.agent.generate({ prompt: PROMPT });
    expect(result.text).toBe('Done.');
    expect(result.steps[0]!.toolResults.map((entry) => entry.output)).toEqual([{ pong: 1 }]);
  });

  it('an error part reaches the SDK stream as an error, and generate() rejects with it', async () => {
    const streamed = await createAgentHarness([[...words('Hel'), { type: 'error', message: 'model broke' }]]).agent.stream({ prompt: PROMPT });
    const { types } = await drain(streamed.fullStream);
    expect(types).toContain('error');
    await expect(createAgentHarness([[{ type: 'error', message: 'model broke' }]]).agent.generate({ prompt: PROMPT }))
      .rejects.toThrow('model broke');
  });

  it('a delay holds the step open: the timeline marks start and end around it', async () => {
    const harness = createAgentHarness([[...words('One.'), { type: 'delay', ms: 60 }, ...words(' Two.')]]);
    await drain((await harness.agent.stream({ prompt: PROMPT })).fullStream);
    const [start, end] = harness.timeline;
    expect(start).toMatchObject({ step: 0, event: 'start' });
    expect(end).toMatchObject({ step: 0, event: 'end' });
    expect(end!.at - start!.at).toBeGreaterThanOrEqual(55);
  });

  it('an abort part fires the harness controller and ends the SDK stream', async () => {
    const harness = createAgentHarness([[...words('Hel'), { type: 'abort' }, ...words('lo')]]);
    const result = await harness.agent.stream({ prompt: PROMPT, abortSignal: harness.abort.signal });
    const { text } = await drain(result.fullStream).catch(() => ({ text: '', types: [] }));
    expect(harness.abort.signal.aborted).toBe(true);
    expect(text).not.toContain('lo');
  });

  it('a model call past the end of the script fails loudly', async () => {
    const harness = createAgentHarness([[{ type: 'tool', name: 'ping' }]]);
    await expect(harness.agent.generate({ prompt: PROMPT })).rejects.toThrow('ran past the 1-step script');
  });
});
