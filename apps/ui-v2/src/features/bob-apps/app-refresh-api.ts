import { z } from 'zod';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { AppRequestError, type BobApp } from './bob-apps-api';
const refreshConfig = z.object({ source: z.literal('tasks'), spaceId: z.uuid(), targetTable: z.string(), schedule: z.object({ weekdays: z.array(z.number().int().min(1).max(7)), localTime: z.string(), timeZone: z.string() }) });
const refreshSchema = z.object({ enabled: z.boolean(), config: refreshConfig.nullable(), nextRunAt: z.number().nullable(), lastRefreshAt: z.number().nullable(), lastError: z.string().nullable() });
const runsSchema = z.object({ runs: z.array(z.object({ id: z.string(), status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']), scheduledAt: z.number(), completedAt: z.number().nullable(), failureCode: z.string().nullable() })) });
export type RefreshState = z.infer<typeof refreshSchema>;
export type RefreshConfig = z.infer<typeof refreshConfig>;
export type AppRun = z.infer<typeof runsSchema>['runs'][number];
export async function getRefresh(appId: string): Promise<RefreshState> {
  const response = await fetchWithAuth(`/api/bob-apps/${appId}/refresh`);
  if (!response.ok) throw new AppRequestError(response.status);
  return refreshSchema.parse(await response.json());
}
export async function getRuns(appId: string): Promise<AppRun[]> {
  const response = await fetchWithAuth(`/api/bob-apps/${appId}/runs`);
  if (!response.ok) throw new AppRequestError(response.status);
  return runsSchema.parse(await response.json()).runs;
}
export async function saveRefresh(app: BobApp, enabled: boolean, config: RefreshConfig | null): Promise<void> {
  const response = await fetchWithAuth(`/api/bob-apps/${app.id}/refresh`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: app.revision, mutationId: crypto.randomUUID(), enabled, consent: true, config }) });
  if (!response.ok) throw new AppRequestError(response.status);
}
