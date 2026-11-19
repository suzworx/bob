/**
 * REST routes for the account's memories, mounted under /api/memories.
 * DELETE /api/memories (delete-all) additionally runs requireActiveSession. An
 * other-account or unknown id answers exactly like a missing one (no oracle).
 * When memoryAvailable() is false the routes answer 503 memory_unavailable
 * rather than an empty list. PATCH re-embeds the corrected text; an embed
 * failure still persists the correction with the embedding nulled and journals
 * reembedded:false. POST and PATCH answer 422 secret_refused for secret-like
 * content. Journal events carry ids and counts only -- never content.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { secretReason } from '@bob/ai';
import { moduleJournal } from '../platform/logger.ts';
import { route, sendError } from '../platform/http/route.ts';
import { StoreConflictError, StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import {
  applyExtractionOps,
  correctMemory,
  deleteAllMemories,
  deleteMemory,
  findCurrentMemoryByContent,
  getMemory,
  listMemories,
  type MemoryEmbedding,
  type StoredMemory,
} from './store.ts';
import { memoryAvailable as memoryAvailableProbe } from './available.ts';
import {
  MemoriesQuerySchema,
  MemoriesResponseSchema,
  MemoryCorrectRequestSchema,
  MemoryCreateRequestSchema,
  MemorySummarySchema,
  OpaqueId,
  type MemorySummary,
} from '../web-schemas.ts';

const journal = moduleJournal('memory');

export interface MemoriesRouterDeps {
  getDb: () => Promise<Db>;
  /** Omitted: corrections never re-embed (the store nulls the vector). */
  embed?: (content: string) => Promise<MemoryEmbedding>;
  memoryAvailable?: (db: Db) => Promise<boolean>;
  requireActiveSession: (request: Request, response: Response, next: NextFunction) => Promise<void>;
}

/** A store outage must be loud, never a fake empty memory list. */
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreError) {
    sendError(response, 500, 'store_error');
    return;
  }
  throw error;
}

function mapCorrectError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) {
    // One generic body for unknown and other-account memories.
    sendError(response, 404, 'not_found');
    return;
  }
  if (error instanceof StoreConflictError) {
    // The corrected text is already another current memory.
    sendError(response, 409, 'memory_exists');
    return;
  }
  mapError(response, error);
}

/** Secret-like text is refused before any store call; the journal carries the
 *  category only, never the text. */
function refuseSecret(response: Response, content: string, route: 'create' | 'correct'): boolean {
  const reason = secretReason(content);
  if (reason === null) return false;
  journal('v2.memory_refused', { route, reason });
  sendError(response, 422, 'secret_refused');
  return true;
}

function toMemorySummary(memory: StoredMemory): MemorySummary {
  return {
    id: memory.id,
    kind: memory.kind,
    content: memory.content,
    confidence: memory.confidence,
    sensitive: memory.sensitive,
    source: { conversation_id: memory.conversationId, message_id: memory.messageId, surface: memory.surface },
    superseded_by: memory.supersededBy,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
  };
}

/** An embed failure stores the memory without a vector. */
async function embedOrNull(embed: MemoriesRouterDeps['embed'], content: string): Promise<MemoryEmbedding | null> {
  if (!embed) return null;
  try {
    return await embed(content);
  } catch {
    return null;
  }
}

function sendUnchanged(response: Response, memory: StoredMemory): void {
  journal('v2.memory_created', {
    memory_id: memory.id,
    kind: memory.kind,
    outcome: 'unchanged',
    embedded: false,
  });
  response.status(200).json(MemorySummarySchema.parse(toMemorySummary(memory)));
}

const IdParams = z.object({ id: OpaqueId });

export function createMemoriesRouter({
  getDb,
  embed,
  memoryAvailable = memoryAvailableProbe,
  requireActiveSession,
}: MemoriesRouterDeps): Router {
  const router = Router();

  /** Null after answering 503 when the memory tables are absent. */
  async function availableDb(response: Response): Promise<Db | null> {
    const db = await getDb();
    if (await memoryAvailable(db)) return db;
    sendError(response, 503, 'memory_unavailable');
    return null;
  }

  router.get('/', route({ query: MemoriesQuerySchema, mapError }, async ({ query, userId }, _request, response) => {
    const db = await availableDb(response);
    if (!db) return;
    const { memories, nextCursor } = await listMemories(db, userId, {
      limit: query.limit,
      cursor: query.cursor,
      kind: query.kind,
      sensitive: query.sensitive === undefined ? undefined : query.sensitive === 'true',
      q: query.q,
      currentOnly: query.current_only === undefined ? undefined : query.current_only === 'true',
    });
    journal('v2.memory_listed', { count: memories.length, has_cursor: nextCursor !== null });
    response.status(200).json(
      MemoriesResponseSchema.parse({ memories: memories.map(toMemorySummary), next_cursor: nextCursor }),
    );
  }));

  router.post('/', route({ body: MemoryCreateRequestSchema, mapError }, async ({ body, userId }, _request, response) => {
    const { content } = body;
    const kind = body.kind ?? 'fact';
    if (refuseSecret(response, content, 'create')) return;
    const db = await availableDb(response);
    if (!db) return;
    const prior = await findCurrentMemoryByContent(db, userId, content);
    if (prior) {
      sendUnchanged(response, prior);
      return;
    }
    const embedding = await embedOrNull(embed, content);
    // The store's duplicate check decides, under its per-account lock: a race
    // against another create of the same content answers 200 with the row that
    // check found, exactly like the pre-check above.
    const [decision] = await applyExtractionOps(
      db,
      userId,
      [{ op: 'add', kind, content, confidence: 1, sensitive: false, embedding }],
      { source: { conversationId: null, messageId: null, surface: 'web_text' }, path: 'manual' },
    );
    if (!decision?.memoryId) throw new StoreError('memory create: no row');
    const memory = await getMemory(db, userId, decision.memoryId);
    if (!memory) throw new StoreError('memory create: no row');
    if (decision.op !== 'add') {
      sendUnchanged(response, memory);
      return;
    }
    journal('v2.memory_created', {
      memory_id: memory.id,
      kind,
      outcome: 'added',
      embedded: embedding !== null,
    });
    response.status(201).json(MemorySummarySchema.parse(toMemorySummary(memory)));
  }));

  router.patch('/:id', route({ body: MemoryCorrectRequestSchema, params: IdParams, mapError: mapCorrectError },
    async ({ body, params, userId }, _request, response) => {
      if (refuseSecret(response, body.content, 'correct')) return;
      const db = await availableDb(response);
      if (!db) return;
      // The store swallows an embed failure, so track whether it landed.
      let reembedded = false;
      const reembed = embed
        ? async (content: string): Promise<MemoryEmbedding> => {
            const result = await embed(content);
            reembedded = true;
            return result;
          }
        : undefined;
      const corrected = await correctMemory(db, userId, params.id, body, reembed);
      journal('v2.memory_corrected', { memory_id: params.id, kind: corrected.kind, reembedded });
      response.status(200).json(MemorySummarySchema.parse(toMemorySummary(corrected)));
    }));

  router.delete('/:id', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const db = await availableDb(response);
    if (!db) return;
    // Idempotent: an unknown or other-account id answers 204, no oracle.
    await deleteMemory(db, userId, params.id);
    journal('v2.memory_deleted', { memory_id: params.id });
    response.status(204).end();
  }));

  router.delete('/', requireActiveSession, route({ mapError }, async ({ userId }, _request, response) => {
    const db = await availableDb(response);
    if (!db) return;
    const count = await deleteAllMemories(db, userId);
    journal('v2.memories_deleted', { count });
    response.status(204).end();
  }));

  return router;
}
