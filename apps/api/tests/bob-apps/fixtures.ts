export const packing = {
  schemaVersion: 1, title: 'Weekend packing', lifecycle: 'keep',
  tables: [{ id: 'items', fields: [{ id: 'label', type: 'text' }, { id: 'packed', type: 'boolean' }] }],
  actions: [{ id: 'add', table: 'items', operation: 'create' }, { id: 'edit', table: 'items', operation: 'update' }, { id: 'remove', table: 'items', operation: 'delete' }],
  metrics: [{ id: 'count', table: 'items', operation: 'count' }],
  views: [{ id: 'list', kind: 'checklist', title: 'Pack a little joy', table: 'items', fields: ['label', 'packed'], actions: ['add', 'edit', 'remove'] }],
};

export const budget = {
  schemaVersion: 1, title: 'Trip budget', lifecycle: 'keep',
  tables: [{ id: 'expenses', fields: [{ id: 'label', type: 'text' }, { id: 'cost', type: 'number' }] }],
  actions: [{ id: 'add', table: 'expenses', operation: 'create' }],
  metrics: [{ id: 'total', table: 'expenses', operation: 'sum', field: 'cost' }],
  views: [{ id: 'costs', kind: 'table', title: 'Expenses', table: 'expenses', fields: ['label', 'cost'], actions: ['add'] }],
};

export const dashboard = {
  ...budget, title: 'Trip dashboard',
  views: [{ id: 'overview', kind: 'dashboard', title: 'At a glance', metrics: ['total'] }],
};

export const presentation = {
  ...budget, title: 'Trip slides',
  views: [{ id: 'deck', kind: 'slides', title: 'Our weekend', slides: [{ title: 'Budget', body: 'A little adventure.', metrics: ['total'] }] }],
};
