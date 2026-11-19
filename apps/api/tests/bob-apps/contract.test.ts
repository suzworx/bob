import { describe, expect, it } from 'vitest';
import { BobAppDefinitionSchema } from '../../src/bob-apps/schemas.ts';
import { applyRecordAction, calculateMetrics } from '../../src/bob-apps/records.ts';
import { budget, packing, presentation, dashboard } from './fixtures.ts';

describe('Bob App local JSON contract', () => {
  it('accepts the four synthetic app shapes and rejects executable or authority fields', () => {
    for (const fixture of [packing, budget, dashboard, presentation]) {
      expect(BobAppDefinitionSchema.safeParse(fixture).success).toBe(true);
    }
    for (const extra of [{ ownerId: 'forged' }, { script: 'alert(1)' }, { permissions: ['network'] }]) {
      expect(BobAppDefinitionSchema.safeParse({ ...packing, ...extra }).success).toBe(false);
    }
  });

  it('recomputes budget totals after a declared local write without mutating prior state', () => {
    const before = { expenses: [{ id: 'meal', values: { label: 'Meal', cost: 20 } }] };
    const after = applyRecordAction(budget, before, { operation: 'write', action: 'add', id: 'train', values: { label: 'Train', cost: 35 } });
    expect(calculateMetrics(budget, before)).toEqual({ total: 20 });
    expect(calculateMetrics(budget, after)).toEqual({ total: 55 });
    expect(before.expenses).toHaveLength(1);
    expect(calculateMetrics(dashboard, after)).toEqual({ total: 55 });
    expect(calculateMetrics(presentation, after)).toEqual({ total: 55 });
  });

  it('rejects broken, duplicate and incompatible references', () => {
    const invalid = [
      { ...packing, schemaVersion: 2 },
      { ...packing, tables: [...packing.tables, ...packing.tables] },
      { ...packing, actions: [{ id: 'add', table: 'other', operation: 'create' }] },
      { ...packing, metrics: [{ id: 'total', table: 'items', operation: 'sum', field: 'label' }] },
      { ...budget, views: [{ id: 'bad', kind: 'dashboard', title: 'Missing', metrics: ['missing'] }] },
      { ...budget, views: [{ id: 'bad', kind: 'slides', title: 'Missing', slides: [{ title: 'A', body: '', metrics: ['missing'] }] }] },
      { ...packing, views: [{ ...packing.views[0], fields: ['unknown'] }] },
      { ...packing, tables: [...packing.tables, { id: 'other', fields: [{ id: 'label', type: 'text' }] }], actions: [{ id: 'add', table: 'other', operation: 'create' }] },
      { ...packing, tables: [{ id: 'constructor', fields: [{ id: 'value', type: 'number' }] }] },
    ];
    for (const value of invalid) expect(BobAppDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it('supports checklist replacement and deletion with strict declared actions', () => {
    const initial = { items: [{ id: 'socks', values: { label: 'Socks', packed: false } }] };
    const updated = applyRecordAction(packing, initial, { operation: 'write', action: 'edit', id: 'socks', values: { label: 'Socks', packed: true } });
    expect(updated.items).toEqual([{ id: 'socks', values: { label: 'Socks', packed: true } }]);
    expect(initial.items[0]?.values.packed).toBe(false);
    const removed = applyRecordAction(packing, updated, { operation: 'delete', action: 'remove', id: 'socks' });
    expect(calculateMetrics(packing, removed)).toEqual({ count: 0 });
    expect(() => applyRecordAction(packing, initial, { operation: 'delete', action: 'edit', id: 'socks' })).toThrow();
  });

  it('rejects invalid writes atomically without silently dropping data', () => {
    const initial = { items: [{ id: 'socks', values: { label: 'Socks', packed: false } }] };
    for (const command of [
      { operation: 'write', action: 'add', id: 'socks', values: { label: 'Duplicate', packed: true } },
      { operation: 'write', action: 'edit', id: 'missing', values: { label: 'Missing', packed: false } },
      { operation: 'write', action: 'edit', id: 'socks', values: { label: 'Incomplete' } },
      { operation: 'write', action: 'edit', id: 'socks', values: { label: 'Wrong type', packed: 'yes' } },
      { operation: 'write', action: 'edit', id: 'socks', values: { label: 'Extra', packed: true, extra: 1 } },
      { operation: 'delete', action: 'undeclared', id: 'socks' },
    ]) expect(() => applyRecordAction(packing, initial, command)).toThrow();
    expect(initial.items).toEqual([{ id: 'socks', values: { label: 'Socks', packed: false } }]);
  });

  it('keeps checklist order when updating a row and appends new rows', () => {
    const initial = { items: [
      { id: 'socks', values: { label: 'Socks', packed: false } },
      { id: 'hat', values: { label: 'Hat', packed: false } },
    ] };
    const updated = applyRecordAction(packing, initial, { operation: 'write', action: 'edit', id: 'socks', values: { label: 'Socks', packed: true } });
    expect(updated.items?.map((row) => row.id)).toEqual(['socks', 'hat']);
    expect(updated.items?.[0]?.values.packed).toBe(true);
    const added = applyRecordAction(packing, updated, { operation: 'write', action: 'add', id: 'coat', values: { label: 'Coat', packed: false } });
    expect(added.items?.map((row) => row.id)).toEqual(['socks', 'hat', 'coat']);
    expect(initial.items[0]?.values.packed).toBe(false);
  });

  it('bounds records, values and aggregate serialized bytes', () => {
    const row = { id: 'one', values: { label: 'One', cost: 1 } };
    for (const state of [
      { other: [row] }, { expenses: [row, row] },
      { expenses: [{ ...row, values: { label: 'a'.repeat(2001), cost: 1 } }] },
      { expenses: [{ ...row, values: { label: 'One', cost: Infinity } }] },
      { expenses: [{ ...row, values: { label: 'One', cost: 1e13 } }] },
      { expenses: Array.from({ length: 501 }, (_, i) => ({ ...row, id: `row${i}` })) },
      { expenses: Array.from({ length: 500 }, (_, i) => ({ id: `row${i}`, values: { label: 'x'.repeat(2000), cost: 1 } })) },
    ]) expect(() => calculateMetrics(budget, state)).toThrow();
  });

  it('keeps hostile-looking record text inert and rejects prototype keys', () => {
    const text = '<script>fetch("https://example.invalid")</script>';
    const state = applyRecordAction(budget, {}, { operation: 'write', action: 'add', id: 'text', values: { label: text, cost: 3 } });
    expect(state.expenses?.[0]?.values.label).toBe(text);
    expect(calculateMetrics(budget, state)).toEqual({ total: 3 });
    expect(() => calculateMetrics(budget, JSON.parse('{"__proto__":[]}'))).toThrow();
    expect(() => applyRecordAction(budget, {}, JSON.parse('{"operation":"write","action":"add","id":"unsafe","values":{"label":"One","cost":1,"__proto__":{}}}'))).toThrow();
  });
});
