// Typed client for GET /api/search (014, S14; CU-SEARCH-1). Follows the
// memory-api.ts / google-accounts-api.ts precedent: every call goes through
// fetchWithAuth, so a 401 refreshes the session once, as elsewhere.

import { fetchWithAuth } from '@/lib/auth/use-session';

export type SearchResourceType = 'task' | 'note' | 'event' | 'thread';

export type SearchResult = {
  resource_type: SearchResourceType;
  resource_id: string;
  space_id: string;
  title: string;
  snippet: string;
  updated_at: number;
  rank: number;
};

type SearchOptions = {
  spaceId?: string;
  types?: SearchResourceType[];
  limit?: number;
  signal?: AbortSignal;
};

const QUERY_MAX_LENGTH = 200;

export async function searchResources(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const q = query.trim().slice(0, QUERY_MAX_LENGTH);
  if (q.length === 0) return [];
  const params = new URLSearchParams();
  params.set('q', q);
  if (options.spaceId) params.set('space_id', options.spaceId);
  for (const type of options.types ?? []) params.append('type', type);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const response = await fetchWithAuth(`/api/search?${params}`, { signal: options.signal });
  if (!response.ok) throw new Error('search_failed');
  const body = (await response.json()) as { results: SearchResult[] };
  return body.results;
}
