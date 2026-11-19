import { type SessionDto } from '../protocol.ts';
import { moduleJournal } from '../../platform/logger.ts';
import { sessionUserId, type DeviceSession } from '../session-handlers.ts';
import { persistDeviceTurn, preparePrivateDeviceTurn, releasePreparedDeviceTurn } from '../cardputer-conversation.ts';
import { newId } from '../../platform/ids.ts';
import { deviceThreadId } from '../device-thread.ts';
import { personalMemoryTurn, type TurnMemoryContext } from './context.ts';
import type { TurnDeps } from './deps.ts';

const journal = moduleJournal('voice');

/** Preparation failure degrades ordinary speech, but leaves no trusted provider anchor. */
export async function prepareTurn(session: SessionDto, transcriptText: string, memory: TurnMemoryContext | null): Promise<void> {
  if (!memory) return;
  const auth = (session as DeviceSession).auth;
  try {
    const prepared = await preparePrivateDeviceTurn(memory.db, memory.userId, {
      pinnedRef: session.activeConversationId, transcriptText, deviceId: auth?.kind === 'device' ? auth.deviceId : null,
      userMessageId: newId('message'), replyMessageId: newId('message'),
    });
    if (!prepared) return;
    memory.prepared = prepared;
    memory.conversation = prepared.scope;
    session.activeConversationId = prepared.conversationId;
  } catch {
    journal('v2.turn_prepare_failed', { session: session.id });
  }
}

export async function releaseTurn(memory: TurnMemoryContext | null): Promise<void> {
  if (!memory?.prepared) return;
  try {
    await releasePreparedDeviceTurn(memory.db, memory.userId, memory.prepared);
  } catch {
    journal('v2.turn_release_failed', {});
  }
}

/**
 * Persists a device turn and publishes its events. With heardChars the reply
 * was cancelled: a private conversation saves it in full, then cuts it to what
 * was heard; a shared one saves only the heard slice. A private reply also
 * saves toolParts, the tools the run finished. A failure never affects
 * what the device already got; it is journaled (names only) and swallowed.
 */
export async function persistTurn(
  deps: TurnDeps,
  session: SessionDto,
  turnRef: string,
  transcriptText: string,
  replyText: string,
  memory: TurnMemoryContext | null,
  heardChars?: number,
  toolParts: ReadonlyArray<Record<string, unknown>> = [],
): Promise<void> {
  try {
    const userId = sessionUserId(session as DeviceSession);
    if (userId === undefined) return;
    const db = await deps.getDb();
    // Every saved message names the paired device that spoke it.
    const auth = (session as DeviceSession).auth;
    const deviceId = auth?.kind === 'device' ? auth.deviceId : null;
    // A lost shared conversation falls back to a new private one that takes the pointer.
    const events = deps.accountEvents();
    // Decided on the pinned conversation's scope, before the pointer moves.
    const feedsMemory = personalMemoryTurn(session, memory);
    const result = await persistDeviceTurn(db, userId, {
      pinnedRef: session.activeConversationId, sessionId: session.id, turnRef, deviceId, transcriptText, replyText, heardChars, toolParts,
      prepared: memory?.prepared,
    }, events);
    if (result.changedAt === null) {
      journal('v2.device_thread_saved', {
        session: session.id, thread_id: deviceThreadId(result.conversationId) ?? undefined, space_id: result.spaceId ?? undefined,
        user_message_id: result.userMessageId, reply_message_id: result.replyMessageId ?? undefined, created: result.created,
        outcome: result.outcome, published: result.published,
      });
      return;
    }
    if (result.fellBackFromShared) journal('v2.device_thread_lost', { session: session.id, thread_id: deviceThreadId(session.activeConversationId) ?? undefined });
    (session as DeviceSession).activeConversationId = result.conversationId;
    (session as DeviceSession).activeConversationTitle = result.title;
    if (result.created) {
      events.publish(userId, { type: 'conversation.updated', conversation_id: result.conversationId, updated_at: Date.now() });
    }
    events.publish(userId, {
      type: 'active.changed',
      conversation_id: result.conversationId,
      title: result.title,
      surface: 'device',
      changed_at: result.changedAt,
    });
    events.publish(userId, {
      type: 'message.appended',
      conversation_id: result.conversationId,
      message_id: result.userMessageId,
      updated_at: Date.now(),
    });
    journal('v2.active_changed', { surface: 'device' });
    // Extraction runs only after the save, never awaited. A lost-thread
    // fallback ran SHARED (other members' history), so it is not fed either.
    if (feedsMemory && result.fellBackFromShared !== true) memory.worker?.enqueue(userId);
  } catch (error) {
    journal('v2.turn_persist_failed', {
      session: session.id,
      conversation_id: session.activeConversationId,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}
