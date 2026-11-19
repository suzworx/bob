/**
 * Prod 2026-10-06: asked to "assign it to sameer4work", the model restated an old,
 * made-up assignment because update_task had no assignee field -- a strict schema
 * gave it no way to reassign. This drives the real tool loop with a scripted model:
 * the reassign call reaches the callback, and the result the model reads back
 * names the assignee the server actually set.
 */
import { describe, expect, it } from 'vitest';
import { ToolLoopAgent, stepCountIs } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createProductivityTools, type ProductivityCallbacks, type UpdateTaskInput } from '../src/productivity-tools.ts';

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0, text: 0, reasoning: 0 },
  totalTokens: 0,
};

/** Calls update_task once with `input`, then ends the turn. */
function reassigningModel(input: Record<string, unknown>): MockLanguageModelV4 {
  let calls = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'update_task', input: JSON.stringify(input) }],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: USAGE,
          warnings: [],
        };
      }
      return { content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE, warnings: [] };
    },
  });
}

function callbacks(updates: UpdateTaskInput[]): ProductivityCallbacks {
  return {
    listTasks: async () => [],
    createTask: async () => ({ taskId: 't-1' }),
    completeTask: async () => ({ taskId: 't-1' }),
    updateTask: async (input) => {
      updates.push(input);
      return { taskId: input.taskId, title: 'work', assignee: '@sameer4work' };
    },
    listAgenda: async () => [],
    createEvent: async () => ({ eventId: 'e-1' }),
  };
}

describe('update_task reassignment through the tool loop', () => {
  it('passes the spoken assignee to the server and returns the assignee it set', async () => {
    const updates: UpdateTaskInput[] = [];
    const agent = new ToolLoopAgent({
      model: reassigningModel({ taskId: 't-1', assigneeHandle: 'Samir number four work' }),
      tools: createProductivityTools(callbacks(updates), { localTimeDues: false }),
      stopWhen: stepCountIs(3),
    });
    const result = await agent.generate({ prompt: 'assign it to Samir number four work' });
    expect(updates).toEqual([{ taskId: 't-1', assigneeHandle: 'Samir number four work' }]);
    const toolResults = result.steps.flatMap((step) => step.toolResults);
    expect(toolResults.map((r) => r.output)).toEqual([{ ok: true, taskId: 't-1', title: 'work', assignee: '@sameer4work' }]);
  });

  it('a null assignee unassigns; an update naming nothing is still refused', async () => {
    const updates: UpdateTaskInput[] = [];
    const tools = createProductivityTools(callbacks(updates), { localTimeDues: false });
    const run = (input: unknown): Promise<unknown> =>
      (tools.update_task as unknown as { execute(i: unknown): Promise<unknown> }).execute(input);
    expect(await run({ taskId: 't-1', assigneeHandle: null })).toMatchObject({ ok: true });
    expect(updates).toEqual([{ taskId: 't-1', assigneeHandle: null }]);
    expect(await run({ taskId: 't-1' })).toEqual({ ok: false, reason: 'nothing to change' });
  });
});
