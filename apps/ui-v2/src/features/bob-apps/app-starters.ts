import type { AppDefinition } from './bob-apps-api';
export function starterApp(kind: 'checklist' | 'budget' | 'tasks'): AppDefinition {
  const budget = kind === 'budget';
  const table = kind === 'tasks' ? 'tasks' : 'items';
  return {
    schemaVersion: 1, title: budget ? 'Budget dashboard' : kind === 'tasks' ? 'Tasks dashboard' : 'My checklist', lifecycle: 'keep',
    tables: [{ id: table, fields: [{ id: 'title', type: 'text' }, budget ? { id: 'amount', type: 'number' } : { id: 'completed', type: 'boolean' }] }],
    actions: ['create', 'update', 'delete'].map((operation) => ({ id: operation, table, operation: operation as 'create' | 'update' | 'delete' })),
    metrics: [{ id: 'items', table, operation: 'count' }, ...(budget ? [{ id: 'total', table, operation: 'sum' as const, field: 'amount' }] : [])],
    views: [
      { id: 'records', kind: budget ? 'table' : 'checklist', title: budget ? 'Expenses' : 'Checklist', table, fields: budget ? ['title', 'amount'] : ['title', 'completed'], actions: ['create', 'update', 'delete'] },
      { id: 'dashboard', kind: 'dashboard', title: 'Dashboard', metrics: budget ? ['items', 'total'] : ['items'] },
      { id: 'slides', kind: 'slides', title: 'Presentation', slides: [{ title: 'At a glance', body: 'These numbers come from your saved records.', metrics: budget ? ['items', 'total'] : ['items'] }, { title: 'Next steps', body: 'Ask Bob to add your story or change this presentation.', metrics: [] }] },
    ],
  };
}
export function fieldLabel(id: string): string { return id.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase()); }
/** A saved value as people read it, in the device's own number format. */
export function cellText(value: string | number | boolean | undefined): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return typeof value === 'number' ? value.toLocaleString(navigator.language) : String(value ?? '');
}
