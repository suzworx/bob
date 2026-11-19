import { expect, it } from 'vitest';
import { appResponseSchema, appsResponseSchema } from './app-schemas';
import { starterApp } from './app-starters';

const summary = {
  id: '00000000-0000-4000-8000-000000000001',
  installationId: '00000000-0000-4000-8000-000000000002',
  spaceId: '00000000-0000-4000-8000-000000000003',
  canManage: false, revision: 1, lifecycle: 'paused', title: 'Team checklist', createdAt: 1, updatedAt: 2,
};
const detail = { ...summary, definition: starterApp('checklist'), state: {}, metrics: {}, pendingDefinition: null, canUndo: false };
const { title: _title, ...app } = detail;

it('reads an installation-owned paused group app without inventing manager access', () => {
  expect(appsResponseSchema.parse({ apps: [summary], nextCursor: null }).apps[0]).toEqual(summary);
  expect(appResponseSchema.parse({ app }).app).toEqual(app);
  expect(appResponseSchema.parse({ app: { ...app, spaceId: null, canManage: true } }).app.spaceId).toBeNull();
});

it('rejects unknown fields and missing or malformed audience permissions', () => {
  expect(appResponseSchema.safeParse({ app: { ...app, owner: true } }).success).toBe(false);
  for (const field of ['installationId', 'spaceId', 'canManage']) {
    const missing: Record<string, unknown> = { ...app };
    delete missing[field];
    expect(appResponseSchema.safeParse({ app: missing }).success, field).toBe(false);
  }
  expect(appResponseSchema.safeParse({ app: { ...app, spaceId: 'someone' } }).success).toBe(false);
  expect(appResponseSchema.safeParse({ app: { ...app, canManage: 'true' } }).success).toBe(false);
});
