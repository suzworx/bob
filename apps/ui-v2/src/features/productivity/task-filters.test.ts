import { describe, expect, it } from 'vitest';
import { isDueOverdue, isOverdue, isTaskSort, isTaskView, localDateKey, sortTasks, viewTasks } from './task-filters';
import type { TaskSummary } from '@/features/productivity/use-tasks';

const NOW = new Date(2026, 8, 21, 12, 0).getTime();

const BASE: TaskSummary = {
  id: 'task_a',
  space_id: 'spc_1',
  parent_task_id: null,
  title: 'Task A',
  body: null,
  status: 'open',
  assignee_user_id: null,
  due: null,
  order_key: 'a',
  revision: 1,
  created_by: 'usr_1',
  completed_at: null,
  completed_by: null,
  trashed_at: null,
  created_at: 1000,
  updated_at: 1000,
};

describe('isTaskView', () => {
  it('accepts each known view and rejects anything else', () => {
    expect(isTaskView('open')).toBe(true);
    expect(isTaskView('mine')).toBe(true);
    // Overdue is a row marker, not a filter: three segments fit a phone.
    expect(isTaskView('overdue')).toBe(false);
    expect(isTaskView('done')).toBe(true);
    expect(isTaskView('deleted')).toBe(true);
    expect(isTaskView('bogus')).toBe(false);
  });
});

describe('isTaskSort', () => {
  it('accepts each known sort and rejects anything else', () => {
    expect(isTaskSort('list')).toBe(true);
    expect(isTaskSort('due')).toBe(true);
    expect(isTaskSort('newest')).toBe(true);
    expect(isTaskSort('bogus')).toBe(false);
  });
});

describe('localDateKey', () => {
  it('formats an epoch as a local YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 8, 21, 12, 0).getTime())).toBe('2026-09-21');
    expect(localDateKey(new Date(2026, 0, 5, 0, 0).getTime())).toBe('2026-01-05');
  });
});

describe('isOverdue', () => {
  it('is true for a past due date on an open task', () => {
    expect(isOverdue({ ...BASE, due: { kind: 'date', date: '2026-09-20' } }, NOW)).toBe(true);
  });

  it('is false for today\'s due date', () => {
    expect(isOverdue({ ...BASE, due: { kind: 'date', date: '2026-09-21' } }, NOW)).toBe(false);
  });

  it('is true for a past instant', () => {
    expect(isOverdue({ ...BASE, due: { kind: 'instant', at: NOW - 60_000, zone: 'UTC' } }, NOW)).toBe(true);
  });

  it('is false for a completed task with a past due date', () => {
    expect(
      isOverdue({ ...BASE, status: 'completed', due: { kind: 'date', date: '2026-09-20' } }, NOW),
    ).toBe(false);
  });

  it('is false when there is no due date', () => {
    expect(isOverdue({ ...BASE, due: null }, NOW)).toBe(false);
  });
});

describe('isDueOverdue (the one overdue rule for every task row)', () => {
  it('compares a date-only due with the caller\'s today key, so a due today is not overdue yet', () => {
    expect(isDueOverdue({ kind: 'date', date: '2026-09-20' }, NOW, '2026-09-21')).toBe(true);
    expect(isDueOverdue({ kind: 'date', date: '2026-09-21' }, NOW, '2026-09-21')).toBe(false);
  });

  it('uses the instant for a timed due, whatever the today key says', () => {
    expect(isDueOverdue({ kind: 'instant', at: NOW - 1, zone: 'UTC' }, NOW, '2000-01-01')).toBe(true);
    expect(isDueOverdue({ kind: 'instant', at: NOW + 1, zone: 'UTC' }, NOW, '2999-01-01')).toBe(false);
  });

  it('defaults the today key to the browser day', () => {
    expect(isDueOverdue({ kind: 'date', date: localDateKey(NOW) }, NOW)).toBe(false);
  });
});

describe('viewTasks', () => {
  const OPEN = { ...BASE, id: 'task_open', status: 'open' as const, due: null };
  const MINE_OPEN = { ...BASE, id: 'task_mine', status: 'open' as const, assignee_user_id: 'usr_self' };
  const OTHER_OPEN = { ...BASE, id: 'task_other', status: 'open' as const, assignee_user_id: 'usr_other' };
  const OVERDUE = { ...BASE, id: 'task_overdue', status: 'open' as const, due: { kind: 'date' as const, date: '2020-01-01' } };
  const DONE = { ...BASE, id: 'task_done', status: 'completed' as const };
  const ALL = [OPEN, MINE_OPEN, OTHER_OPEN, OVERDUE, DONE];

  it('open returns only open tasks', () => {
    expect(viewTasks(ALL, 'open', 'usr_self')).toEqual([OPEN, MINE_OPEN, OTHER_OPEN, OVERDUE]);
  });

  it('mine returns open tasks assigned to selfUserId', () => {
    expect(viewTasks(ALL, 'mine', 'usr_self')).toEqual([MINE_OPEN]);
  });

  it('mine returns nothing when selfUserId is null', () => {
    expect(viewTasks(ALL, 'mine', null)).toEqual([]);
  });

  it('done returns only completed tasks', () => {
    expect(viewTasks(ALL, 'done', 'usr_self')).toEqual([DONE]);
  });
});

describe('sortTasks', () => {
  const NO_DUE = { ...BASE, id: 'task_no_due', due: null, created_at: 100 };
  const DUE_LATE = { ...BASE, id: 'task_due_late', due: { kind: 'date' as const, date: '2026-10-05' }, created_at: 200 };
  const DUE_EARLY = { ...BASE, id: 'task_due_early', due: { kind: 'date' as const, date: '2026-10-01' }, created_at: 300 };
  const DUE_TIE = { ...BASE, id: 'task_due_tie', due: { kind: 'date' as const, date: '2026-10-01' }, created_at: 400 };
  const INPUT = [NO_DUE, DUE_LATE, DUE_EARLY, DUE_TIE];

  it('due puts no-due tasks last and keeps ties in input order', () => {
    expect(sortTasks(INPUT, 'due')).toEqual([DUE_EARLY, DUE_TIE, DUE_LATE, NO_DUE]);
  });

  it('newest sorts by created_at descending', () => {
    expect(sortTasks(INPUT, 'newest').map((t) => t.id)).toEqual([
      'task_due_tie',
      'task_due_early',
      'task_due_late',
      'task_no_due',
    ]);
  });

  it('list returns a copy in the same order', () => {
    const result = sortTasks(INPUT, 'list');
    expect(result).toEqual(INPUT);
    expect(result).not.toBe(INPUT);
  });
});
