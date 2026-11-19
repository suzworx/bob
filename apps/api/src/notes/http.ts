/**
 * REST routes for shared notes (014, S14-T016, contracts/api.md "Notes and
 * assets"). UNMOUNTED: a later task mounts this router; server.ts is untouched.
 * Every handler acts as req.account.userId and lets the store own behaviour;
 * RLS decides access from active membership, so a note in a space the caller is
 * not a member of answers exactly like a missing id (no oracle). A stale
 * `revision` on PATCH answers 409 `conflict` carrying the current revision so
 * the client can preserve the user's draft. Journal events carry ids and counts
 * only -- never note content (FR-013, standing observability). Zod schemas are
 * local to this file by design (web-schemas.ts is owned by another task).
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { moduleJournal } from '../platform/logger.ts';
import { route, sendError } from '../platform/http/route.ts';
import { StoreError, StoreConflictError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import {
  createNote,
  getNote,
  listNotes,
  listRevisions,
  NoteConflictError,
  restoreNote,
  searchNotes,
  setPinned,
  trashNote,
  type StoredNote,
  type StoredRevision,
  updateNote,
} from './store.ts';

const journal = moduleJournal('notes');

interface NotesRouterDeps {
  getDb: () => Promise<Db>;
}

const UuidPath = z.string().uuid();

// --- Local request/response schemas (contracts/api.md "Notes and assets"). ---

const NoteTitle = z.string().trim().min(1).max(200);
const NoteBody = z.string().max(20000);

const CreateNoteRequestSchema = z
  .object({
    title: NoteTitle,
    body: NoteBody.optional(),
    ai_assisted: z.boolean().optional(),
  })
  .strict();

const UpdateNoteRequestSchema = z
  .object({
    revision: z.number().int().positive(),
    title: NoteTitle.optional(),
    body: NoteBody.optional(),
    ai_assisted: z.boolean().optional(),
  })
  .strict();

const NotesQuerySchema = z.object({ trashed: z.enum(['true']).optional() }).strict();
const SearchQuerySchema = z.object({ q: z.string().trim().min(1).max(200) }).strict();

export const NoteSummarySchema = z
  .object({
    id: z.string().uuid(),
    space_id: z.string().uuid(),
    title: z.string().min(1).max(200),
    body: z.string().max(20000),
    pinned: z.boolean(),
    revision: z.number().int().positive(),
    created_by: z.string().uuid(),
    updated_by: z.string().uuid(),
    ai_assisted: z.boolean(),
    trashed_at: z.number().int().positive().nullable(),
    created_at: z.number().int().positive(),
    updated_at: z.number().int().positive(),
  })
  .strict();
type NoteSummary = z.infer<typeof NoteSummarySchema>;

export const NotesResponseSchema = z.object({ notes: z.array(NoteSummarySchema) }).strict();

const NoteRevisionSchema = z
  .object({
    id: z.string().uuid(),
    note_id: z.string().uuid(),
    revision: z.number().int().positive(),
    title: z.string().min(1).max(200),
    body: z.string().max(20000),
    editor_user_id: z.string().uuid(),
    ai_assisted: z.boolean(),
    created_at: z.number().int().positive(),
  })
  .strict();
type NoteRevision = z.infer<typeof NoteRevisionSchema>;

export const NoteRevisionsResponseSchema = z.object({ revisions: z.array(NoteRevisionSchema) }).strict();

/** StoredNote -> the contract NoteSummarySchema shape. */
export function toNoteSummary(note: StoredNote): NoteSummary {
  return {
    id: note.id,
    space_id: note.spaceId,
    title: note.title,
    body: note.body,
    pinned: note.pinned,
    revision: note.revision,
    created_by: note.createdBy,
    updated_by: note.updatedBy,
    ai_assisted: note.aiAssisted,
    trashed_at: note.trashedAt,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
  };
}

function toNoteRevision(revision: StoredRevision): NoteRevision {
  return {
    id: revision.id,
    note_id: revision.noteId,
    revision: revision.revision,
    title: revision.title,
    body: revision.body,
    editor_user_id: revision.editorUserId,
    ai_assisted: revision.aiAssisted,
    created_at: revision.createdAt,
  };
}

/** Maps a store error to the contract shape; rethrows unknown errors so the
 *  express error handler (or the JWT guard) sees a 500, never a silent 200. */
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) {
    sendError(response, 404, 'not_found', error.message);
    return;
  }
  if (error instanceof NoteConflictError) {
    response.status(409).json({
      error: { code: 'conflict', message: error.message, current_revision: error.current.revision },
    });
    return;
  }
  if (error instanceof StoreConflictError) {
    sendError(response, 409, 'conflict', error.message);
    return;
  }
  if (error instanceof StoreError) {
    sendError(response, 409, 'conflict', error.message);
    return;
  }
  throw error;
}

const SpaceParams = z.object({ spaceId: UuidPath });
const IdParams = z.object({ id: UuidPath });

export function createNotesRouter({ getDb }: NotesRouterDeps): Router {
  const router = Router();

  router.get('/spaces/:spaceId/notes', route({ query: NotesQuerySchema, params: SpaceParams, mapError },
    async ({ query, params, userId }, _request, response) => {
      const notes = await listNotes(await getDb(), userId, params.spaceId, { includeTrashed: query.trashed === 'true' });
      journal('v2.notes_listed', { space_id: params.spaceId, count: notes.length });
      response.status(200).json(NotesResponseSchema.parse({ notes: notes.map(toNoteSummary) }));
    }));

  router.post('/spaces/:spaceId/notes', route({ body: CreateNoteRequestSchema, params: SpaceParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const note = await createNote(await getDb(), userId, params.spaceId, {
        title: body.title,
        body: body.body,
        aiAssisted: body.ai_assisted,
      });
      journal('v2.note_created', { note_id: note.id, space_id: params.spaceId });
      response.status(201).json(NoteSummarySchema.parse(toNoteSummary(note)));
    }));

  router.get('/notes/:id', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const note = await getNote(await getDb(), userId, params.id);
    journal('v2.note_read', { note_id: params.id });
    response.status(200).json(NoteSummarySchema.parse(toNoteSummary(note)));
  }));

  router.patch('/notes/:id', route({ body: UpdateNoteRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const note = await updateNote(await getDb(), userId, params.id, {
        revision: body.revision,
        title: body.title,
        body: body.body,
        aiAssisted: body.ai_assisted,
      });
      journal('v2.note_updated', { note_id: params.id, revision: note.revision });
      response.status(200).json(NoteSummarySchema.parse(toNoteSummary(note)));
    }));

  // Trash, not purge.
  router.delete('/notes/:id', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    await trashNote(await getDb(), userId, params.id);
    journal('v2.note_trashed', { note_id: params.id });
    response.status(204).end();
  }));

  router.post('/notes/:id/restore', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const note = await restoreNote(await getDb(), userId, params.id);
    journal('v2.note_restored', { note_id: params.id });
    response.status(200).json(NoteSummarySchema.parse(toNoteSummary(note)));
  }));

  // Pin state is per space, not per viewer; no body is read.
  router.put('/notes/:id/pin', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const note = await setPinned(await getDb(), userId, params.id, true);
    journal('v2.note_pinned', { note_id: params.id });
    response.status(200).json(NoteSummarySchema.parse(toNoteSummary(note)));
  }));

  router.delete('/notes/:id/pin', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const note = await setPinned(await getDb(), userId, params.id, false);
    journal('v2.note_unpinned', { note_id: params.id });
    response.status(200).json(NoteSummarySchema.parse(toNoteSummary(note)));
  }));

  router.get('/notes/:id/revisions', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const revisions = await listRevisions(await getDb(), userId, params.id);
    journal('v2.note_revisions_listed', { note_id: params.id, count: revisions.length });
    response.status(200).json(NoteRevisionsResponseSchema.parse({ revisions: revisions.map(toNoteRevision) }));
  }));

  router.get('/spaces/:spaceId/notes/search', route({ query: SearchQuerySchema, params: SpaceParams, mapError },
    async ({ query, params, userId }, _request, response) => {
      const notes = await searchNotes(await getDb(), userId, params.spaceId, query.q);
      journal('v2.notes_searched', { space_id: params.spaceId, count: notes.length });
      response.status(200).json(NotesResponseSchema.parse({ notes: notes.map(toNoteSummary) }));
    }));

  return router;
}
