/**
 * The tool groups a web chat turn offers beside memory and productivity (timers, voice, device). The device
 * turn's groups are turn/tools.ts: device tools bind to every connected device here, the calling device there.
 */
import type { Tool } from 'ai';
import type { AppDeps } from '../app-deps.ts';
import type { FirstPartyToolContext } from '../voice/tool-providers.ts';
import type { Db } from '../platform/db/db.ts';
import { firstPartyToolGroups } from '../turn/tool-wiring.ts';

/** What webChat needs from the process. Read at request time, so a memory worker set after the route is
 *  mounted is picked up. */
export type WebChatDeps = Pick<AppDeps, 'getDb' | 'agent' | 'deviceSessions' | 'timersChanged' | 'embedder' | 'memoryWorker' | 'recordTurnMetric' | 'googleTools'>;

export function webTurnTools(deps: WebChatDeps, db: Db, userId: string, timeZone: string, spaceId: string | null): Record<string, Tool> {
  const groups = webTurnToolGroups(deps, db, userId, timeZone, spaceId);
  return { ...groups.timers, ...groups.late };
}

/**
 * Timers are always offered; the voice and device tools (`late`) depend on the Space and a connected device,
 * so the cache layout places them after memory, at the end of the tool list.
 */
export function webTurnToolGroups(
  deps: WebChatDeps,
  db: Db,
  userId: string,
  timeZone: string,
  spaceId: string | null,
): { timers: Record<string, Tool>; late: Record<string, Tool> } {
  return firstPartyToolGroups(webToolContext(deps, db, userId, timeZone, spaceId));
}

/** The web turn's first-party context: device tools drive every connected device of the account. */
export function webToolContext(deps: WebChatDeps, db: Db, userId: string, timeZone: string, spaceId: string | null): FirstPartyToolContext {
  const registry = deps.deviceSessions;
  return {
    db, userId, timeZone, spaceId, timersChanged: deps.timersChanged,
    // Every connected device of the account, starting from the first one's state; none connected omits device tools.
    device: registry.forAccount(userId).length === 0
      ? undefined
      : { registry, userId, deviceId: null, state: () => registry.forAccount(userId)[0]?.session.deviceState },
  };
}
