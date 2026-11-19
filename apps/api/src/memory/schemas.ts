/** The /api/memories HTTP contract, shared through web-schemas.ts with the web client. */
import { z } from 'zod';
import { OpaqueId, OriginSchema } from '../platform/id-schemas.ts';

const MemoryKindSchema = z.enum(['fact', 'preference', 'intent', 'action_item']);

/** Where a memory's source turn was spoken; null after the source was deleted. */
const MemorySourceSchema = z
  .object({
    conversation_id: OpaqueId.nullable(),
    message_id: OpaqueId.nullable(),
    surface: OriginSchema,
  })
  .strict();

/** One memory as returned by GET /api/memories and PATCH /api/memories/:id. */
export const MemorySummarySchema = z
  .object({
    id: OpaqueId,
    kind: MemoryKindSchema,
    content: z.string().min(1).max(2000),
    confidence: z.number().min(0).max(1),
    sensitive: z.boolean(),
    source: MemorySourceSchema,
    superseded_by: OpaqueId.nullable(),
    created_at: z.number().int().positive(),
    updated_at: z.number().int().positive(),
  })
  .strict();
export type MemorySummary = z.infer<typeof MemorySummarySchema>;

/** GET /api/memories query (keyset pagination + filters). */
export const MemoriesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: OpaqueId.optional(),
    kind: MemoryKindSchema.optional(),
    sensitive: z.enum(['true', 'false']).optional(),
    q: z.string().max(200).optional(),
    current_only: z.enum(['true', 'false']).optional(),
  })
  .strict();

/** GET /api/memories success body; empty is `{ memories: [], next_cursor: null }`. */
export const MemoriesResponseSchema = z
  .object({ memories: z.array(MemorySummarySchema), next_cursor: OpaqueId.nullable() })
  .strict();

/** PATCH /api/memories/:id; kind is not editable. */
export const MemoryCorrectRequestSchema = z
  .object({
    content: z.string().trim().min(1).max(2000),
    confidence: z.number().min(0).max(1).optional(),
    sensitive: z.boolean().optional(),
  })
  .strict();

/** POST /api/memories (add by hand). kind defaults to fact; action_item also
 *  opens an bob.action_items row. */
export const MemoryCreateRequestSchema = z
  .object({
    content: z.string().trim().min(1).max(2000),
    kind: MemoryKindSchema.optional(),
  })
  .strict();
