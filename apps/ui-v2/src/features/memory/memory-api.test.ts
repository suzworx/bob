import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

import {
  MemoryUnavailableError,
  SecretRefusedError,
  correctMemory,
  createMemory,
  deleteAllMemories,
  deleteMemory,
  listMemories,
  listMoreMemories,
  promoteToTask,
  setActionItemStatus,
  type ActionItem,
  type Memory,
} from './memory-api';

const MEMORY: Memory = {
  id: 'mem_1',
  kind: 'fact',
  content: 'Likes oat milk',
  confidence: 0.9,
  sensitive: false,
  source: { conversation_id: 'cnv_1', message_id: 'msg_1', surface: 'web_text' },
  superseded_by: null,
  created_at: 1756100000000,
  updated_at: 1756100000000,
};

const ITEM: ActionItem = {
  id: 'act_1',
  memory_id: 'mem_2',
  content: 'Call the dentist',
  confidence: 0.8,
  status: 'open',
  due_at: null,
  created_at: 1756100000000,
  updated_at: 1756100000000,
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

describe('listMemories', () => {
  it('fetches memories only (action items live on Today) and maps the cursor', async () => {
    fetchWithAuth.mockResolvedValue(json(200, { memories: [MEMORY], next_cursor: 'cur_2' }));
    await expect(listMemories()).resolves.toEqual({ memories: [MEMORY], nextCursor: 'cur_2' });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/memories');
  });

  it('searches on the server with q', async () => {
    fetchWithAuth.mockResolvedValue(json(200, { memories: [], next_cursor: null }));
    await listMemories('  oat milk ');
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/memories?q=oat+milk');
  });

  it('throws MemoryUnavailableError on a 503', async () => {
    fetchWithAuth.mockResolvedValue(json(503, { error: { code: 'memory_unavailable' } }));
    await expect(listMemories()).rejects.toBeInstanceOf(MemoryUnavailableError);
  });

  it('throws a plain error for any other failure', async () => {
    fetchWithAuth.mockResolvedValue(json(500, {}));
    const error: unknown = await listMemories().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MemoryUnavailableError);
  });
});

describe('listMoreMemories', () => {
  it('sends the cursor encoded, with the search, and returns the next page', async () => {
    fetchWithAuth.mockResolvedValue(json(200, { memories: [MEMORY], next_cursor: null }));
    await expect(listMoreMemories('a b&c', 'tea')).resolves.toEqual({ memories: [MEMORY], nextCursor: null });
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/memories?cursor=a+b%26c&q=tea');
  });

  it('throws when the page cannot be loaded', async () => {
    fetchWithAuth.mockResolvedValue(json(500, {}));
    await expect(listMoreMemories('cur')).rejects.toThrow('load_more_failed');
  });
});

describe('promoteToTask', () => {
  it('sends the space, title and the due date', async () => {
    fetchWithAuth.mockResolvedValue(json(201, { id: 'tsk_1' }));
    await expect(promoteToTask('mem_2', { spaceId: 'spc', title: 'Call', dueAt: 1756600000000 })).resolves.toEqual({ id: 'tsk_1' });
    expect(fetchWithAuth).toHaveBeenCalledWith(
      '/api/memories/mem_2/promote',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ space_id: 'spc', title: 'Call', due_at: 1756600000000 }) }),
    );
  });

  it('leaves due_at out when the item has none', async () => {
    fetchWithAuth.mockResolvedValue(json(201, { id: 'tsk_1' }));
    await promoteToTask('mem_2', { spaceId: 'spc', title: 'Call', dueAt: null });
    expect(fetchWithAuth.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ space_id: 'spc', title: 'Call' }));
  });
});

describe('createMemory', () => {
  it('POSTs the content and kind and returns the created memory', async () => {
    fetchWithAuth.mockResolvedValue(json(201, MEMORY));
    await expect(createMemory('Likes oat milk', 'fact')).resolves.toEqual(MEMORY);
    expect(fetchWithAuth).toHaveBeenCalledWith(
      '/api/memories',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Likes oat milk', kind: 'fact' }),
      }),
    );
  });

  it('throws SecretRefusedError on a 422 secret_refused', async () => {
    fetchWithAuth.mockResolvedValue(json(422, { error: { code: 'secret_refused' } }));
    await expect(createMemory('hunter2', 'fact')).rejects.toBeInstanceOf(SecretRefusedError);
  });

  it('throws a plain error for any other failure', async () => {
    fetchWithAuth.mockResolvedValue(json(500, {}));
    const error: unknown = await createMemory('x', 'fact').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SecretRefusedError);
    expect((error as Error).message).toBe('create_failed');
  });
});

describe('correctMemory', () => {
  it('PATCHes the content and returns the updated memory', async () => {
    const updated = { ...MEMORY, content: 'Likes soy milk' };
    fetchWithAuth.mockResolvedValue(json(200, updated));
    await expect(correctMemory('mem_1', 'Likes soy milk')).resolves.toEqual(updated);
    expect(fetchWithAuth).toHaveBeenCalledWith(
      '/api/memories/mem_1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ content: 'Likes soy milk' }) }),
    );
  });

  it('throws on a non-2xx answer', async () => {
    fetchWithAuth.mockResolvedValue(json(400, {}));
    await expect(correctMemory('mem_1', 'x')).rejects.toThrow('correct_failed');
  });

  it('throws SecretRefusedError on a 422 secret_refused', async () => {
    fetchWithAuth.mockResolvedValue(json(422, { error: { code: 'secret_refused' } }));
    await expect(correctMemory('mem_1', 'hunter2')).rejects.toBeInstanceOf(SecretRefusedError);
  });
});

describe('deleteMemory and deleteAllMemories', () => {
  it('DELETE one memory expects a 204', async () => {
    fetchWithAuth.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(deleteMemory('mem_1')).resolves.toBeUndefined();
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/memories/mem_1', { method: 'DELETE' });
  });

  it('treats any other status as a failed delete', async () => {
    fetchWithAuth.mockResolvedValue(json(200, {}));
    await expect(deleteMemory('mem_1')).rejects.toThrow('delete_failed');
    await expect(deleteAllMemories()).rejects.toThrow('delete_all_failed');
  });

  it('DELETE all hits the collection', async () => {
    fetchWithAuth.mockResolvedValue(new Response(null, { status: 204 }));
    await deleteAllMemories();
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/memories', { method: 'DELETE' });
  });
});

describe('setActionItemStatus', () => {
  it('PATCHes the status and returns the updated item', async () => {
    const done = { ...ITEM, status: 'done' as const };
    fetchWithAuth.mockResolvedValue(json(200, done));
    await expect(setActionItemStatus('act_1', 'done')).resolves.toEqual(done);
    expect(fetchWithAuth).toHaveBeenCalledWith(
      '/api/action-items/act_1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ status: 'done' }) }),
    );
  });

  it('throws on a non-2xx answer', async () => {
    fetchWithAuth.mockResolvedValue(json(500, {}));
    await expect(setActionItemStatus('act_1', 'open')).rejects.toThrow('action_update_failed');
  });
});
