import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '../../lib/auth/use-session';

/**
 * Shared-task data against the 014 task routes
 * (specs/014-family-collaboration/contracts/api.md "Tasks"). The shapes mirror
 * apps/api/src/web-schemas.ts: a `due` is HONEST about date-only versus
 * time-specific, so a caller never invents a midnight time.
 *
 * Conflict handling differs by kind. A stale write answers 409 with the current
 * revision: a dialog edit keeps its draft on screen and lets the user retry; a
 * one-click toggle or assignment is rolled back, reloaded and reported.
 *
 * updateTask, deleteTask, restoreTask and loadTrashed cover editing, trashing
 * and restoring a task, non-optimistically.
 */

export type TaskStatus = 'open' | 'completed';

export type DueValue =
  | { kind: 'date'; date: string }
  | { kind: 'instant'; at: number; zone: string };

export type TaskSummary = {
  id: string;
  space_id: string;
  parent_task_id: string | null;
  title: string;
  body: string | null;
  status: TaskStatus;
  assignee_user_id: string | null;
  due: DueValue | null;
  order_key: string;
  revision: number;
  created_by: string;
  completed_at: number | null;
  completed_by: string | null;
  trashed_at: number | null;
  created_at: number;
  updated_at: number;
};

type TaskConflict = {
  taskId: string;
  currentRevision: number | null;
  message: string;
};

type CreateTaskInput = {
  title: string;
  due?: DueValue;
  assigneeUserId?: string;
};

/** A PATCH /api/tasks/:id body on the wire (web-schemas.ts UpdateTaskRequestSchema). */
type PatchTaskBody = {
  revision: number;
  status?: TaskStatus;
  title?: string;
  body?: string | null;
  assignee_user_id?: string | null;
  due?: DueValue | null;
  space_id?: string;
};
type PatchTaskResult =
  | { kind: 'ok'; task: TaskSummary }
  | { kind: 'conflict'; currentRevision: number | null; message: string }
  | { kind: 'error' };
/** What an editor may change. undefined = leave as is; null = clear. */
export type TaskPatch = {
  title?: string;
  body?: string | null;
  due?: DueValue | null;
  assigneeUserId?: string | null;
};
export type TaskWriteResult = 'ok' | 'conflict' | 'error';

type UseTasksResult = {
  tasks: TaskSummary[];
  loading: boolean;
  error: string | null;
  conflict: TaskConflict | null;
  reload: () => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<boolean>;
  toggleComplete: (task: TaskSummary) => Promise<TaskWriteResult>;
  assign: (task: TaskSummary, assigneeUserId: string | null) => Promise<void>;
  updateTask: (task: TaskSummary, patch: TaskPatch) => Promise<TaskWriteResult>;
  deleteTask: (task: TaskSummary) => Promise<boolean>;
  /** Moves a task to another space; on success it leaves this list. */
  moveTask: (task: TaskSummary, spaceId: string) => Promise<TaskWriteResult>;
  restoreTask: (taskId: string) => Promise<boolean>;
  loadTrashed: () => Promise<TaskSummary[] | null>;
};

const LIST_ERROR = 'Tasks could not be loaded.';
const CREATE_ERROR = 'The task could not be created.';
const UPDATE_ERROR = 'The task could not be updated.';
const DELETE_ERROR = 'The task could not be deleted.';
const RESTORE_ERROR = 'The task could not be restored.';
const CONFLICT_ERROR =
  'This task changed elsewhere. Your change is kept — reload to see the latest.';
const TOGGLE_CONFLICT = 'This task changed elsewhere, so your change was not saved. The list now shows the latest.';

/** Standalone PATCH /api/tasks/:id call shared by editors outside the hook's own optimistic writers. */
export async function patchTask(taskId: string, body: PatchTaskBody): Promise<PatchTaskResult> {
  try {
    const response = await fetchWithAuth(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status === 409) {
      const parsed = (await response.json().catch(() => null)) as {
        error?: { current_revision?: number | null; message?: string };
      } | null;
      return {
        kind: 'conflict',
        currentRevision: parsed?.error?.current_revision ?? null,
        message: parsed?.error?.message ?? CONFLICT_ERROR,
      };
    }
    if (!response.ok) return { kind: 'error' };
    return { kind: 'ok', task: (await response.json()) as TaskSummary };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * `refreshKey` is the single account-events wake-up channel: the caller bumps it
 * from its one `useAccountEvents` handler to refetch. This hook never opens a
 * second event stream.
 */
export function useTasks(spaceId: string, refreshKey = 0): UseTasksResult {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<TaskConflict | null>(null);
  const tasksRef = useRef<TaskSummary[]>([]);
  tasksRef.current = tasks;
  const writeEpoch = useRef(0);

  const load = useCallback(
    async (attempt = 0): Promise<void> => {
      setLoading(true);
      try {
        const epoch = writeEpoch.current;
        const response = await fetchWithAuth(`/api/spaces/${spaceId}/tasks`);
        if (!response.ok) throw new Error('list_failed');
        const body = (await response.json()) as { tasks: TaskSummary[] };
        // If a write completed while the fetch was in flight, the snapshot is stale.
        // Reload again to capture the post-write state (bounded at 3 attempts).
        if (writeEpoch.current !== epoch) {
          if (attempt < 3) {
            await load(attempt + 1);
            return;
          }
          // At limit, don't apply the stale snapshot (local state holds confirmed writes).
          return;
        }
        // Checklist items are child tasks; they're loaded per task, not in this top-level list.
        setTasks(body.tasks.filter((task) => task.parent_task_id === null));
        setError(null);
      } catch {
        setError(LIST_ERROR);
      } finally {
        setLoading(false);
      }
    },
    [spaceId],
  );

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const replaceTask = (id: string, next: TaskSummary): void => {
    setTasks((prev) => prev.map((task) => (task.id === id ? next : task)));
  };

  /** Flip a task open/completed in the local list without waiting on the wire. */
  const applyOptimisticToggle = (task: TaskSummary): TaskSummary => {
    const completed = task.status === 'completed';
    return {
      ...task,
      status: completed ? 'open' : 'completed',
      completed_at: completed ? null : Date.now(),
      completed_by: completed ? null : task.completed_by,
      revision: task.revision,
    };
  };

  const createTask = useCallback(
    async (input: CreateTaskInput): Promise<boolean> => {
      setError(null);
      setConflict(null);
      try {
        const response = await fetchWithAuth(`/api/spaces/${spaceId}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: input.title,
            ...(input.due !== undefined ? { due: input.due } : {}),
            ...(input.assigneeUserId !== undefined ? { assignee_user_id: input.assigneeUserId } : {}),
          }),
        });
        if (!response.ok) throw new Error('create_failed');
        const created = (await response.json()) as TaskSummary;
        setTasks((prev) => [created, ...prev]);
        writeEpoch.current += 1;
        return true;
      } catch {
        setError(CREATE_ERROR);
        return false;
      }
    },
    [spaceId],
  );

  const toggleComplete = useCallback(
    async (task: TaskSummary): Promise<TaskWriteResult> => {
      const optimistic = applyOptimisticToggle(task);
      replaceTask(task.id, optimistic);
      setError(null);
      setConflict(null);
      try {
        const response = await fetchWithAuth(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revision: task.revision, status: optimistic.status }),
        });
        if (response.status === 409) {
          const body = (await response.json().catch(() => null)) as {
            error?: { current_revision?: number | null; message?: string };
          } | null;
          // Roll back the optimistic toggle and reload the latest state.
          replaceTask(task.id, task);
          setConflict({
            taskId: task.id,
            currentRevision: body?.error?.current_revision ?? null,
            message: TOGGLE_CONFLICT,
          });
          void load();
          return 'conflict';
        }
        if (!response.ok) throw new Error('toggle_failed');
        const updated = (await response.json()) as TaskSummary;
        replaceTask(task.id, updated);
        writeEpoch.current += 1;
        return 'ok';
      } catch {
        // Roll the optimistic flip back visibly on a failure other than a 409.
        replaceTask(task.id, task);
        setError(UPDATE_ERROR);
        return 'error';
      }
    },
    [load],
  );

  const assign = useCallback(
    async (task: TaskSummary, assigneeUserId: string | null): Promise<void> => {
      const previous = task;
      const optimistic: TaskSummary = { ...task, assignee_user_id: assigneeUserId, revision: task.revision };
      replaceTask(task.id, optimistic);
      setError(null);
      setConflict(null);
      try {
        const response = await fetchWithAuth(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revision: task.revision, assignee_user_id: assigneeUserId }),
        });
        if (response.status === 409) {
          const body = (await response.json().catch(() => null)) as {
            error?: { current_revision?: number | null; message?: string };
          } | null;
          // Roll back the optimistic assignment and reload the latest state.
          replaceTask(task.id, previous);
          setConflict({
            taskId: task.id,
            currentRevision: body?.error?.current_revision ?? null,
            message: TOGGLE_CONFLICT,
          });
          void load();
          return;
        }
        if (!response.ok) throw new Error('assign_failed');
        const updated = (await response.json()) as TaskSummary;
        replaceTask(task.id, updated);
        writeEpoch.current += 1;
      } catch {
        replaceTask(task.id, previous);
        setError(UPDATE_ERROR);
      }
    },
    [load],
  );

  const updateTask = useCallback(
    async (task: TaskSummary, patch: TaskPatch): Promise<TaskWriteResult> => {
      const body: PatchTaskBody = {
        revision: task.revision,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.due !== undefined ? { due: patch.due } : {}),
        ...(patch.assigneeUserId !== undefined ? { assignee_user_id: patch.assigneeUserId } : {}),
      };
      const result = await patchTask(task.id, body);
      if (result.kind === 'ok') {
        replaceTask(task.id, result.task);
        writeEpoch.current += 1;
        return 'ok';
      }
      if (result.kind === 'conflict') {
        void load();
        return 'conflict';
      }
      return 'error';
    },
    [load],
  );

  const deleteTask = useCallback(
    async (task: TaskSummary): Promise<boolean> => {
      setError(null);
      setConflict(null);
      const index = tasksRef.current.findIndex((t) => t.id === task.id);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      try {
        const response = await fetchWithAuth(`/api/tasks/${task.id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('delete_failed');
        // Remove the row again in case a stale reload restored it, then bump epoch.
        setTasks((prev) => prev.filter((t) => t.id !== task.id));
        writeEpoch.current += 1;
        return true;
      } catch {
        setTasks((prev) => {
          const next = [...prev];
          const at = Math.min(Math.max(index, 0), next.length);
          next.splice(at, 0, task);
          return next;
        });
        setError(DELETE_ERROR);
        return false;
      }
    },
    [],
  );

  const moveTask = useCallback(
    async (task: TaskSummary, spaceId: string): Promise<TaskWriteResult> => {
      const result = await patchTask(task.id, { revision: task.revision, space_id: spaceId });
      if (result.kind === 'ok') {
        setTasks((prev) => prev.filter((t) => t.id !== task.id));
        writeEpoch.current += 1;
        return 'ok';
      }
      if (result.kind === 'conflict') {
        void load();
        return 'conflict';
      }
      return 'error';
    },
    [load],
  );

  const restoreTask = useCallback(async (taskId: string): Promise<boolean> => {
    try {
      const response = await fetchWithAuth(`/api/tasks/${taskId}/restore`, { method: 'POST' });
      if (!response.ok) throw new Error('restore_failed');
      const restored = (await response.json()) as TaskSummary;
      if (restored.parent_task_id === null) {
        setTasks((prev) => {
          if (prev.some((t) => t.id === restored.id)) return prev;
          return [...prev, restored].sort((a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : 0));
        });
      }
      writeEpoch.current += 1;
      return true;
    } catch {
      setError(RESTORE_ERROR);
      return false;
    }
  }, []);

  const loadTrashed = useCallback(async (): Promise<TaskSummary[] | null> => {
    try {
      const response = await fetchWithAuth(`/api/spaces/${spaceId}/tasks?trashed=true`);
      if (!response.ok) throw new Error('list_trashed_failed');
      const body = (await response.json()) as { tasks: TaskSummary[] };
      return body.tasks
        .filter((task) => task.trashed_at !== null && task.parent_task_id === null)
        .sort((a, b) => (b.trashed_at ?? 0) - (a.trashed_at ?? 0));
    } catch {
      return null;
    }
  }, [spaceId]);

  return {
    tasks,
    loading,
    error,
    conflict,
    reload: () => load(),
    createTask,
    toggleComplete,
    assign,
    updateTask,
    deleteTask,
    moveTask,
    restoreTask,
    loadTrashed,
  };
}
