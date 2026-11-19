import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  buildPatch,
  dueToInput,
  dueToTime,
  followerNames,
  isIsoDate,
  parseFollowers,
  TaskEditDialog,
  type TaskEditDraft,
} from './task-edit-dialog';
import type { TaskSummary } from '@/features/productivity/use-tasks';

const { fetchWithAuth } = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/auth/use-session', () => ({
  fetchWithAuth,
  useSession: () => ({ session: { user: { id: 'usr_me' } } }),
}));

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

// By default nobody follows the task.
beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async () => reply(200, { subscribers: [] }));
});

// jsdom has no modal <dialog>; the Astryx Dialog calls showModal() on open.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

const UNASSIGNED = '__unassigned__';

const TASK: TaskSummary = {
  id: 'task_aaa',
  space_id: 'spc_1',
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

const ASSIGNEE_OPTIONS = [
  { value: UNASSIGNED, label: 'Unassigned' },
  { value: 'usr_olive', label: 'Olive' },
];

function draftFor(task: TaskSummary): TaskEditDraft {
  return {
    title: task.title,
    notes: task.body ?? '',
    due: dueToInput(task.due),
    assignee: task.assignee_user_id ?? UNASSIGNED,
  };
}

describe('buildPatch', () => {
  it('returns an empty patch when nothing changed', () => {
    expect(buildPatch(TASK, draftFor(TASK), UNASSIGNED)).toEqual({});
  });

  it('includes a trimmed title change', () => {
    const draft = { ...draftFor(TASK), title: '  Buy oat milk  ' };
    expect(buildPatch(TASK, draft, UNASSIGNED)).toEqual({ title: 'Buy oat milk' });
  });

  it('sends body: null when notes are cleared on a task with a body', () => {
    const withBody: TaskSummary = { ...TASK, body: 'Whole milk' };
    const draft = { ...draftFor(withBody), notes: '' };
    expect(buildPatch(withBody, draft, UNASSIGNED)).toEqual({ body: null });
  });

  it('omits body when notes are cleared on a task with no body', () => {
    const draft = { ...draftFor(TASK), notes: '' };
    expect(buildPatch(TASK, draft, UNASSIGNED)).toEqual({});
  });

  it('sends a new date', () => {
    const noDue: TaskSummary = { ...TASK, due: null };
    const draft = { ...draftFor(noDue), due: '2026-10-01' as TaskEditDraft['due'] };
    expect(buildPatch(noDue, draft, UNASSIGNED)).toEqual({
      due: { kind: 'date', date: '2026-10-01' },
    });
  });

  it('sends due: null when a date is cleared', () => {
    const draft = { ...draftFor(TASK), due: undefined };
    expect(buildPatch(TASK, draft, UNASSIGNED)).toEqual({ due: null });
  });

  it('sends no due key when a timed due is left alone', () => {
    const timed: TaskSummary = { ...TASK, due: { kind: 'instant', at: 1756600000000, zone: 'UTC' } };
    const draft = { ...draftFor(timed), time: dueToTime(timed.due) };
    expect(buildPatch(timed, draft, UNASSIGNED)).toEqual({});
  });

  it('keeps the time of a timed due when only its date changes', () => {
    const at = Date.UTC(2026, 9, 1, 15, 30);
    const timed: TaskSummary = { ...TASK, due: { kind: 'instant', at, zone: 'America/New_York' } };
    const draft = { ...draftFor(timed), time: dueToTime(timed.due), due: '2026-10-03' as TaskEditDraft['due'] };
    expect(buildPatch(timed, draft, UNASSIGNED)).toEqual({
      due: { kind: 'instant', at: Date.UTC(2026, 9, 3, 15, 30), zone: 'America/New_York' },
    });
  });

  it('makes a timed due all-day only when its time is cleared', () => {
    const timed: TaskSummary = { ...TASK, due: { kind: 'instant', at: Date.UTC(2026, 9, 1, 15, 30), zone: 'UTC' } };
    const draft = { ...draftFor(timed), time: undefined };
    expect(buildPatch(timed, draft, UNASSIGNED)).toEqual({ due: { kind: 'date', date: '2026-10-01' } });
  });

  it('sends assigneeUserId: null when Unassigned is chosen', () => {
    const assigned: TaskSummary = { ...TASK, assignee_user_id: 'usr_olive' };
    const draft = { ...draftFor(assigned), assignee: UNASSIGNED };
    expect(buildPatch(assigned, draft, UNASSIGNED)).toEqual({ assigneeUserId: null });
  });
});

describe('dueToInput', () => {
  it('passes a date through', () => {
    expect(dueToInput({ kind: 'date', date: '2026-10-01' })).toBe('2026-10-01');
  });

  it('gives the date of a timed due in its own zone', () => {
    const at = Date.UTC(2026, 9, 1, 2, 30);
    expect(dueToInput({ kind: 'instant', at, zone: 'UTC' })).toBe('2026-10-01');
    expect(dueToInput({ kind: 'instant', at, zone: 'America/Los_Angeles' })).toBe('2026-09-30');
    expect(dueToTime({ kind: 'instant', at, zone: 'America/Los_Angeles' })).toBe('19:30');
    expect(dueToTime({ kind: 'date', date: '2026-10-01' })).toBeUndefined();
  });

  it('gives undefined for no due', () => {
    expect(dueToInput(null)).toBeUndefined();
  });
});

describe('isIsoDate', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(isIsoDate('2026-10-01')).toBe(true);
  });

  it('rejects other shapes', () => {
    expect(isIsoDate('10/01/2026')).toBe(false);
    expect(isIsoDate('2026-10-01T00:00:00Z')).toBe(false);
  });
});

describe('TaskEditDialog', () => {
  it('saves with no changes by calling onClose and not onSave', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <TaskEditDialog
        task={TASK}
        assigneeOptions={ASSIGNEE_OPTIONS}
        unassignedValue={UNASSIGNED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    await screen.findByRole('dialog', { name: 'Edit task' });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('sends a date patch when typing a due date on a task with no due', async () => {
    const noDue: TaskSummary = { ...TASK, due: null };
    const onSave = vi.fn().mockResolvedValue('ok');
    const onClose = vi.fn();
    render(
      <TaskEditDialog
        task={noDue}
        assigneeOptions={ASSIGNEE_OPTIONS}
        unassignedValue={UNASSIGNED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    const dueInput = within(dialog).getByRole('combobox', { name: /^Due date/ });
    await userEvent.type(dueInput, '2026-10-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(noDue, { due: { kind: 'date', date: '2026-10-01' } });
  });

  it('shows the conflict banner, keeps the typed title and does not close on a conflict', async () => {
    const onSave = vi.fn().mockResolvedValue('conflict');
    const onClose = vi.fn();
    render(
      <TaskEditDialog
        task={TASK}
        assigneeOptions={ASSIGNEE_OPTIONS}
        unassignedValue={UNASSIGNED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    const titleInput = within(dialog).getByRole('textbox', { name: 'Title' });
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Buy oat milk');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        'This task changed elsewhere. Your edits are kept — save again to apply them.',
      ),
    ).toBeTruthy();
    expect((titleInput as HTMLInputElement).value).toBe('Buy oat milk');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the error copy on a save error', async () => {
    const onSave = vi.fn().mockResolvedValue('error');
    const onClose = vi.fn();
    render(
      <TaskEditDialog
        task={TASK}
        assigneeOptions={ASSIGNEE_OPTIONS}
        unassignedValue={UNASSIGNED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    const titleInput = within(dialog).getByRole('textbox', { name: 'Title' });
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Buy oat milk');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('The task could not be saved.')).toBeTruthy();
  });

  it('disables Save when the title is cleared', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <TaskEditDialog
        task={TASK}
        assigneeOptions={ASSIGNEE_OPTIONS}
        unassignedValue={UNASSIGNED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    const titleInput = within(dialog).getByRole('textbox', { name: 'Title' });
    await userEvent.clear(titleInput);
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled || save.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('hides the Assignee selector when there is one option or none', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <TaskEditDialog
        task={TASK}
        assigneeOptions={[]}
        unassignedValue={UNASSIGNED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    expect(within(dialog).queryByRole('combobox', { name: /^Assignee/ })).toBeNull();
  });

  it('hides the Assignee selector when there is exactly one option', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <TaskEditDialog
        task={TASK}
        assigneeOptions={[{ value: UNASSIGNED, label: 'Unassigned' }]}
        unassignedValue={UNASSIGNED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    expect(within(dialog).queryByRole('combobox', { name: /^Assignee/ })).toBeNull();
  });

  it('shows the time of a timed due so editing keeps it, and names the task in the header', async () => {
    const timed: TaskSummary = { ...TASK, due: { kind: 'instant', at: Date.UTC(2026, 9, 1, 15, 30), zone: 'UTC' } };
    render(
      <TaskEditDialog task={timed} assigneeOptions={ASSIGNEE_OPTIONS} unassignedValue={UNASSIGNED} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    expect(within(dialog).getByText('Buy milk')).toBeTruthy();
    expect(within(dialog).getByLabelText(/^Time/)).toBeTruthy();
  });

  it('offers Delete in the footer when the caller handles it', async () => {
    const onDelete = vi.fn();
    render(
      <TaskEditDialog task={TASK} assigneeOptions={ASSIGNEE_OPTIONS} unassignedValue={UNASSIGNED} onSave={vi.fn()} onClose={vi.fn()} onDelete={onDelete} />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(TASK);
  });

  it('focuses the title when it opens', async () => {
    render(
      <TaskEditDialog task={TASK} assigneeOptions={ASSIGNEE_OPTIONS} unassignedValue={UNASSIGNED} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Title' })));
  });
});

describe('notify me about changes (#511)', () => {
  function renderDialog(onClose = vi.fn(), onSave = vi.fn().mockResolvedValue('ok')): void {
    render(
      <TaskEditDialog
        task={TASK}
        assigneeOptions={ASSIGNEE_OPTIONS}
        unassignedValue={UNASSIGNED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
  }

  it('parseFollowers reads the user ids and refuses a malformed body', () => {
    expect(parseFollowers({ subscribers: [{ task_id: 't', user_id: 'usr_a', created_at: 1 }] })).toEqual(['usr_a']);
    expect(() => parseFollowers({ subscribers: [{}] })).toThrow('followers_invalid');
    expect(() => parseFollowers(null)).toThrow('followers_invalid');
  });

  it('followerNames shows "You" and member names, never a raw id', () => {
    expect(followerNames(['usr_me', 'usr_olive', 'usr_gone'], 'usr_me', ASSIGNEE_OPTIONS, UNASSIGNED))
      .toEqual(['You', 'Olive']);
    expect(followerNames([UNASSIGNED], null, ASSIGNEE_OPTIONS, UNASSIGNED)).toEqual([]);
  });

  it('shows the switch on for a follower and names who else is notified', async () => {
    fetchWithAuth.mockImplementation(async () => reply(200, { subscribers: [
      { task_id: TASK.id, user_id: 'usr_olive', created_at: 1 },
      { task_id: TASK.id, user_id: 'usr_me', created_at: 2 },
    ] }));
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    const toggle = within(dialog).getByRole('switch', { name: /Notify me about changes/ });
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
    expect(within(dialog).getByText('Also notified: Olive')).toBeTruthy();
    expect(fetchWithAuth).toHaveBeenCalledWith(`/api/tasks/${TASK.id}/subscribers`);
  });

  it('saves the switch with the form, not on toggle', async () => {
    const onClose = vi.fn();
    renderDialog(onClose);
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    const toggle = within(dialog).getByRole('switch', { name: /Notify me about changes/ });
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
    fetchWithAuth.mockImplementation(async () => reply(201, {}));
    await userEvent.click(toggle);
    expect(fetchWithAuth).not.toHaveBeenCalledWith(`/api/tasks/${TASK.id}/subscribers`, expect.objectContaining({ method: 'POST' }));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fetchWithAuth).toHaveBeenLastCalledWith(`/api/tasks/${TASK.id}/subscribers`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ user_id: 'usr_me' }),
    }));
  });

  it('keeps the dialog open and says so when the notification change fails', async () => {
    const onClose = vi.fn();
    renderDialog(onClose);
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    const toggle = within(dialog).getByRole('switch', { name: /Notify me about changes/ });
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
    fetchWithAuth.mockImplementation(async () => reply(500));
    await userEvent.click(toggle);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText("Your edits are saved, but notifications couldn't change. Try again.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables the switch and explains when the list cannot load', async () => {
    fetchWithAuth.mockImplementation(async () => reply(500));
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    expect(await within(dialog).findByText("Couldn't load who gets notified.")).toBeTruthy();
    expect((within(dialog).getByRole('switch', { name: /Notify me about changes/ }) as HTMLInputElement).disabled).toBe(true);
  });
});
