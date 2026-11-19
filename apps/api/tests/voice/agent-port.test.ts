/**
 * AgentPort (ADR 0002, #662): the real, stub and scripted-stub adapters and
 * the one function that picks them. Plain fakes only; nothing reaches a model.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createScriptedStubAgent } from '@bob/ai';
import { agentConfigFromEnv, createRealAgent, createScriptedAgent, createStubAgent, selectAgent, selectAgentLive } from '../../src/voice/agent-adapters.ts';
import { canStream, runAgent, streamAgent } from '../../src/voice/turn/agent.ts';
import { isStubAgent, type AgentImpl, type AgentPort } from '../../src/voice/agent-port.ts';

const messages = [{ role: 'user', content: 'hello there' }];
type GenerateFn = (call: unknown) => Promise<{ text: string; toolCalls: unknown[] }>;
const generate = (agent: unknown): Promise<{ text: string; toolCalls: unknown[] }> => {
  const run = (agent as Record<string, unknown>)['generate'] as GenerateFn;
  return run.call(agent, { messages });
};

describe('agentConfigFromEnv', () => {
  it('is real when AI stub mode is off, even if the scripted flag is allowed', () => {
    expect(agentConfigFromEnv(false, true)).toEqual({ stub: false, scripted: false });
  });
  it('is the canned stub in AI stub mode, scripted only when allowed', () => {
    expect(agentConfigFromEnv(true, false)).toEqual({ stub: true, scripted: false });
    expect(agentConfigFromEnv(true, true)).toEqual({ stub: true, scripted: true });
  });
});

describe('createStubAgent', () => {
  it('echoes the last message as the device turn always did, marked as a stub', async () => {
    const port = createStubAgent();
    expect(port.kind).toBe('stub');
    const agent = port.create({});
    expect(isStubAgent(agent)).toBe(true);
    expect(isStubAgent(port.base())).toBe(true);
    await expect(generate(agent)).resolves.toEqual({ text: 'System test response: hello there', toolCalls: [] });
  });
  it('answers an invocation with the fixed canned reply', async () => {
    const agent = createStubAgent().createInvocation({});
    await expect(generate(agent)).resolves.toEqual({ text: 'System test response', toolCalls: [] });
  });
  it('leaves the offered-tools agent untouched', () => {
    const port = createStubAgent();
    const agent = port.base();
    expect(port.withOfferedTools(agent, {})).toBe(agent);
  });
});

describe('createRealAgent', () => {
  it('builds from the injected factories and marks nothing as a stub', () => {
    const built = { tag: 'built' };
    const base = { tag: 'base' } as unknown as AgentImpl;
    const factory = vi.fn(() => built);
    const port = createRealAgent({ createBobAgent: factory as never, bobAgent: () => base });
    expect(port.kind).toBe('real');
    expect(port.base()).toBe(base);
    expect(port.create({ timeZone: 'UTC' })).toBe(built);
    expect(port.createInvocation({ timeZone: 'UTC' })).toBe(built);
    expect(factory).toHaveBeenCalledWith({ timeZone: 'UTC' });
    expect(isStubAgent(built)).toBe(false);
    expect(port.withOfferedTools(base, {})).toBe(base);
  });
});

describe('createScriptedAgent', () => {
  it('keeps the fixed canned reply for an ordinary group invocation without an app binding', async () => {
    const build = vi.fn((tools) => createScriptedStubAgent(tools, { BOB_AI_STUB: 'scripted' }));
    const agent = createScriptedAgent(build).createInvocation({ mode: 'group', memoryTools: {}, capabilityTools: {} });
    const response = await generate(agent);
    expect(response.text).toBe('System test response');
    expect(response.toolCalls).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });
  it('runs shared invocations over only their policy-permitted bound tools', () => {
    const scripted = { tag: 'shared-scripted' } as unknown as AgentImpl;
    const build = vi.fn(() => scripted);
    const capabilityTools = { allowed: { inputSchema: z.object({}) }, denied: { inputSchema: z.object({}) } };
    const permitted = { allowed: capabilityTools.allowed };
    const filterTools = vi.fn(() => permitted);
    const port = createScriptedAgent(build);
    expect(port.createInvocation({ capabilityTools, filterTools, memoryTools: {}, mode: 'shared_app_run' })).toBe(scripted);
    expect(filterTools).toHaveBeenCalledWith(capabilityTools);
    expect(build).toHaveBeenCalledWith(permitted);
  });
  it('is the canned stub for callers that build an agent, and scripted over the offered tools', () => {
    const scripted = { tag: 'scripted' } as unknown as AgentImpl;
    const build = vi.fn(() => scripted);
    const port = createScriptedAgent(build as never);
    expect(port.kind).toBe('scripted');
    expect(isStubAgent(port.create({}))).toBe(true);
    const tools = {};
    expect(port.withOfferedTools(port.base(), tools)).toBe(scripted);
    expect(build).toHaveBeenCalledWith(tools);
  });
});

describe('selectAgent', () => {
  const real: AgentPort = { ...createStubAgent(), kind: 'real' };
  it('picks real, stub or scripted from the config, and only from the config', () => {
    expect(selectAgent({ stub: false, scripted: false }, real)).toBe(real);
    expect(selectAgent({ stub: true, scripted: false }, real).kind).toBe('stub');
    expect(selectAgent({ stub: true, scripted: true }, real).kind).toBe('scripted');
  });
});

describe('selectAgentLive', () => {
  it('re-reads the config on every call, so flipping the scripted opt-in takes effect without a new port', () => {
    let config = agentConfigFromEnv(true, false);
    const port = selectAgentLive(() => config);
    expect(port.kind).toBe('stub');
    config = agentConfigFromEnv(true, true);
    expect(port.kind).toBe('scripted');
    config = agentConfigFromEnv(false, false);
    expect(port.kind).toBe('real');
  });
});

describe('the turn pipeline over the stub adapter', () => {
  it('runAgent answers a stub agent with the canned reply, marked stub, even when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = createStubAgent().create({});
    await expect(runAgent(messages as never, agent, controller.signal)).resolves.toEqual({ text: 'System test response: hello there', toolCalls: [], stub: true });
  });
  it('streamAgent hands the whole canned reply to onText once, and a stub agent can always stream', async () => {
    const agent = createStubAgent().create({});
    const deltas: string[] = [];
    expect(canStream(agent)).toBe(true);
    const result = await streamAgent(messages as never, agent, (delta) => deltas.push(delta));
    expect(deltas).toEqual(['System test response: hello there']);
    expect(result.stub).toBe(true);
  });
});
