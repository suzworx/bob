import { z } from 'zod';
import { appDefinitionSchema as BobAppDefinitionSchema, appResponseSchema as BobAppResponseSchema, appsResponseSchema as BobAppsResponseSchema, appExportSchema as BobAppExportSchema, appCommandSchema as RecordCommandSchema, appRecordsSchema as RecordStateSchema } from './app-schemas';
import { fetchWithAuth } from '@/lib/auth/use-session';
export type AppDefinition = z.infer<typeof BobAppDefinitionSchema>;
export type AppRecords = z.infer<typeof RecordStateSchema>;
export type AppCommand = z.infer<typeof RecordCommandSchema>;
export type BobApp = z.infer<typeof BobAppResponseSchema>['app'];
export class AppRequestError extends Error {
  constructor(readonly status: number) { super('app_request_failed'); }
}
async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<Response> {
  const response = await fetchWithAuth(`/api/bob-apps${path}`, { method, ...(signal ? { signal } : {}), ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new AppRequestError(response.status);
  return response;
}
export async function listApps(cursor?: string, spaceId?: string | null): Promise<z.infer<typeof BobAppsResponseSchema>> {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  if (spaceId) query.set('spaceId', spaceId);
  return BobAppsResponseSchema.parse(await (await request(query.size ? `?${query}` : '')).json());
}
export async function openAppConversation(appId: string): Promise<{ conversationId: string; spaceId: string }> {
  return z.strictObject({ conversationId: z.string().min(1).max(64), spaceId: z.uuid() }).parse(await (await request(`/${encodeURIComponent(appId)}/conversation`, 'POST')).json());
}
export async function getApp(id: string, signal?: AbortSignal): Promise<BobApp> { return BobAppResponseSchema.parse(await (await request(`/${encodeURIComponent(id)}`, 'GET', undefined, signal)).json()).app; }
export async function createApp(definition: AppDefinition, spaceId?: string | null): Promise<BobApp> {
  return BobAppResponseSchema.parse(await (await request('', 'POST', { definition, mutationId: crypto.randomUUID(), ...(spaceId ? { spaceId } : {}) })).json()).app;
}
export async function changeApp(app: BobApp, operation: 'activate' | 'pause' | 'resume' | 'archive' | 'restore' | 'apply_revision' | 'undo' | 'duplicate', mutationId: string = crypto.randomUUID()): Promise<BobApp> {
  return BobAppResponseSchema.parse(await (await request(`/${app.id}`, 'PATCH', { operation, expectedRevision: app.revision, mutationId })).json()).app;
}
export async function actOnApp(app: BobApp, command: AppCommand): Promise<BobApp> {
  return BobAppResponseSchema.parse(await (await request(`/${app.id}/actions`, 'POST', { command, expectedRevision: app.revision, mutationId: crypto.randomUUID() })).json()).app;
}
export async function deleteApp(app: BobApp): Promise<void> { await request(`/${app.id}`, 'DELETE', { expectedRevision: app.revision, mutationId: crypto.randomUUID() }); }
export async function exportApp(app: BobApp): Promise<void> {
  const data = BobAppExportSchema.parse(await (await request(`/${app.id}/export`)).json());
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'bob-app.json'; link.click(); URL.revokeObjectURL(url);
}
