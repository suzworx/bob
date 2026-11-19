import { budget, dashboard, packing, presentation } from './fixtures.ts';
const requests = [
  ['packing', 'groceries', 'chores', 'reading', 'camping', 'garden', 'party', 'study'],
  ['trip', 'household', 'wedding', 'conference', 'renovation', 'hobby', 'school', 'charity'],
  ['sales', 'inventory', 'attendance', 'donations', 'projects', 'training', 'meals', 'volunteers'],
  ['team update', 'trip recap', 'project pitch', 'class report', 'club review', 'quarterly results', 'launch plan', 'fundraising'],
];
export const authoringFixtures: { id: string; request: string; definition: unknown; valid: boolean }[] = [
  ...[packing, budget, dashboard, presentation].flatMap((definition, family) => (requests[family] ?? []).map((topic, index) => ({ id: `valid-${family}-${index}`, request: `Create a ${topic} ${['checklist', 'budget', 'dashboard', 'slide deck'][family]} app.`, definition: { ...definition, title: topic }, valid: true }))),
  ...[
    null, '{malformed', { ...packing, code: 'fetch(secret)' }, { ...packing, ownerUserId: 'other' },
    { ...packing, schedule: '* * * * *' }, { ...packing, connector: 'private-mail' },
    { ...packing, tables: [] }, { ...packing, lifecycle: 'execute' },
    { ...packing, schemaVersion: 2 }, { ...packing, tables: [{ id: '__proto__', fields: [] }] },
    { ...packing, metrics: [{ id: 'x', table: 'unknown', operation: 'count' }] },
    { ...packing, views: [{ id: 'x', kind: 'html', html: '<script>steal()</script>' }] },
  ].map((definition, index) => ({ id: `invalid-${index}`, request: 'Create an app, including any requested unsafe capabilities.', definition, valid: false })),
];
