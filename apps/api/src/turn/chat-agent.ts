/**
 * Chat agent build: one web chat turn's prep reads and its agent, on the shared ability wiring (turn/tool-wiring.ts).
 * Trigger: workflows/workflow-web-chat-turn.ts (startWebPrep at once, buildTurnAgent once the history is read).
 * Steps: 1. start every prep read at once: scope, memory, retrieval, history, anchor, app tools, and the build's reads
 *   (game, capabilities, policy, Google). 2. build the agent: game scoping, memory tools, the private-space tools, the
 *   policy gate (every tool waits for the store), or the bound app's agent on the policy alone.
 * Outcome: the agent, the tools it offers and its section sizes; an ordinary turn whose wiring fails degrades to the
 *   base agent, a bound app never does.
 * Journal: v2.agent_tools_degraded (interface web).
 */
import type { Tool } from 'ai';
import { BOB_AGENT_INSTRUCTIONS, assistantTools, localTimeDuesEnabled, type CoreTaskContext } from '@bob/ai';
import { prepareToolPolicyFilter } from '../tools/policy.ts';
import { createTimelineTools } from '../timeline/tools.ts';
import { startMemoryRetrieval, type RetrievalResult } from '../memory/retrieval.ts';
import { allowsPersonalMemory } from '../memory/extract.ts';
import { memoryAvailable } from '../memory/available.ts';
import { getConversationScope } from '../conversations/scope.ts';
import { loadRecentHistory, type RecentMessage } from '../conversations/store.ts';
import { keepForActiveGame, type GameScope, type GameTurnState } from '../voice/game-tools.ts';
import { agentSectionSizes, HISTORY_TRIM_CHUNK, MAX_HISTORY_MESSAGES, type AgentSectionSizes } from '../voice/turn-core.ts';
import type { AgentImpl } from '../voice/agent-port.ts';
import { ensurePrivateSpace } from '../spaces/store.ts';
import { moduleJournal } from '../platform/logger.ts';
import { StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { webTurnToolGroups, type WebChatDeps } from '../conversations/chat-tools.ts';
import type { AppBinding, AppTurnExtension, AppTurnTools } from '../bob-apps/app-turn-extension.ts';
import { gatedTools, started, timed, waitedFor, type PrepTimings } from './prep-kit.ts';
import {
  appExtensionTools, closeOnceGameOpens, isLivePrivateScope, lazyAnchor, readGameScope, spaceProductivityTools, turnMemoryTools,
} from './tool-wiring.ts';

const journal = moduleJournal('conversations');

export interface BuildAgentInput {
  deps: WebChatDeps;
  db: Db;
  userId: string;
  conversationId: string;
  turnId: string;
  surface: 'web_text' | 'web_voice';
  agentSignal: AbortSignal;
  /** The build's reads, started with the turn's prep (startWebPrep). */
  reads: AgentReads;
  /** The prep window's critical-path waits; the build adds its own (game, capabilities, Google, policy, build). */
  waits: PrepTimings;
  /** Settles when the reader's message is stored: every offered tool waits for it before it executes. */
  toolGate: PromiseLike<unknown>;
  scope: Scope;
  retrieval: { result: Promise<RetrievalResult> } | null;
  block: string | null;
  userMessageAnchor: string | null;
  timeZone: string;
  /** Called as soon as the game this turn is in is known, so the reply guard sees it even if a later step throws. */
  onGameTurn: (turn: GameTurnState | null) => void;
  /** The app extension's tools, built on the server after its preflight authorizes the installation. Never from request JSON. */
  appTools?: Record<string, Tool>;
  /** Trusted generic-app scope resolved by Core, never selected by client JSON. */
  boundApp?: { kind: 'declarative' };
  /** Fixed workflow guidance from the app extension after binding authorization; separate from personal memory. */
  taskContext?: CoreTaskContext;
  /** The app tool names whose permitted presence keeps `taskContext`. */
  contextToolNames?: string[];
}

type BuiltAgentParts = { agent: AgentImpl; offeredToolMap: Record<string, Tool>; sections: AgentSectionSizes };
/** The turn's agent on its started reads; the bound-app agent reads only the policy. */
export async function buildTurnAgent(input: BuildAgentInput): Promise<BuiltAgentParts> {
  return input.boundApp ? buildBoundAppAgent(input) : buildGeneralTurnAgent(input);
}

// Ordinary turn wiring may degrade to the base agent when setup fails.
async function buildGeneralTurnAgent(input: BuildAgentInput): Promise<BuiltAgentParts> {
  const { deps, conversationId, turnId, surface, timeZone, reads, waits } = input;
  let { block } = input;
  let agent: AgentImpl;
  let offeredToolMap: Record<string, Tool>;
  let sections: AgentSectionSizes;
  try {
    // A games-store failure leaves the turn without game tools.
    const game = await waitedFor(waits, 'game_wait_ms', reads.game);
    input.onGameTurn(game?.turn ?? null);
    let memoryTools = memoryToolsFor(input, game);
    let { capabilityTools, lateTools } = await waitedFor(waits, 'capabilities_wait_ms', reads.capabilities);
    capabilityTools = await privateSpaceTools(input, game, capabilityTools);
    // The tool set is chosen before the model runs (see scopeToolsToGame).
    ({ capabilityTools, lateTools, memoryTools, block } = scopeToolsToGame(game, { capabilityTools, lateTools, memoryTools, block }));
    const policy = await waitedFor(waits, 'policy_wait_ms', reads.policy);
    const filterTools = gatedTools(policy, input.toolGate, input.agentSignal);
    const buildStartedAt = Date.now();
    agent = deps.agent.create({
      mode: surface === 'web_voice' ? 'web_voice' : 'chat',
      filterTools,
      memoryContext: block ?? undefined,
      ...appTaskOptions(input, game, policy),
      ...(memoryTools ? { memoryTools } : {}),
      ...(capabilityTools ? { capabilityTools } : {}),
      ...(lateTools ? { lateTools } : {}),
      timeZone,
      cacheKey: conversationId,
    });
    offeredToolMap = agent.tools ?? filterTools({ ...assistantTools, ...(capabilityTools ?? {}), ...(memoryTools ?? {}), ...(lateTools ?? {}) });
    sections = agentSectionSizes({ tools: offeredToolMap, instructions: BOB_AGENT_INSTRUCTIONS, memory: block });
    waits.build_ms = Date.now() - buildStartedAt;
  } catch (error) {
    agent = deps.agent.create({ mode: surface === 'web_voice' ? 'web_voice_degraded' : 'chat_degraded' });
    offeredToolMap = {};
    sections = agentSectionSizes({ tools: offeredToolMap, instructions: BOB_AGENT_INSTRUCTIONS });
    journal('v2.agent_tools_degraded', {
      interface: 'web',
      turn_id: turnId,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
  return { agent, offeredToolMap, sections };
}

/** An app improvement never falls back to the person's general tools or context. */
async function buildBoundAppAgent(input: BuildAgentInput): Promise<BuiltAgentParts> {
  if (!isLivePrivateTurn(input.scope, input.userMessageAnchor)) throw new StoreNotFoundError('app_unavailable');
  const filterTools = gatedTools(await waitedFor(input.waits, 'policy_wait_ms', input.reads.policy), input.toolGate, input.agentSignal);
  const buildStartedAt = Date.now();
  const permitted = filterTools(input.appTools ?? {});
  const agent = input.deps.agent.create({
    mode: input.surface === 'web_voice' ? 'bound_app_voice' : 'bound_app',
    filterTools,
    memoryTools: {},
    capabilityTools: permitted,
    lateTools: {},
    timeZone: input.timeZone,
    cacheKey: input.conversationId,
  });
  const offeredToolMap = agent.tools ?? permitted;
  input.waits.build_ms = (input.waits.build_ms ?? 0) + Date.now() - buildStartedAt;
  return { agent, offeredToolMap, sections: agentSectionSizes({ tools: offeredToolMap, instructions: BOB_AGENT_INSTRUCTIONS }) };
}

/** A workflow preference is useful only while this private turn still has a permitted app capability that admits it. */
function appTaskOptions(input: BuildAgentInput, game: GameScope | null, filterTools: (tools: Record<string, Tool>) => Record<string, Tool>): Pick<BuildAgentInput, 'taskContext' | 'contextToolNames'> {
  const { taskContext, contextToolNames = [] } = input;
  if (!taskContext || !input.appTools || !isLivePrivateTurn(input.scope, input.userMessageAnchor) || game?.mode === 'active') return {};
  const permitted = filterTools(input.appTools);
  if (!contextToolNames.some((name) => Object.hasOwn(permitted, name))) return {};
  return { taskContext, contextToolNames };
}

/** Memory tools, offered only when this turn retrieved memory and no game is active. */
function memoryToolsFor(input: BuildAgentInput, game: GameScope | null): Record<string, Tool> | undefined {
  const { deps, db, userId, conversationId, userMessageAnchor, scope, retrieval } = input;
  if (!retrieval || game?.mode === 'active') return undefined;
  // remember must store a vector or semantic retrieval can never find it. deps.embedder() hands back ONE
  // embedder, built lazily (never at import time, never per turn).
  return turnMemoryTools({
    db, userId,
    turn: { conversationId: conversationId, messageId: userMessageAnchor, surface: 'web_text' },
    spaceId: scope?.spaceId ?? undefined,
    deps,
    journal,
  });
}

/** A live private conversation with a persisted message anchor: the only scope whose tools reach the user's own space. */
function isLivePrivateTurn(scope: BuildAgentInput['scope'], userMessageAnchor: string | null): userMessageAnchor is string {
  return Boolean(userMessageAnchor) && isLivePrivateScope(scope);
}

/** Google, timeline and app tools join the capability group on a private space; Google and app tools also wait for no active game. */
async function privateSpaceTools(input: BuildAgentInput, game: GameScope | null, capabilityTools: Record<string, Tool> | undefined): Promise<Record<string, Tool> | undefined> {
  const { db, userId, conversationId, userMessageAnchor, scope, appTools, reads, waits } = input;
  let tools = capabilityTools;
  const livePrivate = isLivePrivateTurn(scope, userMessageAnchor) && game?.mode !== 'active';
  if (livePrivate) tools = { ...tools, ...await waitedFor(waits, 'google_wait_ms', reads.google) };
  if (scope?.spaceKind === 'private') tools = { ...tools, ...createTimelineTools(db, userId, conversationId) };
  // Merged before scopeToolsToGame, so a game opening mid-turn closes them with the rest of the capability group.
  if (appTools && livePrivate) tools = { ...tools, ...appTools };
  return tools;
}

interface CapabilityGroups {
  capabilityTools: Record<string, Tool> | undefined;
  lateTools: Record<string, Tool> | undefined;
}

interface ScopedTools extends CapabilityGroups {
  memoryTools: Record<string, Tool> | undefined;
  block: string | null;
}

/** Productivity tools bound to the private space, then the timer tools that lead them and the late group
 *  (voice and device tools) that trails memory. A failure drops only what it touched; the turn keeps the rest. */
async function capabilityToolGroups(deps: WebChatDeps, db: Db, userId: string, timeZone: string): Promise<CapabilityGroups> {
  // Productivity tools bound to the private space; omitted when the spaces
  // store is unavailable, and the turn proceeds with what remains.
  let capabilityTools: Record<string, Tool> | undefined;
  let privateSpaceId: string | null = null;
  try {
    const space = await ensurePrivateSpace(db, userId);
    const localTimeDues = localTimeDuesEnabled();
    capabilityTools = spaceProductivityTools(db, userId, space.id, { timeZone, localTimeDues }, { allowNotifyEmail: true });
    privateSpaceId = space.id;
  } catch {
    capabilityTools = undefined;
  }
  // Timers lead the productivity group and the conditional voice/device
  // tools go last, after memory; a wiring failure keeps what the turn has.
  let lateTools: Record<string, Tool> | undefined;
  try {
    const groups = webTurnToolGroups(deps, db, userId, timeZone, privateSpaceId);
    capabilityTools = { ...groups.timers, ...(capabilityTools ?? {}) };
    lateTools = groups.late;
  } catch {
    // Keep the productivity group (or none).
  }
  return { capabilityTools, lateTools };
}

/** Scopes the tool sets to the game this turn is in. An active game offers only the engine controls, that
 *  game's tools, currentDateTime and set_volume: no memory and no other capability. */
function scopeToolsToGame(game: GameScope | null, tools: ScopedTools): ScopedTools {
  if (game?.mode === 'active') {
    return {
      capabilityTools: { ...game.tools, ...keepForActiveGame({ ...(tools.capabilityTools ?? {}), ...(tools.lateTools ?? {}) }) },
      lateTools: undefined,
      memoryTools: tools.memoryTools,
      block: null,
    };
  }
  if (game === null) return tools;
  // A game opened mid-turn closes what an active game would not have offered.
  const close = closeOnceGameOpens(game);
  return {
    ...tools,
    capabilityTools: close({ ...(tools.capabilityTools ?? {}), ...game.tools }),
    lateTools: tools.lateTools ? close(tools.lateTools) : undefined,
    memoryTools: tools.memoryTools ? close(tools.memoryTools) : undefined,
  };
}

type Scope = Awaited<ReturnType<typeof getConversationScope>> | null;
type ToolFilter = (tools: Record<string, Tool>) => Record<string, Tool>;

/** The build's reads, each started at once and marked handled (startWebPrep). */
export interface AgentReads {
  game: Promise<GameScope | null>;
  capabilities: Promise<CapabilityGroups>;
  policy: Promise<ToolFilter>;
  /** The Google tools; {} without a Google runtime. Offered only on a live private turn outside an active game. */
  google: Promise<Record<string, Tool>>;
}

/** What one web turn's prep reads on. */
export interface WebPrepInput {
  deps: WebChatDeps & { appTurnTools?: AppTurnExtension };
  db: Db; userId: string; conversationId: string; regenerate: boolean | undefined;
  signal: AbortSignal; timeZone: string; timings: PrepTimings;
  /** The app preflight, started already; it rejects on a refused binding. */
  app: Promise<AppBinding | null>;
  /** The reader's message store: the stored id once it settles (null on a regenerate). */
  stored: Promise<string | null>;
  /** Set while the store may still be running (a plain new message): the message it writes, appended to the history in
   *  memory, whose id the Google and app tools take lazily. Unset when the store (or truncation) already landed. */
  pending?: { id: string; parts: unknown[]; origin: RecentMessage['origin'] };
  /** A generic bound app (admitted before the prep starts): its build reads only the tool policy. */
  boundApp?: boolean;
  /** The request names an app: memory waits for its admission, since only a named app can be generic. */
  explicitApp?: boolean;
}

/** One web turn's prep, every read started at once (FR-007). */
export interface WebPrep {
  scope: Promise<Scope>;
  memoryOn: Promise<boolean>;
  retrieval: Promise<{ result: Promise<RetrievalResult> } | null>;
  /** The bounded history (null when the conversation vanished), the pending message last. */
  history: Promise<RecentMessage[] | null>;
  /** The message the turn's tools write against: the stored one, or on a regenerate the newest stored question. */
  anchor: Promise<string | null>;
  appTools: Promise<AppTurnTools>;
  reads: AgentReads;
}

// HISTORY_TRIM_CHUNK - 1 extra rows let the chunked window, anchored on the first row's position, still hold MAX_HISTORY_MESSAGES.
const HISTORY_LIMIT = MAX_HISTORY_MESSAGES + HISTORY_TRIM_CHUNK - 1;

/** Starts the turn's prep: scope (then memory availability and retrieval), history, the build's reads, Google and the
 *  app tools, each timed into `timings` (own ms). The Google and app tools never run before the store settles. */
export function startWebPrep(input: WebPrepInput, queryText: string): WebPrep {
  const { deps, db, userId, conversationId, timings, pending } = input;
  const scope = started(() => timed(timings, 'scope_ms', getConversationScope(db, userId, conversationId).catch(() => null)));
  // A pair or group conversation reads and feeds no personal memory; an unreadable scope is legacy private.
  // Only a named app can make the turn generic, so a plain message starts retrieval on the scope alone, not the preflight.
  const memoryOn = started(() => Promise.all([input.explicitApp ? input.app : null, scope]).then(([app, read]) =>
    !app?.generic && allowsPersonalMemory(read?.spaceKind) && timed(timings, 'scope_ms', memoryAvailable(db))));
  const retrieval = started(() => memoryOn.then((on) => {
    if (!on) return null;
    const run = startMemoryRetrieval(db, userId, queryText, { embedder: deps.embedder() });
    run.result.catch(() => undefined);
    return run;
  }));
  const history = started(() => timed(timings, 'history_ms', loadRecentHistory(db, userId, conversationId, HISTORY_LIMIT, { requireConversation: true }))
    .then((fresh) => (fresh && pending ? withPending(fresh, pending) : fresh)));
  // Regeneration trusts only this owner's stored history, never the question id supplied by the browser.
  const anchor = pending ? Promise.resolve(pending.id) : started(() => Promise.all([input.stored, history]).then(([id, fresh]) =>
    id ?? (input.regenerate ? fresh?.findLast((entry) => entry.role === 'user')?.id ?? null : null)));
  const reads = startAgentReads(input, (game) => googleToolsFor(input, scope, anchor, game));
  const appTools = started(() => Promise.all([input.app, anchor]).then(async ([app, id]) => {
    // The app's tools are built against the committed message.
    if (app && pending) await input.stored;
    const appAnchor = id ? { conversationId, messageId: id } : null;
    return timed(timings, 'app_tools_ms', appExtensionTools(deps.appTurnTools, db, userId, app, appAnchor));
  }));
  return { scope, memoryOn, retrieval, history, anchor, appTools, reads };
}

type ReadsInput = Pick<WebPrepInput, 'deps' | 'db' | 'userId' | 'conversationId' | 'timeZone' | 'timings' | 'boundApp'>;

/** The build's reads, every one started now: the game scope, the capability groups, the tool policy, and Google
 *  (`google`, handed the game read; none by default). A generic bound app reads only the policy. */
export function startAgentReads(input: ReadsInput, google: (game: Promise<GameScope | null>) => Promise<Record<string, Tool>> = async () => ({})): AgentReads {
  const { deps, db, userId, conversationId, timeZone, timings } = input;
  const policy = started(() => timed(timings, 'policy_ms', prepareToolPolicyFilter(db, userId, { conversationId })));
  if (input.boundApp) return { game: Promise.resolve(null), capabilities: Promise.resolve({ capabilityTools: undefined, lateTools: undefined }), policy, google: Promise.resolve({}) };
  const game = started(() => timed(timings, 'game_ms', readGameScope(db, userId, { conversationId, deviceId: null, timeZone })));
  return {
    game,
    capabilities: started(() => timed(timings, 'capabilities_ms', capabilityToolGroups(deps, db, userId, timeZone))),
    policy,
    google: started(() => google(game)),
  };
}

/** A pending message: started as soon as the scope reads live private, on a lazy anchor that the store resolves (the ids
 *  are already known). Otherwise
 *  once the scope, anchor and game are read, only on a live private turn outside an active game. */
async function googleToolsFor(input: WebPrepInput, scope: Promise<Scope>, anchor: Promise<string | null>, game: Promise<GameScope | null>): Promise<Record<string, Tool>> {
  const { deps, userId, conversationId, signal, timings, pending, stored } = input;
  const google = deps.googleTools;
  if (!google) return {};
  if (pending) {
    // Started once the scope says live private (never on a pair, group, archived or unreadable scope), beside the
    // history, game, capabilities and policy reads; an active game discards it in the build.
    if (!isLivePrivateTurn(await scope, pending.id)) return {};
    const lazy = lazyAnchor(stored, (id) => (id ? { conversationId, messageId: id } : null));
    return timed(timings, 'google_ms', google({ userId, conversationId, messageId: pending.id, anchor: lazy, allowNewOperations: true, signal })).catch(() => ({}));
  }
  const [read, anchorId, scoped] = await Promise.all([scope, anchor, game]);
  if (!isLivePrivateTurn(read, anchorId) || scoped?.mode === 'active') return {};
  return timed(timings, 'google_ms', google({ userId, conversationId, messageId: anchorId, allowNewOperations: !input.regenerate, signal })).catch(() => ({}));
}

/** A read that already holds the stored row is used as read (saved order, even when a later message landed after it);
 *  otherwise the message still being stored goes last, the window the history would hold had the store landed first. */
function withPending(fresh: RecentMessage[], pending: NonNullable<WebPrepInput['pending']>): RecentMessage[] {
  if (fresh.some((row) => row.id === pending.id)) return fresh;
  const position = (fresh.at(-1)?.position ?? -1) + 1;
  // The parts as the store returns them (JSON).
  const parts = JSON.parse(JSON.stringify(pending.parts)) as unknown[];
  return [...fresh, { id: pending.id, role: 'user' as const, position, origin: pending.origin, parts }].slice(-HISTORY_LIMIT);
}
