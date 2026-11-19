/**
 * REST routes for shared human threads. RLS decides access, so a thread or
 * message outside the caller's audience answers like a missing id (no oracle).
 *
 * POST /api/threads/:id/messages posts a HUMAN message and NEVER invokes the
 * model: web-threads.test.ts greps this source and fails on an AI import.
 * Journal events carry ids and counts only, never bodies.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { route, sendError } from '../platform/http/route.ts';
import { moduleJournal } from '../platform/logger.ts';
import type { AccountEvent } from '../account/events-bus.ts';
import { StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { clearActiveThread } from '../conversations/active.ts';
import { archiveThread, createThread, editMessage, getMessage, getThread, listMessages, listThreads, markRead, renameThread, type StoredThread, type StoredThreadMessage, type ThreadReadState, tombstoneMessage } from '../conversations/thread-store.ts';
import { postThreadMessage } from '../workflows/workflow-thread-message-post.ts';
import { listMembers } from './store.ts';

const journal = moduleJournal('spaces');

const UuidPath = z.string().uuid();

export const ThreadSummarySchema = z
  .object({
    id: z.string().uuid(),
    space_id: z.string().uuid(),
    title: z.string().min(1).max(120),
    created_by: z.string().uuid(),
    archived_at: z.number().int().positive().nullable(),
    last_sequence: z.number().int().nonnegative(),
    unread_count: z.number().int().nonnegative(),
    created_at: z.number().int().positive(),
    updated_at: z.number().int().positive(),
  })
  .strict();

export const ThreadsResponseSchema = z.object({ threads: z.array(ThreadSummarySchema) }).strict();

const CreateThreadRequestSchema = z
  .object({ title: z.string().trim().min(1).max(120) })
  .strict();

const RenameThreadRequestSchema = CreateThreadRequestSchema;

export const ThreadMessageSchema = z
  .object({
    id: z.string().uuid(),
    thread_id: z.string().uuid(),
    space_id: z.string().uuid(),
    author_user_id: z.string().uuid().nullable(),
    // '' only for a tombstoned message (the store redacts it).
    body: z.string().max(8000),
    reply_to_message_id: z.string().uuid().nullable(),
    sequence: z.number().int().nonnegative(),
    client_message_id: z.string().min(1).max(128),
    revision: z.number().int().positive(),
    tombstoned_at: z.number().int().positive().nullable(),
    tombstoned_by: z.string().uuid().nullable(),
    created_at: z.number().int().positive(),
    updated_at: z.number().int().positive(),
    // Never device_id (privacy).
    origin: z.enum(['web_text', 'web_voice', 'device']),
  })
  .strict();

const MessagesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(64).optional(),
  })
  .strict();

export const MessagesResponseSchema = z
  .object({ messages: z.array(ThreadMessageSchema), next_cursor: z.string().nullable() })
  .strict();

const PostMessageRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(8000),
    reply_to_message_id: z.string().uuid().optional(),
    client_message_id: z.string().min(1).max(128),
  })
  .strict();

const EditMessageRequestSchema = z
  .object({ body: z.string().trim().min(1).max(8000) })
  .strict();

const RevisionSchema = z
  .object({
    revision: z.number().int().positive(),
    body: z.string().min(1).max(8000),
    author_user_id: z.string().uuid().nullable(),
    updated_at: z.number().int().positive(),
  })
  .strict();

export const RevisionsResponseSchema = z.object({ revisions: z.array(RevisionSchema) }).strict();

const MarkReadRequestSchema = z
  .object({ last_read_sequence: z.number().int().nonnegative().optional() })
  .strict();

export const ReadStateSchema = z
  .object({
    thread_id: z.string().uuid(),
    user_id: z.string().uuid(),
    last_read_sequence: z.number().int().nonnegative(),
    updated_at: z.number().int().positive(),
  })
  .strict();

interface ThreadsRouterDeps {
  getDb: () => Promise<Db>;
  events: { publish: (userId: string, event: AccountEvent) => void };
}

/** After an archive, clears every member's pointer still naming this thread.
 *  Best-effort: a stale thread is also nulled on the next read. */
async function clearArchivedThreadPointers(
  db: Db,
  events: { publish: (userId: string, event: AccountEvent) => void },
  userId: string,
  thread: StoredThread,
): Promise<void> {
  let memberIds: string[];
  try {
    memberIds = (await listMembers(db, userId, thread.spaceId)).map((member) => member.userId);
  } catch (error) {
    journal('v2.thread_pointer_clear_failed', {
      thread_id: thread.id,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return;
  }
  for (const memberId of memberIds) {
    try {
      const changedAt = await clearActiveThread(db, memberId, thread.id);
      if (changedAt === null) continue;
      events.publish(memberId, {
        type: 'active.changed', conversation_id: null, title: null, surface: 'activate', changed_at: changedAt,
      });
    } catch (error) {
      journal('v2.thread_pointer_clear_failed', {
        thread_id: thread.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

/** StoreNotFoundError (missing, outside the audience, or not yours) is 404;
 *  any other StoreError is an impossible payload, so 400. */
function mapError(response: Response, error: unknown): void {
  // Only the named group lifecycle denials are permissions errors. A missing
  // database grant or another infrastructure failure must still surface as 500.
  if (error instanceof Error && 'code' in error && error.code === '42501'
      && ['use group chat lifecycle', 'only the group owner can rename'].includes(error.message)) {
    sendError(response, 403, 'forbidden');
    return;
  }
  if (error instanceof StoreNotFoundError) {
    sendError(response, 404, 'not_found', error.message);
    return;
  }
  if (error instanceof StoreError) {
    sendError(response, 400, 'invalid_request', error.message);
    return;
  }
  throw error;
}

function toThread(thread: StoredThread) {
  return {
    id: thread.id,
    space_id: thread.spaceId,
    title: thread.title,
    created_by: thread.createdBy,
    archived_at: thread.archivedAt,
    last_sequence: thread.lastSequence,
    unread_count: thread.unreadCount ?? 0,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
  };
}

function toMessage(message: StoredThreadMessage) {
  return {
    id: message.id,
    thread_id: message.threadId,
    space_id: message.spaceId,
    author_user_id: message.authorUserId,
    body: message.body,
    reply_to_message_id: message.replyToMessageId,
    sequence: message.sequence,
    client_message_id: message.clientMessageId,
    revision: message.revision,
    tombstoned_at: message.tombstonedAt,
    tombstoned_by: message.tombstonedBy,
    created_at: message.createdAt,
    updated_at: message.updatedAt,
    origin: message.origin,
  };
}

function toReadState(state: ThreadReadState) {
  return {
    thread_id: state.threadId,
    user_id: state.userId,
    last_read_sequence: state.lastReadSequence,
    updated_at: state.updatedAt,
  };
}

const SpaceParams = z.object({ spaceId: UuidPath });
const IdParams = z.object({ id: UuidPath });

export function createThreadsRouter({ getDb, events }: ThreadsRouterDeps): Router {
  const router = Router();

  router.get('/spaces/:spaceId/threads', route({ params: SpaceParams, mapError },
    async ({ params: { spaceId }, userId }, _request, response) => {
      const threads = await listThreads(await getDb(), userId, spaceId);
      journal('v2.threads_listed', { space_id: spaceId, count: threads.length });
      response.status(200).json(ThreadsResponseSchema.parse({ threads: threads.map(toThread) }));
    }));

  router.post('/spaces/:spaceId/threads', route({ body: CreateThreadRequestSchema, params: SpaceParams, mapError },
    async ({ body, params: { spaceId }, userId }, _request, response) => {
      const thread = await createThread(await getDb(), userId, { spaceId, title: body.title });
      journal('v2.thread_created', { thread_id: thread.id, space_id: spaceId });
      response.status(201).json(ThreadSummarySchema.parse(toThread(thread)));
    }));

  router.get('/threads/:id', route({ params: IdParams, mapError }, async ({ params: { id }, userId }, _request, response) => {
    const thread = await getThread(await getDb(), userId, id);
    journal('v2.thread_read', { thread_id: id });
    response.status(200).json(ThreadSummarySchema.parse(toThread(thread)));
  }));

  router.patch('/threads/:id', route({ body: RenameThreadRequestSchema, params: IdParams, mapError },
    async ({ body, params: { id }, userId }, _request, response) => {
      const thread = await renameThread(await getDb(), userId, id, { title: body.title });
      journal('v2.thread_renamed', { thread_id: id });
      response.status(200).json(ThreadSummarySchema.parse(toThread(thread)));
    }));

  router.delete('/threads/:id', route({ params: IdParams, mapError }, async ({ params: { id }, userId }, _request, response) => {
    const db = await getDb();
    const thread = await archiveThread(db, userId, id);
    journal('v2.thread_archived', { thread_id: id });
    await clearArchivedThreadPointers(db, events, userId, thread);
    response.status(200).json(ThreadSummarySchema.parse(toThread(thread)));
  }));

  router.get('/threads/:id/messages', route({ query: MessagesQuerySchema, params: IdParams, mapError },
    async ({ query, params: { id }, userId }, _request, response) => {
      const { messages, nextCursor } = await listMessages(await getDb(), userId, id, {
        limit: query.limit,
        cursor: query.cursor,
      });
      journal('v2.messages_listed', { thread_id: id, count: messages.length, has_cursor: nextCursor !== null });
      response.status(200).json(
        MessagesResponseSchema.parse({ messages: messages.map(toMessage), next_cursor: nextCursor }),
      );
    }));

  // A retry with the same client_message_id returns the original (200).
  router.post('/threads/:id/messages', route({ body: PostMessageRequestSchema, params: IdParams, mapError },
    async ({ body, params: { id }, userId }, _request, response) => {
      const { message, created } = await postThreadMessage(await getDb(), events, userId, {
        threadId: id,
        body: body.body,
        replyToMessageId: body.reply_to_message_id,
        clientMessageId: body.client_message_id,
      });
      response.status(created ? 201 : 200).json(ThreadMessageSchema.parse(toMessage(message)));
    }));

  router.patch('/messages/:id', route({ body: EditMessageRequestSchema, params: IdParams, mapError },
    async ({ body, params: { id }, userId }, _request, response) => {
      const message = await editMessage(await getDb(), userId, id, { body: body.body });
      journal('v2.thread_message_edited', { message_id: id, revision: message.revision });
      response.status(200).json(ThreadMessageSchema.parse(toMessage(message)));
    }));

  router.delete('/messages/:id', route({ params: IdParams, mapError }, async ({ params: { id }, userId }, _request, response) => {
    const message = await tombstoneMessage(await getDb(), userId, id);
    journal('v2.thread_message_tombstoned', {
      message_id: id,
      thread_id: message.threadId,
      moderator: message.tombstonedBy !== message.authorUserId,
    });
    response.status(200).json(ThreadMessageSchema.parse(toMessage(message)));
  }));

  // Revision history is the current state: one entry, the latest revision.
  router.get('/messages/:id/revisions', route({ params: IdParams, mapError }, async ({ params: { id }, userId }, _request, response) => {
    const message = await getMessage(await getDb(), userId, id);
    journal('v2.thread_message_revisions_read', { message_id: id, revision: message.revision });
    response.status(200).json(
      RevisionsResponseSchema.parse({
        revisions:
          message.tombstonedAt !== null
            ? []
            : [
                {
                  revision: message.revision,
                  body: message.body,
                  author_user_id: message.authorUserId,
                  updated_at: message.updatedAt,
                },
              ],
      }),
    );
  }));

  // Without a body, the cursor advances to the thread's last_sequence.
  router.put('/threads/:id/read', route({ body: MarkReadRequestSchema.optional(), params: IdParams, mapError },
    async ({ body, params: { id }, userId }, _request, response) => {
      const state = await markRead(await getDb(), userId, id, { lastReadSequence: body?.last_read_sequence });
      journal('v2.thread_read_cursor', { thread_id: id, last_read_sequence: state.lastReadSequence });
      response.status(200).json(ReadStateSchema.parse(toReadState(state)));
    }));

  return router;
}
