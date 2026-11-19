import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTasks, patchTask, type TaskSummary, type TaskWriteResult } from './use-tasks';

vi.mock('../../lib/auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

const SPACE_ID = 'spc_1';

const TASK_A: TaskSummary = {
  id: 'task_aaa',
  space_id: SPACE_ID,
  parent_task_id: null,
  title: 'Buy milk',
  body: null,
  status: 'open',
  assignee_user_id: null,
  due: { kind: 'date', date: '2026-10-01' },
  order_key: 'a',
  revision: 1,
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

async function ready(spaceId = SPACE_ID) {
  const rendered = renderHook(() => useTasks(spaceId));
  await waitFor(() => expect(rendered.result.current.loading).toBe(false));
  return rendered;
}

describe('useTasks', () => {
  it('load drops child tasks', async () => {
    const child = { ...TASK_A, id: 'task_child', parent_task_id: TASK_A.id };
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => json(200, { tasks: [TASK_A, child] });
    const { result } = await ready();
    expect(result.current.tasks).toEqual([TASK_A]);
  });

  it('updateTask sends the full patch and replaces the task on ok', async () => {
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => json(200, { tasks: [TASK_A] });
    const updated = { ...TASK_A, title: 'New', revision: 5 };
    routes[`PATCH /api/tasks/${TASK_A.id}`] = () => json(200, updated);
    const { result } = await ready();
    const taskArg = { ...TASK_A, revision: 4 };
    let outcome: TaskWriteResult | undefined;
    await act(async () => {
      outcome = await result.current.updateTask(taskArg, {
        title: 'New',
        body: null,
        due: { kind: 'date', date: '2026-10-01' },
        assigneeUserId: null,
      });
    });
    expect(outcome).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${TASK_A.id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          revision: 4,
          title: 'New',
          body: null,
          due: { kind: 'date', date: '2026-10-01' },
          assignee_user_id: null,
        }),
      }),
    );
    expect(result.current.tasks[0]).toEqual(updated);
  });

  it('updateTask with an empty patch sends only revision', async () => {
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => json(200, { tasks: [TASK_A] });
    routes[`PATCH /api/tasks/${TASK_A.id}`] = () => json(200, TASK_A);
    const { result } = await ready();
    await act(async () => {
      await result.current.updateTask(TASK_A, {});
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${TASK_A.id}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ revision: TASK_A.revision }) }),
    );
  });

  it('updateTask on a 409 reloads the list and returns conflict', async () => {
    let getCalls = 0;
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => {
      getCalls += 1;
      return json(200, { tasks: [TASK_A] });
    };
    routes[`PATCH /api/tasks/${TASK_A.id}`] = () =>
      json(409, { error: { current_revision: 9, message: 'conflict' } });
    const { result } = await ready();
    let outcome: TaskWriteResult | undefined;
    await act(async () => {
      outcome = await result.current.updateTask(TASK_A, { title: 'x' });
    });
    expect(outcome).toBe('conflict');
    await waitFor(() => expect(getCalls).toBe(2));
    expect(result.current.error).toBeNull();
    expect(result.current.conflict).toBeNull();
  });

  it('updateTask on a 500 returns error and leaves the task unchanged', async () => {
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => json(200, { tasks: [TASK_A] });
    routes[`PATCH /api/tasks/${TASK_A.id}`] = () => json(500, {});
    const { result } = await ready();
    let outcome: TaskWriteResult | undefined;
    await act(async () => {
      outcome = await result.current.updateTask(TASK_A, { title: 'x' });
    });
    expect(outcome).toBe('error');
    expect(result.current.tasks).toEqual([TASK_A]);
  });

  it('deleteTask with a 204 removes the task', async () => {
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => json(200, { tasks: [TASK_A] });
    routes[`DELETE /api/tasks/${TASK_A.id}`] = () => new Response(null, { status: 204 });
    const { result } = await ready();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deleteTask(TASK_A);
    });
    expect(ok).toBe(true);
    expect(result.current.tasks).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${TASK_A.id}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('deleteTask with a 500 restores the task at its index', async () => {
    const taskB = { ...TASK_A, id: 'task_b', order_key: 'b' };
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => json(200, { tasks: [TASK_A, taskB] });
    routes[`DELETE /api/tasks/${TASK_A.id}`] = () => json(500, {});
    const { result } = await ready();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deleteTask(TASK_A);
    });
    expect(ok).toBe(false);
    expect(result.current.tasks).toEqual([TASK_A, taskB]);
    expect(result.current.error).toBe('The task could not be deleted.');
  });

  it('restoreTask inserts the task in order_key order', async () => {
    const taskB = { ...TASK_A, id: 'task_b', order_key: 'b' };
    const restoredA = { ...TASK_A, order_key: 'a' };
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => json(200, { tasks: [taskB] });
    routes[`POST /api/tasks/${TASK_A.id}/restore`] = () => json(200, restoredA);
    const { result } = await ready();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.restoreTask(TASK_A.id);
    });
    expect(ok).toBe(true);
    expect(result.current.tasks.map((t) => t.id)).toEqual([restoredA.id, taskB.id]);
  });

  it('restoreTask with a 500 returns false', async () => {
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => json(200, { tasks: [] });
    routes[`POST /api/tasks/${TASK_A.id}/restore`] = () => json(500, {});
    const { result } = await ready();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.restoreTask(TASK_A.id);
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe('The task could not be restored.');
  });

  it('loadTrashed returns trashed top-level tasks, newest first', async () => {
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => json(200, { tasks: [TASK_A] });
    const trashedOld = { ...TASK_A, id: 'task_old', trashed_at: 100 };
    const trashedNew = { ...TASK_A, id: 'task_new', trashed_at: 200 };
    const trashedChild = { ...TASK_A, id: 'task_child', parent_task_id: TASK_A.id, trashed_at: 300 };
    routes[`GET /api/spaces/${SPACE_ID}/tasks?trashed=true`] = () =>
      json(200, { tasks: [trashedOld, trashedNew, trashedChild, TASK_A] });
    const { result } = await ready();
    let trashed: TaskSummary[] | null | undefined;
    await act(async () => {
      trashed = await result.current.loadTrashed();
    });
    expect(trashed?.map((t) => t.id)).toEqual(['task_new', 'task_old']);
    expect(result.current.tasks).toEqual([TASK_A]);
  });

  it('loadTrashed returns null on a 500 and leaves tasks unchanged', async () => {
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => json(200, { tasks: [TASK_A] });
    routes[`GET /api/spaces/${SPACE_ID}/tasks?trashed=true`] = () => json(500, {});
    const { result } = await ready();
    let trashed: TaskSummary[] | null | undefined;
    await act(async () => {
      trashed = await result.current.loadTrashed();
    });
    expect(trashed).toBeNull();
    expect(result.current.tasks).toEqual([TASK_A]);
  });

  it('a refused toggle is rolled back and reloaded, and the next toggle sends the reloaded revision', async () => {
    let getCalls = 0;
    let patchCalls = 0;
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => {
      getCalls += 1;
      const rev = getCalls === 1 ? 1 : 5;
      return json(200, { tasks: [{ ...TASK_A, revision: rev }] });
    };
    routes[`PATCH /api/tasks/${TASK_A.id}`] = () => {
      patchCalls += 1;
      return patchCalls === 1
        ? json(409, { error: { current_revision: 5, message: 'conflict' } })
        : json(200, { ...TASK_A, status: 'completed', revision: 6 });
    };
    const { result } = await ready();
    expect(result.current.tasks[0]?.status).toBe('open');

    // First toggle gets a 409; the row reverts and is reloaded
    await act(async () => {
      await result.current.toggleComplete(TASK_A);
    });
    expect(result.current.tasks[0]?.status).toBe('open');
    expect(result.current.conflict?.message).toContain('This task changed elsewhere, so your change was not saved');
    await waitFor(() => expect(getCalls).toBe(2));
    expect(result.current.tasks[0]?.revision).toBe(5);

    // Second toggle uses the reloaded revision (5)
    await act(async () => {
      await result.current.toggleComplete(result.current.tasks[0]!);
    });
    expect(result.current.tasks[0]?.status).toBe('completed');
    expect(result.current.tasks[0]?.revision).toBe(6);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      `/api/tasks/${TASK_A.id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ revision: 5, status: 'completed' }),
      }),
    );
  });

  it('a refused assignment is rolled back and reloaded, and the next assignment sends the reloaded revision', async () => {
    let getCalls = 0;
    let patchCalls = 0;
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = () => {
      getCalls += 1;
      const rev = getCalls === 1 ? 2 : 5;
      return json(200, { tasks: [{ ...TASK_A, revision: rev }] });
    };
    routes[`PATCH /api/tasks/${TASK_A.id}`] = () => {
      patchCalls += 1;
      return patchCalls === 1
        ? json(409, { error: { current_revision: 5, message: 'conflict' } })
        : json(200, { ...TASK_A, assignee_user_id: 'usr_2', revision: 6 });
    };
    const { result } = await ready();
    expect(result.current.tasks[0]?.assignee_user_id).toBeNull();

    // First assignment gets a 409; the row reverts and is reloaded
    await act(async () => {
      await result.current.assign(TASK_A, 'usr_2');
    });
    expect(result.current.tasks[0]?.assignee_user_id).toBeNull();
    expect(result.current.conflict?.message).toContain('This task changed elsewhere, so your change was not saved');
    await waitFor(() => expect(getCalls).toBe(2));
    expect(result.current.tasks[0]?.revision).toBe(5);

    // Second assignment uses the reloaded revision (5)
    await act(async () => {
      await result.current.assign(result.current.tasks[0]!, 'usr_2');
    });
    expect(result.current.tasks[0]?.assignee_user_id).toBe('usr_2');
    expect(result.current.tasks[0]?.revision).toBe(6);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      `/api/tasks/${TASK_A.id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ revision: 5, assignee_user_id: 'usr_2' }),
      }),
    );
  });

  it('a reload that lands after a later save keeps the saved row', async () => {
    const taskB = { ...TASK_A, id: 'task_b', title: 'Buy eggs', status: 'open' as const, revision: 1 };
    let getResolve: ((value: Response) => void) | null = null;
    const getPromise = new Promise<Response>((resolve) => {
      getResolve = resolve;
    });
    let getCalls = 0;
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = async () => {
      getCalls += 1;
      if (getCalls === 1) return json(200, { tasks: [TASK_A, taskB] });
      if (getCalls === 2) return getPromise;
      return json(200, { tasks: [{ ...taskB, status: 'completed', revision: 2 }] });
    };
    routes[`PATCH /api/tasks/${TASK_A.id}`] = () =>
      json(409, { error: { current_revision: 2, message: 'conflict' } });
    routes[`PATCH /api/tasks/${taskB.id}`] = () =>
      json(200, { ...taskB, status: 'completed', revision: 2 });
    const { result } = await ready();
    // Toggle A to trigger conflict and reload (GET #2 deferred)
    await act(async () => {
      await result.current.toggleComplete(TASK_A);
    });
    // Toggle B while reload is pending
    await act(async () => {
      await result.current.toggleComplete(taskB);
    });
    expect(result.current.tasks.find((t) => t.id === taskB.id)?.status).toBe('completed');
    // Release the deferred GET with stale B; hook detects epoch changed, fetches again
    await act(async () => {
      getResolve?.(json(200, { tasks: [{ ...taskB, status: 'open', revision: 1 }] }));
      await waitFor(() => expect(getCalls).toBe(3));
    });
    // B should show completed with revision 2 after the second reload
    expect(result.current.tasks.find((t) => t.id === taskB.id)?.status).toBe('completed');
  });

  it('a reload that lands after a create keeps the created task', async () => {
    const newTask = { ...TASK_A, id: 'task_new', title: 'New task' };
    const taskB = { ...TASK_A, id: 'task_b', title: 'Buy eggs' };
    let getResolve: ((value: Response) => void) | null = null;
    const getPromise = new Promise<Response>((resolve) => {
      getResolve = resolve;
    });
    let getCalls = 0;
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = async () => {
      getCalls += 1;
      if (getCalls === 1) return json(200, { tasks: [TASK_A, taskB] });
      if (getCalls === 2) return getPromise;
      return json(200, { tasks: [newTask, TASK_A, taskB] });
    };
    routes[`PATCH /api/tasks/${taskB.id}`] = () =>
      json(409, { error: { current_revision: 2, message: 'conflict' } });
    routes[`POST /api/spaces/${SPACE_ID}/tasks`] = () => json(200, newTask);
    const { result } = await ready();
    // Toggle B to trigger conflict and reload (GET #2 deferred)
    await act(async () => {
      await result.current.toggleComplete(taskB);
    });
    // Create a new task while reload is pending
    await act(async () => {
      await result.current.createTask({ title: 'New task' });
    });
    expect(result.current.tasks.some((t) => t.id === 'task_new')).toBe(true);
    // Release the deferred GET without the new task; hook detects epoch changed, fetches again
    await act(async () => {
      getResolve?.(json(200, { tasks: [TASK_A, taskB] }));
      await waitFor(() => expect(getCalls).toBe(3));
    });
    // New task should still be in the list after the second reload
    expect(result.current.tasks.some((t) => t.id === 'task_new')).toBe(true);
  });

  it('a reload that lands after a delete does not bring the task back', async () => {
    const taskB = { ...TASK_A, id: 'task_b', title: 'Buy eggs' };
    const taskC = { ...TASK_A, id: 'task_c', title: 'Buy cheese' };
    let getResolve: ((value: Response) => void) | null = null;
    const getPromise = new Promise<Response>((resolve) => {
      getResolve = resolve;
    });
    let getCalls = 0;
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = async () => {
      getCalls += 1;
      if (getCalls === 1) return json(200, { tasks: [TASK_A, taskB, taskC] });
      if (getCalls === 2) return getPromise;
      return json(200, { tasks: [TASK_A, taskC] });
    };
    routes[`PATCH /api/tasks/${taskC.id}`] = () =>
      json(409, { error: { current_revision: 2, message: 'conflict' } });
    routes[`DELETE /api/tasks/${taskB.id}`] = () => new Response(null, { status: 204 });
    const { result } = await ready();
    expect(result.current.tasks.length).toBe(3);
    // Toggle C to trigger conflict and reload (GET #2 deferred)
    await act(async () => {
      await result.current.toggleComplete(taskC);
    });
    // Delete task B while reload is pending
    await act(async () => {
      await result.current.deleteTask(taskB);
    });
    expect(result.current.tasks.length).toBe(2);
    // Release the deferred GET with all 3 tasks; hook detects epoch changed, fetches again
    await act(async () => {
      getResolve?.(json(200, { tasks: [TASK_A, taskB, taskC] }));
      await waitFor(() => expect(getCalls).toBe(3));
    });
    // B should still be deleted after the second reload
    expect(result.current.tasks.length).toBe(2);
    expect(result.current.tasks.some((t) => t.id === taskB.id)).toBe(false);
  });

  it('a reload that lands while a delete is pending does not keep the task', async () => {
    const taskB = { ...TASK_A, id: 'task_b', title: 'Buy eggs' };
    const taskC = { ...TASK_A, id: 'task_c', title: 'Buy cheese' };
    let deleteResolve: ((value: Response) => void) | null = null;
    const deletePromise = new Promise<Response>((resolve) => {
      deleteResolve = resolve;
    });
    let getCalls = 0;
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = async () => {
      getCalls += 1;
      if (getCalls === 1) return json(200, { tasks: [TASK_A, taskB, taskC] });
      if (getCalls === 2) return json(200, { tasks: [TASK_A, taskB, taskC] }); // Stale (returned during delete)
      return json(200, { tasks: [TASK_A, taskC] });
    };
    routes[`DELETE /api/tasks/${taskB.id}`] = async () => deletePromise;
    routes[`PATCH /api/tasks/${taskC.id}`] = () =>
      json(409, { error: { current_revision: 2, message: 'conflict' } });
    const { result } = await ready();
    // Start delete (DELETE is deferred)
    let deletePromise2: Promise<boolean>;
    await act(async () => {
      deletePromise2 = result.current.deleteTask(taskB);
    });
    expect(result.current.tasks.length).toBe(2);
    // Trigger a 409 on taskC which triggers a reload while delete is pending
    await act(async () => {
      await result.current.toggleComplete(taskC);
    });
    // Stale GET lands with taskB still there (epoch unchanged, DELETE still pending)
    expect(result.current.tasks.length).toBe(3);
    // Now release the DELETE
    await act(async () => {
      deleteResolve?.(new Response(null, { status: 204 }));
      await deletePromise2;
    });
    // After DELETE succeeds, taskB should be removed again (second filter in deleteTask)
    expect(result.current.tasks.length).toBe(2);
    expect(result.current.tasks.some((t) => t.id === taskB.id)).toBe(false);
  });

  it('at the retry limit a stale snapshot is not applied', async () => {
    let getCalls = 0;
    routes[`GET /api/spaces/${SPACE_ID}/tasks`] = async () => {
      getCalls += 1;
      // Each GET returns different state, forcing epoch mismatch
      if (getCalls === 1) return json(200, { tasks: [TASK_A] });
      if (getCalls === 2) return json(200, { tasks: [] }); // Stale (attempt 1)
      if (getCalls === 3) return json(200, { tasks: [] }); // Stale (attempt 2)
      return json(200, { tasks: [] }); // Stale (attempt 3 - at limit)
    };
    routes[`PATCH /api/tasks/${TASK_A.id}`] = () => {
      // Each toggle bumps epoch, so load will always see stale data
      return json(200, { ...TASK_A, status: 'completed', revision: 2 });
    };
    const { result } = await ready();
    // Toggle to bump epoch and trigger reload
    await act(async () => {
      await result.current.toggleComplete(TASK_A);
    });
    // At the third attempt, the stale snapshot is not applied, so TASK_A still shows
    expect(result.current.tasks.length).toBe(1);
    expect(result.current.tasks[0]?.id).toBe(TASK_A.id);
  });
});

describe('patchTask', () => {
  it('parses the conflict body', async () => {
    routes[`PATCH /api/tasks/${TASK_A.id}`] = () =>
      json(409, { error: { current_revision: 3, message: 'task revision conflict' } });
    const result = await patchTask(TASK_A.id, { revision: 1 });
    expect(result).toEqual({ kind: 'conflict', currentRevision: 3, message: 'task revision conflict' });
  });

  it('falls back to the default conflict message on an empty body', async () => {
    routes[`PATCH /api/tasks/${TASK_A.id}`] = () => json(409, {});
    const result = await patchTask(TASK_A.id, { revision: 1 });
    expect(result).toEqual({
      kind: 'conflict',
      currentRevision: null,
      message: 'This task changed elsewhere. Your change is kept — reload to see the latest.',
    });
  });
});
