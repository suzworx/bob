import { z } from 'zod';
import { BobAppDefinitionSchema, RecordCommandSchema, RecordStateSchema } from './schemas.ts';

const mutation = { expectedRevision: z.number().int().positive().max(2147483646), mutationId: z.uuid() };
export const BobAppCreateSchema = z.strictObject({ definition: BobAppDefinitionSchema, state: RecordStateSchema.optional(), mutationId: z.uuid(), spaceId: z.uuid().nullable().optional() });
export const BobAppMutationSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...mutation, operation: z.enum(['activate', 'pause', 'resume', 'archive', 'restore', 'apply_revision', 'undo', 'duplicate']) }),
  z.strictObject({ ...mutation, operation: z.literal('revise'), definition: BobAppDefinitionSchema }),
]);
export const BobAppActionSchema = z.strictObject({ ...mutation, command: RecordCommandSchema });
export const BobAppDeleteSchema = z.strictObject(mutation);
export const BobAppSchema = z.strictObject({
  id: z.uuid(), installationId: z.uuid(), spaceId: z.uuid().nullable(), canManage: z.boolean(), revision: z.number().int().positive(), lifecycle: z.enum(['draft', 'active', 'paused', 'archived']),
  definition: BobAppDefinitionSchema, state: RecordStateSchema, metrics: z.record(z.string(), z.number()),
  pendingDefinition: BobAppDefinitionSchema.nullable(), canUndo: z.boolean(),
  createdAt: z.number().int(), updatedAt: z.number().int(),
});
export const BobAppResponseSchema = z.strictObject({ app: BobAppSchema });
export const BobAppSummarySchema = BobAppSchema.pick({ id: true, installationId: true, spaceId: true, canManage: true, revision: true, lifecycle: true, createdAt: true, updatedAt: true }).extend({ title: z.string().max(120) });
export const BobAppsQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(30).default(20), cursor: z.uuid().optional(), spaceId: z.uuid().nullable().optional() });
export const BobAppsResponseSchema = z.strictObject({ apps: z.array(BobAppSummarySchema), nextCursor: z.uuid().nullable() });
export const BobAppExportSchema = z.strictObject({ schemaVersion: z.literal(1), updatedAt: z.number().int(), definition: BobAppDefinitionSchema, state: RecordStateSchema });

export const BobAppConversationResponseSchema = z.strictObject({ conversationId: z.string().min(1).max(64), spaceId: z.uuid() });
