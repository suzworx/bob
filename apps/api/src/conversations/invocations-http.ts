/**
 * REST routes for AI invocations, the explicit "ask Bob" route. RLS decides
 * access from active membership, so an invocation (or thread) outside the
 * caller's audience answers exactly like a missing id. The body names only
 * the trigger message; actor, space, thread and context boundary are all
 * server-built. Journal events carry ids and states only.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { route, sendError } from '../platform/http/route.ts';
import { moduleJournal } from '../platform/logger.ts';
import { StoreConflictError, StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { getMessage } from './thread-store.ts';
import { getInvocation, cancelInvocation, type StoredInvocation } from './invocations-store.ts';
import { runInvocation, type InvocationAgentSource, type InvocationContext, type InvocationResult } from '../workflows/workflow-thread-invocation.ts';
import { accountTimeZone } from '../account/auth.ts';
import { publishThreadMessage, type ThreadMessageEvents } from './thread-events.ts';
import { CreateInvocationRequestSchema } from './invocations-schemas.ts';
import type { AppTurnExtension } from '../bob-apps/app-turn-extension.ts';

const journal = moduleJournal('conversations');

const UuidPath = z.string().uuid();

export const InvocationResponseSchema = z
  .object({
    id: z.string().uuid(),
    thread_id: z.string().uuid(),
    space_id: z.string().uuid(),
    state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    result_message_id: z.string().uuid().nullable(),
    error_code: z.string().nullable(),
  })
  .strict();

interface InvocationsRouterDeps {
  getDb: () => Promise<Db>;
  run?: typeof runInvocation;
  /** The agent port from AppDeps; omitted, runInvocation picks the port for this process's env. */
  agent?: InvocationAgentSource | undefined;
  events?: ThreadMessageEvents;
  /** The installed apps' turn extension from AppDeps, handed to every invocation. */
  appTurnTools: AppTurnExtension;
}

function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreConflictError) {
    sendError(response, 409, 'conflict', error.message);
    return;
  }
  if (error instanceof StoreNotFoundError) {
    sendError(response, 404, 'not_found');
    return;
  }
  if (error instanceof StoreError) {
    sendError(response, 400, 'invalid_request', error.message);
    return;
  }
  throw error;
}

function toInvocation(invocation: StoredInvocation) {
  return {
    id: invocation.id,
    thread_id: invocation.threadId,
    space_id: invocation.spaceId,
    state: invocation.state,
    result_message_id: invocation.resultMessageId,
    error_code: invocation.errorCode,
  };
}

/** Maps runInvocation's outcome to the wire: busy -> 409, everything else 202. */
function respondToRun(response: Response, result: InvocationResult): void {
  if (!result.claimed && result.reason === 'busy') {
    sendError(response, 409, 'conflict', 'an invocation is already running in this thread');
    return;
  }
  journal('v2.invocation_responded', {
    outcome: result.claimed ? result.outcome : 'duplicate',
  });
  response.status(202).json({ invocation_id: result.invocation.id });
}

const IdParams = z.object({ id: UuidPath });

export function createInvocationsRouter({ getDb, run = runInvocation, agent, events, appTurnTools }: InvocationsRouterDeps): Router {
  const router = Router();

  router.post('/threads/:id/invocations', route({ body: CreateInvocationRequestSchema, params: IdParams, mapError },
    async ({ body, params: { id: threadId }, userId }, request, response) => {
      const db = await getDb();
      // The trigger must be a message in THIS thread; its sequence is the context boundary.
      const trigger = await getMessage(db, userId, body.trigger_message_id);
      if (trigger.threadId !== threadId || (body.appBinding && trigger.authorUserId !== userId)) {
        sendError(response, 404, 'not_found');
        return;
      }
      const ctx: InvocationContext = {
        actorUserId: userId,
        ...(request.account?.sessionId ? { sessionId: request.account.sessionId } : {}),
        spaceId: trigger.spaceId,
        threadId,
        triggerMessageId: trigger.id,
        contextHighWater: trigger.sequence,
        timeZone: accountTimeZone(request),
        ...(body.appBinding ? { appBinding: body.appBinding } : {}),
      };
      const result = await run(ctx, { db, agent, appTurnTools });
      if (events && result.claimed && result.outcome === 'completed' && result.resultMessageId) {
        await publishThreadMessage(db, events, userId, await getMessage(db, userId, result.resultMessageId));
      }
      journal('v2.invocation_created', {
        thread_id: threadId,
        state: result.claimed ? result.outcome : result.reason,
      });
      respondToRun(response, result);
    }));

  router.get('/invocations/:id', route({ params: IdParams, mapError }, async ({ params: { id }, userId }, _request, response) => {
    const invocation = await getInvocation(await getDb(), userId, id);
    journal('v2.invocation_read', { invocation_id: id, turn_id: id, state: invocation.state });
    response.status(200).json(InvocationResponseSchema.parse(toInvocation(invocation)));
  }));

  router.delete('/invocations/:id', route({ params: IdParams, mapError }, async ({ params: { id }, userId }, _request, response) => {
    const invocation = await cancelInvocation(await getDb(), userId, id);
    journal('v2.invocation_cancelled', { invocation_id: id, turn_id: id, state: invocation.state });
    response.status(200).json(InvocationResponseSchema.parse(toInvocation(invocation)));
  }));

  return router;
}
