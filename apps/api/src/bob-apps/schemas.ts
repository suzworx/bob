import { z } from 'zod';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).refine((value) => !['constructor', 'prototype', '__proto__'].includes(value));
const title = z.string().trim().min(1).max(120);
const refs = z.array(key).max(32);
const field = z.strictObject({ id: key, type: z.enum(['text', 'number', 'boolean']) });
const table = z.strictObject({ id: key, fields: z.array(field).min(1).max(32) });
const action = z.strictObject({ id: key, table: key, operation: z.enum(['create', 'update', 'delete']) });
const metric = z.discriminatedUnion('operation', [
  z.strictObject({ id: key, table: key, operation: z.literal('count') }),
  z.strictObject({ id: key, table: key, operation: z.literal('sum'), field: key }),
]);
const view = z.discriminatedUnion('kind', [
  z.strictObject({ id: key, kind: z.enum(['table', 'checklist']), title, table: key, fields: refs.min(1), actions: refs }),
  z.strictObject({ id: key, kind: z.literal('dashboard'), title, metrics: refs.min(1) }),
  z.strictObject({ id: key, kind: z.literal('slides'), title, slides: z.array(z.strictObject({ title, body: z.string().max(2000), metrics: refs })).min(1).max(20) }),
]);
const definition = z.strictObject({
  schemaVersion: z.literal(1), title, lifecycle: z.literal('keep').describe('Always keep. This is retention, not draft/active app status.'),
  tables: z.array(table).min(1).max(8), actions: z.array(action).max(32),
  metrics: z.array(metric).max(32), views: z.array(view).min(1).max(12).describe('At least one view, with valid references to the declared tables, fields, actions or metrics.'),
});
type Definition = z.infer<typeof definition>;

function unique(ids: string[]): boolean {
  return new Set(ids).size === ids.length;
}

function validMetric(app: Definition, item: Definition['metrics'][number]): boolean {
  const source = app.tables.find((candidate) => candidate.id === item.table);
  if (!source) return false;
  return item.operation === 'count' || source.fields.some((candidate) => candidate.id === item.field && candidate.type === 'number');
}

function validView(app: Definition, item: Definition['views'][number]): boolean {
  if ('table' in item) {
    const source = app.tables.find((candidate) => candidate.id === item.table);
    if (!source) return false;
    return unique(item.fields) && unique(item.actions)
      && item.fields.every((id) => source.fields.some((candidate) => candidate.id === id))
      && item.actions.every((id) => app.actions.some((candidate) => candidate.id === id && candidate.table === item.table));
  }
  const ids = item.kind === 'slides' ? item.slides.flatMap((slide) => slide.metrics) : item.metrics;
  return ids.every((id) => app.metrics.some((candidate) => candidate.id === id));
}

// Definitions carry no account, grants, executable expressions, connectors or schedules.
// Installation identity and authorization belong to a future server-owned envelope.
export const BobAppDefinitionSchema = definition.refine((app) =>
  [app.tables, app.actions, app.metrics, app.views].every((items) => unique(items.map((item) => item.id)))
  && app.tables.every((item) => unique(item.fields.map((column) => column.id)))
  && app.actions.every((item) => app.tables.some((source) => source.id === item.table))
  && app.metrics.every((item) => validMetric(app, item))
  && app.views.every((item) => validView(app, item)),
{ message: 'App references must name unique, compatible declarations.' });

function safeKeys(limit: number): z.ZodType<Record<string, unknown>> {
  return z.custom<Record<string, unknown>>((value) => typeof value === 'object' && value !== null
    && !Array.isArray(value) && Object.keys(value).length <= limit
    && Object.keys(value).every((name) => key.safeParse(name).success));
}

const RecordSchema = z.strictObject({
  id: key,
  values: safeKeys(32).pipe(z.record(key, z.union([z.string().max(2000), z.number().min(-1e12).max(1e12), z.boolean()]))),
});
export const RecordStateSchema = safeKeys(8).pipe(z.record(key, z.array(RecordSchema).max(500)));
export const RecordCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('write'), action: key, id: key, values: RecordSchema.shape.values }),
  z.strictObject({ operation: z.literal('delete'), action: key, id: key }),
]);
