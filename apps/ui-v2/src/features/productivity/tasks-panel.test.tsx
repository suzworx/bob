import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { TasksPanel } from './tasks-panel';
import type { TaskSummary } from '@/features/productivity/use-tasks';
import { SpacesProvider, type Space } from '@/features/spaces/use-spaces';
import { SPACE_GUTTER } from '../spaces/space-header';

// Records every Section's props so a test can read the tab root's padding:
// jsdom computes no layout, and padding={0} makes a nested Section escape the
// page gutter and start 24px left of the space name.
const sectionProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@astryxdesign/core/Section', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/Section')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Section: (props: Parameters<typeof actual.Section>[0]) => {
      sectionProps.push(props as Record<string, unknown>);
      return createElement(actual.Section, props);
    },
  };
});

function rootSectionPadding(label: string): unknown {
  return sectionProps.filter((props) => props['aria-label'] === label).at(-1)?.padding;
}

// The panel reads the caller's own id from the session; fetchWithAuth is the
// real one so route matching in tests still works against plain fetch.
vi.mock('@/lib/auth/use-session', () => ({
  useSession: () => ({ session: { user: { id: 'usr_olive' } } }),
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

// A row's actions live in one menu; its items exist only while it is open.
async function rowAction(taskTitle: string, action: string): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: `Actions for ${taskTitle}` }));
  await userEvent.click(await screen.findByRole('menuitem', { name: action }));
}

function renderPanel(space: Space): ReturnType<typeof render> {
  return render(
    <LayerProvider>
      <TasksPanel space={space} />
    </LayerProvider>,
  );
}

const OPEN_A: TaskSummary = {
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

const TIMED_A: TaskSummary = {
  ...OPEN_A,
  id: 'task_timed',
  title: 'Dentist',
  due: { kind: 'instant', at: 1756600000000, zone: 'UTC' },
};

const DONE_A: TaskSummary = {
  ...OPEN_A,
  id: 'task_done',
  title: 'Submit forms',
  status: 'completed',
  completed_at: 1756100001000,
};

const SPACE: Space = {
  id: 'spc_1',
  kind: 'group',
  name: 'Test Family',
  role: 'owner',
  membership_revision: 1,
  members: [],
  created_at: 1756100000000,
  updated_at: 1756100000000,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TasksPanel', () => {
  it('re-applies the space gutter on its root Section, so its content starts where the space name starts', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [] }));
    renderPanel(SPACE);
    await screen.findByText('No tasks yet');
    expect(screen.getByRole('region', { name: 'Tasks' })).toBeTruthy();
    expect(rootSectionPadding('Tasks')).toBe(SPACE_GUTTER);
  });

  it('has no panel heading, and names the Tasks landmark for a screen reader', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [] }));
    renderPanel(SPACE);
    await screen.findByText('No tasks yet');
    expect(screen.queryByRole('heading', { name: 'Tasks' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Tasks' })).toBeTruthy();
  });

  it('shows open tasks under Open and completed ones only under Done', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [DONE_A, OPEN_A] }));
    renderPanel(SPACE);
    expect(await screen.findByText('Buy milk')).toBeTruthy();
    expect(screen.queryByText('Submit forms')).toBeNull();
    expect(screen.queryByText(/^Completed \(/)).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Done' }));
    expect(screen.getByText('Submit forms')).toBeTruthy();
  });

  it('offers exactly Open, Mine and Done, with Deleted in the list menu', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [OPEN_A] }));
    renderPanel(SPACE);
    await screen.findByText('Buy milk');
    const segments = within(screen.getByRole('radiogroup', { name: 'Show tasks' })).getAllByRole('radio');
    expect(segments.map((radio) => radio.getAttribute('aria-label') ?? radio.textContent)).toEqual(['Open', 'Mine', 'Done']);
    await userEvent.click(screen.getByRole('button', { name: 'Task list options' }));
    expect(await screen.findByRole('menuitem', { name: 'Recently deleted' })).toBeTruthy();
  });

  it('gives each row one actions menu, with Delete last, and no edit or delete icons at rest', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [OPEN_A, TIMED_A] }));
    renderPanel(SPACE);
    await screen.findByText('Buy milk');
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Actions for / })).toHaveLength(2);
    // Nothing of the menu is mounted until it opens.
    expect(screen.queryAllByRole('menuitem', { hidden: true })).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Buy milk' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Edit', 'Delete']);
  });

  it('says nothing about a due on a task that has none', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [{ ...OPEN_A, due: null }] }));
    const { container } = renderPanel(SPACE);
    await screen.findByText('Buy milk');
    expect(container.textContent).not.toContain('No due');
  });

  it('renders a date-only due with no time shown', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [OPEN_A] }));
    renderPanel(SPACE);
    await screen.findByText('Buy milk');
    expect(screen.queryByText(/\d{1,2}:\d{2}/)).toBeNull();
  });

  it('renders a timed due with its time', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [TIMED_A] }));
    renderPanel(SPACE);
    await screen.findByText('Dentist');
    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeTruthy();
  });

  it('completes a task with a PATCH and updates optimistically', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [OPEN_A] }));
    fetchMock.mockResolvedValueOnce(json(200, { ...OPEN_A, status: 'completed' }));
    renderPanel(SPACE);
    const checkbox = await screen.findByRole('checkbox', { name: 'Complete Buy milk' });
    await userEvent.click(checkbox);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${OPEN_A.id}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ revision: 1, status: 'completed' }) }),
    );
  });

  it('confirms a completion with a toast whose Undo reopens the task', async () => {
    const patches: unknown[] = [];
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
      'PATCH /api/tasks/task_aaa': (init) => {
        const body = JSON.parse(String(init?.body)) as { status: string };
        patches.push(body);
        return json(200, { ...OPEN_A, status: body.status, revision: patches.length + 1 });
      },
    });
    renderPanel(SPACE);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Complete Buy milk' }));
    expect((await screen.findAllByText('Completed Buy milk')).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Undo', hidden: true }));
    await waitFor(() => expect(patches).toEqual([
      { revision: 1, status: 'completed' },
      { revision: 2, status: 'open' },
    ]));
    expect(await screen.findByText('Buy milk')).toBeTruthy();
  });

  it('adds a task by calling createTask', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [] }));
    fetchMock.mockResolvedValueOnce(json(200, OPEN_A));
    renderPanel(SPACE);
    const input = await screen.findByPlaceholderText('Add a task');
    await userEvent.type(input, 'Buy milk');
    const button = screen.getByRole('button', { name: 'Add task' });
    await userEvent.click(button);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/spaces/${SPACE.id}/tasks`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ title: 'Buy milk' }) }),
    );
  });

  it('adds a task when Enter is pressed in the name input', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [] }));
    fetchMock.mockResolvedValueOnce(json(200, OPEN_A));
    renderPanel(SPACE);
    const input = await screen.findByPlaceholderText('Add a task');
    await userEvent.type(input, 'Buy milk');
    await userEvent.keyboard('{Enter}');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/spaces/${SPACE.id}/tasks`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ title: 'Buy milk' }) }),
    );
  });

  it('sends one POST for two rapid Enter presses while the create is in flight', async () => {
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [] }));
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    renderPanel(SPACE);
    const input = await screen.findByRole('textbox', { name: 'New task' });
    await userEvent.type(input, 'Buy milk');
    await userEvent.keyboard('{Enter}{Enter}');

    const posts = () =>
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(posts()).toHaveLength(1);
    const add = screen.getByRole('button', { name: 'Add task' });
    expect((add as HTMLButtonElement).disabled || add.getAttribute('aria-disabled') === 'true').toBe(true);

    release(json(200, OPEN_A));
    expect(await screen.findByText('Buy milk')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('');
    expect(posts()).toHaveLength(1);
  });

  it('rolls back a refused toggle and says so in a toast', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
      'PATCH /api/tasks/task_aaa': () =>
        json(409, { error: { code: 'conflict', current_revision: 3, message: 'task revision conflict' } }),
    });
    renderPanel(SPACE);
    const checkbox = await screen.findByRole('checkbox', { name: 'Complete Buy milk' });
    await userEvent.click(checkbox);
    expect((await screen.findAllByText('This task changed elsewhere, so your change was not saved. The list now shows the latest.')).length).toBeGreaterThan(0);
    await waitFor(() => {
      const updatedCheckbox = screen.getByRole('checkbox', { name: 'Complete Buy milk' });
      expect(updatedCheckbox).toHaveProperty('checked', false);
    });
  });

  it('starts with the add row and an empty state whose action focuses it', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [] }));
    renderPanel(SPACE);
    expect(await screen.findByText('No tasks yet')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a task' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'New task' }));
  });

  it('shows a load error with Retry, which loads the list again', async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: { code: 'server_error' } }));
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [OPEN_A] }));
    renderPanel(SPACE);
    expect(await screen.findByText('Tasks could not be loaded.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Buy milk')).toBeTruthy();
  });

  it('keeps the due date and assignee off the add row until there is a title', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [] }));
    renderPanel(TEAM);
    const input = await screen.findByRole('textbox', { name: 'New task' });
    expect(screen.queryByRole('combobox', { name: 'Due date for new task' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Assignee for new task' })).toBeNull();
    await userEvent.type(input, 'B');
    expect(screen.getByRole('combobox', { name: 'Due date for new task' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Assignee for new task' })).toBeTruthy();
  });

  it('hides the assignee on the add row in a space of one', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [] }));
    renderPanel({ ...SPACE, members: [OLIVE] });
    await userEvent.type(await screen.findByRole('textbox', { name: 'New task' }), 'Buy milk');
    expect(screen.queryByRole('combobox', { name: 'Assignee for new task' })).toBeNull();
  });
});

type Member = Space['members'][number];

const OLIVE: Member = {
  user_id: 'usr_olive',
  role: 'owner',
  joined_at: 1,
  display_name: 'Olive',
  handle: 'olive',
  email: 'olive@example.com',
};
const BEN: Member = {
  user_id: 'usr_ben',
  role: 'member',
  joined_at: 2,
  display_name: null,
  handle: 'ben',
  email: 'ben@example.com',
};
const TEAM: Space = { ...SPACE, members: [OLIVE, BEN] };

// A resting row shows who holds the task as text, never an open dropdown:
// assigning goes through the row's edit affordance, whose dialog owns the one
// assignee Selector. Its options open in a popup, outside the dialog's subtree.
async function chooseAssignee(taskTitle: string, option: string): Promise<void> {
  await rowAction(taskTitle, 'Edit');
  const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
  await userEvent.click(within(dialog).getByRole('combobox', { name: 'Assignee' }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
}

// The assignee a row shows at rest, or null when nobody holds the task.
function rowAssignee(taskTitle: string): string | null {
  const row = screen.getByRole('checkbox', { name: `Complete ${taskTitle}` }).closest('li');
  const token = row?.querySelector('[class*="astryx-token"]');
  return token === null || token === undefined ? null : token.textContent;
}

function patchBodies(): unknown[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

type Handler = (init: RequestInit | undefined) => Response;

// Answers by "METHOD url"; anything unrouted is a 404 so a stray request fails
// loudly, except an unrouted checklist GET (the edit dialog always fetches
// one), which answers with an empty list so tests that don't care about the
// checklist aren't forced to route it.
function routeFetch(routes: Record<string, Handler>): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const handler = routes[`${method} ${String(input)}`];
    if (handler) return handler(init);
    if (method === 'GET' && String(input).endsWith('/items')) return json(200, { items: [] });
    return json(404, { error: { code: 'not_found' } });
  });
}

// jsdom has no modal <dialog>; the Astryx Dialog calls showModal() on open.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

describe('TasksPanel assignees', () => {
  it('shows the assignee by display name, by handle, or as Someone, never a raw id', async () => {
    const assigned = (task: TaskSummary, id: string): TaskSummary => ({ ...task, assignee_user_id: id });
    fetchMock.mockResolvedValueOnce(
      json(200, {
        tasks: [
          assigned(OPEN_A, 'usr_olive'),
          assigned({ ...OPEN_A, id: 'task_ben', title: 'Call Ben' }, 'usr_ben'),
          assigned(TIMED_A, 'usr_left_the_space'),
          assigned(DONE_A, 'usr_ben'),
        ],
      }),
    );
    const { container } = renderPanel(TEAM);
    await screen.findByText('Buy milk');

    // Olive has a display_name; Ben has only a handle; a user who has since
    // left the space matches no member and falls back to the neutral word.
    expect(rowAssignee('Buy milk')).toContain('Olive');
    expect(rowAssignee('Call Ben')).toContain('@ben');
    expect(rowAssignee('Dentist')).toContain('Someone');
    for (const row of screen.getAllByRole('listitem')) {
      expect(within(row).queryByRole('combobox')).toBeNull();
    }
    // A completed task reads the same way — the row never grows a control.
    await userEvent.click(screen.getByRole('radio', { name: 'Done' }));
    expect(rowAssignee('Submit forms')).toContain('@ben');
    expect(container.textContent).not.toContain('usr_left_the_space');
    expect(container.textContent).not.toContain('usr_olive');
    expect(container.textContent).not.toContain('usr_ben');
  });

  it('says nothing at all on a row nobody holds, rather than "Unassigned"', async () => {
    routeFetch({ 'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }) });
    renderPanel(TEAM);
    await screen.findByText('Buy milk');
    expect(rowAssignee('Buy milk')).toBeNull();

    // The dialog is where the assignee is set, and there it reads "Unassigned".
    await rowAction('Buy milk', 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    expect(within(dialog).getByRole('combobox', { name: 'Assignee' }).textContent).toContain('Unassigned');
  });

  it('assigns a member with the task revision', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [{ ...OPEN_A, revision: 4 }] }),
      'PATCH /api/tasks/task_aaa': () => json(200, { ...OPEN_A, revision: 5, assignee_user_id: 'usr_olive' }),
    });
    renderPanel(TEAM);
    await chooseAssignee('Buy milk', 'Olive');

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${OPEN_A.id}`,
      expect.objectContaining({ method: 'PATCH' }),
    );
    expect(patchBodies()).toEqual([{ revision: 4, assignee_user_id: 'usr_olive' }]);
    await waitFor(() => expect(rowAssignee('Buy milk')).toContain('Olive'));
  });

  it('sends a null assignee when Unassigned is chosen', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () =>
        json(200, { tasks: [{ ...OPEN_A, revision: 7, assignee_user_id: 'usr_olive' }] }),
      'PATCH /api/tasks/task_aaa': () => json(200, { ...OPEN_A, revision: 8 }),
    });
    renderPanel(TEAM);
    await chooseAssignee('Buy milk', 'Unassigned');

    expect(patchBodies()).toEqual([{ revision: 7, assignee_user_id: null }]);
    await waitFor(() => expect(rowAssignee('Buy milk')).toBeNull());
  });

  it('keeps a refused assignment off the row and says so in the dialog', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
      'PATCH /api/tasks/task_aaa': () =>
        json(409, { error: { code: 'conflict', current_revision: 3, message: 'task revision conflict' } }),
    });
    renderPanel(TEAM);
    await chooseAssignee('Buy milk', 'Olive');

    expect(
      await screen.findByText('This task changed elsewhere. Your edits are kept — save again to apply them.'),
    ).toBeTruthy();
    await waitFor(() => expect(rowAssignee('Buy milk')).toBeNull());
  });

  it('retries a task edit after a 409 with the latest revision', async () => {
    let patchCall = 0;
    let getCall = 0;
    const patchBodies: unknown[] = [];
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => {
        getCall += 1;
        return json(200, { tasks: [{ ...OPEN_A, revision: getCall === 1 ? 2 : 3 }] });
      },
      'PATCH /api/tasks/task_aaa': (init) => {
        patchCall += 1;
        patchBodies.push(JSON.parse(String(init?.body)));
        return patchCall === 1
          ? json(409, { error: { code: 'conflict', current_revision: 3, message: 'task revision conflict' } })
          : json(200, { ...OPEN_A, revision: 4, title: 'Buy oat milk' });
      },
    });
    renderPanel(SPACE);
    await screen.findByText('Buy milk');
    await rowAction('Buy milk', 'Edit');

    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    const titleInput = within(dialog).getByRole('textbox', { name: 'Title' });
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Buy oat milk');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await screen.findByText(
      'This task changed elsewhere. Your edits are kept — save again to apply them.',
    );
    await waitFor(() => expect(getCall).toBe(2));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[1]).toEqual({ revision: 3, title: 'Buy oat milk' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('uses the standard conflict copy when the 409 carries no message', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
      'PATCH /api/tasks/task_aaa': () => json(409, {}),
    });
    renderPanel(TEAM);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Complete Buy milk' }));

    expect(
      (await screen.findAllByText('This task changed elsewhere, so your change was not saved. The list now shows the latest.')).length,
    ).toBeGreaterThan(0);
  });

  it('leaves the row unassigned and says so when the assigning PATCH fails', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
      'PATCH /api/tasks/task_aaa': () => json(500, { error: { code: 'server_error' } }),
    });
    renderPanel(TEAM);
    await chooseAssignee('Buy milk', 'Olive');

    expect(await screen.findByText('The task could not be saved.')).toBeTruthy();
    expect(rowAssignee('Buy milk')).toBeNull();
  });

  it('lets the add form pick an assignee, then goes back to Unassigned', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [] }));
    fetchMock.mockResolvedValueOnce(json(200, { ...OPEN_A, assignee_user_id: 'usr_ben' }));
    renderPanel(TEAM);
    await userEvent.type(await screen.findByPlaceholderText('Add a task'), 'Buy milk');
    await userEvent.click(screen.getByRole('combobox', { name: 'Assignee for new task' }));
    await userEvent.click(await screen.findByRole('option', { name: '@ben' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await screen.findByText('Buy milk');
    await waitFor(() => expect(rowAssignee('Buy milk')).toContain('@ben'));
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({
      title: 'Buy milk',
      assignee_user_id: 'usr_ben',
    });
    // The row folds back to one line, and the next task starts unassigned.
    expect(screen.queryByRole('combobox', { name: 'Assignee for new task' })).toBeNull();
    await userEvent.type(screen.getByRole('textbox', { name: 'New task' }), 'Next');
    expect(screen.getByRole('combobox', { name: 'Assignee for new task' }).textContent).toContain('Unassigned');
  });
});

describe('TasksPanel refresh on focus', () => {
  const WATER: TaskSummary = { ...OPEN_A, id: 'task_water', title: 'Water plants' };

  function returnToTab(): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('refetches the tasks when the tab becomes visible again', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [OPEN_A] }));
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [OPEN_A, WATER] }));
    renderPanel(TEAM);
    await screen.findByText('Buy milk');
    expect(screen.queryByText('Water plants')).toBeNull();

    returnToTab();

    expect(await screen.findByText('Water plants')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the list on screen while it refetches', async () => {
    let release: () => void = () => undefined;
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [OPEN_A] }));
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = () => resolve(json(200, { tasks: [OPEN_A, WATER] }));
      }),
    );
    renderPanel(TEAM);
    await screen.findByText('Buy milk');

    returnToTab();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(screen.getByText('Buy milk')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Loading tasks' })).toBeNull();
    await act(async () => {
      release();
    });
    expect(await screen.findByText('Water plants')).toBeTruthy();
  });
});

describe('TasksPanel edit', () => {
  it('edits a title through the dialog and sends a PATCH with only the change', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [{ ...OPEN_A, revision: 4 }] }),
      'PATCH /api/tasks/task_aaa': () => json(200, { ...OPEN_A, revision: 5, title: 'Buy oat milk' }),
    });
    renderPanel(SPACE);
    await screen.findByText('Buy milk');
    await rowAction('Buy milk', 'Edit');

    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    const titleInput = within(dialog).getByRole('textbox', { name: 'Title' });
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Buy oat milk');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(patchBodies()).toEqual([{ revision: 4, title: 'Buy oat milk' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Buy oat milk')).toBeTruthy();
  });

  it('keeps the dialog open with the warning on a 409 and does not lose the typed title', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
      'PATCH /api/tasks/task_aaa': () =>
        json(409, { error: { code: 'conflict', current_revision: 3, message: 'task revision conflict' } }),
    });
    renderPanel(SPACE);
    await screen.findByText('Buy milk');
    await rowAction('Buy milk', 'Edit');

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
    expect(screen.getByRole('dialog', { name: 'Edit task' })).toBeTruthy();
    expect((titleInput as HTMLInputElement).value).toBe('Buy oat milk');
    const gets = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === undefined || (init as RequestInit | undefined)?.method === 'GET')
      .map(([url]) => String(url));
    // updateTask reloads the task list on a conflict: the initial load plus
    // one reload. The dialog's own reads (checklist, followers) stay unaffected.
    expect(gets.filter((url) => url === '/api/spaces/spc_1/tasks')).toHaveLength(2);
  });

  it('closes the dialog with no PATCH when Cancel is clicked', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
    });
    renderPanel(SPACE);
    await screen.findByText('Buy milk');
    await rowAction('Buy milk', 'Edit');

    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(patchBodies()).toEqual([]);
  });

  it('shows the checklist and fetches it when the dialog opens', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
      'GET /api/tasks/task_aaa/items': () => json(200, { items: [] }),
    });
    renderPanel(SPACE);
    await screen.findByText('Buy milk');
    await rowAction('Buy milk', 'Edit');

    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    expect(await within(dialog).findByText('Checklist')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task_aaa/items', undefined);
  });
});

describe('TasksPanel delete', () => {
  it('deletes from the row menu with no confirmation, then undoes it from the toast', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
      'DELETE /api/tasks/task_aaa': () => new Response(null, { status: 204 }),
      'POST /api/tasks/task_aaa/restore': () => json(200, { ...OPEN_A, revision: 3 }),
    });
    renderPanel(SPACE);
    await screen.findByText('Buy milk');
    await rowAction('Buy milk', 'Delete');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(screen.queryByText('Buy milk')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task_aaa',
      expect.objectContaining({ method: 'DELETE' }),
    );

    // The toast's visible body and its screen-reader live-region
    // announcement both carry the same text, so this matches two elements.
    expect((await screen.findAllByText('Deleted Buy milk')).length).toBeGreaterThan(0);
    // jsdom applies the native `[popover]:not(:popover-open) { display: none }`
    // UA rule but never implements showPopover(), so the toast viewport (which
    // uses popover="manual") stays permanently excluded from the a11y tree in
    // tests even though it's genuinely in the DOM — `hidden: true` opts back in.
    await userEvent.click(screen.getByRole('button', { name: 'Undo', hidden: true }));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task_aaa/restore',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await screen.findByText('Buy milk')).toBeTruthy();
  });

  it('keeps the task and says so when the delete fails', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
      'DELETE /api/tasks/task_aaa': () => json(500, { error: { code: 'server_error' } }),
    });
    renderPanel(SPACE);
    await screen.findByText('Buy milk');
    await rowAction('Buy milk', 'Delete');

    expect((await screen.findAllByText('The task could not be deleted.')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Buy milk')).toBeTruthy();
  });

  it('deletes from the edit dialog footer and closes it', async () => {
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
      'DELETE /api/tasks/task_aaa': () => new Response(null, { status: 204 }),
    });
    renderPanel(SPACE);
    await rowAction('Buy milk', 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await screen.findAllByText('Deleted Buy milk')).length).toBeGreaterThan(0);
  });
});

describe('TasksPanel deep link', () => {
  it('highlights and scrolls to the focused task, switching to Done when it is completed', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [OPEN_A, DONE_A] }));
    render(<LayerProvider><TasksPanel space={SPACE} focusTaskId={DONE_A.id} /></LayerProvider>);
    const row = (await screen.findByRole('checkbox', { name: 'Complete Submit forms' })).closest('li');
    expect(row?.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Done' }).getAttribute('aria-checked')).toBe('true');
    expect(scrolled).toHaveBeenCalledTimes(1);
  });
});

describe('TasksPanel open and move', () => {
  it('moves a task to another space from the row menu and says where it went', async () => {
    const WORK: Space = { ...SPACE, id: 'spc_2', name: 'Work' };
    const patches: unknown[] = [];
    routeFetch({
      'GET /api/spaces': () => json(200, { spaces: [SPACE, WORK].map(({ members: _m, ...summary }) => summary) }),
      'GET /api/spaces/spc_1/members': () => json(200, { members: [] }),
      'GET /api/spaces/spc_2/members': () => json(200, { members: [] }),
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
      'PATCH /api/tasks/task_aaa': (init) => {
        patches.push(JSON.parse(String(init?.body)));
        return json(200, { ...OPEN_A, space_id: 'spc_2', revision: 2 });
      },
    });
    render(<LayerProvider><SpacesProvider><TasksPanel space={SPACE} /></SpacesProvider></LayerProvider>);
    await screen.findByText('Buy milk');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/spaces/spc_2/members', undefined));
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Buy milk' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Work' }));

    await waitFor(() => expect(patches).toEqual([{ revision: 1, space_id: 'spc_2' }]));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Complete Buy milk' })).toBeNull());
    expect((await screen.findAllByText('Moved Buy milk to Work')).length).toBeGreaterThan(0);
  });

  it('opens the edit dialog when the row itself is clicked', async () => {
    routeFetch({ 'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }) });
    renderPanel(SPACE);
    await userEvent.click(await screen.findByText('Buy milk'));
    expect(await screen.findByRole('dialog', { name: 'Edit task' })).toBeTruthy();
  });
});

describe('TasksPanel due date', () => {
  it('sets a due date when adding a task', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [] }));
    fetchMock.mockResolvedValueOnce(json(200, OPEN_A));
    renderPanel(SPACE);
    await userEvent.type(await screen.findByPlaceholderText('Add a task'), 'Buy milk');
    await userEvent.type(
      screen.getByRole('combobox', { name: 'Due date for new task' }),
      '2026-10-01',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));

    const posts = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({
      title: 'Buy milk',
      due: { kind: 'date', date: '2026-10-01' },
    });
  });
});

describe('TasksPanel view filters', () => {
  it('Mine shows only open tasks assigned to usr_olive', async () => {
    const mine = { ...OPEN_A, id: 'task_mine', title: 'Mine task', assignee_user_id: 'usr_olive' };
    const other = { ...OPEN_A, id: 'task_other', title: 'Other task', assignee_user_id: 'usr_ben' };
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [mine, other] }));
    renderPanel(SPACE);
    await screen.findByText('Other task');

    await userEvent.click(screen.getByRole('radio', { name: 'Mine' }));

    expect(screen.getByText('Mine task')).toBeTruthy();
    expect(screen.queryByText('Other task')).toBeNull();
  });

  it('Done shows completed tasks with no Completed (n) trigger', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [OPEN_A, DONE_A] }));
    renderPanel(SPACE);
    await screen.findByText('Buy milk');

    await userEvent.click(screen.getByRole('radio', { name: 'Done' }));

    expect(screen.getByText('Submit forms')).toBeTruthy();
    expect(screen.queryByText(/^Completed \(/)).toBeNull();
  });

  it('sorts by due date when Due date is chosen', async () => {
    const later = { ...OPEN_A, id: 'task_later', title: 'Later task', due: { kind: 'date' as const, date: '2026-12-01' } };
    const earlier = { ...OPEN_A, id: 'task_earlier', title: 'Earlier task', due: { kind: 'date' as const, date: '2026-10-01' } };
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [later, earlier] }));
    renderPanel(SPACE);
    await screen.findByText('Later task');

    await userEvent.click(screen.getByRole('combobox', { name: 'Sort tasks' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Due date' }));

    const earlierBox = screen.getByRole('checkbox', { name: 'Complete Earlier task' });
    const laterBox = screen.getByRole('checkbox', { name: 'Complete Later task' });
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.indexOf(earlierBox)).toBeLessThan(checkboxes.indexOf(laterBox));
  });
});

async function openDeleted(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Task list options' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Recently deleted' }));
}

describe('TasksPanel deleted view', () => {
  it('loads deleted tasks with GET ?trashed=true and lists them', async () => {
    const trashed = { ...OPEN_A, id: 'task_trashed', title: 'Trashed task', trashed_at: 1756200000000 };
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [OPEN_A] }),
      'GET /api/spaces/spc_1/tasks?trashed=true': () => json(200, { tasks: [trashed] }),
    });
    renderPanel(SPACE);
    await screen.findByText('Buy milk');

    await openDeleted();

    expect(await screen.findByText('Trashed task')).toBeTruthy();
    expect(screen.queryByText('Buy milk')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/spaces/spc_1/tasks?trashed=true', undefined);
  });

  it('restores a task from Deleted, then shows it again in Open', async () => {
    const trashed = { ...OPEN_A, id: 'task_trashed', title: 'Trashed task', trashed_at: 1756200000000 };
    routeFetch({
      'GET /api/spaces/spc_1/tasks': () => json(200, { tasks: [] }),
      'GET /api/spaces/spc_1/tasks?trashed=true': () => json(200, { tasks: [trashed] }),
      'POST /api/tasks/task_trashed/restore': () => json(200, { ...trashed, trashed_at: null }),
    });
    renderPanel(SPACE);
    await screen.findByText('No tasks yet');
    await openDeleted();
    await screen.findByText('Trashed task');
    expect(screen.queryByRole('textbox', { name: 'New task' })).toBeNull();

    await rowAction('Trashed task', 'Restore');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task_trashed/restore',
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => expect(screen.queryByText('Trashed task')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Back to tasks' }));
    expect(await screen.findByText('Trashed task')).toBeTruthy();
  });
});

// #874: the row itself says a task is overdue, in every view, not only under the
// Overdue filter. Local-time constructors keep the cases true in any time zone.
describe('TasksPanel overdue marker', () => {
  const NOW = new Date(2026, 9, 6, 12, 0);

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function rowOf(title: string): HTMLElement {
    const row = screen.getByText(title).closest('li');
    if (row === null) throw new Error(`no row for ${title}`);
    return row;
  }

  function hasOverdueMarker(title: string): boolean {
    return within(rowOf(title)).queryByText('Overdue') !== null;
  }

  it('marks an open task whose due time has passed', async () => {
    const pastTimed = {
      ...OPEN_A,
      id: 'task_past',
      title: 'Past timed',
      due: { kind: 'instant' as const, at: new Date(2026, 9, 6, 9, 0).getTime(), zone: 'UTC' },
    };
    const pastDate = { ...OPEN_A, id: 'task_past_date', title: 'Past date', due: { kind: 'date' as const, date: '2026-10-05' } };
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [pastTimed, pastDate] }));
    renderPanel(SPACE);
    await screen.findByText('Past timed');

    expect(hasOverdueMarker('Past timed')).toBe(true);
    expect(hasOverdueMarker('Past date')).toBe(true);
  });

  it('does not mark a date-only task due today until that day has ended', async () => {
    const today = { ...OPEN_A, id: 'task_today', title: 'Due today', due: { kind: 'date' as const, date: '2026-10-06' } };
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [today] }));
    renderPanel(SPACE);
    await screen.findByText('Due today');

    expect(hasOverdueMarker('Due today')).toBe(false);
  });

  it('does not mark a task due in the future or a task with no due', async () => {
    const future = {
      ...OPEN_A,
      id: 'task_future',
      title: 'Later today',
      due: { kind: 'instant' as const, at: new Date(2026, 9, 6, 15, 0).getTime(), zone: 'UTC' },
    };
    const noDue = { ...OPEN_A, id: 'task_none', title: 'Someday', due: null };
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [future, noDue] }));
    renderPanel(SPACE);
    await screen.findByText('Later today');

    expect(hasOverdueMarker('Later today')).toBe(false);
    expect(hasOverdueMarker('Someday')).toBe(false);
  });

  it('never marks a completed task, however long past its due', async () => {
    const donePast = { ...DONE_A, id: 'task_done_past', title: 'Done long ago', due: { kind: 'date' as const, date: '2020-01-01' } };
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [OPEN_A, donePast] }));
    renderPanel(SPACE);
    await screen.findByText('Buy milk');

    await userEvent.click(screen.getByRole('radio', { name: 'Done' }));

    expect(hasOverdueMarker('Done long ago')).toBe(false);
  });
});
