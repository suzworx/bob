/**
 * REST routes backing the sidebar. Mounted under the /api prefix behind the
 * bearer JWT guard; every handler acts as req.account.userId -- an
 * other-account id answers exactly as not-found, no oracle. Journal events
 * carry ids and counts only -- never a title, never message text.
 */
import type { Response } from 'express';
import { z } from 'zod';
import { StoreError, withUser, type Db } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import {
  deleteConversation,
  getConversation,
  isUndefinedColumnError,
  listConversations,
  renameConversation,
  setConversationFlag,
  StoreConflictError,
  StoreNotFoundError,
} from './store.ts';
import { getActive, setActive, type ActiveSurface } from './active.ts';
import {
  ActivateRequestSchema,
  ActivateResponseSchema,
  ActiveResponseSchema,
  conversationListFilterSchema,
  conversationUpdateSchema,
  ConversationDetailSchema,
} from '../web-schemas.ts';
import { getAccountEvents } from '../devices/pairing-service.ts';
import { moduleJournal } from '../platform/logger.ts';

const journal = moduleJournal('conversations');

type RouteDeps = { getDb: () => Promise<Db> };

const IdParams = z.object({ id: z.string() });

/** A store outage must be loud, never a fake empty history. */
function sendStoreError(response: Response, error: unknown): void {
  if (error instanceof StoreError) {
    sendError(response, 500, 'store_error');
    return;
  }
  throw error;
}

function sendConflictOrStoreError(response: Response, error: unknown): void {
  if (error instanceof StoreConflictError) {
    sendError(response, 409, 'conflict', 'The conversation changed since it was read.');
    return;
  }
  sendStoreError(response, error);
}

function sendUpdateError(response: Response, error: unknown): void {
  if (isUndefinedColumnError(error)) {
    journal('v2.conversation_flags_unavailable', { reason: 'undefined_column' });
    sendError(response, 503, 'feature_unavailable');
    return;
  }
  if (error instanceof StoreNotFoundError) {
    sendError(response, 404, 'not_found');
    return;
  }
  sendConflictOrStoreError(response, error);
}

export const listConversationsRoute = (deps: RouteDeps): ReturnType<typeof route> =>
  route({ query: conversationListFilterSchema, mapError: sendStoreError }, async ({ query, userId }, _request, response) => {
    const conversations = await listConversations(await deps.getDb(), userId, {
      q: query.q,
      archived: query.archived === '1',
    });
    journal('v2.conversation_listed', { count: conversations.length });
    response.status(200).json({ conversations });
  });

export const getConversationRoute = (deps: RouteDeps): ReturnType<typeof route> =>
  route({ params: IdParams, mapError: sendStoreError }, async ({ params, userId }, _request, response) => {
    const detail = await getConversation(await deps.getDb(), userId, params.id);
    if (!detail) {
      sendError(response, 404, 'not_found');
      return;
    }
    journal('v2.conversation_opened', { id: detail.id, messages: detail.messages.length });
    response.status(200).json(ConversationDetailSchema.parse(detail));
  });

export const renameConversationRoute = (deps: RouteDeps): ReturnType<typeof route> =>
  route({ body: conversationUpdateSchema, params: IdParams, mapError: sendUpdateError },
    async ({ body, params: { id }, userId }, _request, response) => {
      const db = await deps.getDb();
      if (body.title !== undefined) {
        const updated = await renameConversation(db, userId, id, body.title, body.expectedUpdatedAt);
        getAccountEvents().publish(userId, {
          type: 'conversation.updated',
          conversation_id: updated.id,
          updated_at: updated.updatedAt,
        });
        journal('v2.conversation_renamed', { id: updated.id });
        response.status(200).json({ id: updated.id, title: updated.title, updatedAt: updated.updatedAt });
        return;
      }
      const flag: 'pinned' | 'archived' = body.pinned !== undefined ? 'pinned' : 'archived';
      const on = flag === 'pinned' ? body.pinned! : body.archived!;
      const updated = await setConversationFlag(db, userId, id, flag, on, body.expectedUpdatedAt);
      getAccountEvents().publish(userId, {
        type: 'conversation.updated',
        conversation_id: updated.id,
        updated_at: updated.updatedAt,
      });
      if (flag === 'pinned') {
        journal('v2.conversation_pinned', { id: updated.id, pinned: updated.pinned });
      } else {
        journal('v2.conversation_archived', { id: updated.id, archived: updated.archived });
      }
      response.status(200).json({
        id: updated.id,
        title: updated.title,
        updatedAt: updated.updatedAt,
        pinned: updated.pinned,
        archived: updated.archived,
      });
    });

export const deleteConversationRoute = (deps: RouteDeps): ReturnType<typeof route> =>
  route({ params: IdParams, mapError: sendConflictOrStoreError }, async ({ params: { id }, userId }, request, response) => {
    const db = await deps.getDb();
    // Read before delete so the journal can report the cascade size without a
    // second query on the happy path.
    const before = await getConversation(db, userId, id);
    // The pointer read happens before the delete so the FK's `on delete set
    // null` (which keeps the row's surface/changed_at) can be reported as the
    // active.changed null form after the fact.
    const active = await getActive(db, userId);
    const wasActive: { surface: ActiveSurface; changedAt: number } | null =
      active?.conversationId === id ? { surface: active.surface, changedAt: active.changedAt } : null;
    const expectedUpdatedAt = Number.parseInt(String(request.get('x-bob-expected-updated-at') ?? ''), 10);
    try {
      await deleteConversation(
        db,
        userId,
        id,
        Number.isFinite(expectedUpdatedAt) && expectedUpdatedAt > 0 ? expectedUpdatedAt : undefined,
      );
    } catch (error) {
      // Deleted between the read and the write is still a successful delete.
      if (!(error instanceof StoreNotFoundError)) throw error;
    }
    if (before !== null) {
      getAccountEvents().publish(userId, {
        type: 'conversation.deleted',
        conversation_id: id,
        updated_at: before.updatedAt,
      });
    }
    if (wasActive !== null) {
      getAccountEvents().publish(userId, {
        type: 'active.changed',
        conversation_id: null,
        title: null,
        surface: wasActive.surface,
        changed_at: wasActive.changedAt,
      });
      journal('v2.active_changed', { surface: 'delete' });
    }
    journal('v2.conversation_deleted', { id, messages: before?.messages.length ?? 0 });
    response.status(204).end();
  });

/** "Continue on device": points the account's pointer at :id and publishes
 *  active.changed. Only the JWT guard applies -- the pointer write is not a
 *  sensitive action. An other-account or unknown id answers exactly as
 *  not-found. */
export const activateConversationRoute = (deps: RouteDeps): ReturnType<typeof route> =>
  route({ body: ActivateRequestSchema, params: IdParams, mapError: sendStoreError },
    async ({ params: { id }, userId }, _request, response) => {
      const db = await deps.getDb();
      const detail = await getConversation(db, userId, id);
      if (detail === null) {
        sendError(response, 404, 'not_found');
        return;
      }
      const changedAt = await withUser(db, userId, (tx) => setActive(tx, userId, id, 'activate'));
      getAccountEvents().publish(userId, {
        type: 'active.changed',
        conversation_id: id,
        title: detail.title,
        surface: 'activate',
        changed_at: changedAt,
      });
      journal('v2.active_changed', { surface: 'activate' });
      response.status(200).json(ActivateResponseSchema.parse({ conversation_id: id, title: detail.title }));
    });

/** GET /api/active: the account's pointer. No pointer yet is a valid state
 *  (200 `{ active: null }`), never an error. */
export const getActiveRoute = (deps: RouteDeps): ReturnType<typeof route> =>
  route({ mapError: sendStoreError }, async ({ userId }, _request, response) => {
    const active = await getActive(await deps.getDb(), userId);
    // This read nulled a stale thread pointer; tell the other surfaces.
    if (active !== null && active.cleared) {
      getAccountEvents().publish(userId, {
        type: 'active.changed', conversation_id: null, title: null, surface: active.surface, changed_at: active.changedAt,
      });
      journal('v2.active_changed', { surface: active.surface });
    }
    response.status(200).json(
      ActiveResponseSchema.parse({
        active:
          active === null
            ? null
            : {
                conversation_id: active.conversationId,
                title: active.title,
                surface: active.surface,
                changed_at: active.changedAt,
              },
      }),
    );
  });
