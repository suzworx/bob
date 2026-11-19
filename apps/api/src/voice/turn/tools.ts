import { createSpaceMemberTools, localTimeDuesEnabled } from '@bob/ai';
import {
  type DeviceControlPatch,
  type SessionDto,
} from '../protocol.ts';
import { type DeviceSession } from '../session-handlers.ts';
import { DEFAULT_DEVICE_SETTINGS } from '../../devices/settings-store.ts';
import type { FirstPartyToolContext } from '../tool-providers.ts';
import { keepForActiveGame, type GameScope } from '../game-tools.ts';
import { type Db } from '../../platform/db/db.ts';
import { ensurePrivateSpace, getSpace } from '../../spaces/store.ts';
import { getActiveSpace } from '../../spaces/active.ts';
import { bindSpaceMemberCallbacks } from '../../conversations/space-member-callbacks.ts';
import { type LocalTimeScope } from '../../conversations/invocations-service.ts';
import type { Tool } from 'ai';
import { sharedTurn, type TurnMemoryContext } from './context.ts';
import type { TurnDeps } from './deps.ts';
import type { GoogleTurnAnchor } from '../../integrations/google-tools.ts';
import { abortable } from './abort.ts';
import {
  appExtensionTools, firstPartyToolGroups, isLivePrivateScope, lazyAnchor, readGameScope, spaceProductivityTools,
} from '../../turn/tool-wiring.ts';

/** The account's active Space when it names a live space the account is
 *  still a member of; null for no pointer, a cleared one, or any read error,
 *  so the turn falls back to the private space. The space kind is
 *  checked separately to gate list_space_members. */
async function resolveActiveSpace(db: Db, userId: string): Promise<{ spaceId: string; name: string } | null> {
  try {
    const active = await getActiveSpace(db, userId);
    if (!active || active.spaceId === null || active.name === null) return null;
    return { spaceId: active.spaceId, name: active.name };
  } catch {
    return null;
  }
}

/** The space a live shared conversation's turn binds its tools to; null
 *  for a private turn or a shared conversation that is gone or archived. */
function sharedSpace(session: SessionDto, memory: TurnMemoryContext): { spaceId: string; name: string } | null {
  const scope = memory.conversation ?? null;
  if (scope === null || scope.spaceId === null || scope.archivedAt !== null || !sharedTurn(session, memory)) return null;
  return { spaceId: scope.spaceId, name: scope.spaceName ?? '' };
}

/**
 * Timers, voice tools (the same Space as the productivity tools; omitted with
 * them when no Space resolved) and device tools. Building them touches no
 * store; the caller's try/catch still degrades the turn if one throws.
 */
function deviceTurnTools(
  deps: TurnDeps,
  session: SessionDto,
  memory: TurnMemoryContext,
  spaceId: string | null,
): { timers: Record<string, Tool>; late: Record<string, Tool> } {
  // `late` (voice, device) follows memory in the tool order.
  return firstPartyToolGroups(deviceToolContext(deps, session, memory, spaceId));
}

/** The device turn's first-party context: device tools bind to the calling device (the web chat drives every connected one). */
export function deviceToolContext(deps: TurnDeps, session: SessionDto, memory: TurnMemoryContext, spaceId: string | null): FirstPartyToolContext {
  const { db, userId, timeZone } = memory;
  const auth = (session as DeviceSession).auth;
  return {
    db, userId, timeZone, spaceId, timersChanged: deps.timersChanged,
    device: {
      registry: deps.deviceSessions,
      userId,
      deviceId: auth?.kind === 'device' ? auth.deviceId : null,
      ...(auth?.kind === 'device' ? { deviceName: auth.name } : {}),
      state: () => session.deviceState,
      apply: (patch: DeviceControlPatch) => {
        session.deviceState = { ...(session.deviceState ?? DEFAULT_DEVICE_SETTINGS), ...patch };
      },
    },
  };
}

/** The capability half of a device turn's tool set, with its Space context. */
export interface TurnCapabilities {
  /** The actual Space targeted by productivity and voice tools, which may differ from the conversation. */
  toolSpaceId?: string | null;
  capabilityTools: Record<string, Tool>;
  /** The voice and device tools, placed after memory. */
  lateTools?: Record<string, Tool>;
  spaceContext: string | null;
  scope: 'private' | 'space';
  spaceMs: number;
  /** The game scope read's ms, for the prep journal. */
  gameMs?: number;
  /** The conversation's game scope; null with no conversation or when the games store failed. */
  game: GameScope | null;
}

/** The device conversation's game scope, read before any other tool. */
async function turnGameScope(session: SessionDto, memory: TurnMemoryContext): Promise<GameScope | null> {
  const conversationId = session.activeConversationId;
  // Games live only in private conversations, never a shared one.
  if (!conversationId || sharedTurn(session, memory)) return null;
  const auth = (session as DeviceSession).auth;
  return await readGameScope(memory.db, memory.userId, {
    conversationId, deviceId: auth?.kind === 'device' ? auth.deviceId : null, timeZone: memory.timeZone,
  });
}

/** The productivity tools and Space context, bound to the active Space
 *  (or the shared conversation's space), else the private one. A spaces-store
 *  failure leaves them out; the rest of the turn's tools still build. */
async function spaceTools(memory: TurnMemoryContext, session: SessionDto): Promise<{
  productivityTools: Record<string, Tool>; spaceContext: string | null; scope: 'private' | 'space'; toolSpaceId: string | null; spaceMs: number;
}> {
  const spaceStartedAt = Date.now();
  const localTimeDues = localTimeDuesEnabled();
  const timeScope: LocalTimeScope = { timeZone: memory.timeZone, localTimeDues };
  try {
    // A shared conversation's turn's tools act on its space.
    const active = sharedSpace(session, memory) ?? await resolveActiveSpace(memory.db, memory.userId);
    if (active) {
      let memberTools: Record<string, Tool> = {};
      let allowNotifyEmail = false;
      try {
        const space = await getSpace(memory.db, memory.userId, active.spaceId);
        allowNotifyEmail = space.kind === 'private';
        memberTools = space.kind !== 'private' ? createSpaceMemberTools(bindSpaceMemberCallbacks(memory.db, memory.userId, active.spaceId)) : {};
      } catch {
        // Space fetch failed, skip member tools but continue with context
      }
      return {
        productivityTools: {
          ...spaceProductivityTools(memory.db, memory.userId, active.spaceId, timeScope, {
            calendarName: active.name,
            allowNotifyEmail,
          }),
          ...memberTools,
        },
        spaceContext: `[Active space]
Tasks, events, reminders and notes you create or list belong to the space "${active.name}".`,
        scope: 'space',
        toolSpaceId: active.spaceId,
        spaceMs: Date.now() - spaceStartedAt,
      };
    }
    const space = await ensurePrivateSpace(memory.db, memory.userId);
    return {
      productivityTools: spaceProductivityTools(memory.db, memory.userId, space.id, timeScope, { allowNotifyEmail: true }),
      spaceContext: null, scope: 'private', toolSpaceId: space.id, spaceMs: Date.now() - spaceStartedAt,
    };
  } catch {
    return { productivityTools: {}, spaceContext: null, scope: 'private', toolSpaceId: null, spaceMs: Date.now() - spaceStartedAt };
  }
}

/**
 * The capability tools of a device turn, built whether or not memory is
 * available, so memory-on and memory-off turns offer the same set. Productivity
 * tools bind to the active Space, else the private one. A spaces-store failure
 * omits the productivity and voice tools; timers and device tools remain.
 * The game scope and the Space are read in parallel (independent store reads);
 * the Google tools are not built here: they need the prepared anchor, so the
 * caller starts googleTurnTools once the turn is prepared and appends them.
 */
export async function buildTurnCapabilities(deps: TurnDeps, session: SessionDto, memory: TurnMemoryContext): Promise<TurnCapabilities> {
  const spacePromise = spaceTools(memory, session);
  const gameStartedAt = Date.now();
  const game = await turnGameScope(session, memory);
  const gameMs = Date.now() - gameStartedAt;
  // An ACTIVE game replaces every capability tool with its own, keeping only
  // set_volume. No Space, productivity, timer or voice tool is offered for it
  // (the parallel Space read is discarded).
  if (game?.mode === 'active') {
    const kept = keepForActiveGame(deviceTurnTools(deps, session, memory, null).late);
    return { capabilityTools: game.tools, lateTools: kept, spaceContext: null, scope: 'private', spaceMs: 0, gameMs, game };
  }
  const { productivityTools, spaceContext, scope, toolSpaceId, spaceMs } = await spacePromise;
  // Timers lead; voice/device go last as `lateTools`, after memory.
  const groups = deviceTurnTools(deps, session, memory, toolSpaceId);
  return { capabilityTools: { ...groups.timers, ...productivityTools, ...(game?.tools ?? {}) }, lateTools: groups.late, toolSpaceId, spaceContext, scope, spaceMs, gameMs, game };
}

/** The Google tools of a private, prepared device turn; {} when it is not one,
 *  when no Google runtime is configured, or on any failure. They go last in
 *  the capability tools, after the game tools. */
export async function googleTurnTools(deps: TurnDeps, memory: TurnMemoryContext, signal?: AbortSignal, gate?: Promise<void>): Promise<Record<string, Tool>> {
  if (gate !== undefined) {
    // A speculative run: the anchor message is written after turn_end, so the tools get it lazily, once the commit has
    // released the gate (after prepare settled). A discarded run never calls it.
    const conversationId = memory.conversation?.conversationId;
    if (!deps.googleTools || !conversationId || !mayOfferGoogleTools(deps, memory)) return {};
    const anchor = lazyAnchor(gate, (): GoogleTurnAnchor | null => {
      const prepared = memory.prepared;
      return prepared && prepared.conversationId === conversationId ? { conversationId: prepared.conversationId, messageId: prepared.userMessageId } : null;
    });
    return deps.googleTools({ userId: memory.userId, anchor, allowNewOperations: true, signal }).catch(() => ({}));
  }
  const prepared = memory.prepared;
  if (!deps.googleTools || !prepared || !mayOfferGoogleTools(deps, memory)) return {};
  return deps.googleTools({ userId: memory.userId, conversationId: prepared.conversationId, messageId: prepared.userMessageId, allowNewOperations: true, signal }).catch(() => ({}));
}

/** Whether a device turn in this scope could be offered the Google runtime's tools (the Google tools and the routine tools):
 *  the runtime is wired and the scope is a live private space. The routine tools reach every private turn (routines/tools.ts,
 *  through google-runtime.ts), so a linked-account read could not narrow this. A speculative run gets them on a lazy anchor. */
function mayOfferGoogleTools(deps: TurnDeps, memory: TurnMemoryContext): boolean {
  return deps.googleTools !== undefined && isLivePrivateScope(memory.conversation);
}

/** An app's tools need a committed owner-authored anchor even to construct its offered map, on a live private
 * space only. An eligible speculative turn waits for commit before building that map, then re-admits the app on the
 * committed scope; {} without the extension, outside that scope, or on any failure. A turn with a bound app waits for the
 * anchor before the model starts, because the app's tools are built against the committed message. */
export async function appTurnTools(deps: TurnDeps, memory: TurnMemoryContext, signal?: AbortSignal, gate?: Promise<void>): Promise<Record<string, Tool>> {
  const apps = deps.appTurnTools;
  const scope = memory.conversation;
  if (!apps || !isLivePrivateScope(scope)) return {};
  if (gate === undefined && !memory.prepared) return {};
  signal?.throwIfAborted();
  const initial = await apps.preflight(memory.db, memory.userId, scope.conversationId).catch(() => null);
  if (!initial) return {};
  if (gate !== undefined) await abortable(gate, signal);
  signal?.throwIfAborted();
  const prepared = memory.prepared;
  if (!prepared || prepared.conversationId !== scope.conversationId) return {};
  const binding = gate === undefined ? initial : await apps.preflight(memory.db, memory.userId, prepared.conversationId).catch(() => null);
  signal?.throwIfAborted();
  const anchor = { conversationId: prepared.conversationId, messageId: prepared.userMessageId };
  const { tools } = await appExtensionTools(apps, memory.db, memory.userId, binding, anchor).catch(() => ({ tools: {} }));
  signal?.throwIfAborted();
  return tools;
}
