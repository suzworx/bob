import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

import { searchResources, type SearchResult } from './search-api';

const RESULT: SearchResult = {
  resource_type: 'task',
  resource_id: 'tsk_1',
  space_id: 'spc_1',
  title: 'Buy milk',
  snippet: 'Buy milk before Friday',
  updated_at: 1756100000000,
  rank: 1,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('searchResources', () => {
  it('trims the query and returns the results', async () => {
    fetchWithAuth.mockResolvedValue(json(200, { results: [RESULT] }));
    await expect(searchResources('  milk ', { limit: 20 })).resolves.toEqual([RESULT]);
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/search?q=milk&limit=20', expect.objectContaining({}));
  });

  it('repeats type once per entry and adds space_id', async () => {
    fetchWithAuth.mockResolvedValue(json(200, { results: [] }));
    await searchResources('milk', { types: ['task', 'note'], spaceId: 'spc_1' });
    expect(fetchWithAuth).toHaveBeenCalledWith(
      '/api/search?q=milk&space_id=spc_1&type=task&type=note',
      expect.objectContaining({}),
    );
  });

  it('returns an empty list without fetching for a whitespace-only query', async () => {
    await expect(searchResources('   ')).resolves.toEqual([]);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('throws search_failed on a non-2xx answer', async () => {
    fetchWithAuth.mockResolvedValue(json(500, {}));
    await expect(searchResources('milk')).rejects.toThrow('search_failed');
  });

  it('passes the abort signal through', async () => {
    fetchWithAuth.mockResolvedValue(json(200, { results: [] }));
    const controller = new AbortController();
    await searchResources('milk', { signal: controller.signal });
    expect(fetchWithAuth).toHaveBeenCalledWith(
      '/api/search?q=milk',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
