import { z } from 'zod';
import { fetchWithAuth } from '@/lib/auth/use-session';
const kindSchema = z.enum(['routine', 'conversation', 'task', 'note', 'event']);
const entrySchema = z.object({ id: z.string(), kind: kindSchema, action: z.enum(['scheduled', 'conversation', 'created', 'completed', 'updated']), title: z.string(), at: z.number(), recordId: z.string(), spaceId: z.string().nullable(), routineId: z.string().nullable(), status: z.string().nullable(), count: z.number() });
const cursorSchema = z.object({ before: z.number(), beforeId: z.string() });
const responseSchema = z.object({ day: z.string(), timeZone: z.string(), entries: z.array(entrySchema), nextCursor: cursorSchema.nullable() });
export type TimelineEntry = z.infer<typeof entrySchema>;
export type TimelineFilter = 'all' | z.infer<typeof kindSchema>;
export type TimelineCursor = z.infer<typeof cursorSchema>;
export type TimelineResponse = z.infer<typeof responseSchema>;
export async function listTimeline(day: string, timeZone: string, kind: TimelineFilter, cursor?: TimelineCursor): Promise<TimelineResponse> {
  const params = new URLSearchParams({ day, timeZone, kind, limit: '30' });
  if (cursor) { params.set('before', String(cursor.before)); params.set('beforeId', cursor.beforeId); }
  const response = await fetchWithAuth(`/api/timeline?${params}`);
  if (!response.ok) throw new Error('timeline_unavailable');
  return responseSchema.parse(await response.json());
}
