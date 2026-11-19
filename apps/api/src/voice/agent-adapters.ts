/**
 * AgentPort adapters and the function that picks them.
 *
 *  - real adapter: the @bob/ai Gateway agent.
 *  - stub adapter: canned replies, no model (the AI_STUB_MODE behaviour).
 *  - scripted adapter: the stub, plus a scripted model over the tools a
 *    turn offered; never built when BOB_PRODUCTION=1.
 *  - selectAgent(config): the only place stub mode is decided for the agent.
 */
import type { Tool } from 'ai';
import { AI_STUB_MODE, createBobAgent, createScriptedStubAgent, bobAgent, scriptedStubAllowed, TURN_PROFILES } from '@bob/ai';
import { markStubAgent, type AgentImpl, type AgentPort, type InvocationAgent } from './agent-port.ts';

export const STUB_INVOCATION_REPLY = 'System test response';

/** Which adapter is chosen. Built from env once, at the composition root. */
export interface AgentConfig {
  /** AI stub mode: canned replies, no model. */
  stub: boolean;
  /** The scripted stub (BOB_AI_STUB=scripted); implies `stub`, never in production. */
  scripted: boolean;
}

/** `aiStub` is @bob/ai's AI_STUB_MODE; `scriptedAllowed` its scriptedStubAllowed(). */
export function agentConfigFromEnv(aiStub: boolean, scriptedAllowed: boolean): AgentConfig {
  return { stub: aiStub, scripted: aiStub && scriptedAllowed };
}

/** The injectable pieces of the real adapter; tests replace them. */
export interface RealAgentFactories {
  createBobAgent: typeof createBobAgent;
  bobAgent: () => AgentImpl;
}

/** The real adapter. Defaults read @bob/ai at call time. */
export function createRealAgent(factories?: RealAgentFactories): AgentPort {
  const build = factories?.createBobAgent ?? ((options: Parameters<typeof createBobAgent>[0]) => createBobAgent(options));
  const base = factories?.bobAgent ?? ((): AgentImpl => bobAgent);
  return {
    kind: 'real',
    base,
    create: (options) => build(options) as unknown as AgentImpl,
    createInvocation: (options) => build(options),
    withOfferedTools: (agent) => agent,
  };
}

/** The device turn's canned agent: echoes the last message; runAgent/streamAgent recognise it as a stub. */
function cannedTurnAgent(): AgentImpl {
  return markStubAgent({
    generate: (call: { messages: Array<{ content?: unknown }> }) => {
      const last = call.messages.at(-1)?.content ?? '';
      return Promise.resolve({ text: `System test response: ${String(last)}`, toolCalls: [] });
    },
  }) as unknown as AgentImpl;
}

function cannedInvocationAgent(): InvocationAgent {
  return markStubAgent({
    generate: () => Promise.resolve({ text: STUB_INVOCATION_REPLY, toolCalls: [] }),
  }) as unknown as InvocationAgent;
}

/** The stub adapter: no model call anywhere. */
export function createStubAgent(): AgentPort {
  return {
    kind: 'stub',
    base: cannedTurnAgent,
    create: cannedTurnAgent,
    createInvocation: cannedInvocationAgent,
    withOfferedTools: (agent) => agent,
  };
}

/** The scripted adapter: the stub for every caller, plus the scripted model over the offered tools. `build` is injectable. */
export function createScriptedAgent(build: (tools: Record<string, Tool>) => AgentImpl = (tools) => createScriptedStubAgent(tools) as unknown as AgentImpl): AgentPort {
  return {
    ...createStubAgent(),
    kind: 'scripted',
    createInvocation: (options) => {
      // Only a shared-app row runs the scripted model; every other invocation stays canned.
      if (!options.mode || !TURN_PROFILES[options.mode].shared) return cannedInvocationAgent();
      const tools = options.capabilityTools ?? {};
      return build(options.filterTools ? options.filterTools(tools) : tools);
    },
    withOfferedTools: (_agent, offered) => build(offered),
  };
}

/** Picks the agent adapter for a config: the one place agent stubbing is decided. `real` is injectable for tests. */
export function selectAgent(config: AgentConfig, real: AgentPort = createRealAgent()): AgentPort {
  if (config.scripted) return createScriptedAgent();
  if (config.stub) return createStubAgent();
  return real;
}

/**
 * The port the composition root hands out. AI-stub mode itself is fixed at process start, but the
 * scripted opt-in (BOB_AI_STUB=scripted, never in production) is documented as read on every call
 * so a test can flip it; `config` is therefore a function and the matching adapter answers each call.
 */
export function selectAgentLive(config: () => AgentConfig, real: AgentPort = createRealAgent()): AgentPort {
  const current = (): AgentPort => selectAgent(config(), real);
  return {
    get kind() { return current().kind; },
    base: () => current().base(),
    create: (options) => current().create(options),
    createInvocation: (options) => current().createInvocation(options),
    withOfferedTools: (agent, offered) => current().withOfferedTools(agent, offered),
  };
}

/** The port for this process's env: what createAppDeps() picks, for callers built without AppDeps. */
export function defaultAgentPort(): AgentPort {
  return selectAgent(agentConfigFromEnv(AI_STUB_MODE, scriptedStubAllowed()));
}
