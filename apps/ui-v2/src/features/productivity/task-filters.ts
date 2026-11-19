import type { DueValue, TaskSummary } from '@/features/productivity/use-tasks';

/** The three filters a person picks from; Deleted is a separate view reached from the list menu. */
export type TaskView = 'open' | 'mine' | 'done' | 'deleted';
export type TaskSort = 'list' | 'due' | 'newest';

const TASK_VIEWS: TaskView[] = ['open', 'mine', 'done', 'deleted'];
const TASK_SORTS: TaskSort[] = ['list', 'due', 'newest'];

export function isTaskView(value: string): value is TaskView {
  return (TASK_VIEWS as string[]).includes(value);
}

export function isTaskSort(value: string): value is TaskSort {
  return (TASK_SORTS as string[]).includes(value);
}

/** Local YYYY-MM-DD for an epoch-ms instant, in the caller's own time zone. */
export function localDateKey(epochMs: number): string {
  const date = new Date(epochMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The one overdue rule for every task row (Tasks, Today, Calendar, Suggested by
 * Bob): a timed due is overdue once its instant has passed; a date-only due
 * names no time, so it is overdue only on a later day, never part-way through
 * its own. `todayKey` is the caller's YYYY-MM-DD for "today" (the account zone
 * where the caller has one), defaulting to the browser's.
 */
export function isDueOverdue(due: DueValue, now: number, todayKey: string = localDateKey(now)): boolean {
  if (due.kind === 'date') return due.date < todayKey;
  return due.at < now;
}

export function isOverdue(task: TaskSummary, now: number): boolean {
  if (task.status !== 'open' || task.due === null) return false;
  return isDueOverdue(task.due, now);
}

function dueTime(task: TaskSummary): number {
  if (task.due === null) return Infinity;
  if (task.due.kind === 'date') return new Date(`${task.due.date}T00:00:00`).getTime();
  return task.due.at;
}

export function viewTasks(
  tasks: TaskSummary[],
  view: Exclude<TaskView, 'deleted'>,
  selfUserId: string | null,
): TaskSummary[] {
  if (view === 'open') return tasks.filter((task) => task.status === 'open');
  if (view === 'mine') {
    if (selfUserId === null) return [];
    return tasks.filter((task) => task.status === 'open' && task.assignee_user_id === selfUserId);
  }
  return tasks.filter((task) => task.status === 'completed');
}

export function sortTasks(tasks: TaskSummary[], sort: TaskSort): TaskSummary[] {
  const copy = tasks.slice();
  if (sort === 'list') return copy;
  if (sort === 'due') {
    return copy
      .map((task, index) => ({ task, index }))
      .sort((a, b) => dueTime(a.task) - dueTime(b.task) || a.index - b.index)
      .map((entry) => entry.task);
  }
  return copy.sort((a, b) => b.created_at - a.created_at);
}
