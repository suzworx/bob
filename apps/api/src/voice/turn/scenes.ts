/**
 * The action scene of a turn: the last succeeded tool call that has a scene in
 * the table is pushed to the calling device as soon as the reply is final (a streamed reply may already be playing). Tool
 * names and counts only reach the journal, never labels, inputs or results.
 */
import { type DeviceSession } from '../session-handlers.ts';
import { sceneForToolResult } from '../scene-table.ts';
import type { TurnDeps } from './deps.ts';

const TOOL_PART = /^tool-(.+)$/;

/** Sends the turn's scene to its device; returns how many devices got it. */
export function pushTurnScene(
  deps: Pick<TurnDeps, 'deviceSessions'>,
  session: unknown,
  userId: string | undefined,
  toolParts: ReadonlyArray<Record<string, unknown>>,
): number {
  const auth = (session as DeviceSession).auth;
  if (userId === undefined || auth?.kind !== 'device') return 0;
  for (const part of [...toolParts].reverse()) {
    const name = typeof part.type === 'string' ? TOOL_PART.exec(part.type)?.[1] : undefined;
    if (name === undefined || part.state !== 'output-available') continue;
    const scene = sceneForToolResult(name, part.input, part.output);
    if (scene !== null) return deps.deviceSessions.sendScene(userId, auth.deviceId, scene);
  }
  return 0;
}
