import { StoreConflictError, StoreNotFoundError } from '../platform/db/db.ts';
import { createNoteOnce } from '../notes/store.ts';
import { authorizeGenericApp } from '../bob-apps/bound-app-turn.ts';
import { appIdeaOperationId, type SaveAppIdea } from '../bob-apps/bound-app-tools.ts';

/** Save locally in Notes only, on the already authorized app transaction. */
export const saveAppIdea: SaveAppIdea = async (tx, context, text) => {
  const audience = await authorizeGenericApp(tx, context.actor, context.binding, context.conversationId, context.sourceId);
  if (!audience.conversationSpaceId) throw new StoreNotFoundError('app_scope_unavailable');
  const title = 'Idea for this app';
  const body = `App: ${audience.appId}\n\n${text}`;
  const note = await createNoteOnce(tx, context.actor, audience.conversationSpaceId, appIdeaOperationId(context, 'save_app_idea'), { title, body, aiAssisted: true });
  if (!note) throw new StoreNotFoundError('app_idea_unavailable');
  if (note.title !== title || note.body !== body || note.spaceId !== audience.conversationSpaceId) throw new StoreConflictError('app_idea_conflict');
  return { receipt: { kind: 'app.idea', appId: audience.appId, noteId: note.id }, note, url: `/spaces/${note.spaceId}/notes?note=${note.id}` };
};
