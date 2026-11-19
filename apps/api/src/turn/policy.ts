/**
 * Device tool policy: the filter a device turn's offered tools pass through, and the no-tools agent it falls back to.
 * Trigger: the device turn's prep (turn/device-prep.ts loadPrep) and its agent build (turn/device-agent.ts).
 * Steps: 1. read the conversation's policy. 2. when the tools target another Space (an active group), read that
 *   Space's policy too and intersect the two.
 * Outcome: a filter neither scope can widen; with no policy storage the turn gets the no-tools degraded agent, never
 *   the unfiltered singleton.
 * Journal: none.
 */
import type { Tool } from 'ai';
import { prepareToolPolicyFilter } from '../tools/policy.ts';
import type { SessionDto } from '../voice/protocol.ts';
import type { AgentImpl } from '../voice/agent-port.ts';
import type { TurnMemoryContext } from '../voice/turn/context.ts';
import type { TurnDeps } from '../voice/turn/deps.ts';
import type { TurnCapabilities } from '../voice/turn/tools.ts';

/** Missing policy storage must never restore the unfiltered singleton: the no-tools device row. */
export function voiceAgent(deps: TurnDeps, session: SessionDto): AgentImpl {
  return deps.agent.create({ mode: 'device_degraded' });
}

/** The device may target an active group while retaining its private chat history.
 * Intersect both independently authorized scopes; neither can enable the other's denial. */
export async function turnPolicyFilter(memory: TurnMemoryContext, conversationId: string | undefined, capabilities: TurnCapabilities): Promise<(tools: Record<string, Tool>) => Record<string, Tool>> {
  const conversationFilter = await prepareToolPolicyFilter(memory.db, memory.userId, conversationId ? { conversationId } : {});
  if (!capabilities.toolSpaceId || capabilities.toolSpaceId === memory.conversation?.spaceId) return conversationFilter;
  const spaceFilter = await prepareToolPolicyFilter(memory.db, memory.userId, { spaceId: capabilities.toolSpaceId });
  return (tools) => spaceFilter(conversationFilter(tools));
}
