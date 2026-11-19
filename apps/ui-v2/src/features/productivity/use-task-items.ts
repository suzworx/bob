import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '../../lib/auth/use-session';
import { patchTask, type TaskSummary, type TaskStatus } from './use-tasks';

/**
 * Checklist items for a task are child tasks (apps/api/src/tasks/store.ts),
 * loaded and written through the same /api/tasks routes as a top-level task.
 * Removing an item trashes it. Nothing subscribes to a task's items yet.
 */

const LOAD_ERROR = 'The checklist could not be loaded.';
const ADD_ERROR = 'The item could not be added.';
const UPDATE_ERROR = 'The item could not be updated.';
const REMOVE_ERROR = 'The item could not be removed.';
const MOVE_ERROR = 'The item could not be moved.';
const CONFLICT_ERROR = 'This checklist changed elsewhere. It has been refreshed.';
const TITLE_MAX = 200;

export type MoveDirection = 'up' | 'down';

/** The server's order: order_key in byte order (a plain string compare). */
function sortByOrderKey(items: TaskSummary[]): TaskSummary[] {
  return [...items].sort((a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : 0));
}

type UseTaskItemsResult = {
  items: TaskSummary[];
  loading: boolean;
  error: string | null;
  addItem: (title: string) => Promise<boolean>;
  toggleItem: (item: TaskSummary) => Promise<void>;
  removeItem: (item: TaskSummary) => Promise<boolean>;
  /** Moves an item one place; resolves to its new 1-based position, or null
   *  when it did not move (a 409 reloads the list from the server). */
  moveItem: (item: TaskSummary, direction: MoveDirection) => Promise<number | null>;
};

export function useTaskItems(taskId: string): UseTaskItemsResult {
  const [items, setItems] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef<TaskSummary[]>([]);
  itemsRef.current = items;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await fetchWithAuth(`/api/tasks/${taskId}/items`);
      if (!response.ok) throw new Error('list_failed');
      const body = (await response.json()) as { items: TaskSummary[] };
      setItems(body.items);
      setError(null);
    } catch {
      setError(LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceItem = (id: string, next: TaskSummary): void => {
    setItems((prev) => prev.map((item) => (item.id === id ? next : item)));
  };

  const addItem = useCallback(
    async (title: string): Promise<boolean> => {
      setError(null);
      const trimmed = title.trim();
      if (trimmed.length === 0 || trimmed.length > TITLE_MAX) return false;
      try {
        const response = await fetchWithAuth(`/api/tasks/${taskId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: trimmed }),
        });
        if (response.status !== 201) throw new Error('create_failed');
        const created = (await response.json()) as TaskSummary;
        setItems((prev) => [...prev, created]);
        return true;
      } catch {
        setError(ADD_ERROR);
        return false;
      }
    },
    [taskId],
  );

  const toggleItem = useCallback(
    async (item: TaskSummary): Promise<void> => {
      setError(null);
      const completed = item.status === 'completed';
      const next: TaskStatus = completed ? 'open' : 'completed';
      const optimistic: TaskSummary = {
        ...item,
        status: next,
        completed_at: completed ? null : Date.now(),
        revision: item.revision + 1,
      };
      replaceItem(item.id, optimistic);
      const result = await patchTask(item.id, { revision: item.revision, status: next });
      if (result.kind === 'ok') {
        replaceItem(item.id, result.task);
        return;
      }
      if (result.kind === 'conflict') {
        await load();
        setError(CONFLICT_ERROR);
        return;
      }
      replaceItem(item.id, item);
      setError(UPDATE_ERROR);
    },
    [load],
  );

  const removeItem = useCallback(
    async (item: TaskSummary): Promise<boolean> => {
      setError(null);
      const index = itemsRef.current.findIndex((i) => i.id === item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      try {
        const response = await fetchWithAuth(`/api/tasks/${item.id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('delete_failed');
        return true;
      } catch {
        setItems((prev) => {
          const next = [...prev];
          const at = Math.min(Math.max(index, 0), next.length);
          next.splice(at, 0, item);
          return next;
        });
        setError(REMOVE_ERROR);
        return false;
      }
    },
    [],
  );

  const moveItem = useCallback(
    async (item: TaskSummary, direction: MoveDirection): Promise<number | null> => {
      setError(null);
      const before = itemsRef.current;
      const index = before.findIndex((i) => i.id === item.id);
      const current = before[index];
      const neighbour = before[direction === 'up' ? index - 1 : index + 1];
      if (!current || !neighbour) return null;
      const next = before.filter((i) => i.id !== item.id);
      const at = next.findIndex((i) => i.id === neighbour.id);
      next.splice(direction === 'up' ? at : at + 1, 0, current);
      setItems(next);
      const anchor = direction === 'up' ? { before_item_id: neighbour.id } : { after_item_id: neighbour.id };
      try {
        const response = await fetchWithAuth(`/api/tasks/${taskId}/items/${item.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...anchor, revision: current.revision }),
        });
        if (response.status === 409) {
          await load();
          setError(CONFLICT_ERROR);
          return null;
        }
        if (!response.ok) throw new Error('move_failed');
        const moved = (await response.json()) as TaskSummary;
        setItems((prev) => sortByOrderKey(prev.map((i) => (i.id === moved.id ? moved : i))));
        return next.findIndex((i) => i.id === item.id) + 1;
      } catch {
        setItems(before);
        setError(MOVE_ERROR);
        return null;
      }
    },
    [taskId, load],
  );

  return { items, loading, error, addItem, toggleItem, removeItem, moveItem };
}
