/**
 * Tool registry and mergeTools tests: createBobAgent merges capability and
 * memory tools into assistantTools, throws on name clashes, and returns the
 * shared assistantTools reference when no extra tools are given.
 */
import { describe, expect, it } from 'vitest';
import type { Tool } from 'ai';
import { createBobAgent, assistantTools } from '../src/agents.ts';
import { currentDateTimeTool } from '../src/tools.ts';

function settingsOf(agent: unknown): Record<string, unknown> {
  return (agent as { settings: Record<string, unknown> }).settings;
}

describe('mergeTools via createBobAgent', () => {
  it('returns the shared assistantTools reference when no options are given', () => {
    const agent = createBobAgent();
    const settings = settingsOf(agent);
    expect(settings.tools).toBe(assistantTools);
  });

  it('merges disjoint memory tools so every name is present', () => {
    const memoryTools: Record<string, Tool> = {
      myMemory: currentDateTimeTool,
      anotherMemory: currentDateTimeTool,
    };
    const agent = createBobAgent({ memoryTools });
    const tools = settingsOf(agent).tools as Record<string, Tool>;
    const names = Object.keys(tools);
    expect(names).toContain('currentDateTime');
    expect(names).toContain('myMemory');
    expect(names).toContain('anotherMemory');
    expect(names.length).toBe(3);
  });

  it('offers only currentDateTime as a base tool', () => {
    expect(Object.keys(assistantTools)).toEqual(['currentDateTime']);
  });

  it('does not offer the speech tools with or without memory tools', () => {
    const memoryTools: Record<string, Tool> = { myMemory: currentDateTimeTool };
    for (const agent of [createBobAgent(), createBobAgent({ memoryTools })]) {
      const names = Object.keys(settingsOf(agent).tools as Record<string, Tool>);
      expect(names).not.toContain('textToSpeech');
      expect(names).not.toContain('speechToText');
    }
  });

  it('merges disjoint capability tools with assistant tools', () => {
    const capabilityTools: Record<string, Tool> = {
      list_tasks: currentDateTimeTool,
    };
    const agent = createBobAgent({ capabilityTools });
    const tools = settingsOf(agent).tools as Record<string, Tool>;
    expect(Object.keys(tools)).toContain('currentDateTime');
    expect(Object.keys(tools)).toContain('list_tasks');
  });

  it('throws when a memory tool name clashes with an assistant tool', () => {
    const clashingTools: Record<string, Tool> = {
      currentDateTime: currentDateTimeTool,
    };
    expect(() => createBobAgent({ memoryTools: clashingTools }))
      .toThrow(/Tool "currentDateTime" clashes with an existing assistant tool/);
  });

  it('throws when a capability tool name clashes with an assistant tool', () => {
    const clashingTools: Record<string, Tool> = {
      currentDateTime: currentDateTimeTool,
    };
    expect(() => createBobAgent({ capabilityTools: clashingTools }))
      .toThrow(/Tool "currentDateTime" clashes with an existing assistant tool/);
  });

  it('throws when a capability tool clashes with a memory tool', () => {
    const memoryTools: Record<string, Tool> = { myTool: currentDateTimeTool };
    const capabilityTools: Record<string, Tool> = { myTool: currentDateTimeTool };
    expect(() => createBobAgent({ memoryTools, capabilityTools }))
      .toThrow(/Tool "myTool" clashes with an existing assistant tool/);
  });

  it('merges both memory and capability tools when disjoint', () => {
    const memoryTools: Record<string, Tool> = { myMemory: currentDateTimeTool };
    const capabilityTools: Record<string, Tool> = { list_tasks: currentDateTimeTool };
    const agent = createBobAgent({ memoryTools, capabilityTools });
    const tools = settingsOf(agent).tools as Record<string, Tool>;
    expect(Object.keys(tools)).toContain('myMemory');
    expect(Object.keys(tools)).toContain('list_tasks');
  });
});
