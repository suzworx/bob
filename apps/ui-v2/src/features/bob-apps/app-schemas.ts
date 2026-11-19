import { z } from 'zod';
// Browser DTOs mirror the server contract without importing its Node-only graph.
const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).refine((value) => !['constructor', 'prototype', '__proto__'].includes(value));
const title = z.string().min(1).max(120);
const refs = z.array(key).max(32);
const field = z.strictObject({ id: key, type: z.enum(['text', 'number', 'boolean']) });
const action = z.strictObject({ id: key, table: key, operation: z.enum(['create', 'update', 'delete']) });
const metric = z.discriminatedUnion('operation', [z.strictObject({ id: key, table: key, operation: z.literal('count') }), z.strictObject({ id: key, table: key, operation: z.literal('sum'), field: key })]);
const view = z.discriminatedUnion('kind', [
  z.strictObject({ id: key, kind: z.enum(['table', 'checklist']), title, table: key, fields: refs.min(1), actions: refs }),
  z.strictObject({ id: key, kind: z.literal('dashboard'), title, metrics: refs.min(1) }),
  z.strictObject({ id: key, kind: z.literal('slides'), title, slides: z.array(z.strictObject({ title, body: z.string().max(2000), metrics: refs })).min(1).max(20) }),
]);
export const appDefinitionSchema = z.strictObject({ schemaVersion: z.literal(1), title, lifecycle: z.literal('keep'), tables: z.array(z.strictObject({ id: key, fields: z.array(field).min(1).max(32) })).min(1).max(8), actions: z.array(action).max(32), metrics: z.array(metric).max(32), views: z.array(view).min(1).max(12) });
const values = z.record(key, z.union([z.string().max(2000), z.number().min(-1e12).max(1e12), z.boolean()]));
export const appRecordsSchema = z.record(key, z.array(z.strictObject({ id: key, values })).max(500));
export const appCommandSchema = z.discriminatedUnion('operation', [z.strictObject({ operation: z.literal('write'), action: key, id: key, values }), z.strictObject({ operation: z.literal('delete'), action: key, id: key })]);
const summary = z.strictObject({ id: z.uuid(), installationId: z.uuid(), spaceId: z.uuid().nullable(), canManage: z.boolean(), revision: z.number().int().positive(), lifecycle: z.enum(['draft', 'active', 'paused', 'archived']), title: z.string().max(120), createdAt: z.number().int(), updatedAt: z.number().int() });
export const appsResponseSchema = z.strictObject({ apps: z.array(summary), nextCursor: z.uuid().nullable() });
export const appResponseSchema = z.strictObject({ app: summary.omit({ title: true }).extend({ definition: appDefinitionSchema, state: appRecordsSchema, metrics: z.record(z.string(), z.number()), pendingDefinition: appDefinitionSchema.nullable(), canUndo: z.boolean() }) });
export const appExportSchema = z.strictObject({ schemaVersion: z.literal(1), updatedAt: z.number().int(), definition: appDefinitionSchema, state: appRecordsSchema });
