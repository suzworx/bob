import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskItems } from './use-task-items';
import type { TaskSummary } from './use-tasks';

vi.mock('../../lib/auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

const TASK_ID = 'task_root';

const ITEM_1: TaskSummary = {
  id: 'item_1',
  space_id: 'spc_1',
  parent_task_id: TASK_ID,
  title: 'Buy milk',
  body: null,
  status: 'open',
  assignee_user_id: null,
  due: null,
  order_key: 'a',
  revision: 2,
  created_by: 'usr_1',
  completed_at: null,
  completed_by: null,
  trashed_at: null,
  created_at: 1756100000000,
  updated_at: 1756100000000,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routes = {};
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    routes[`${init?.method ?? 'GET'} ${String(input)}`]?.(init) ?? json(404, {}),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function ready(taskId = TASK_ID) {
  const rendered = renderHook(() => useTaskItems(taskId));
  await waitFor(() => expect(rendered.result.current.loading).toBe(false));
  return rendered;
}

describe('useTaskItems', () => {
  it('loads items from /api/tasks/task_root/items', async () => {
    routes[`GET /api/tasks/${TASK_ID}/items`] = () => json(200, { items: [ITEM_1] });
    const { result } = await ready();
    expect(result.current.items).toEqual([ITEM_1]);
    expect(result.current.error).toBeNull();
  });

  it('a load failure sets the load error', async () => {
    routes[`GET /api/tasks/${TASK_ID}/items`] = () => json(500, {});
    const { result } = await ready();
    expect(result.current.items).toEqual([]);
    expect(result.current.error).toBe('The checklist could not be loaded.');
  });

  it('addItem posts the trimmed title and appends the reply', async () => {
    routes[`GET /api/tasks/${TASK_ID}/items`] = () => json(200, { items: [] });
    const created = { ...ITEM_1, id: 'item_2', title: 'step one' };
    routes[`POST /api/tasks/${TASK_ID}/items`] = () => json(201, created);
    const { result } = await ready();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.addItem('  step one ');
    });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${TASK_ID}/items`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ title: 'step one' }) }),
    );
    expect(result.current.items).toEqual([created]);
  });

  it('addItem with a blank title sends nothing', async () => {
    routes[`GET /api/tasks/${TASK_ID}/items`] = () => json(200, { items: [] });
    const { result } = await ready();
    fetchMock.mockClear();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.addItem('   ');
    });
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('toggleItem sends the revision and status and adopts the reply', async () => {
    routes[`GET /api/tasks/${TASK_ID}/items`] = () => json(200, { items: [ITEM_1] });
    const updated = { ...ITEM_1, status: 'completed' as const, revision: 3 };
    routes[`PATCH /api/tasks/${ITEM_1.id}`] = () => json(200, updated);
    const { result } = await ready();
    await act(async () => {
      await result.current.toggleItem(ITEM_1);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${ITEM_1.id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ revision: 2, status: 'completed' }),
      }),
    );
    expect(result.current.items).toEqual([updated]);
  });

  it('toggleItem on a 409 reloads the items and sets the conflict copy', async () => {
    let getCalls = 0;
    routes[`GET /api/tasks/${TASK_ID}/items`] = () => {
      getCalls += 1;
      return json(200, { items: [ITEM_1] });
    };
    routes[`PATCH /api/tasks/${ITEM_1.id}`] = () =>
      json(409, { error: { current_revision: 9, message: 'conflict' } });
    const { result } = await ready();
    await act(async () => {
      await result.current.toggleItem(ITEM_1);
    });
    await waitFor(() => expect(getCalls).toBe(2));
    expect(result.current.error).toBe('This checklist changed elsewhere. It has been refreshed.');
  });

  it('toggleItem on a 500 puts the item back and sets the update error', async () => {
    routes[`GET /api/tasks/${TASK_ID}/items`] = () => json(200, { items: [ITEM_1] });
    routes[`PATCH /api/tasks/${ITEM_1.id}`] = () => json(500, {});
    const { result } = await ready();
    await act(async () => {
      await result.current.toggleItem(ITEM_1);
    });
    expect(result.current.items).toEqual([ITEM_1]);
    expect(result.current.error).toBe('The item could not be updated.');
  });

  it('removeItem sends DELETE and returns true on 204', async () => {
    routes[`GET /api/tasks/${TASK_ID}/items`] = () => json(200, { items: [ITEM_1] });
    routes[`DELETE /api/tasks/${ITEM_1.id}`] = () => new Response(null, { status: 204 });
    const { result } = await ready();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.removeItem(ITEM_1);
    });
    expect(ok).toBe(true);
    expect(result.current.items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${ITEM_1.id}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('removeItem on a 500 puts the item back at its index with the remove error', async () => {
    const item2 = { ...ITEM_1, id: 'item_2', order_key: 'b' };
    routes[`GET /api/tasks/${TASK_ID}/items`] = () => json(200, { items: [ITEM_1, item2] });
    routes[`DELETE /api/tasks/${ITEM_1.id}`] = () => json(500, {});
    const { result } = await ready();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.removeItem(ITEM_1);
    });
    expect(ok).toBe(false);
    expect(result.current.items).toEqual([ITEM_1, item2]);
    expect(result.current.error).toBe('The item could not be removed.');
  });
});
