/**
 * Message routes under /api/conversations/:id/messages/:messageId.
 *
 * PATCH records the heard portion of an interrupted assistant reply. The
 * browser owns playback and therefore knows exactly how far it got, so the body
 * carries the measured character offset; the store truncates the message's
 * selected version to that offset (cut back to the last sentence boundary) and
 * sets the interrupted flag. The reply is never resumed, repeated or completed.
 *
 * Production safety: the hosted database gets the `interrupted` column only
 * after a user-approved push. Until then a store that reports the column missing
 * (Postgres 42703, undefined_column) is answered 503 feature_unavailable and
 * journaled -- never 500. Journal events carry ids and counts only, never reply
 * text.
 */
import type { Response } from 'express';
import { z } from 'zod';
import { StoreError, type Db } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import { deleteMessagesFrom, isUndefinedColumnError, markReplyInterrupted } from './store.ts';
import { HearPartsRequestSchema, HearPartsResponseSchema } from '../web-schemas.ts';
import { moduleJournal } from '../platform/logger.ts';
import { getAccountEvents } from '../devices/pairing-service.ts';

const journal = moduleJournal('conversations');

type RouteDeps = { getDb: () => Promise<Db> };

const MessageParams = z.object({ id: z.string(), messageId: z.string() });

function sendStoreError(response: Response, error: unknown): void {
  if (error instanceof StoreError) {
    sendError(response, 500, 'store_error');
    return;
  }
  throw error;
}

function sendInterruptError(response: Response, error: unknown): void {
  if (isUndefinedColumnError(error)) {
    journal('v2.reply_interrupted_unavailable', { reason: 'undefined_column' });
    sendError(response, 503, 'feature_unavailable');
    return;
  }
  sendStoreError(response, error);
}

export const markReplyInterruptedRoute = (deps: RouteDeps): ReturnType<typeof route> =>
  route({ body: HearPartsRequestSchema, params: MessageParams, mapError: sendInterruptError },
    async ({ body, params, userId }, _request, response) => {
      const result = await markReplyInterrupted(await deps.getDb(), userId, params.id, params.messageId, body.heard_chars);
      // The store answers null for an unknown/foreign id, a wrong conversation, or
      // a non-assistant message -- all exactly like not_found, no oracle.
      if (!result) {
        sendError(response, 404, 'not_found');
        return;
      }
      journal('v2.reply_interrupted', { heard_chars: body.heard_chars, truncated: result.truncated });
      response.status(200).json(
        HearPartsResponseSchema.parse({ message_id: params.messageId, heard_chars: body.heard_chars, interrupted: true }),
      );
    });

/**
 * DELETE: "delete from here" -- deletes a user message and every later message.
 * No body. A non-user anchor is refused (409 not_user_message) rather than
 * leaving an unanswered question or an orphan reply in the model's history.
 */
export const deleteMessagesFromRoute = (deps: RouteDeps): ReturnType<typeof route> =>
  route({ params: MessageParams, mapError: sendStoreError }, async ({ params, userId }, _request, response) => {
    const conversationId = params.id;
    const result = await deleteMessagesFrom(await deps.getDb(), userId, conversationId, params.messageId);
    if (result.kind === 'not_found') {
      sendError(response, 404, 'not_found');
      return;
    }
    if (result.kind === 'not_user_message') {
      sendError(response, 409, 'not_user_message');
      return;
    }
    getAccountEvents().publish(userId, {
      type: 'conversation.updated',
      conversation_id: conversationId,
      updated_at: result.updatedAt,
    });
    journal('v2.messages_deleted', { id: conversationId, messages: result.deleted });
    response.status(204).end();
  });
