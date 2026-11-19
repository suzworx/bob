/**
 * The agent of a live game test turn, as the device turn builds it
 * (voice/turn/generate.ts and turn/tools.ts): voice reply style as Bob, an
 * active game offers only its own tools and currentDateTime, and a one-step
 * scope adds its [Game turn] context, stop condition and first-call tool
 * choice. Opt-in live tests only.
 */
import type { Tool, ToolLoopAgent } from 'ai';
import { createBobAgent } from '@bob/ai';
import type { GameScope } from '../../src/voice/game-tools.ts';

export function liveGameAgent(scope: GameScope): ToolLoopAgent {
  const keep = new Set([...Object.keys(scope.tools), 'currentDateTime']);
  const only = (tools: Record<string, Tool>): Record<string, Tool> =>
    Object.fromEntries(Object.entries(tools).filter(([name]) => keep.has(name)));
  const agent = createBobAgent({
    capabilityTools: scope.tools, timeZone: 'UTC', mode: 'device',
    ...(scope.mode === 'active' ? { filterTools: only } : {}),
    ...(scope.oneStep ? { memoryContext: scope.oneStep.context, stopWhen: scope.oneStep.stopWhen, prepareStep: scope.oneStep.prepareStep } : {}),
  });
  return agent;
}
