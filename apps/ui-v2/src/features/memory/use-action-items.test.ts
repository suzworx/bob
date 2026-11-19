import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

import { useActionItems } from './use-action-items';
import type { ActionItem } from './memory-api';

const DUE_AT = 1756600000000;
const OPEN: ActionItem = {
  id: 'act_1',
  memory_id: 'mem_1',
  content: 'Call the dentist',
  confidence: 0.8,
  status: 'open',
  due_at: DUE_AT,
  created_at: 1756100000000,
  updated_at: 1756100000000,
};
const SECOND: ActionItem = { ...OPEN, id: 'act_2', memory_id: 'mem_2', content: 'Renew passport', due_at: null };
const DONE: ActionItem = { ...OPEN, id: 'act_3', status: 'done' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function serve(handlers: Record<string, Handler>): void {
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const handler = handlers[`${init?.method ?? 'GET'} ${url}`];
    if (!handler) throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    return handler(init);
  });
}

const LIST = { 'GET /api/action-items': () => json(200, { action_items: [OPEN, SECOND, DONE] }) };
const SPACES = {
  'GET /api/spaces': () =>
    json(200, {
      spaces: [
        { id: 'spc_family', kind: 'group', name: 'Family' },
        { id: 'spc_me', kind: 'private', name: 'Personal' },
      ],
    }),
};

function patchStatus(): Handler & { mock: { calls: [RequestInit?][] } } {
  return vi.fn((init?: RequestInit) => {
    const { status } = JSON.parse(String(init?.body)) as { status: ActionItem['status'] };
    return json(200, { ...OPEN, status });
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

async function loaded(): Promise<ReturnType<typeof renderHook<ReturnType<typeof useActionItems>, unknown>>> {
  const hook = renderHook(() => useActionItems());
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

describe('useActionItems', () => {
  it('lists open items only', async () => {
    serve(LIST);
    const { result } = await loaded();
    expect(result.current.items.map((item) => item.id)).toEqual(['act_1', 'act_2']);
    expect(result.current.error).toBeNull();
  });

  it('reports a load failure, and memory being off separately', async () => {
    serve({ 'GET /api/action-items': () => json(500, {}) });
    const failed = await loaded();
    expect(failed.result.current.error).toBe('load_failed');
    serve({ 'GET /api/action-items': () => json(503, {}) });
    const off = await loaded();
    expect(off.result.current.isUnavailable).toBe(true);
    expect(off.result.current.error).toBeNull();
  });

  it('complete and dismiss drop the item; undo puts it back in its place', async () => {
    const patch = patchStatus();
    serve({ ...LIST, 'PATCH /api/action-items/act_1': patch, 'PATCH /api/action-items/act_2': patch });
    const { result } = await loaded();
    await act(async () => {
      expect(await result.current.complete('act_1')).toBe(true);
    });
    expect(result.current.items.map((item) => item.id)).toEqual(['act_2']);
    await act(async () => {
      expect(await result.current.undo('act_1')).toBe(true);
    });
    expect(result.current.items.map((item) => item.id)).toEqual(['act_1', 'act_2']);
    await act(async () => {
      await result.current.dismiss('act_2');
    });
    expect(result.current.items.map((item) => item.id)).toEqual(['act_1']);
    const statuses = patch.mock.calls.map(([init]) => JSON.parse(String(init?.body)).status);
    expect(statuses).toEqual(['done', 'open', 'dropped']);
  });

  it('keeps the item and reports an error when the update fails', async () => {
    serve({ ...LIST, 'PATCH /api/action-items/act_1': () => json(500, {}) });
    const { result } = await loaded();
    await act(async () => {
      expect(await result.current.complete('act_1')).toBe(false);
    });
    expect(result.current.items.map((item) => item.id)).toEqual(['act_1', 'act_2']);
    expect(result.current.error).toBe('update_failed');
  });

  // P0: "Make it a task" put personal to-dos into a shared space, dropped the
  // due date and left the action item open next to the new task.
  it('toTask defaults to the private space, keeps the due date and closes the item', async () => {
    const promote = vi.fn((_init?: RequestInit) => json(201, { id: 'tsk_1' }));
    const patch = patchStatus();
    serve({ ...LIST, ...SPACES, 'POST /api/memories/mem_1/promote': promote, 'PATCH /api/action-items/act_1': patch });
    const { result } = await loaded();
    let outcome: Awaited<ReturnType<typeof result.current.toTask>> = null;
    await act(async () => {
      outcome = await result.current.toTask('act_1');
    });
    expect(outcome).toEqual({ taskId: 'tsk_1', spaceId: 'spc_me', spaceName: 'Personal' });
    expect(JSON.parse(String(promote.mock.calls[0]?.[0]?.body))).toEqual({
      space_id: 'spc_me',
      title: 'Call the dentist',
      due_at: DUE_AT,
    });
    expect(JSON.parse(String(patch.mock.calls[0]?.[0]?.body))).toEqual({ status: 'done' });
    expect(result.current.items.map((item) => item.id)).toEqual(['act_2']);
  });

  it('toTask uses a chosen space and title when given', async () => {
    const promote = vi.fn((_init?: RequestInit) => json(201, { id: 'tsk_2' }));
    serve({ ...LIST, 'POST /api/memories/mem_2/promote': promote, 'PATCH /api/action-items/act_2': patchStatus() });
    const { result } = await loaded();
    await act(async () => {
      await result.current.toTask('act_2', { spaceId: 'spc_family', title: ' Renew both passports ' });
    });
    expect(JSON.parse(String(promote.mock.calls[0]?.[0]?.body))).toEqual({
      space_id: 'spc_family',
      title: 'Renew both passports',
    });
  });

  it('toTask leaves the item open and reports an error when the promote fails', async () => {
    serve({ ...LIST, ...SPACES, 'POST /api/memories/mem_1/promote': () => json(500, {}) });
    const { result } = await loaded();
    await act(async () => {
      expect(await result.current.toTask('act_1')).toBeNull();
    });
    expect(result.current.error).toBe('task_failed');
    expect(result.current.items.map((item) => item.id)).toEqual(['act_1', 'act_2']);
  });
});
