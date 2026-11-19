import { z } from 'zod';
import { fetchWithAuth } from '@/lib/auth/use-session';
const scopeRef = z.object({ scope: z.enum(['account', 'integration', 'space', 'conversation']), scopeId: z.string() });
const catalog = z.object({ scope: scopeRef, canEdit: z.boolean(), tools: z.array(z.object({
  id: z.string(), toolName: z.string(), name: z.string(), description: z.string(), group: z.string(),
  integrationKind: z.literal('google').nullable(), availability: z.enum(['context_dependent', 'unavailable']),
  enabled: z.boolean(), preference: z.boolean().nullable(), blockedBy: z.array(scopeRef),
})) });
export type ToolCatalog = z.infer<typeof catalog>;
export type ToolEntry = ToolCatalog['tools'][number];
export interface ToolContext { integrationId?: string; spaceId?: string; conversationId?: string }
export async function getTools(context: ToolContext, signal?: AbortSignal): Promise<ToolCatalog> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(context)) if (value) query.set(key, value);
  const response = await fetchWithAuth(`/api/tools${query.size ? `?${query}` : ''}`, { signal });
  if (!response.ok) throw new Error('tools_unavailable');
  return catalog.parse(await response.json());
}
export async function setTool(scope: ToolCatalog['scope'], toolId: string, enabled: boolean | null, signal?: AbortSignal): Promise<void> {
  const response = await fetchWithAuth('/api/tools/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scope, toolId, enabled }), signal });
  if (!response.ok) throw new Error('tools_save_failed');
  catalog.parse(await response.json());
  window.dispatchEvent(new Event('bob:tool-preferences-changed'));
}
