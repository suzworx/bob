import { moduleJournal } from '../platform/logger.ts';
import { StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { getConversation } from '../conversations/store.ts';
import { getThread } from '../conversations/thread-store.ts';
import { parseDeviceRef } from '../devices/conversation-ref.ts';

const journal = moduleJournal('voice');

/** The session fields a turn_start conversation_id may pin. */
interface PinnableSession { id: string; activeConversationId?: string; activeConversationTitle?: string }

/** The title of a device conversation ref the account can open (the picker's
 *  checks: own conversation, or a live thread of a Space it belongs to), else null. */
async function openableDeviceRefTitle(db: Db, userId: string, ref: string): Promise<string | null> {
  const parsed = parseDeviceRef(ref);
  if (parsed === null) return null;
  if (parsed.kind === 'conversation') return (await getConversation(db, userId, parsed.conversationId))?.title ?? null;
  try {
    const thread = await getThread(db, userId, parsed.threadId);
    return thread.archivedAt === null ? thread.title : null;
  } catch (error) {
    if (error instanceof StoreNotFoundError) return null;
    throw error;
  }
}

/** turn_start's conversation_id: the conversation on the device's screen.
 *  Once the account is shown to open it, this turn is pinned to it, so its root
 *  span, journal and persisted messages agree. The account's pointer is not
 *  moved. Anything else leaves the server's resolution in place. */
export async function pinDeviceConversation(
  getDb: () => Promise<Db>, session: PinnableSession, userId: string, ref: string,
): Promise<void> {
  let title: string | null;
  try {
    title = await openableDeviceRefTitle(await getDb(), userId, ref);
  } catch {
    return journal('v2.turn_conversation_ignored', { session: session.id, reason: 'lookup_failed' });
  }
  if (title === null) return journal('v2.turn_conversation_ignored', { session: session.id, reason: 'not_found' });
  session.activeConversationId = ref;
  session.activeConversationTitle = title;
}
