import type { AccountEvent } from '../account/events-bus.ts';
import type { Db } from '../platform/db/db.ts';
import { listMembers } from '../spaces/store.ts';
import type { StoredThreadMessage } from './thread-store.ts';

export interface ThreadMessageEvents {
  publish: (userId: string, event: AccountEvent) => void;
}

/** Notify current participants after persistence; clients fetch the authorized
 * transcript themselves. No message content is carried on the account stream. */
export async function publishThreadMessage(
  db: Db,
  events: ThreadMessageEvents,
  userId: string,
  message: StoredThreadMessage,
): Promise<void> {
  const members = await listMembers(db, userId, message.spaceId);
  for (const member of members) {
    events.publish(member.userId, {
      type: 'thread.message_appended',
      thread_id: message.threadId,
      space_id: message.spaceId,
      message_id: message.id,
      sequence: message.sequence,
    });
  }
}
