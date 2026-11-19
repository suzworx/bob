// The open action items Bob picked up from conversations: Today's "Suggested
// by Bob" group. This hook is their one home; the Memory page no longer lists
// them. It owns the data and the writes; the caller owns the rows and the
// Toast (with Undo) that follows a complete or a dismiss.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MemoryUnavailableError,
  findPrivateSpace,
  listActionItems,
  promoteToTask,
  setActionItemStatus,
  type ActionItem,
} from './memory-api';

type ActionItemsError = 'load_failed' | 'update_failed' | 'task_failed' | 'no_private_space';

type ToTaskOptions = {
  /** Defaults to the person's private space. */
  spaceId?: string;
  /** Defaults to the action item's text. */
  title?: string;
};

type ToTaskResult = { taskId: string; spaceId: string; spaceName: string | null };

export type UseActionItems = {
  /** Open items only, in the server's order. */
  items: ActionItem[];
  isLoading: boolean;
  /** The last failure, cleared by the next successful call. */
  error: ActionItemsError | null;
  /** Memory is switched off for this account (503): show nothing. */
  isUnavailable: boolean;
  /** Marks the item done and drops it from `items`. Resolves false on failure. */
  complete: (id: string) => Promise<boolean>;
  /** Marks the item dropped and drops it from `items`. Resolves false on failure. */
  dismiss: (id: string) => Promise<boolean>;
  /** Reopens an item completed or dismissed in this session, back in its place. */
  undo: (id: string) => Promise<boolean>;
  /**
   * Copies the item into a space as a task, keeping its due date, then closes
   * the item so it is not listed twice. Defaults to the private space.
   * Resolves null on failure (see `error`).
   */
  toTask: (id: string, options?: ToTaskOptions) => Promise<ToTaskResult | null>;
  reload: () => Promise<void>;
};

const TASK_TITLE_MAX = 200;

export function useActionItems({ refreshKey = 0 }: { refreshKey?: number } = {}): UseActionItems {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ActionItemsError | null>(null);
  const [isUnavailable, setIsUnavailable] = useState(false);
  // Items closed in this session, with the index they held, for undo.
  const closed = useRef(new Map<string, { item: ActionItem; index: number }>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const reload = useCallback(async (): Promise<void> => {
    try {
      const all = await listActionItems();
      setItems(all.filter((item) => item.status === 'open'));
      setIsUnavailable(false);
      setError(null);
    } catch (caught) {
      if (caught instanceof MemoryUnavailableError) setIsUnavailable(true);
      else setError('load_failed');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const close = useCallback(async (id: string, status: 'done' | 'dropped'): Promise<boolean> => {
    const index = itemsRef.current.findIndex((item) => item.id === id);
    const item = itemsRef.current[index];
    if (!item) return false;
    setItems((prev) => prev.filter((candidate) => candidate.id !== id));
    try {
      await setActionItemStatus(id, status);
      closed.current.set(id, { item, index });
      setError(null);
      return true;
    } catch {
      setItems((prev) => insertAt(prev, item, index));
      setError('update_failed');
      return false;
    }
  }, []);

  const complete = useCallback((id: string) => close(id, 'done'), [close]);
  const dismiss = useCallback((id: string) => close(id, 'dropped'), [close]);

  const undo = useCallback(async (id: string): Promise<boolean> => {
    const entry = closed.current.get(id);
    if (!entry) return false;
    try {
      const reopened = await setActionItemStatus(id, 'open');
      closed.current.delete(id);
      setItems((prev) => (prev.some((item) => item.id === id) ? prev : insertAt(prev, reopened, entry.index)));
      setError(null);
      return true;
    } catch {
      setError('update_failed');
      return false;
    }
  }, []);

  const toTask = useCallback(
    async (id: string, options: ToTaskOptions = {}): Promise<ToTaskResult | null> => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (!item) return null;
      let spaceId = options.spaceId;
      let spaceName: string | null = null;
      try {
        if (spaceId === undefined) {
          const own = await findPrivateSpace();
          if (own === null) {
            setError('no_private_space');
            return null;
          }
          spaceId = own.id;
          spaceName = own.name;
        }
        const title = (options.title ?? item.content).trim().slice(0, TASK_TITLE_MAX);
        const task = await promoteToTask(item.memory_id, { spaceId, title, dueAt: item.due_at });
        // The task now carries it; the suggestion is closed so Today shows one row.
        const closedOk = await close(id, 'done');
        closed.current.delete(id);
        if (closedOk) setError(null);
        return { taskId: task.id, spaceId, spaceName };
      } catch {
        setError('task_failed');
        return null;
      }
    },
    [close],
  );

  return { items, isLoading, error, isUnavailable, complete, dismiss, undo, toTask, reload };
}

function insertAt(list: ActionItem[], item: ActionItem, index: number): ActionItem[] {
  const next = [...list];
  next.splice(Math.min(Math.max(index, 0), next.length), 0, item);
  return next;
}
