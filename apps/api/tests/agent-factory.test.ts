/**
 * Agent factory (specs/010-cross-session-memory T014): createBobAgent()
 * defaults to a config identical to the shared bobAgent singleton, merges
 * per-account memory tools (a name clash throws), and appends the pre-built
 * [BOB MEMORY ...] block to the system instructions as a separate, clearly
 * delimited section -- never a user message. Construct-only: no model call.
 */
import { describe, expect, it } from 'vitest';
import { createBobAgent, bobAgent, assistantTools, BOB_AGENT_INSTRUCTIONS, currentDateTimeTool } from '@bob/ai';

/**
 * ToolLoopAgent keeps its constructor settings in a private field that is a
 * plain own property at runtime; the tests read it to compare the factory's
 * config with the singleton's without calling the model.
 */
function settingsOf(agent: unknown): Record<string, unknown> {
  return (agent as { settings: Record<string, unknown> }).settings;
}

describe('createBobAgent', () => {
  it('applies the tool policy after merging every tool source, including base tools', () => {
    let offered: string[] = [];
    const settings = settingsOf(createBobAgent({
      capabilityTools: { capabilityExample: currentDateTimeTool },
      memoryTools: { memoryExample: currentDateTimeTool },
      lateTools: { lateExample: currentDateTimeTool },
      filterTools: (tools) => {
        offered = Object.keys(tools);
        return {};
      },
    }));
    expect(offered).toEqual(expect.arrayContaining(['currentDateTime', 'capabilityExample', 'memoryExample', 'lateExample']));
    expect(settings.tools).toEqual({});
  });
  it('builds a default agent whose config is identical to the bobAgent singleton', () => {
    const factory = settingsOf(createBobAgent());
    const singleton = settingsOf(bobAgent);
    expect(factory.model).toBe(singleton.model);
    expect(factory.instructions).toBe(singleton.instructions);
    expect(factory.tools).toBe(singleton.tools);
    expect(factory.telemetry).toBe(singleton.telemetry);
    expect(factory.stopWhen).toBe(singleton.stopWhen);
    expect(factory.tools).toBe(assistantTools);
  });

  it('merges memory tools into the assistant tools', () => {
    const settings = settingsOf(createBobAgent({ memoryTools: { myMemory: currentDateTimeTool } }));
    const tools = settings.tools as Record<string, unknown>;
    expect(Object.keys(tools)).toEqual([...Object.keys(assistantTools), 'myMemory']);
    expect(tools.myMemory).toBe(currentDateTimeTool);
  });

  it('throws when a memory tool name clashes with an assistant tool', () => {
    expect(() => createBobAgent({ memoryTools: { currentDateTime: currentDateTimeTool } })).toThrow(/clash/i);
  });

  it('sends the memory context as one system message before the final user message, never in the instructions', () => {
    const context = `[BOB MEMORY — background only. The user did NOT say this in this turn. Do not
read it aloud or quote it verbatim; use it only if it helps answer.]
Known facts and preferences (from earlier conversations):
- (fact, confidence 0.92) Allergic to peanuts.
[END BOB MEMORY]`;
    const settings = settingsOf(createBobAgent({ memoryContext: context }));
    expect(settings.instructions).toBe(BOB_AGENT_INSTRUCTIONS);
    expect(settings.messages).toBeUndefined();
    const prepareCall = settings.prepareCall as (opts: unknown) => { messages: Array<{ role: string; content: string }> };
    const { messages } = prepareCall({ messages: [{ role: 'user', content: 'hi' }] });
    const contextMessage = messages.find((m) => m.role === 'system');
    expect(contextMessage?.content).toContain('[BOB MEMORY — background only.');
    expect(contextMessage?.content).toContain('[END BOB MEMORY]');
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'hi' });
  });

  it('leaves the default agent instructions untouched', () => {
    const settings = settingsOf(createBobAgent());
    expect(settings.instructions).toBe(BOB_AGENT_INSTRUCTIONS);
  });
});

describe('agent instructions', () => {
  it('tells the agent the BOB MEMORY block is background, not current speech', () => {
    expect(BOB_AGENT_INSTRUCTIONS).toMatch(/\[BOB MEMORY/);
    expect(BOB_AGENT_INSTRUCTIONS).toMatch(/\[END BOB MEMORY\]/);
    expect(BOB_AGENT_INSTRUCTIONS).toMatch(/background/i);
    expect(BOB_AGENT_INSTRUCTIONS).toMatch(/user said/i);
  });
});
