/**
 * Device agent build: one paired device turn's offered tools and agent, on its prep (turn/device-prep.ts).
 * Trigger: voice/turn/generate.ts generateReply, once the memory block is read.
 * Steps: 1. the capabilities and the game (turn/game-turn.ts). 2. the Google, app and timeline tools after them, the late
 *   group and the memory tools, each closed once a game opens. 3. the Space and one-step game context. 4. the policy
 *   (gated on the anchor write for an early turn), then the agent.
 * Outcome: the agent and what it offers; any setup error falls back to the no-tools agent, and the turn still replies.
 * Journal: v2.agent_tools_degraded (interface cardputer).
 */
import { BOB_AGENT_INSTRUCTIONS, assistantTools } from '@bob/ai';
import type { Tool } from 'ai';
import { createTimelineTools } from '../timeline/tools.ts';
import type { GameTurnState } from '../voice/game-tools.ts';
import type { SessionDto } from '../voice/protocol.ts';
import { sessionBoard } from '../voice/session-board.ts';
import type { AgentImpl } from '../voice/agent-port.ts';
import { agentSectionSizes, type AgentSectionSizes } from '../voice/turn-core.ts';
import { abortable } from '../voice/turn/abort.ts';
import { personalMemoryTurn, type TurnMemoryContext } from '../voice/turn/context.ts';
import type { TurnDeps } from '../voice/turn/deps.ts';
import type { TurnCapabilities } from '../voice/turn/tools.ts';
import type { TurnPrep } from './device-prep.ts';
import { deviceGameTurn } from './game-turn.ts';
import { voiceAgent } from './policy.ts';
import { gatedTools, waitedFor } from './prep-kit.ts';
import { turnMemoryTools } from './tool-wiring.ts';

type Journal = (event: string, fields: Record<string, string | number | boolean | undefined>) => void;

export interface DeviceAgentInput {
  deps: TurnDeps; session: SessionDto; turnRef: string; memory: TurnMemoryContext; prep: TurnPrep;
  block: string | null; toolGate: Promise<void> | undefined; signal: AbortSignal | undefined;
  waits: Record<string, number>; speculative: { speculative?: boolean }; journal: Journal;
}

/** The built agent; the game fields keep what was read even when a later step degraded the tools. */
export interface DeviceAgent {
  agent: AgentImpl; offeredToolMap: Record<string, Tool>; sections: AgentSectionSizes; toolScope: 'private' | 'space';
  gameTurn: GameTurnState | null; gameActive: boolean; spaceMs?: number; gameMs?: number;
}

type OneStep = NonNullable<TurnCapabilities['game']>['oneStep'];

/** A one-step game's stop and step hooks; none outside one. */
function oneStepOptions(oneStep: OneStep): { stopWhen?: NonNullable<OneStep>['stopWhen']; prepareStep?: NonNullable<OneStep>['prepareStep'] } {
  return oneStep ? { stopWhen: oneStep.stopWhen, prepareStep: oneStep.prepareStep } : {};
}

type BuildState = Omit<DeviceAgent, 'agent' | 'offeredToolMap' | 'sections'>;

/** The capability, late and memory groups, closed once a game opens; `out` keeps the game and Space read so far. */
async function deviceToolSet(input: DeviceAgentInput, out: BuildState) {
  const { deps, session, turnRef, memory, prep, signal, waits, journal } = input;
  let { block } = input;
  // Memory tools only when memory is on; the capability tools and the
  // Space context ride on every paired turn, so the tool set (the head of
  // the cached prefix) does not flip with memory availability.
  const capabilities = await prep.capabilities;
  // An active game gets neither memory tools nor the memory block.
  const { gameTurn, gameActive, close } = deviceGameTurn(deps, session, turnRef, capabilities, signal);
  out.gameTurn = gameTurn; out.gameActive = gameActive;
  // Google tools go last in the capability tools, after the game tools.
  const timeline = !gameActive && capabilities.scope === 'private' && session.activeConversationId
    ? createTimelineTools(memory.db, memory.userId, session.activeConversationId) : {};
  // The app extension's tools sit after Google, before the timeline.
  const googleTools = await waitedFor(waits, 'google_wait_ms', prep.google);
  const appTools = gameActive ? {} : await waitedFor(waits, 'app_tools_wait_ms', abortable(prep.appTools, signal));
  const capabilityTools = close({ ...capabilities.capabilityTools, ...googleTools, ...appTools, ...timeline });
  const lateTools = capabilities.lateTools ? close(capabilities.lateTools) : undefined; if (gameActive) block = null;
  const memoryTools = personalMemoryTurn(session, memory) && !gameActive
    ? close(turnMemoryTools({
      db: memory.db, userId: memory.userId,
      turn: { conversationId: session.activeConversationId ?? null, messageId: null, surface: 'device' },
      spaceId: memory.conversation?.spaceId ?? undefined,
      deps,
      journal,
    }))
    : undefined;
  out.spaceMs = capabilities.spaceMs;
  out.gameMs = capabilities.gameMs;
  out.toolScope = capabilities.scope;
  const { spaceContext } = capabilities;
  // The one-step game context rides with the Space context, and is sized with it.
  const turnContext = [spaceContext, capabilities.game?.oneStep?.context ?? null].filter((part): part is string => part !== null).join('\n\n') || null;
  const context = [block, turnContext].filter((part): part is string => part !== null).join('\n\n');
  return { capabilities, capabilityTools, lateTools, memoryTools, block, turnContext, context };
}

export async function buildDeviceAgent(input: DeviceAgentInput): Promise<DeviceAgent> {
  const { deps, session, turnRef, memory, toolGate, signal, waits, journal } = input;
  const out: BuildState = { toolScope: 'private', gameTurn: null, gameActive: false };
  // Tool wiring must never cost the user their turn: any setup error falls
  // back to an agent with no tools, and the turn still replies and persists.
  try {
    const { capabilities, capabilityTools, lateTools, memoryTools, block, turnContext, context } = await deviceToolSet(input, out);
    const conversationId = memory.conversation?.conversationId ?? memory.prepared?.conversationId;
    if (session.activeConversationId && !conversationId) throw new Error('tool_policy_scope_unavailable');
    const policy = await waitedFor(waits, 'policy_ms', input.prep.policy);
    const filterTools = toolGate === undefined ? policy : gatedTools(policy, toolGate, signal);
    const buildStartedAt = Date.now();
    const agent = deps.agent.create({
      mode: 'device',
      filterTools,
      memoryContext: context === '' ? undefined : context,
      ...(memoryTools ? { memoryTools } : {}),
      capabilityTools,
      ...(lateTools ? { lateTools } : {}),
      timeZone: memory.timeZone,
      ...(session.activeConversationId ? { cacheKey: session.activeConversationId } : {}),
      ...oneStepOptions(capabilities.game?.oneStep),
    });
    const offeredToolMap = agent.tools ?? filterTools({ ...assistantTools, ...capabilityTools, ...(memoryTools ?? {}), ...(lateTools ?? {}) });
    const sections = agentSectionSizes({ tools: offeredToolMap, instructions: BOB_AGENT_INSTRUCTIONS, memory: block, context: turnContext });
    waits.build_ms = Date.now() - buildStartedAt;
    return { ...out, agent, offeredToolMap, sections };
  } catch (error) {
    signal?.throwIfAborted();
    const agent = voiceAgent(deps, session);
    const offeredToolMap = {};
    const sections = agentSectionSizes({ tools: offeredToolMap, instructions: BOB_AGENT_INSTRUCTIONS });
    journal('v2.agent_tools_degraded', {
      interface: 'cardputer',
      board: sessionBoard(session),
      turn_id: turnRef,
      error: error instanceof Error ? error.name : 'unknown',
      ...input.speculative,
    });
    return { ...out, toolScope: 'private', agent, offeredToolMap, sections };
  }
}
