import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpaces, SpacesProvider, type SpaceSummary } from './use-spaces';

vi.mock('../../lib/auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

const ACTIVE_KEY = 'bob.family.activeSpaceId';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SPACE_1: SpaceSummary = {
  id: 's1',
  kind: 'group',
  name: 'Family',
  role: 'owner',
  membership_revision: 1,
  created_at: 1756100000000,
  updated_at: 1756100000000,
  archived_at: null,
};

const SPACE_2: SpaceSummary = {
  id: 's2',
  kind: 'group',
  name: 'Cabin',
  role: 'owner',
  membership_revision: 1,
  created_at: 1756100000000,
  updated_at: 1756100000000,
  archived_at: null,
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function routeKey(input: RequestInfo | URL, init?: RequestInit): string {
  const url = typeof input === 'string' ? input : input.toString();
  const method = init?.method ?? 'GET';
  return `${method} ${url}`;
}

function install(routes: Record<string, Response | (() => Response)>): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = routeKey(input, init);
    if (key.startsWith('GET /api/spaces/') && key.endsWith('/members')) {
      return json(200, { members: [] });
    }
    const route = routes[key];
    if (route === undefined) throw new Error(`unhandled route: ${key}`);
    return typeof route === 'function' ? route() : route;
  });
}

beforeEach(() => {
  window.localStorage.clear();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSpaces', () => {
  it('renameSpace trims, PATCHes, resolves true and refetches with the new name', async () => {
    install({
      'GET /api/spaces': json(200, { spaces: [SPACE_1] }),
      'PATCH /api/spaces/s1': json(200, { ...SPACE_1, name: 'Den' }),
    });
    const { result } = renderHook(() => useSpaces(), { wrapper: SpacesProvider });
    await waitFor(() => expect(result.current.state).toBe('ready'));

    fetchMock.mockClear();
    install({
      'PATCH /api/spaces/s1': json(200, { ...SPACE_1, name: 'Den' }),
      'GET /api/spaces': json(200, { spaces: [{ ...SPACE_1, name: 'Den' }] }),
    });
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.renameSpace('s1', '  Den  ');
    });
    expect(ok).toBe(true);
    const [, init] = fetchMock.mock.calls.find(([, callInit]) => callInit?.method === 'PATCH')!;
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Den' });
    await waitFor(() => expect(result.current.spaces[0].name).toBe('Den'));
  });

  it('createSpace POSTs only the trimmed name (spaces have no type) and opens the new space', async () => {
    install({ 'GET /api/spaces': json(200, { spaces: [SPACE_1] }) });
    const { result } = renderHook(() => useSpaces(), { wrapper: SpacesProvider });
    await waitFor(() => expect(result.current.state).toBe('ready'));

    fetchMock.mockClear();
    install({
      'POST /api/spaces': json(201, SPACE_2),
      'GET /api/spaces': json(200, { spaces: [SPACE_1, SPACE_2] }),
    });
    await act(async () => {
      await result.current.createSpace('  Cabin  ');
    });
    const post = fetchMock.mock.calls.find(([, callInit]) => callInit?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ name: 'Cabin' });
    expect(result.current.activeSpaceId).toBe('s2');
  });

  it('a 403 on rename resolves false and triggers no refetch', async () => {
    install({
      'GET /api/spaces': json(200, { spaces: [SPACE_1] }),
      'PATCH /api/spaces/s1': json(403, { error: { code: 'forbidden' } }),
    });
    const { result } = renderHook(() => useSpaces(), { wrapper: SpacesProvider });
    await waitFor(() => expect(result.current.state).toBe('ready'));

    fetchMock.mockClear();
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.renameSpace('s1', 'Den');
    });
    expect(ok).toBe(false);
    const getCalls = fetchMock.mock.calls.filter(([input]) => routeKey(input) === 'GET /api/spaces');
    expect(getCalls).toHaveLength(0);
  });

  it('archiveSpace DELETEs, resolves true, and clears the active pick once refetch drops it', async () => {
    window.localStorage.setItem(ACTIVE_KEY, 's1');
    install({
      'GET /api/spaces': json(200, { spaces: [SPACE_1] }),
    });
    const { result } = renderHook(() => useSpaces(), { wrapper: SpacesProvider });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.activeSpaceId).toBe('s1');

    fetchMock.mockClear();
    install({
      'DELETE /api/spaces/s1': json(200, { ...SPACE_1, archived_at: 1756100000001 }),
      'GET /api/spaces': json(200, { spaces: [] }),
    });
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.archiveSpace('s1');
    });
    expect(ok).toBe(true);
    await waitFor(() => expect(result.current.activeSpaceId).toBeNull());
    expect(window.localStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it('reads a stored active space in its prefixed spc_ form as the stored uuid', async () => {
    const uuid = '6f86817c-ea95-481d-8456-8e608d5db780';
    window.localStorage.setItem(ACTIVE_KEY, 'spc_6f86817cea95481d84568e608d5db780');
    install({ 'GET /api/spaces': json(200, { spaces: [{ ...SPACE_1, id: uuid }] }) });
    const { result } = renderHook(() => useSpaces(), { wrapper: SpacesProvider });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.activeSpaceId).toBe(uuid);
  });

  it('listArchivedSpaces GETs with the query string and returns summaries; a 500 returns null', async () => {
    install({
      'GET /api/spaces': json(200, { spaces: [SPACE_1] }),
    });
    const { result } = renderHook(() => useSpaces(), { wrapper: SpacesProvider });
    await waitFor(() => expect(result.current.state).toBe('ready'));

    install({
      'GET /api/spaces': json(200, { spaces: [SPACE_1] }),
      'GET /api/spaces?archived=true': json(200, { spaces: [SPACE_2] }),
    });
    let archived: SpaceSummary[] | null = null;
    await act(async () => {
      archived = await result.current.listArchivedSpaces();
    });
    expect(archived).toEqual([SPACE_2]);

    install({
      'GET /api/spaces': json(200, { spaces: [SPACE_1] }),
      'GET /api/spaces?archived=true': json(500, { error: { code: 'store_error' } }),
    });
    let failed: SpaceSummary[] | null = [SPACE_1];
    await act(async () => {
      failed = await result.current.listArchivedSpaces();
    });
    expect(failed).toBeNull();
  });

  it('restoreSpace PATCHes { archived: false }, resolves true and refetches', async () => {
    install({
      'GET /api/spaces': json(200, { spaces: [SPACE_1] }),
    });
    const { result } = renderHook(() => useSpaces(), { wrapper: SpacesProvider });
    await waitFor(() => expect(result.current.state).toBe('ready'));

    fetchMock.mockClear();
    install({
      'PATCH /api/spaces/s2': json(200, SPACE_2),
      'GET /api/spaces': json(200, { spaces: [SPACE_1, SPACE_2] }),
    });
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.restoreSpace('s2');
    });
    expect(ok).toBe(true);
    const [, init] = fetchMock.mock.calls.find(([, callInit]) => callInit?.method === 'PATCH')!;
    expect(JSON.parse(String(init?.body))).toEqual({ archived: false });
    await waitFor(() => expect(result.current.spaces).toHaveLength(2));
  });

  it('a throwing fetch makes rename, archive and restore resolve false', async () => {
    install({
      'GET /api/spaces': json(200, { spaces: [SPACE_1] }),
    });
    const { result } = renderHook(() => useSpaces(), { wrapper: SpacesProvider });
    await waitFor(() => expect(result.current.state).toBe('ready'));

    fetchMock.mockImplementation(async () => {
      throw new Error('network down');
    });
    let renameOk!: boolean;
    let archiveOk!: boolean;
    let restoreOk!: boolean;
    await act(async () => {
      renameOk = await result.current.renameSpace('s1', 'Den');
      archiveOk = await result.current.archiveSpace('s1');
      restoreOk = await result.current.restoreSpace('s1');
    });
    expect(renameOk).toBe(false);
    expect(archiveOk).toBe(false);
    expect(restoreOk).toBe(false);
  });
});
