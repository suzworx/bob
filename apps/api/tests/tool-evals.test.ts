/**
 * Offline checks for the tool-selection eval (#410, epic #394 X1): the
 * fixtures meet the X1 minimums, every expected name and args key is a real
 * tool or parameter, and the agent under test exposes the full registry of a
 * memory-on device turn. Construct-only: no model call, no gateway key.
 */
import { describe, expect, it } from 'vitest';
import { asSchema } from 'ai';
import { assistantTools, createDeviceTools, createMemoryTools, createProductivityTools, createSpaceMemberTools, createTimerTools, createVoiceTools } from '@bob/ai';
import { loadFixtures, toolCaseSchema, type ToolCase } from '../../ai/evals/fixtures.ts';
import { buildToolEvalAgent, toolEvalRegistry, toolEvalTools } from '../../ai/evals/tool-agent.ts';

/** A callback bag whose every method resolves to an empty object; only tool names are read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub: any = new Proxy({}, { get: () => async () => ({}) });

/** Base + capability + memory + late tools of a memory-on device turn in an active Space, in turn.ts order. */
function deviceTurnToolNames(): string[] {
  return Object.keys({
    ...assistantTools,
    ...createTimerTools(stub),
    ...createProductivityTools(stub),
    ...createSpaceMemberTools(stub),
    ...createMemoryTools(stub),
    ...createVoiceTools(stub),
    ...createDeviceTools(stub),
  });
}

/** ToolLoopAgent keeps its constructor settings in a plain own property at runtime. */
function toolsOf(agent: unknown): Record<string, unknown> {
  return (agent as { settings: { tools: Record<string, unknown> } }).settings.tools;
}

/** The top-level input parameter names of a tool, from its JSON schema. */
async function parameterNames(toolInput: unknown): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = await asSchema(toolInput as any).jsonSchema;
  return Object.keys((schema as { properties?: Record<string, unknown> }).properties ?? {});
}

describe('tool-selection eval (offline)', () => {
  const fixtures: ToolCase[] = loadFixtures('tools', toolCaseSchema);
  const registry = toolEvalRegistry();

  it('registry equals base + memory + all capability tools of a memory-on device turn', () => {
    expect(registry).toEqual(deviceTurnToolNames());
    expect(new Set(registry).size).toBe(registry.length);
  });

  it('buildToolEvalAgent() exposes the full registry', () => {
    expect(Object.keys(toolsOf(buildToolEvalAgent()))).toEqual(registry);
  });

  it('has at least 120 fixtures and the category minimums', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(120);
    const count = (category: ToolCase['category']): number => fixtures.filter((f) => f.category === category).length;
    expect(count('no_tool')).toBeGreaterThanOrEqual(20);
    expect(count('confusable')).toBeGreaterThanOrEqual(20);
    expect(count('follow_up')).toBeGreaterThanOrEqual(10);
    expect(count('stt_noise')).toBeGreaterThanOrEqual(10);
  });

  it('covers every registry tool with at least 3 fixtures', () => {
    // #408 removes the speech tools from the per-turn agent; they carry no fixtures, and on the merged
    // registry this exemption matches nothing.
    const retiredBy408 = new Set(['textToSpeech', 'speechToText']);
    const short = registry
      .filter((name) => !retiredBy408.has(name))
      .filter((name) => fixtures.filter((f) => f.expected.includes(name)).length < 3);
    expect(short).toEqual([]);
  });

  it('keeps expectations consistent with the category', () => {
    for (const fixture of fixtures) {
      if (fixture.category === 'no_tool') expect(fixture.expected, fixture.input).toEqual([]);
      if (fixture.category === 'follow_up') expect(fixture.prior, fixture.input).toBeDefined();
      if (fixture.category !== 'no_tool' && fixture.category !== 'stt_noise') {
        expect(fixture.expected.length, fixture.input).toBeGreaterThan(0);
      }
    }
  });

  it('names only real tools in expected', () => {
    const unknown = fixtures.flatMap((f) => f.expected).filter((name) => !registry.includes(name));
    expect(unknown).toEqual([]);
  });

  it('names only real tools and parameters in args', async () => {
    const tools = toolEvalTools();
    expect(await parameterNames(tools.set_timer?.inputSchema)).toContain('duration');
    const problems: string[] = [];
    for (const fixture of fixtures) {
      for (const [toolName, params] of Object.entries(fixture.args ?? {})) {
        const found = tools[toolName];
        if (found === undefined) {
          problems.push(`${fixture.input}: unknown tool ${toolName}`);
          continue;
        }
        if (!fixture.expected.includes(toolName)) problems.push(`${fixture.input}: args for unexpected ${toolName}`);
        const names = await parameterNames(found.inputSchema);
        for (const key of Object.keys(params)) {
          if (!names.includes(key)) problems.push(`${fixture.input}: ${toolName} has no parameter ${key}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('pins the #1046 task-vs-action-item cases', () => {
    const expectedOf = (input: string): string[] | undefined => fixtures.find((f) => f.input === input)?.expected;
    // A fresh conversation that finishes a task by name reads the task list first, not complete_action.
    expect(expectedOf('Mark water the plants as done.')).toEqual(['list_tasks']);
    expect(expectedOf('I bought the milk, mark the buy milk task as done.')).toEqual(['list_tasks']);
    // The same name as both a task and an action item: the task wins.
    const both = fixtures.find((f) => f.input === 'I watered the plants, mark it done.');
    expect(both?.expected).toEqual(['complete_task']);
    expect(both?.args).toEqual({ complete_task: { taskId: 'task-71' } });
    // Action items stay reachable when the person names one.
    expect(expectedOf('Mark the action item about renewing the parking permit as done.')).toEqual(['complete_action']);
  });

  it('contains no emails or phone-number-like digits', () => {
    const text = JSON.stringify(fixtures);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/);
    expect(text).not.toMatch(/\+?\d[\d\s-]{8,}\d/);
  });
});
