/**
 * Live tool probes (#758, was apps/api/scripts/live-tool-check.ts, S19-TOOLS-LIVE):
 * the assistant actually CALLS its memory, task and calendar tools on the real
 * model. A mock proves the tools are handed to the agent; only a real provider
 * proves the model invokes them, and only a real provider serialises the real
 * tool schemas (the bug feature 010 shipped). Each probe sends one turn and
 * asserts on the tool calls recorded by onStepEnd -- never on the prose.
 *
 * The callbacks are recording stubs that return plausible results so the tool
 * loop completes; the tool schemas and descriptions sent to the provider are
 * the real ones from createMemoryTools and createProductivityTools, merged by
 * createBobAgent the way a memory-on web turn merges them.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryTools,
  createBobAgent,
  createProductivityTools,
  type MemoryToolCallbacks,
  type ProductivityCallbacks,
} from '@bob/ai';
import { liveRun } from './support/live-env.ts';

/** Per-turn wall-clock cap: a dead provider ends a probe instead of hanging it. */
const RUN_TIMEOUT_MS = 60_000;

const memoryCallbacks: MemoryToolCallbacks = {
  listActions: async () => [],
  completeAction: async () => ({ completed: true, action_item_id: 'live-check' }),
  remember: async () => ({ stored: true, memory_id: 'live-check', sensitive: false }),
  forget: async () => ({ deleted: 0, memory_id: null }),
};

const productivityCallbacks: ProductivityCallbacks = {
  listTasks: async () => [],
  createTask: async () => ({ taskId: 'live-check' }),
  completeTask: async () => ({ taskId: 'live-check' }),
  updateTask: async () => ({ taskId: 'live-check' }),
  listAgenda: async () => [],
  createEvent: async () => ({ eventId: 'live-check' }),
};

/** One real turn through the gateway; the names of every tool called, in order. */
async function runTurn(prompt: string): Promise<string[]> {
  const agent = createBobAgent({
    memoryTools: createMemoryTools(memoryCallbacks),
    capabilityTools: createProductivityTools(productivityCallbacks),
  });
  const called: string[] = [];
  await agent.generate({
    prompt,
    timeout: { totalMs: RUN_TIMEOUT_MS },
    onStepEnd: (step) => {
      for (const call of step.toolCalls) called.push(call.toolName);
    },
  });
  return called;
}

const PROBES: ReadonlyArray<{ name: string; expected: string; prompt: string }> = [
  { name: 'memory', expected: 'remember', prompt: "Remember that my daughter's recital is on Tuesday" },
  { name: 'tasks', expected: 'create_task', prompt: 'Add buying batteries to my task list' },
  { name: 'calendar', expected: 'list_agenda', prompt: 'What is on my calendar tomorrow?' },
];

describe.skipIf(!liveRun)('live tools: the model calls the tool a request needs', () => {
  it.each(PROBES)('$name: calls $expected', async ({ name, expected, prompt }) => {
    const called = await runTurn(prompt);
    console.log(`[live:tools] ${name}: expected=${expected} called=${called.join(',') || 'none'}`);
    expect(called, `expected ${expected}; the model called ${called.join(', ') || 'none'}`).toContain(expected);
  });
});
