import { z } from 'zod';
import { fetchWithAuth } from '@/lib/auth/use-session';

export const INSIGHT_CATEGORIES = ['future', 'reflections', 'past'] as const;
export type InsightCategory = typeof INSIGHT_CATEGORIES[number];
const sourceSchema = z.object({ kind: z.enum(['gmail', 'calendar']), id: z.string(), label: z.string(), url: z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}).optional() });
const insightSchema = z.object({ id: z.string(), routineId: z.string().nullable(), googleAccountId: z.string(), category: z.enum(INSIGHT_CATEGORIES), title: z.string(), summary: z.string(), periodStart: z.number(), periodEnd: z.number(), generatedAt: z.number(), sources: z.array(sourceSchema), partial: z.boolean(), messageCount: z.number().int().nonnegative() });
export type Insight = z.infer<typeof insightSchema>;

export async function listInsights(category: InsightCategory): Promise<Insight[]> {
  const response = await fetchWithAuth(`/api/insights?category=${category}`);
  if (!response.ok) throw new Error('insights_unavailable');
  return z.object({ insights: z.array(insightSchema) }).parse(await response.json()).insights;
}

export async function refreshInsights(googleAccountId: string, category: 'future' | 'reflections'): Promise<Insight[]> {
  const response = await fetchWithAuth('/api/insights/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ googleAccountId: z.uuid().parse(googleAccountId), category }),
  });
  if (!response.ok) {
    const result = z.object({ error: z.object({ code: z.string() }) }).safeParse(await response.json().catch(() => null));
    throw new Error(result.success && result.data.error.code === 'insight_no_selected_calendars' ? 'insight_no_selected_calendars' : 'insights_refresh_failed');
  }
  return z.object({ insights: z.array(insightSchema) }).parse(await response.json()).insights;
}
