import type { z } from 'zod';
import { BobAppDefinitionSchema, RecordCommandSchema, RecordStateSchema } from './schemas.ts';

type Definition = z.infer<typeof BobAppDefinitionSchema>;
type State = z.infer<typeof RecordStateSchema>;
type Values = State[string][number]['values'];

function validateValues(table: Definition['tables'][number], values: Values): void {
  if (Object.keys(values).length !== table.fields.length) throw new Error('Record fields do not match the app.');
  for (const field of table.fields) {
    const expected = field.type === 'text' ? 'string' : field.type;
    if (!Object.hasOwn(values, field.id) || typeof values[field.id] !== expected) throw new Error('Record fields do not match the app.');
  }
}

function parseState(app: Definition, input: unknown): State {
  const state = RecordStateSchema.parse(input);
  for (const [id, rows] of Object.entries(state)) {
    const table = app.tables.find((candidate) => candidate.id === id);
    if (!table) throw new Error('Record table is not declared.');
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('Record ids must be unique.');
    for (const row of rows) validateValues(table, row.values);
  }
  // Bounds aggregate serialized storage as well as individual fields and rows.
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > 1_000_000) throw new Error('App data is full.');
  return state;
}

/** Pure local operation only: callers must authorize and persist atomically elsewhere. */
export function applyRecordAction(definition: unknown, input: unknown, request: unknown): State {
  const app = BobAppDefinitionSchema.parse(definition);
  const state = parseState(app, input);
  const command = RecordCommandSchema.parse(request);
  const action = app.actions.find((candidate) => candidate.id === command.action);
  if (!action) throw new Error('Action is not declared.');
  const rows = state[action.table] ?? [];
  const exists = rows.some((row) => row.id === command.id);
  if (action.operation === 'create' && exists) throw new Error('Record already exists.');
  if (action.operation !== 'create' && !exists) throw new Error('Record was not found.');
  if ((action.operation === 'delete') !== (command.operation === 'delete')) throw new Error('Action does not match the request.');
  const next = mutateRows(rows, command, action.operation);
  return parseState(app, { ...state, [action.table]: next });
}

function mutateRows(rows: State[string], command: z.infer<typeof RecordCommandSchema>, operation: Definition['actions'][number]['operation']): State[string] {
  if (command.operation === 'delete') return rows.filter((row) => row.id !== command.id);
  const replacement = { id: command.id, values: command.values };
  if (operation === 'create') return [...rows, replacement];
  return rows.map((row) => row.id === command.id ? replacement : row);
}

/** Recomputed from current validated records; no cached model-generated values. */
export function calculateMetrics(definition: unknown, input: unknown): Record<string, number> {
  const app = BobAppDefinitionSchema.parse(definition);
  const state = parseState(app, input);
  return Object.fromEntries(app.metrics.map((metric) => {
    const rows = state[metric.table] ?? [];
    if (metric.operation === 'count') return [metric.id, rows.length];
    const total = rows.reduce((sum, row) => sum + Number(row.values[metric.field]), 0);
    return [metric.id, total];
  }));
}
