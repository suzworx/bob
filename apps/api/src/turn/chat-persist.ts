/**
 * Chat persist: saves one web chat turn's reply once, after its question is stored.
 * Trigger: turn/chat-stream-reply.ts (the stream's onEnd, or the partial reply of a turn that failed mid-stream).
 * Steps: 1. wait for the reader's message store (a reply is never saved without its question). 2. guard a game reply
 *   once (the saved copy and the held stream share it). 3. add the reply version (a regenerate moves the pointer in
 *   the same transaction). 4. enqueue memory extraction, off the reply path.
 * Outcome: the reply is saved, or the failed save is loud; it publishes active.changed on a regenerate.
 * Journal: v2.messages_persisted, v2.messages_persist_failed, v2.active_changed, v2.game_guard_replaced.
 */
import { guardGameReply } from '../voice/game-tools.ts';
import { withUser } from '../platform/db/db.ts';
import { moduleJournal } from '../platform/logger.ts';
import { setActive } from '../conversations/active.ts';
import { getAccountEvents } from '../devices/pairing-service.ts';
import { addReplyVersion } from '../conversations/store.ts';
import type { TurnCtx, TurnRun } from './chat-turn-ctx.ts';

const journal = moduleJournal('conversations');

export interface ReplyPersister {
  persistReply: (streamed: Array<Record<string, unknown>>) => Promise<void>;
  checkOnce: (text: string) => Promise<string>;
}

export function createReplyPersister(ctx: Pick<TurnCtx, 'deps' | 'db' | 'userId' | 'conversation' | 'regenerate' | 'surface' | 'stored'>, run: TurnRun, memoryOn: boolean): ReplyPersister {
  const { deps, db, userId, conversation, regenerate, surface } = ctx;
  const worker = deps.memoryWorker;
  let persisted = false;
  // The reply is checked once: the saved copy and the held stream share it.
  let checkedReply: Promise<string> | null = null;
  const checkOnce = (text: string): Promise<string> =>
    (checkedReply ??= run.gameTurn === null ? Promise.resolve(text) : guardGameReply(text, run.gameTurn, journal));
  const persistReply = async (streamed: Array<Record<string, unknown>>): Promise<void> => {
    if (persisted || streamed.length === 0) return;
    persisted = true;
    // A reply is never saved without its question (a store that failed after the model started).
    if (!await ctx.stored.then(() => true, () => false)) return;
    let parts = streamed;
    // A game reply is saved only once checked: an unsafe or off-script one is
    // replaced by the last game tool's `say`.
    if (run.gameTurn !== null) {
      const text = parts.filter((part) => part.type === 'text').map((part) => String(part.text ?? '')).join('');
      const safe = await checkOnce(text);
      if (safe !== text) parts = [...parts.filter((part) => part.type !== 'text'), { type: 'text', text: safe }];
    }
    try {
      if (regenerate) {
        // A regenerated turn appends no user message, so the pointer write
        // rides the reply version's transaction instead.
        const changedAt = await withUser(db, userId, async (tx) => {
          await addReplyVersion(tx, userId, conversation.id, parts, surface);
          return setActive(tx, userId, conversation.id, surface);
        });
        getAccountEvents().publish(userId, {
          type: 'active.changed',
          conversation_id: conversation.id,
          title: conversation.title,
          surface,
          changed_at: changedAt,
        });
        journal('v2.active_changed', { surface });
      } else {
        await addReplyVersion(db, userId, conversation.id, parts, surface);
      }
      journal('v2.messages_persisted', {
        id: conversation.id,
        versions: 1,
        bytes: JSON.stringify(parts).length,
      });
      // Off the reply path and never awaited; a game turn is never extracted.
      if (memoryOn && run.gameTurn?.gameTurn !== true) worker?.enqueue(userId);
    } catch (error) {
      // The reply already rendered for the reader; a failed save must be loud.
      journal('v2.messages_persist_failed', { id: conversation.id });
      console.error(`[bob] conversation save failed (${error instanceof Error ? error.name : 'Error'})`);
    }
  };
  return { persistReply, checkOnce };
}
