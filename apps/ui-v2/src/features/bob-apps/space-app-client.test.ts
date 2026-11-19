import { expect, it, vi } from 'vitest';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { listApps, createApp, openAppConversation, changeApp } from './bob-apps-api';
import { starterApp } from './app-starters';
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth: vi.fn() }));
const spaceId = '00000000-0000-4000-8000-000000000001';
it('lists only the explicitly requested group audience', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(Response.json({ apps: [], nextCursor: null }));
  await listApps(undefined, spaceId);
  expect(fetchWithAuth).toHaveBeenLastCalledWith(`/api/bob-apps?spaceId=${spaceId}`, expect.anything());
});
it('creates draft work with explicit audience and opens a server-owned group conversation', async () => {
  const app = { id: spaceId, installationId: spaceId, spaceId, canManage: false, revision: 1, lifecycle: 'draft', definition: starterApp('checklist'), state: {}, metrics: {}, pendingDefinition: null, canUndo: false, createdAt: 1, updatedAt: 1 };
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(Response.json({ app })).mockResolvedValueOnce(Response.json({ conversationId: spaceId, spaceId }));
  await createApp(app.definition, spaceId);
  expect(JSON.parse(String(vi.mocked(fetchWithAuth).mock.calls.at(-1)?.[1]?.body))).toMatchObject({ spaceId });
  expect(await openAppConversation(app.id)).toEqual({ conversationId: spaceId, spaceId });
  expect(fetchWithAuth).toHaveBeenLastCalledWith(`/api/bob-apps/${app.id}/conversation`, { method: 'POST' });
});
it('retries an explicit app acceptance with its original mutation identity', async () => {
  const app = { id: spaceId, installationId: spaceId, spaceId: null, canManage: true, revision: 1, lifecycle: 'draft' as const, definition: starterApp('checklist'), state: {}, metrics: {}, pendingDefinition: null, canUndo: false, createdAt: 1, updatedAt: 1 };
  const mutationId = '00000000-0000-4000-8000-000000000002';
  vi.mocked(fetchWithAuth).mockImplementation(async () => Response.json({ app: { ...app, revision: 2, lifecycle: 'active' } }));
  await changeApp(app, 'activate', mutationId);
  await changeApp(app, 'activate', mutationId);
  const attempts = vi.mocked(fetchWithAuth).mock.calls.slice(-2).map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
  expect(attempts).toEqual([
    { operation: 'activate', expectedRevision: 1, mutationId },
    { operation: 'activate', expectedRevision: 1, mutationId },
  ]);
});
