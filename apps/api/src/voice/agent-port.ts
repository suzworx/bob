/**
 * The seam between the agent callers (device turn, web chat, invocations) and
 * whatever supplies the agent. Callers never check an AI-stub flag: which
 * adapter answers is decided once, by selectAgent() at the composition root.
 */
import type { Tool } from 'ai';
import type { CreateBobAgentOptions, createBobAgent, bobAgent } from '@bob/ai';

/** The agent shape the turn pipeline and web chat call (a ToolLoopAgent). */
export type AgentImpl = typeof bobAgent;
export type InvocationAgent = ReturnType<typeof createBobAgent>;
/** What a caller hands the port: a TURN_PROFILES `mode` plus data only; the row supplies the rest. */
type TurnAgentOptions = CreateBobAgentOptions;

/** Which adapter a port is; only web chat's canned-stream branch reads it. */
type AgentKind = 'real' | 'stub' | 'scripted';

export interface AgentPort {
  readonly kind: AgentKind;
  /** The shared agent with no per-turn tools: the `unpaired` TURN_PROFILES row. */
  base(): AgentImpl;
  create(options: TurnAgentOptions): AgentImpl;
  createInvocation(options: TurnAgentOptions): InvocationAgent;
  /** The agent to run over the tools actually offered this turn: the scripted stub answers over exactly those tools; every other adapter returns `agent` unchanged. */
  withOfferedTools(agent: AgentImpl, offered: Record<string, Tool>): AgentImpl;
}

const STUB_MARK = Symbol.for('bob.stubAgent');

/** Marks an agent as a canned stub: it has no model, no tokens and always "streams". */
export function markStubAgent<T extends object>(agent: T): T {
  Object.defineProperty(agent, STUB_MARK, { value: true });
  return agent;
}

/** Whether `agent` came from a stub adapter. */
export function isStubAgent(agent: unknown): boolean {
  return typeof agent === 'object' && agent !== null && (agent as Record<symbol, unknown>)[STUB_MARK] === true;
}
