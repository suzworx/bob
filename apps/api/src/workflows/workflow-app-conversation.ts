import { StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { requireAppAccess } from '../bob-apps/app-access.ts';
import { createThread, getThread, reopenThread } from '../conversations/thread-store.ts';

/** Resolve one ordinary group thread for any app, under its audience/app lock. */
export async function openAppConversation(db: Db, actor: string, appId: string): Promise<{ conversationId: string; spaceId: string }> {
  return withUser(db, actor, async (tx) => {
    const app = await requireAppAccess(tx, actor, appId, 'read', true);
    if (!app.spaceId) throw new StoreError('shared_app_required');
    const [row] = await tx.query<{ title: string; lifecycle: string }>("select definition->>'title' as title,lifecycle from bob.bob_apps where id=$1", [appId]);
    if (!row || row.lifecycle === 'archived') throw new StoreNotFoundError('app_not_found');
    const [existing] = await tx.query<{ conversation_id: string }>('select conversation_id from bob.bob_app_conversations where installation_id=$1', [app.installationId]);
    if (existing) {
      const thread = await getThread(tx, actor, existing.conversation_id);
      if (thread.spaceId !== app.spaceId) throw new StoreNotFoundError('app_conversation_unavailable');
      if (thread.archivedAt !== null) await reopenThread(tx, actor, thread.id, app.spaceId);
      return { conversationId: thread.id, spaceId: thread.spaceId };
    }
    const thread = await createThread(tx, actor, { spaceId: app.spaceId, title: row.title });
    await tx.query('insert into bob.bob_app_conversations(installation_id,conversation_id) values($1,$2)', [app.installationId, thread.id]);
    return { conversationId: thread.id, spaceId: app.spaceId };
  });
}
