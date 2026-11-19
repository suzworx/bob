import { resolveTimeZone } from '@bob/ai';
import type { ModelMessage } from 'ai';
import {
  type ChatMessage,
  type SessionDto,
} from '../protocol.ts';
import { sessionUserId, type DeviceSession } from '../session-handlers.ts';
import { loadCardputerHistory, loadDeviceThreadHistory, type PreparedDeviceTurn } from '../cardputer-conversation.ts';
import { getConversationScope, isSharedConversation, type ConversationScope } from '../../conversations/scope.ts';
import type { Db } from '../../platform/db/db.ts';
import { getAccountTimeZone } from '../../devices/settings-store.ts';
import { allowsPersonalMemory, type MemoryExtractionWorker } from '../../memory/extract.ts';
import { memoryAvailable } from '../../memory/available.ts';
import type { TurnDeps } from './deps.ts';

// The memory embedder adapter is shared with the web chat turn (turn/tool-wiring.ts).
export { memoryEmbedderDep } from '../../turn/tool-wiring.ts';

/** Whether this turn runs shared (a pair or group conversation), from
 *  the scope resolved once at turn start. */
export function sharedTurn(session: SessionDto, memory: TurnMemoryContext | null): boolean {
  return isSharedConversation(session.activeConversationId, memory?.conversation ?? null);
}

/** Whether this turn reads and feeds personal memory: memory is on and
 *  the conversation's space kind allows it. With no scope (nothing pinned, or
 *  gone) a lost thread stays shared, so it reads and feeds nothing. */
export function personalMemoryTurn(session: SessionDto, memory: TurnMemoryContext | null): memory is TurnMemoryContext {
  if (!memory?.memoryOn) return false;
  const scope = memory.conversation ?? null;
  return scope === null ? !sharedTurn(session, memory) : allowsPersonalMemory(scope.spaceKind);
}

/** Builds the message list the agent runs on: the stored history (see
 *  loadAgentHistory) plus the current transcript. Never throws. */
export async function buildAgentMessages(
  deps: TurnDeps,
  session: SessionDto,
  transcriptText: string,
  memory: TurnMemoryContext | null = null,
): Promise<ModelMessage[]> {
  const userMessage: ChatMessage = { role: 'user', content: transcriptText };
  return [...await loadAgentHistory(deps, session, memory), userMessage];
}

/** The history the agent runs on, without the current transcript: stored
 *  history (trimmed by the shared rule, with the tool calls past replies made),
 *  or the in-memory history when no conversation is resolved or the store is
 *  unavailable. Needs no transcript, so it can be read at turn_start. Never throws. */
export async function loadAgentHistory(
  deps: TurnDeps,
  session: SessionDto,
  memory: TurnMemoryContext | null = null,
): Promise<ModelMessage[]> {
  const userId = sessionUserId(session as DeviceSession);
  if (session.activeConversationId === undefined || userId === undefined) return [...session.messages];
  try {
    const db = await deps.getDb();
    // A shared conversation reads its history, other members included.
    return sharedTurn(session, memory)
      ? await loadDeviceThreadHistory(db, userId, memory?.conversation ?? null)
      : await loadCardputerHistory(db, userId, session.activeConversationId, memory?.prepared?.userMessageId);
  } catch {
    return [...session.messages];
  }
}

/** The memory wiring a device turn needs to build its agent and enqueue
 *  extraction: the resolved db, account id, whether memory is available, and
 *  the shared background worker (when the server created one). */
export interface TurnMemoryContext {
  /** A committed private user anchor, independent of automatic memory availability. */
  prepared?: PreparedDeviceTurn;
  db: Db;
  userId: string;
  memoryOn: boolean;
  worker?: MemoryExtractionWorker;
  /** The account's IANA zone (UTC when unset or unreadable). Never journaled. */
  timeZone: string;
  /** The pinned conversation's scope, resolved once per turn; null when
   *  nothing is pinned or it is gone, hidden or unreadable. */
  conversation?: ConversationScope | null;
}

/**
 * The memory context, resolved once per turn so the agent build and the
 * post-persist enqueue share one decision. Probed whenever there is an account,
 * so a new conversation's first turn gets the same tools as later ones. A store
 * that cannot be reached leaves memory off rather than failing the turn.
 */
export async function resolveTurnMemory(
  deps: TurnDeps,
  session: SessionDto,
  worker?: MemoryExtractionWorker,
): Promise<{ memory: TurnMemoryContext | null; contextMs?: number }> {
  const accountId = sessionUserId(session as DeviceSession);
  if (accountId === undefined) return { memory: null };
  const startedAt = Date.now();
  let memory: TurnMemoryContext | null = null;
  try {
    const db = await deps.getDb();
    const ref = session.activeConversationId;
    // Independent reads, one round trip's wait instead of three.
    const [memoryOn, zone, conversation] = await Promise.all([
      memoryAvailable(db).catch(() => false),
      getAccountTimeZone(db, accountId).catch(() => null),
      ref === undefined ? null : getConversationScope(db, accountId, ref).catch(() => null),
    ]);
    // The account's zone, the value web chat reads from the JWT;
    // unset, unreadable or not a zone Intl accepts is UTC.
    memory = { db, userId: accountId, memoryOn, worker, timeZone: resolveTimeZone(zone), conversation };
  } catch {
    memory = null;
  }
  return { memory, contextMs: Date.now() - startedAt };
}
