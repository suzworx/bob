/**
 * Workflow: posts a human message to a shared thread, then fans it out to the thread's audience.
 * Trigger: POST /api/threads/:id/messages (spaces/threads-http.ts).
 * Steps: 1. Store the message, deduped on client_message_id (postMessage). 2. Journal the post. 3. For a new message only,
 *   publish it to the account bus of every member (publishThreadMessage), then notify the people it mentions
 *   (notifyThreadMentions), in that order.
 * Outcome: a new message is stored, pushed to the thread's live surfaces and its mentions are notified; a retry with the same
 *   client_message_id returns the original and publishes nothing. Never invokes the model.
 * Journal: v2.thread_message_posted (thread_id, message_id, sequence, deduped). No trace names of its own. The body is user
 *   text: stored and published, never journaled.
 */
import { moduleJournal } from '../platform/logger.ts';
import type { Db } from '../platform/db/db.ts';
import { notifyThreadMentions } from '../notifications/notify.ts';
import { publishThreadMessage, type ThreadMessageEvents } from '../conversations/thread-events.ts';
import { postMessage, type StoredThreadMessage } from '../conversations/thread-store.ts';

const journal = moduleJournal('spaces');

/** Posts the message and, when it is new, publishes it and notifies its mentions. */
export async function postThreadMessage(
  db: Db, events: ThreadMessageEvents, userId: string, input: Parameters<typeof postMessage>[2],
): Promise<{ message: StoredThreadMessage; created: boolean }> {
  const { message, created } = await postMessage(db, userId, input);
  journal('v2.thread_message_posted', {
    thread_id: input.threadId,
    message_id: message.id,
    sequence: message.sequence,
    deduped: !created,
  });
  if (created) {
    await publishThreadMessage(db, events, userId, message);
    await notifyThreadMentions(db, userId, message);
  }
  return { message, created };
}
