/**
 * POST /api/notes/:id/publish and POST /api/memories/:id/promote. A source or
 * destination the caller cannot reach answers exactly like a missing id (no
 * oracle), and nothing in the response names the private source.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { route, sendError } from '../platform/http/route.ts';
import { moduleJournal } from '../platform/logger.ts';
import { StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { promoteMemoryToTask, publishNoteIntoSpace } from './publication-service.ts';
import { OpaqueId, TaskSummarySchema } from '../web-schemas.ts';
import { toNoteSummary } from '../notes/http.ts';
import { toTaskSummary } from '../tasks/http.ts';

const journal = moduleJournal('spaces');

interface PublicationRouterDeps {
  getDb: () => Promise<Db>;
}

const UuidPath = z.string().uuid();

// A note needs a title, so title must be selected; body is the caller's choice.
const PublishNoteRequestSchema = z
  .object({
    space_id: z.string().uuid(),
    fields: z.object({ title: z.literal(true), body: z.boolean().optional() }).strict(),
  })
  .strict();

// The title is supplied by the person, never copied from the memory text.
const PromoteMemoryRequestSchema = z
  .object({
    space_id: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    due_at: z.number().int().positive().optional(),
  })
  .strict();

/** The message is left out on purpose: it could echo something about the source. */
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) {
    sendError(response, 404, 'not_found');
    return;
  }
  if (error instanceof StoreError) {
    sendError(response, 409, 'conflict');
    return;
  }
  throw error;
}

export function createPublicationRouter({ getDb }: PublicationRouterDeps): Router {
  const router = Router();

  router.post('/notes/:id/publish', route({ body: PublishNoteRequestSchema, params: z.object({ id: UuidPath }), mapError },
    async ({ body: { space_id: spaceId, fields }, params, userId }, _request, response) => {
      const copy = await publishNoteIntoSpace({
        db: await getDb(),
        userId,
        noteId: params.id,
        spaceId,
        fields: { title: true, body: fields.body === true },
      });
      journal('v2.publication_route', { published_type: 'note', field_count: fields.body === true ? 2 : 1 });
      response.status(201).json(toNoteSummary(copy));
    }));

  router.post('/memories/:id/promote', route({ body: PromoteMemoryRequestSchema, params: z.object({ id: OpaqueId }), mapError },
    async ({ body: { space_id: spaceId, title, due_at: dueAt }, params, userId }, _request, response) => {
      const task = await promoteMemoryToTask({
        db: await getDb(),
        userId,
        memoryId: params.id,
        spaceId,
        title,
        ...(dueAt !== undefined ? { dueAt } : {}),
      });
      journal('v2.publication_route', { published_type: 'task', field_count: 1 });
      response.status(201).json(TaskSummarySchema.parse(toTaskSummary(task)));
    }));

  return router;
}
