/**
 * Chat store: the reader's message of one web chat turn, stored with the active pointer.
 * Trigger: workflows/workflow-web-chat-turn.ts runTurn (a new conversation opens with its message; otherwise the store
 *   settles the turn's `stored`).
 * Steps: 1. a new conversation, its opening message and the pointer commit together. 2. otherwise the message is
 *   appended (an edit truncates in the same transaction; a regenerate appends none) and the pointer moves.
 * Outcome: the stored message id (null on a regenerate); the account events conversation.updated, message.appended
 *   and active.changed.
 * Journal: v2.conversation_created, v2.active_changed.
 */
import { withUser, type Db } from '../platform/db/db.ts';
import { moduleJournal } from '../platform/logger.ts';
import { setActive } from '../conversations/active.ts';
import { getAccountEvents } from '../devices/pairing-service.ts';
import { appendMessage, createConversation, deriveTitle, truncateAfterMessage, truncateAllMessages, type StoredConversation } from '../conversations/store.ts';
import type { Surface, TurnCtx, TurnMessage } from './chat-turn-ctx.ts';

const journal = moduleJournal('conversations');

// A new conversation, its opening message and the pointer commit together, so a failed store leaves no
// conversation without a message. Elsewhere the pointer rides the message append.
export async function createOpeningConversation(db: Db, userId: string, message: TurnMessage, surface: Surface): Promise<{ conversation: StoredConversation; createdTitle: string; openingMessageId: string }> {
  const openingText = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => String((part as { text?: string }).text ?? ''))
    .join(' ');
  // An attachment-only opening still deserves a truthful title, so it falls
  // back to the filenames the reader chose rather than the voice-turn label.
  const openingNames = message.parts
    .filter((part) => part.type === 'file')
    .map((part) => String((part as { filename?: string }).filename ?? ''))
    .filter(Boolean)
    .join(' ');
  const createdTitle = deriveTitle(openingText.trim() || openingNames);
  const { created, changedAt } = await withUser(db, userId, async (tx) => {
    const record = await createConversation(tx, userId, createdTitle);
    await appendMessage(tx, userId, record.id, { id: message.id, role: 'user', parts: message.parts, origin: surface });
    const stamp = await setActive(tx, userId, record.id, surface);
    return { created: record, changedAt: stamp };
  });
  journal('v2.conversation_created', { id: created.id });
  getAccountEvents().publish(userId, { type: 'conversation.updated', conversation_id: created.id, updated_at: created.updatedAt });
  getAccountEvents().publish(userId, { type: 'active.changed', conversation_id: created.id, title: created.title, surface, changed_at: changedAt });
  journal('v2.active_changed', { surface });
  getAccountEvents().publish(userId, { type: 'message.appended', conversation_id: created.id, message_id: message.id, updated_at: Date.now() });
  return { conversation: created, createdTitle, openingMessageId: message.id };
}

/** Stores the reader's message (a regenerated turn appends none) and returns its id, or null. */
export async function storeUserMessage(ctx: Pick<TurnCtx, 'db' | 'userId' | 'conversation' | 'surface' | 'message' | 'regenerate'>, editFrom: string | undefined, editFromStart: true | undefined): Promise<string | null> {
  const { db, userId, conversation, surface, message, regenerate } = ctx;
  let persistedUserMessageId: string | null = null;
  const requestedMessageId = typeof message.id === 'string' ? message.id : undefined;
  // `truncate` shares the append's transaction: an edit that cannot store its
  // message leaves the thread as it was.
  const appendWebTurn = async (truncate?: (tx: Db) => Promise<void>): Promise<void> => {
    const { stored, changedAt } = await withUser(db, userId, async (tx) => {
      await truncate?.(tx);
      const appended = await appendMessage(tx, userId, conversation.id, {
        id: requestedMessageId, role: 'user', parts: message.parts, origin: surface,
      });
      const stamp = await setActive(tx, userId, conversation.id, surface);
      return { stored: appended!, changedAt: stamp };
    });
    persistedUserMessageId = stored.id;
    getAccountEvents().publish(userId, {
      type: 'message.appended',
      conversation_id: conversation.id,
      message_id: stored.id,
      updated_at: Date.now(),
    });
    getAccountEvents().publish(userId, {
      type: 'active.changed',
      conversation_id: conversation.id,
      title: conversation.title,
      surface,
      changed_at: changedAt,
    });
    journal('v2.active_changed', { surface });
  };
  if (editFrom) {
    await appendWebTurn((tx) => truncateAfterMessage(tx, userId, conversation.id, editFrom));
  } else if (editFromStart) {
    // No anchor precedes the first message, so the whole conversation goes
    // and the edited turn becomes its new first message.
    await appendWebTurn((tx) => truncateAllMessages(tx, userId, conversation.id));
  } else if (!regenerate) {
    // A regenerated turn appends no user message; the client still sends the
    // newest one, for context only.
    await appendWebTurn();
  }
  return persistedUserMessageId;
}
