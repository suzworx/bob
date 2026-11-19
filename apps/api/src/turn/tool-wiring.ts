/**
 * Ability wiring: the one way a turn builds its tool groups, shared by the device turn (voice/turn/tools.ts,
 * voice/turn/generate.ts) and the web chat turn (turn/chat-agent.ts, conversations/chat-tools.ts).
 * Trigger: a turn's prep (the capability reads) or its agent build (memory tools, game closing).
 * Steps: 1. first-party groups from the one registry (timers early; voice, apps, device late). 2. productivity tools
 *   bound to a Space. 3. the game scope read, then closing what an active game would not offer once one opens.
 *   4. memory tools. 5. the Google tools' lazy anchor (the gate form). 6. the app extension's tools.
 * Outcome: tool maps the caller merges in its own order; each surface keeps only what differs (how device tools bind,
 *   which Space, where the Google, app and timeline tools sit).
 * Journal: none (memory tools journal through the caller's `journal`).
 */
import type { Tool } from 'ai';
import { createMemoryTools, createProductivityTools, type Embedder } from '@bob/ai';
import { createToolRegistry } from '../voice/tool-registry.ts';
import { firstPartyToolProviders, type FirstPartyToolContext } from '../voice/tool-providers.ts';
import { ACTIVE_GAME_KEEP, closedOnceGameOpens, resolveGameScope, type GameScope } from '../voice/game-tools.ts';
import { bindPrivateCallbacks } from '../tasks/agent-callbacks.ts';
import type { LocalTimeScope } from '../conversations/invocations-service.ts';
import { createMemoryCallbacks } from '../memory/callbacks.ts';
import { defaultMemoryJudge } from '../memory/judge.ts';
import type { MemoryEmbedding } from '../memory/store.ts';
import type { GoogleTurnAnchor } from '../integrations/google-tools.ts';
import type { AppBinding, AppTurnExtension, AppTurnTools } from '../bob-apps/app-turn-extension.ts';
import type { Db } from '../platform/db/db.ts';

type ToolMap = Record<string, Tool>;

const toolRegistry = createToolRegistry<FirstPartyToolContext>(firstPartyToolProviders());

/** Timers (`timers`, leading the capability group) and the voice, app and device tools (`late`, after memory). */
export function firstPartyToolGroups(ctx: FirstPartyToolContext): { timers: ToolMap; late: ToolMap } {
  return { timers: toolRegistry.resolveSync(ctx, 'early'), late: toolRegistry.resolveSync(ctx, 'late') };
}

export function spaceProductivityTools(
  db: Db, userId: string, spaceId: string, timeScope: LocalTimeScope, options: Parameters<typeof bindPrivateCallbacks>[4],
): ToolMap {
  return createProductivityTools(bindPrivateCallbacks(db, userId, spaceId, timeScope, options), { localTimeDues: timeScope.localTimeDues });
}

interface SpaceScope { spaceKind: string | null; spaceId: string | null; spaceArchived: boolean; archivedAt: unknown }

/** A live private conversation: the only scope whose Google and app tools reach the account's own space. */
export function isLivePrivateScope<T extends SpaceScope>(scope: T | null | undefined): scope is T {
  return scope?.spaceKind === 'private' && Boolean(scope.spaceId) && !scope.spaceArchived && scope.archivedAt === null;
}

/** The conversation's game scope; null when the games store failed. */
export function readGameScope(db: Db, userId: string, scope: Parameters<typeof resolveGameScope>[2]): Promise<GameScope | null> {
  return resolveGameScope(db, userId, scope).catch(() => null);
}

/** Closes, once a game opens mid-turn, every tool an active game would not have offered; unchanged outside a game and
 *  inside an active one (whose tool set is already scoped). */
export function closeOnceGameOpens(game: GameScope | null): (tools: ToolMap) => ToolMap {
  if (game === null || game.mode === 'active') return (tools) => tools;
  const open = new Set([...Object.keys(game.tools), ...ACTIVE_GAME_KEEP]);
  return (tools) => closedOnceGameOpens(tools, game.turn, open);
}

// Remember must store a vector or semantic retrieval can never find it.
/** The MemoryCallbackDeps.embedder for a turn: embeds content and adapts the
 *  Embedder's number[] into the { values, model, dim } MemoryEmbedding. */
export function memoryEmbedderDep(deps: { embedder(): Embedder }): (content: string) => Promise<MemoryEmbedding> {
  return (content) => {
    const embedder = deps.embedder();
    return embedder.embed(content).then((values) => ({ values, model: embedder.modelId, dim: embedder.dim }));
  };
}

type MemoryCallbackDeps = NonNullable<Parameters<typeof createMemoryCallbacks>[2]>;

/** The memory tools of one turn, recorded against its conversation and message (null until stored). */
export function turnMemoryTools(input: {
  db: Db; userId: string; turn: MemoryCallbackDeps['turn']; spaceId: string | undefined;
  deps: { embedder(): Embedder }; journal: NonNullable<MemoryCallbackDeps['journal']>;
}): ToolMap {
  return createMemoryTools(
    createMemoryCallbacks(input.db, input.userId, {
      turn: input.turn,
      spaceId: input.spaceId,
      embedder: memoryEmbedderDep(input.deps),
      journal: input.journal,
      judge: defaultMemoryJudge(),
    }),
  );
}

/** The gate form of the Google tools' anchor: read lazily, inside an execute, once `settles` settles; `anchorOf` null
 *  (the message never landed, or landed elsewhere) fails the tool closed. */
export function lazyAnchor<T>(settles: Promise<T>, anchorOf: (settled: T) => GoogleTurnAnchor | null): () => Promise<GoogleTurnAnchor> {
  return () => settles.then((settled) => {
    const anchor = anchorOf(settled);
    if (!anchor) throw new Error('google_tool_scope_unavailable');
    return anchor;
  });
}

/** The app extension's tools on a committed anchor; none without the extension. */
export function appExtensionTools(
  apps: AppTurnExtension | undefined, db: Db, userId: string, app: AppBinding | null, anchor: GoogleTurnAnchor | null,
): Promise<AppTurnTools> {
  return apps?.tools(db, userId, app, anchor) ?? Promise.resolve({ tools: {}, contextToolNames: [] });
}
