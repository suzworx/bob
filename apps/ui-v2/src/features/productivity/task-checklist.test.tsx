import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskChecklist } from './task-checklist';
import type { TaskSummary } from '@/features/productivity/use-tasks';

const TASK_ID = 'task_aaa';

const ITEM_1: TaskSummary = {
  id: 'item_1',
  space_id: 'spc_1',
  parent_task_id: TASK_ID,
  title: 'step one',
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
  created_at: 1756100000000,
  updated_at: 1756100000000,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Handler = (init: RequestInit | undefined) => Response;

// Answers by "METHOD url"; anything unrouted is a 404 so a stray request fails loudly.
function routeFetch(routes: Record<string, Handler>): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const handler = routes[`${init?.method ?? 'GET'} ${String(input)}`];
    return handler ? handler(init) : json(404, { error: { code: 'not_found' } });
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

describe('TaskChecklist', () => {
  it('lists items from the task', async () => {
    routeFetch({
      [`GET /api/tasks/${TASK_ID}/items`]: () => json(200, { items: [ITEM_1] }),
    });
    render(<TaskChecklist taskId={TASK_ID} />);
    expect(await screen.findByRole('checkbox', { name: 'step one' })).toBeTruthy();
  });

  it('ticking an item sends a PATCH with its revision and completed status', async () => {
    routeFetch({
      [`GET /api/tasks/${TASK_ID}/items`]: () => json(200, { items: [ITEM_1] }),
      [`PATCH /api/tasks/${ITEM_1.id}`]: () => json(200, { ...ITEM_1, status: 'completed', revision: 2 }),
    });
    render(<TaskChecklist taskId={TASK_ID} />);
    const checkbox = await screen.findByRole('checkbox', { name: 'step one' });
    await userEvent.click(checkbox);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${ITEM_1.id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ revision: 1, status: 'completed' }),
      }),
    );
  });

  it('removing an item sends a DELETE and the row disappears', async () => {
    routeFetch({
      [`GET /api/tasks/${TASK_ID}/items`]: () => json(200, { items: [ITEM_1] }),
      [`DELETE /api/tasks/${ITEM_1.id}`]: () => new Response(null, { status: 204 }),
    });
    render(<TaskChecklist taskId={TASK_ID} />);
    await screen.findByRole('checkbox', { name: 'step one' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove step one' }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${ITEM_1.id}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
    await vi.waitFor(() => expect(screen.queryByRole('checkbox', { name: 'step one' })).toBeNull());
  });

  it('typing a title and pressing Enter adds one item', async () => {
    const created: TaskSummary = { ...ITEM_1, id: 'item_2', title: 'step two', order_key: 'b' };
    routeFetch({
      [`GET /api/tasks/${TASK_ID}/items`]: () => json(200, { items: [] }),
      [`POST /api/tasks/${TASK_ID}/items`]: () => json(201, created),
    });
    render(<TaskChecklist taskId={TASK_ID} />);
    await screen.findByText('No items yet.');
    const input = screen.getByPlaceholderText('Add an item…');
    await userEvent.type(input, 'step two');
    await userEvent.keyboard('{Enter}');

    const posts = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({ title: 'step two' });
    expect(await screen.findByRole('checkbox', { name: 'step two' })).toBeTruthy();
  });

  it('shows an error when the checklist fails to load', async () => {
    routeFetch({
      [`GET /api/tasks/${TASK_ID}/items`]: () => json(500, { error: { code: 'server_error' } }),
    });
    render(<TaskChecklist taskId={TASK_ID} />);
    expect(await screen.findByText('The checklist could not be loaded.')).toBeTruthy();
  });

  describe('reordering (#510)', () => {
    const A: TaskSummary = { ...ITEM_1, id: 'item_a', title: 'step A', order_key: 'a' };
    const B: TaskSummary = { ...ITEM_1, id: 'item_b', title: 'step B', order_key: 'b' };
    const C: TaskSummary = { ...ITEM_1, id: 'item_c', title: 'step C', order_key: 'c' };

    // Row order, read from each row's "Move up <title>" control.
    const titles = (): string[] =>
      screen
        .getAllByRole('button', { name: /^Move up / })
        .map((button) => (button.getAttribute('aria-label') ?? '').slice('Move up '.length));

    const isDisabled = (element: HTMLElement): boolean =>
      (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true';

    it('Move up works from the keyboard, keeps focus and announces the new position', async () => {
      routeFetch({
        [`GET /api/tasks/${TASK_ID}/items`]: () => json(200, { items: [A, B, C] }),
        [`PATCH /api/tasks/${TASK_ID}/items/${C.id}`]: () => json(200, { ...C, order_key: 'aU', revision: 2 }),
      });
      render(<TaskChecklist taskId={TASK_ID} />);
      await screen.findByRole('checkbox', { name: 'step C' });
      expect(isDisabled(screen.getByRole('button', { name: 'Move up step A' }))).toBe(true);
      expect(isDisabled(screen.getByRole('button', { name: 'Move down step C' }))).toBe(true);
      screen.getByRole('button', { name: 'Move up step C' }).focus();
      await userEvent.keyboard('{Enter}');

      expect(fetchMock).toHaveBeenCalledWith(
        `/api/tasks/${TASK_ID}/items/${C.id}`,
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ before_item_id: B.id, revision: 1 }) }),
      );
      expect(await screen.findByText('Moved step C to position 2 of 3.')).toBeTruthy();
      expect(titles()).toEqual(['step A', 'step C', 'step B']);
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Move up step C');
    });

    it('Move down works with the Space key and sends the after anchor', async () => {
      routeFetch({
        [`GET /api/tasks/${TASK_ID}/items`]: () => json(200, { items: [A, B, C] }),
        [`PATCH /api/tasks/${TASK_ID}/items/${A.id}`]: () => json(200, { ...A, order_key: 'bU', revision: 2 }),
      });
      render(<TaskChecklist taskId={TASK_ID} />);
      await screen.findByRole('checkbox', { name: 'step A' });
      screen.getByRole('button', { name: 'Move down step A' }).focus();
      await userEvent.keyboard(' ');

      expect(fetchMock).toHaveBeenCalledWith(
        `/api/tasks/${TASK_ID}/items/${A.id}`,
        expect.objectContaining({ body: JSON.stringify({ after_item_id: B.id, revision: 1 }) }),
      );
      expect(await screen.findByText('Moved step A to position 2 of 3.')).toBeTruthy();
    });

    it('a 409 reloads the server order and keeps the unsaved item text', async () => {
      let reads = 0;
      routeFetch({
        [`GET /api/tasks/${TASK_ID}/items`]: () => {
          reads += 1;
          return json(200, { items: reads === 1 ? [A, B, C] : [{ ...C, order_key: '0', revision: 2 }, A, B] });
        },
        [`PATCH /api/tasks/${TASK_ID}/items/${B.id}`]: () =>
          json(409, { error: { code: 'conflict', current_revision: 2 } }),
      });
      render(<TaskChecklist taskId={TASK_ID} />);
      await screen.findByRole('checkbox', { name: 'step B' });
      const input = screen.getByPlaceholderText('Add an item…') as HTMLInputElement;
      await userEvent.type(input, 'half-typed item');
      await userEvent.click(screen.getByRole('button', { name: 'Move down step B' }));

      expect(await screen.findByText('This checklist changed elsewhere. It has been refreshed.')).toBeTruthy();
      await vi.waitFor(() => expect(titles()).toEqual(['step C', 'step A', 'step B']));
      expect((screen.getByPlaceholderText('Add an item…') as HTMLInputElement).value).toBe('half-typed item');
    });
  });
});
